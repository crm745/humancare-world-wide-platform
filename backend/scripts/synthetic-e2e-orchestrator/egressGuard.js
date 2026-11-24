// In-process egress guard for the synthetic E2E run. Installed (via egressGuard.preload.js, `node --require`) BEFORE any
// application code runs in the isolated API and the dedicated worker, and also in the orchestrator itself.
//
// It replaces the earlier "replace global fetch" guard, which only covered fetch. The hooks below cover every outbound
// transport a Node process can use from JavaScript:
//   * net.Socket.prototype.connect - the single choke point under net.connect/createConnection, tls.connect (TLSSocket is a
//     net.Socket), http/https Agents, http2, undici/fetch, nodemailer, the AWS SDK, firebase-admin, google-auth-library.
//     It blocks by host name AND wraps the lookup so a resolved ADDRESS is re-checked (DNS rebinding, a name that
//     resolves to the blocked address, inet_aton spellings), and re-checks the connected remote address.
//   * dns.lookup / dns.resolve* / dns.promises.* / Resolver - a blocked name is not even resolved; a lookup that
//     returns a blocked address is turned into an error.
//   * globalThis.fetch (early, clear failure; the real enforcement is the socket layer, which redirects cannot skip
//     because every redirect hop opens a new connection through the same hook).
//   * dgram (UDP), child_process.*, worker_threads.Worker, process.dlopen (native addons): refused outright in the API and
//     worker, because a child process, a thread or a native module could open sockets this file cannot see.
//   * Module loading: the API and worker refuse to load the general worker or any Bitrix job/worker module.
//   * console: the console email provider prints message bodies; those lines are replaced by a fixed notice.
//
// What it cannot do (disclosed in README.md and the report): it is enforced by the process itself, not by the operating
// system. Native code already inside an allowed module (the Prisma query engine, which only talks to the loopback MySQL
// server named in DATABASE_URL) opens its own sockets outside JavaScript, and nothing here can intercept those.
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const dgram = require('dgram');
const util = require('util');
const Module = require('module');
const childProcess = require('child_process');
const workerThreads = require('worker_threads');
const { CANARY_HOST, CANARY_IP, normalizeHost } = require('./egressPolicy');
const evidence = require('./egressEvidence');

class EgressBlockedError extends Error {
  constructor(message, destination) {
    super(message);
    this.name = 'EgressBlockedError';
    this.code = 'EGRESS_BLOCKED';
    if (destination !== undefined) this.destination = destination;
  }
}

// Native modules the API/worker legitimately load: Prisma's query engine (loopback MySQL only).
const ALLOWED_NATIVE = /query[_-]engine|[\\/]\.prisma[\\/]client[\\/]|[\\/]@prisma[\\/]/i;

