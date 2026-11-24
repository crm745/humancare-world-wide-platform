// Egress guard tests (node:test). Every scenario runs in a CHILD process started exactly like the isolated API / worker
// (`node --require egressGuard.preload.js ...`), against LOCAL mock endpoints only:
//   * 127.0.0.2 stands in for "Bitrix" (its listener counts connections - the count must stay ZERO);
//   * 127.0.0.1 is the allowed local side (API / MySQL / ClamAV stand-ins);
//   * the only host names used are *.test and *.invalid, which cannot resolve on the public internet.
// No real Bitrix request is possible from this file. No database, no firewall, no browser. Run: npm run test:synthetic-orchestrator
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const BACKEND = path.resolve(__dirname, '..', '..');
const PRELOAD = path.join(BACKEND, 'scripts', 'synthetic-e2e-orchestrator', 'egressGuard.preload.js');
const PROBE = path.join(__dirname, 'helpers', 'egress-probe-child.js');
const evidenceLib = require(path.join(BACKEND, 'scripts', 'synthetic-e2e-orchestrator', 'egressEvidence'));

const SYSTEM = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WINDIR']) if (process.env[key] !== undefined) SYSTEM[key] = process.env[key];

let blockedHits = 0; // connections that reached the "Bitrix" stand-in on 127.0.0.2
let blockedServer; let allowedServer; let tcpServer;
let ports = {};
let blockedAvailable = true;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-egress-'));

const listen = (server, port, host) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address().port)); });

