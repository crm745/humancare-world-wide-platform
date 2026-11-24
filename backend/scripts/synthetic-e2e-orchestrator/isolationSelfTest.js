// The isolation GATE. Nothing that creates a patient account (the browser journey's "CREATE ACCOUNT" step, i.e.
// POST /auth/register) may run until this gate has passed; any failed check - or any error while checking - throws an
// IsolationError and the run aborts before registration. Every check states what it actually observed.
//
// It also provides the checks that are re-run during the run (evidence/violation re-check) so a guard that was healthy at
// the gate cannot silently stop being healthy.
const net = require('net');
const http = require('http');
const evidence = require('./egressEvidence');
const { CANARY_HOST } = require('./egressPolicy');

class IsolationError extends Error {
  constructor(message, checks) {
    super(message);
    this.name = 'IsolationError';
    this.code = 'isolation_failed';
    if (checks) this.checks = checks;
  }
}

// ---- default probes (injectable for tests) -------------------------------------------------------------------------------
function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; socket.destroy(); resolve(ok); } };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect({ host, port });
  });
}

function httpStatus(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

// Sends a CONNECT for the canary host through the proxy; the proxy must answer 403 (and never open a tunnel).
function proxyCanaryDenied(proxyPort, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
    let data = '';
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('connect', () => socket.write(`CONNECT ${CANARY_HOST}:443 HTTP/1.1\r\nHost: ${CANARY_HOST}:443\r\n\r\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n')) finish(/^HTTP\/1\.[01] 403\b/.test(data));
    });
    socket.on('close', () => finish(/^HTTP\/1\.[01] 403\b/.test(data)));
  });
}

function parseDatabaseEndpoint(databaseUrl) {
  try {
    const url = new URL(String(databaseUrl));
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 3306) };
  } catch {
    return null;
  }
}

// ---- the gate -----------------------------------------------------------------------------------------------------------
// ctx: { evidenceFile, children: { api, worker }, orchestratorGuard: {ok}, proxy, proxyPort, bundle, web: {url},
//        local: { databaseUrl, clamav: {host, port}, apiUrl }, probes? }
async function runGate(ctx) {
  const probes = { tcpProbe, httpStatus, proxyCanaryDenied, ...(ctx.probes || {}) };
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  const guarded = async (name, fn) => { try { await fn(); } catch (err) { add(name, false, `error while checking: ${err.message}`); } };

  const records = evidence.readAll(ctx.evidenceFile);
  const summary = evidence.summarize(records, ['api', 'worker']);
  for (const role of ['api', 'worker']) {
    add(`${role}_egress_guard_installed`, summary.byRole[role].installed, null);
    add(`${role}_egress_selftest_passed`, summary.byRole[role].selftest, null);
  }
  add('api_database_identity_humancare_dev', summary.byRole.api.identity === true, 'the API\'s own Prisma connection answered SELECT DATABASE() = humancare_dev before listening');
  add('worker_database_identity_humancare_dev', !!(ctx.children.worker && ctx.children.worker.isReady()), 'the worker prints "Started jobs" only after its own confirmDatabase() passed');
  add('no_egress_violations_recorded', summary.violations.length === 0, summary.violations.map((v) => `${v.role || '?'}:${v.kind}`));
  add('orchestrator_egress_guard_selftest', ctx.orchestratorGuard && ctx.orchestratorGuard.ok, null);
  add('api_process_alive', ctx.children.api && !ctx.children.api.hasExited(), null);
  add('worker_process_alive', ctx.children.worker && !ctx.children.worker.hasExited(), null);

  await guarded('browser_proxy_denies_bitrix_canary', async () => {
    const denied = await probes.proxyCanaryDenied(ctx.proxyPort);
    add('browser_proxy_denies_bitrix_canary', denied, 'CONNECT to the canary Bitrix name through the browser proxy answered 403');
  });
  add('web_bundle_targets_isolated_api', ctx.bundle && ctx.bundle.matchedFiles && ctx.bundle.matchedFiles.length > 0, ctx.bundle ? { apiUrl: ctx.bundle.apiUrl, matchedFiles: ctx.bundle.matchedFiles.length } : null);

  await guarded('local_mysql_reachable', async () => {
    const endpoint = parseDatabaseEndpoint(ctx.local.databaseUrl);
    add('local_mysql_reachable', !!endpoint && await probes.tcpProbe(endpoint.host, endpoint.port), endpoint ? `${endpoint.host}:${endpoint.port} (TCP connect only)` : 'DATABASE_URL unreadable');
  });
  await guarded('local_clamav_reachable', async () => {
    add('local_clamav_reachable', await probes.tcpProbe(ctx.local.clamav.host, ctx.local.clamav.port), `${ctx.local.clamav.host}:${ctx.local.clamav.port}`);
  });
  await guarded('isolated_api_answers', async () => {
    const status = await probes.httpStatus(ctx.local.apiUrl);
    add('isolated_api_answers', status > 0 && status < 500, `HTTP ${status}`);
  });
  await guarded('isolated_web_served', async () => {
    const status = await probes.httpStatus(ctx.web.url);
    add('isolated_web_served', status === 200, `HTTP ${status}`);
  });

  return { ok: checks.every((c) => c.ok), checks };
}

async function assertGate(ctx) {
  let result;
  try {
    result = await runGate(ctx);
  } catch (err) {
    throw new IsolationError(`isolation gate could not be evaluated: ${err.message}`);
  }
  if (!result.ok) {
    throw new IsolationError(`isolation gate failed: ${result.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}. No patient account was created.`, result.checks);
  }
  return result;
}

// Re-checked on every poll tick during the run, and once more at the end. Returns { ok, problems }.
function checkStillIsolated({ evidenceFile, children, proxy }) {
  const problems = [];
  const summary = evidence.summarize(evidence.readAll(evidenceFile), ['api', 'worker']);
  for (const v of summary.violations) problems.push(`${v.role || '?'} recorded ${v.kind}${v.destination ? ` (${v.destination})` : ''}`);
  for (const role of ['api', 'worker']) {
    if (children[role] && children[role].hasExited()) problems.push(`the isolated ${role} process is no longer running`);
  }
  if (proxy) for (const d of proxy.violations()) problems.push(`the browser asked the proxy for ${d.host} (${d.reason})`);
  return { ok: problems.length === 0, problems };
}

module.exports = { IsolationError, runGate, assertGate, checkStillIsolated, tcpProbe, httpStatus, proxyCanaryDenied, parseDatabaseEndpoint };