// Modules that must never load in the isolated processes. Paths are matched with forward slashes.
const COMMON_FORBIDDEN_MODULES = [/\/src\/worker\.js$/, /\/src\/jobs\/index\.js$/];
const API_FORBIDDEN_MODULES = [/\/src\/jobs\//];
const WORKER_FORBIDDEN_MODULES = [
  /\/src\/jobs\/(?!scan-request-documents\.job\.js$|job-runner\.js$)/,
  /\/modules\/bitrix\/(bitrix-deal\.api|bitrix\.service|deal-worker\.service|deal-inbox\.service|deal-reconcile\.service|quotation-sync\.service|deal-document-worker\.service)\.js$/,
  /\/modules\/payments\/razorpay\.api\.js$/,
];

const CHILD_PROCESS_FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const DNS_NAME_FUNCTIONS = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt'];

let current = null;
// True only while the guard runs its SYNCHRONOUS self-test probes inside install(), i.e. before any application code has run.
let selfTestSync = false;

function install({
  role, policy, evidenceFile = null,
  allowChildProcess = false, allowWorkerThreads = false, blockNativeModules = true,
  forbiddenModules = [], redactConsole = true, selfTest = true,
}) {
  if (current) return current;
  if (!role || !policy) throw new Error('egress guard: role and policy are required');

  const note = (event) => evidence.record(evidenceFile, { role, ...event });
  const originals = {
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup,
    promisesLookup: dns.promises.lookup,
    fetch: globalThis.fetch,
    moduleLoad: Module._load,
    dlopen: process.dlopen,
    worker: workerThreads.Worker,
  };

  // Every denial goes through here: it records the evidence and builds the error. The canary is the self-test's
  // known-blocked destination, so its denials are recorded as self-test events, not as violations.
  function deny(kind, destination, message) {
    const shown = String(destination).slice(0, 200);
    const isCanary = selfTestSync || normalizeHost(shown) === CANARY_HOST || shown === CANARY_IP;
    note({ kind: isCanary ? 'selftest_block' : kind, destination: shown });
    return new EgressBlockedError(message || `Outbound connection to ${shown} is blocked by the synthetic E2E isolation policy`, shown);
  }

  // ---- net.Socket.prototype.connect --------------------------------------------------------------------------------
  function guardedLookup(userLookup, socket) {
    return (hostname, options, callback) => {
      let opts = options;
      let cb = callback;
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      const lookupFn = userLookup || originals.lookup;
      lookupFn.call(socket, hostname, opts, (err, address, family) => {
        if (err) return cb(err, address, family);
        const list = Array.isArray(address) ? address.map((a) => a && a.address) : [address];
        const bad = list.find((a) => a && policy.checkIp(a).blocked);
        if (bad) return cb(deny('blocked_connect', bad, `Outbound connection to ${bad} (resolved from ${hostname}) is blocked by the synthetic E2E isolation policy`));
        return cb(null, address, family);
      });
    };
  }

  net.Socket.prototype.connect = function guardedConnect(...args) {
    const first = args[0];
    let options = null;
    let arrayForm = false;
    if (Array.isArray(first)) { options = first[0]; arrayForm = true; }
    else if (first !== null && typeof first === 'object') options = first;
    else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      const callback = args.find((a) => typeof a === 'function');
      options = { port: Number(first), host: typeof args[1] === 'string' ? args[1] : undefined };
      args = callback ? [options, callback] : [options];
    } else {
      return originals.connect.apply(this, args); // IPC path (named pipe / unix socket): local by definition
    }
    if (options && options.path && options.port === undefined) return originals.connect.apply(this, args); // IPC

    const host = options && options.host ? String(options.host) : 'localhost';
    const verdict = policy.check(host);
    if (verdict.blocked) {
      const err = deny('blocked_connect', host);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    const wrapped = { ...options, lookup: guardedLookup(options && options.lookup, this) };
    if (arrayForm) first[0] = wrapped; else args[0] = wrapped;
    this.once('connect', () => {
      const remote = this.remoteAddress;
      if (remote && policy.checkIp(remote).blocked) this.destroy(deny('blocked_connect', remote, `Connected to blocked address ${remote}; connection destroyed`));
    });
    return originals.connect.apply(this, args);
  };

  const originalTlsConnect = tls.connect;
  tls.connect = function guardedTlsConnect(...args) {
    const a0 = args[0];
    const names = [];
    if (a0 && typeof a0 === 'object') { if (a0.host) names.push(a0.host); if (a0.servername) names.push(a0.servername); }
    else if (typeof args[1] === 'string') names.push(args[1]);
    for (const name of names) if (policy.checkName(String(name)).blocked || policy.check(String(name)).blocked) throw deny('blocked_connect', name);
    return originalTlsConnect.apply(this, args);
  };

  // ---- DNS --------------------------------------------------------------------------------------------------------
  function checkLookupResult(hostname, address) {
    const list = Array.isArray(address) ? address.map((a) => a && a.address) : [address];
    const bad = list.find((a) => a && policy.checkIp(a).blocked);
    return bad ? deny('blocked_dns', bad, `Lookup of ${hostname} returned blocked address ${bad}`) : null;
  }

  const guardedDnsLookup = function lookup(hostname, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (policy.check(String(hostname)).blocked) {
      const err = deny('blocked_dns', hostname);
      process.nextTick(() => cb(err));
      return {};
    }
    return originals.lookup.call(dns, hostname, opts, (err, address, family) => {
      if (err) return cb(err, address, family);
      const bad = checkLookupResult(hostname, address);
      return bad ? cb(bad) : cb(null, address, family);
    });
  };
  if (originals.lookup[util.promisify.custom]) guardedDnsLookup[util.promisify.custom] = (...a) => dns.promises.lookup(...a);
  dns.lookup = guardedDnsLookup;

  dns.promises.lookup = async function lookup(hostname, options) {
    if (policy.check(String(hostname)).blocked) throw deny('blocked_dns', hostname);
    const result = await originals.promisesLookup.call(dns.promises, hostname, options);
    const bad = checkLookupResult(hostname, result);
    if (bad) throw bad;
    return result;
  };

  function guardNameFunction(owner, name, promiseStyle) {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function guardedResolve(hostname, ...rest) {
      if (policy.check(String(hostname)).blocked) {
        const err = deny('blocked_dns', hostname);
        if (promiseStyle) return Promise.reject(err);
        const cb = rest.find((a) => typeof a === 'function');
        if (cb) { process.nextTick(() => cb(err)); return undefined; }
        throw err;
      }
      return original.call(this, hostname, ...rest);
    };
  }
  for (const name of DNS_NAME_FUNCTIONS) {
    guardNameFunction(dns, name, false);
    guardNameFunction(dns.promises, name, true);
    guardNameFunction(dns.Resolver.prototype, name, false);
    if (dns.promises.Resolver) guardNameFunction(dns.promises.Resolver.prototype, name, true);
  }

  // ---- fetch (early failure; the socket layer is the real boundary) ------------------------------------------------
  if (typeof originals.fetch === 'function') {
    globalThis.fetch = function guardedFetch(input, init) {
      try {
        const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
        const host = new URL(raw).hostname;
        if (policy.check(host).blocked) return Promise.reject(deny('blocked_fetch', host));
      } catch { /* an unparseable URL fails inside fetch itself */ }
      return originals.fetch.call(globalThis, input, init);
    };
  }

  // ---- UDP ---------------------------------------------------------------------------------------------------------
  const dgramSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function guardedSend(...args) {
    const host = args.slice(1).find((a) => typeof a === 'string');
    if (host && policy.check(host).blocked) throw deny('blocked_dgram', host);
    return dgramSend.apply(this, args);
  };
  const dgramConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function guardedDgramConnect(port, address, ...rest) {
    if (typeof address === 'string' && policy.check(address).blocked) throw deny('blocked_dgram', address);
    return dgramConnect.call(this, port, address, ...rest);
  };

  // ---- child processes, threads, native modules ---------------------------------------------------------------------
  if (!allowChildProcess) {
    for (const name of CHILD_PROCESS_FUNCTIONS) {
      if (typeof childProcess[name] !== 'function') continue;
      childProcess[name] = function blockedChildProcess() {
        throw deny('blocked_child_process', name, `child_process.${name} is blocked in this isolated process (a child process could open sockets this guard cannot see)`);
      };
    }
  }
  if (!allowWorkerThreads) {
    workerThreads.Worker = class BlockedWorker {
      constructor() {
        throw deny('blocked_worker_thread', 'worker_threads.Worker', 'worker threads are blocked in this isolated process');
      }
    };
  }
  if (blockNativeModules) {
    process.dlopen = function guardedDlopen(module, filename, ...rest) {
      if (!ALLOWED_NATIVE.test(String(filename))) {
        throw deny('blocked_native_module', require('path').basename(String(filename)), 'loading a native module is blocked in this isolated process');
      }
      return originals.dlopen.call(process, module, filename, ...rest);
    };
  }

  // ---- module tripwire ---------------------------------------------------------------------------------------------
  const forbidden = [...forbiddenModules];
  if (role === 'api') forbidden.push(...COMMON_FORBIDDEN_MODULES, ...API_FORBIDDEN_MODULES);
  if (role === 'worker') forbidden.push(...COMMON_FORBIDDEN_MODULES, ...WORKER_FORBIDDEN_MODULES);
  if (forbidden.length) {
    Module._load = function guardedModuleLoad(request, parent, isMain) {
      let filename = null;
      try { filename = Module._resolveFilename(request, parent, isMain); } catch { /* the real loader reports it */ }
      if (filename && !isMain) {
        const normalized = filename.replace(/\\/g, '/');
        if (forbidden.some((pattern) => pattern.test(normalized))) {
          throw deny('blocked_module_load', normalized.split('/').slice(-3).join('/'), 'this module must never load in the isolated process');
        }
      }
      return originals.moduleLoad.apply(this, arguments); // eslint-disable-line prefer-rest-params
    };
  }

  // ---- console email bodies ------------------------------------------------------------------------------------------
  if (redactConsole) {
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = console[method];
      console[method] = (...args) => {
        if (typeof args[0] === 'string' && args[0].startsWith('[DEV ONLY')) return original.call(console, '[DEV ONLY] console email output suppressed by the synthetic E2E isolation.');
        return original.apply(console, args);
      };
    }
  }

  // ---- installation proof -------------------------------------------------------------------------------------------
  const hooksPresent = net.Socket.prototype.connect !== originals.connect
    && dns.lookup !== originals.lookup
    && dns.promises.lookup !== originals.promisesLookup
    && (typeof originals.fetch !== 'function' || globalThis.fetch !== originals.fetch);
  if (!hooksPresent) throw new Error('egress guard: a hook did not take effect');
  note({ kind: 'guard_installed', childProcessBlocked: !allowChildProcess, workerThreadsBlocked: !allowWorkerThreads, nativeBlocked: blockNativeModules, moduleTripwires: forbidden.length });

  current = { role, policy, originals, selfTestPromise: Promise.resolve(null) };
  if (selfTest) {
    current.selfTestPromise = runSelfTest({ policy, allowChildProcess, allowWorkerThreads, note });
  }
  return current;
}