test.before(async () => {
  blockedServer = net.createServer((socket) => { blockedHits += 1; socket.destroy(); });
  try {
    ports.blocked = await listen(blockedServer, 0, '127.0.0.2');
  } catch {
    blockedAvailable = false; // 127.0.0.2 not bindable on this machine: the IP-based scenarios are skipped, not faked
    ports.blocked = 9;
  }
  allowedServer = http.createServer((req, res) => {
    if (req.url === '/to-ip') { res.writeHead(302, { Location: `http://127.0.0.2:${ports.blocked}/` }); res.end(); return; }
    if (req.url === '/to-name') { res.writeHead(302, { Location: `http://mock-bitrix.test:${ports.blocked}/` }); res.end(); return; }
    if (req.url === '/to-portal') { res.writeHead(302, { Location: 'https://acme.bitrix24.invalid/rest/1/x/crm.deal.add.json' }); res.end(); return; }
    if (req.url === '/to-allowed') { res.writeHead(302, { Location: `http://127.0.0.1:${ports.allowed}/` }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
  });
  ports.allowed = await listen(allowedServer, 0, '127.0.0.1');
  tcpServer = net.createServer((socket) => { socket.on('data', () => socket.end('PONG')); });
  ports.tcp = await listen(tcpServer, 0, '127.0.0.1');
});

test.after(async () => {
  for (const s of [blockedServer, allowedServer, tcpServer]) await new Promise((r) => s.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Runs one scenario under the guard and returns { result, stdout, evidence, evidenceFile }.
function run(scenario, { role = 'api', env = {}, waitForSelfTestMs = 0 } = {}) {
  const evidenceFile = path.join(tmp, `${scenario}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  fs.writeFileSync(evidenceFile, '');
  const childEnv = {
    ...SYSTEM,
    HC_EGRESS_ROLE: role,
    HC_EGRESS_EVIDENCE: evidenceFile,
    HC_EGRESS_BLOCK_HOSTS: JSON.stringify(['mock-bitrix.test']),
    HC_EGRESS_BLOCK_IPS: JSON.stringify(['127.0.0.2']),
    PROBE_BLOCKED_PORT: String(ports.blocked), PROBE_ALLOWED_PORT: String(ports.allowed), PROBE_REDIRECT_PORT: String(ports.allowed), PROBE_TCP_PORT: String(ports.tcp),
    // dummy, loopback, closed port: loading the app/worker module graph never connects anywhere
    DATABASE_URL: 'mysql://nobody:nothing@127.0.0.1:1/humancare_dev',
    JWT_ACCESS_SECRET: 'x'.repeat(40), JWT_REFRESH_SECRET: 'y'.repeat(40),
    BITRIX_SYNC_ENABLED: 'false', BITRIX24_WEBHOOK_URL: '', NODE_ENV: 'development',
    ...env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', PRELOAD, PROBE, scenario], { cwd: BACKEND, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`scenario ${scenario} timed out`)); }, 60000);
    child.once('exit', () => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT:'));
      const result = line ? JSON.parse(line.slice(7)) : null;
      resolve({ result, stdout, stderr, evidence: evidenceLib.readAll(evidenceFile), evidenceFile });
    });
  });
}

function assertBlocked(out, kind) {
  assert.ok(out.result, `no result; stderr: ${out.stderr.slice(0, 400)}`);
  assert.strictEqual(out.result.blocked, true, `expected EGRESS_BLOCKED but got ${JSON.stringify(out.result)}`);
  if (kind) assert.ok(out.evidence.some((e) => e.kind === kind), `expected an evidence record of kind ${kind}; got ${out.evidence.map((e) => e.kind).join(',')}`);
}

// ---- 2/3. API / worker attempts to reach "Bitrix" are blocked, by every JavaScript transport -------------------------
const BLOCKED_BY_NAME = [
  ['fetch to a blocked host name', 'fetch_name', 'blocked_fetch'],
  ['fetch to a Bitrix24 portal name (pattern, not just the configured host)', 'fetch_portal_pattern', 'blocked_fetch'],
  ['http.get to a blocked address', 'http_request_ip', 'blocked_connect'],
  ['https.get to a Bitrix24 portal name', 'https_request_name', 'blocked_connect'],
  ['net.connect to a blocked host name', 'net_connect_name', 'blocked_connect'],
  ['net.connect with a trailing dot in the name', 'net_connect_trailing_dot', 'blocked_connect'],
  ['net.connect with upper-case letters in the name', 'net_connect_uppercase', 'blocked_connect'],
  ['tls.connect to a Bitrix24 portal name', 'tls_connect_name', 'blocked_connect'],
  ['dns.lookup of a blocked name', 'dns_lookup_name', 'blocked_dns'],
  ['dns.promises.lookup of a Bitrix24 portal name', 'dns_promises_lookup_name', 'blocked_dns'],
  ['dns.resolve4 of a Bitrix24 portal name', 'dns_resolve4_name', 'blocked_dns'],
  ['dns.promises.resolve4 of a Bitrix24 portal name', 'dns_promises_resolve4_name', 'blocked_dns'],
  ['dns.Resolver of a Bitrix24 portal name', 'dns_resolver_name', 'blocked_dns'],
  ['UDP send to a blocked name', 'dgram_name', 'blocked_dgram'],
  ['http2.connect to a Bitrix24 portal name', 'http2_name', 'blocked_connect'],
];
for (const role of ['api', 'worker']) {
  for (const [title, scenario, kind] of BLOCKED_BY_NAME) {
    test(`${role}: ${title} is blocked`, async () => {
      const before = blockedHits;
      assertBlocked(await run(scenario, { role }), kind);
      assert.strictEqual(blockedHits, before, 'the Bitrix stand-in received a connection');
    });
  }
}

const BLOCKED_BY_IP = [
  ['fetch to a blocked address', 'fetch_ip', 'blocked_fetch'],
  ['net.connect to a blocked address', 'net_connect_ip', 'blocked_connect'],
  ['net.connect(port, host) form to a blocked address', 'net_connect_port_host_form', 'blocked_connect'],
  ['net.connect to the hex spelling of the blocked address', 'net_connect_hex_ip', 'blocked_connect'],
  ['net.connect to the decimal spelling of the blocked address', 'net_connect_decimal_ip', 'blocked_connect'],
  ['net.connect to the IPv4-mapped IPv6 spelling of the blocked address', 'net_connect_mapped_ipv6', 'blocked_connect'],
  ['a harmless-looking name whose lookup returns the blocked address (DNS rebinding)', 'net_rebind_via_lookup', 'blocked_connect'],
  ['tls.connect to a blocked address', 'tls_connect_ip', 'blocked_connect'],
  ['UDP send to a blocked address', 'dgram_ip', 'blocked_dgram'],
];
for (const [title, scenario, kind] of BLOCKED_BY_IP) {
  test(`api: ${title} is blocked and never reaches the listener`, async (t) => {
    if (!blockedAvailable) return t.skip('127.0.0.2 is not bindable on this machine');
    const before = blockedHits;
    assertBlocked(await run(scenario), kind);
    assert.strictEqual(blockedHits, before, 'the Bitrix stand-in received a connection');
    return undefined;
  });
}

// ---- 4. HTTPS/HTTP redirects cannot bypass the restriction -----------------------------------------------------------
test('a redirect from an allowed local server to a blocked ADDRESS is blocked at the redirect hop', async (t) => {
  if (!blockedAvailable) return t.skip('127.0.0.2 is not bindable on this machine');
  const before = blockedHits;
  assertBlocked(await run('fetch_redirect_ip'), 'blocked_connect');
  assert.strictEqual(blockedHits, before);
  return undefined;
});
test('a redirect from an allowed local server to a blocked NAME is blocked at the redirect hop', async () => {
  assertBlocked(await run('fetch_redirect_name'));
});
test('a redirect to an https Bitrix24 portal URL is blocked at the redirect hop', async () => {
  assertBlocked(await run('fetch_redirect_https_pattern'));
});
test('control: a redirect between ALLOWED local servers still works (the guard is not just blocking all redirects)', async () => {
  const out = await run('fetch_redirect_allowed_control');
  assert.deepStrictEqual(out.result, { blocked: false, result: 'ok' });
});

// ---- 5. alternate transports cannot bypass the restriction -----------------------------------------------------------
for (const [title, scenario] of [
  ['child_process.spawn', 'child_process_spawn'],
  ['child_process.exec', 'child_process_exec'],
  ['child_process.execFileSync', 'child_process_execFileSync'],
]) {
  test(`${title} is refused in the isolated process (a child could open sockets the guard cannot see)`, async () => {
    const out = await run(scenario);
    assertBlocked(out, 'blocked_child_process');
  });
}
test('worker threads are refused in the isolated process', async () => {
  assertBlocked(await run('worker_thread'), 'blocked_worker_thread');
});
test('an unknown native module cannot be loaded in the isolated process', async () => {
  assertBlocked(await run('native_module'), 'blocked_native_module');
});

// ---- 6/7/8/9. local services stay reachable ---------------------------------------------------------------------------
test('local API traffic (fetch and http to 127.0.0.1) still works under the guard', async () => {
  assert.deepStrictEqual((await run('allowed_fetch_local')).result, { blocked: false, result: 'ok' });
  assert.deepStrictEqual((await run('allowed_http_local')).result, { blocked: false, result: 'ok' });
});
test('local TCP services (MySQL / ClamAV stand-in on 127.0.0.1) still work under the guard', async () => {
  assert.deepStrictEqual((await run('allowed_tcp_local')).result, { blocked: false, result: 'PONG' });
  assert.deepStrictEqual((await run('allowed_localhost_name')).result, { blocked: false, result: 'PONG' });
});
test('DNS for localhost still works under the guard', async () => {
  const out = await run('allowed_dns_localhost');
  assert.strictEqual(out.result.blocked, false);
  assert.ok(['127.0.0.1', '::1'].includes(out.result.result));
});
test('the guard records no violation for allowed local traffic', async () => {
  const out = await run('allowed_tcp_local');
  assert.deepStrictEqual(evidenceLib.summarize(out.evidence, ['api']).violations, []);
});

// ---- installation + self-test evidence --------------------------------------------------------------------------------
test('the guard records installation and a PASSED self-test (every probe refused) before the process does any work', async () => {
  const out = await run('sleep', { env: { PROBE_SLEEP_MS: '1500' } });
  const s = evidenceLib.summarize(out.evidence, ['api']);
  assert.strictEqual(s.byRole.api.installed, true);
  assert.strictEqual(s.byRole.api.selftest, true, `self-test not recorded; evidence: ${JSON.stringify(out.evidence)}`);
  const passed = out.evidence.find((e) => e.kind === 'guard_selftest_passed');
  for (const probe of ['net.connect(name)', 'tls.connect(name)', 'dns.lookup(name)', 'dns.promises.resolve4(name)', 'fetch(name)', 'dgram.send(name)', 'child_process.spawn', 'worker_threads.Worker']) {
    assert.ok(passed.probes.includes(probe), `self-test did not exercise ${probe}`);
  }
  assert.deepStrictEqual(s.violations, [], 'the self-test canary must be recorded as a self-test event, not as a violation');
});

test('the guard refuses to start (the entry file is never loaded) when its configuration is unreadable', async () => {
  for (const env of [{ HC_EGRESS_ROLE: 'nonsense' }, { HC_EGRESS_BLOCK_HOSTS: '{not json' }]) {
    const out = await run('sleep', { env });
    assert.strictEqual(out.result, null, 'the probe must never have run');
    assert.match(out.stderr, /egress guard could not be established/);
  }
});

test('the self-test FAILS when the hooks are not installed (so a missing guard can never look healthy)', async () => {
  const code = `
    const { createPolicy } = require(${JSON.stringify(path.join(BACKEND, 'scripts', 'synthetic-e2e-orchestrator', 'egressPolicy'))});
    const { runSelfTest } = require(${JSON.stringify(path.join(BACKEND, 'scripts', 'synthetic-e2e-orchestrator', 'egressGuard'))});
    runSelfTest({ policy: createPolicy({}), allowChildProcess: true, allowWorkerThreads: true, note() {} }).then((r) => { console.log('RESULT:' + JSON.stringify({ ok: r.ok })); process.exit(0); });
  `;
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], { env: SYSTEM, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; child.stdout.on('data', (c) => { stdout += c; });
    child.once('exit', () => resolve(stdout));
  });
  assert.match(out, /RESULT:\{"ok":false\}/);
});

// ---- console fallback must not expose OTPs / email contents ------------------------------------------------------------
test('console-provider email output (which can contain one-time codes) is replaced by a fixed notice', async () => {
  const out = await run('console_redaction');
  assert.ok(!out.stdout.includes('482913'), 'the one-time code reached stdout');
  assert.ok(!out.stdout.includes('someone@example.test'), 'the recipient reached stdout');
  assert.ok(out.stdout.includes('console email output suppressed'));
  assert.ok(out.stdout.includes('ordinary application log line'), 'ordinary logging must be unaffected');
});

// ---- the API and worker cannot start the general worker or any Bitrix job -------------------------------------------------
test('role api: the general worker, the job index and every job module are refused at load time', async () => {
  for (const scenario of ['require_general_worker', 'require_jobs_index', 'require_bitrix_job', 'require_scan_job']) {
    assertBlocked(await run(scenario, { role: 'api' }), 'blocked_module_load');
  }
});
test('role worker: the general worker, the job index and every job except the scan job are refused at load time', async () => {
  for (const scenario of ['require_general_worker', 'require_jobs_index', 'require_bitrix_job', 'require_bitrix_deal_api']) {
    assertBlocked(await run(scenario, { role: 'worker' }), 'blocked_module_load');
  }
});
test('role worker: the scan job (its one allowed job) still loads', async () => {
  const out = await run('require_scan_job', { role: 'worker' });
  assert.deepStrictEqual(out.result, { blocked: false, result: 'loaded' }, JSON.stringify(out.result));
  assert.deepStrictEqual(evidenceLib.summarize(out.evidence, ['worker']).violations, []);
});
test('role worker: the dedicated worker\'s whole module graph loads without touching any forbidden Bitrix/job module', async () => {
  const out = await run('load_worker_graph', { role: 'worker' });
  assert.deepStrictEqual(out.result, { blocked: false, result: 'loaded' }, `${JSON.stringify(out.result)} ${out.stderr.slice(0, 600)}`);
  assert.deepStrictEqual(evidenceLib.summarize(out.evidence, ['worker']).violations, []);
});
test('role api: the whole API app module graph loads without loading the general worker or any job module', async () => {
  const out = await run('load_api_graph', { role: 'api' });
  assert.deepStrictEqual(out.result, { blocked: false, result: 'loaded' }, `${JSON.stringify(out.result)} ${out.stderr.slice(0, 600)}`);
  assert.deepStrictEqual(evidenceLib.summarize(out.evidence, ['api']).violations, []);
});

// ---- the "Bitrix" stand-in never heard from anyone ---------------------------------------------------------------------------
test('summary: across every scenario above, the Bitrix stand-in listener received ZERO connections', () => {
  assert.strictEqual(blockedHits, 0);
});