// Each probe must be REFUSED by the guard. A probe that is not refused fails the self-test, which kills the process.
async function runSelfTest({ policy, allowChildProcess, allowWorkerThreads, note }) {
  const results = [];
  // Synchronous probes first: they finish before this function's first await, so before any application code can run and
  // before anything else could be denied in the same window (their denials are recorded as self-test events).
  const syncResults = [];
  const expectBlockedSync = (name, attemptFn) => {
    selfTestSync = true;
    try {
      attemptFn();
      syncResults.push({ name, ok: false, detail: 'was not blocked' });
    } catch (err) {
      syncResults.push({ name, ok: !!err && err.code === 'EGRESS_BLOCKED', detail: err && err.code });
    } finally {
      selfTestSync = false;
    }
  };
  if (!allowChildProcess) expectBlockedSync('child_process.spawn', () => { childProcess.spawn(process.execPath, ['-e', '0']); });
  if (!allowWorkerThreads) expectBlockedSync('worker_threads.Worker', () => { new workerThreads.Worker('0', { eval: true }); }); // eslint-disable-line no-new
  const expectBlocked = async (name, attempt) => {
    try {
      await attempt();
      results.push({ name, ok: false, detail: 'was not blocked' });
    } catch (err) {
      results.push({ name, ok: !!err && err.code === 'EGRESS_BLOCKED', detail: err && err.code });
    }
  };
  await expectBlocked('net.connect(name)', () => new Promise((resolve, reject) => {
    const s = net.connect({ host: CANARY_HOST, port: 9 });
    s.setTimeout(2000, () => s.destroy(new Error('self-test probe was not refused')));
    s.once('connect', () => { s.destroy(); resolve(); });
    s.once('error', reject);
  }));
  await expectBlocked('tls.connect(name)', async () => { const s = tls.connect({ host: CANARY_HOST, port: 9 }); s.on('error', () => {}); });
  await expectBlocked('dns.lookup(name)', () => new Promise((resolve, reject) => dns.lookup(CANARY_HOST, (err) => (err ? reject(err) : resolve()))));
  await expectBlocked('dns.promises.resolve4(name)', () => dns.promises.resolve4(CANARY_HOST));
  if (typeof globalThis.fetch === 'function') await expectBlocked('fetch(name)', () => globalThis.fetch(`https://${CANARY_HOST}/`));
  await expectBlocked('dgram.send(name)', async () => { const s = dgram.createSocket('udp4'); s.on('error', () => {}); try { s.send(Buffer.from('x'), 9, CANARY_HOST); } finally { s.close(); } });
  await expectBlocked('net.connect(blocked ip)', () => new Promise((resolve, reject) => {
    const s = net.connect({ host: CANARY_IP, port: 9 });
    s.setTimeout(2000, () => s.destroy(new Error('self-test probe was not refused')));
    s.once('connect', () => { s.destroy(); resolve(); });
    s.once('error', reject);
  }));
  results.push(...syncResults);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    note({ kind: 'guard_selftest_failed', failed: failed.map((f) => f.name) });
    return { ok: false, results };
  }
  note({ kind: 'guard_selftest_passed', probes: results.map((r) => r.name) });
  return { ok: true, results };
}

module.exports = { install, EgressBlockedError, ALLOWED_NATIVE, runSelfTest };
