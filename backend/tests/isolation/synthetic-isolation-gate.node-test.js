// Isolation gate + orchestration-ordering tests (node:test). Everything is stubbed or local: no database, no browser, no
// child process, no network, no firewall. The point is the SAFETY ORDERING: a failed isolation gate means the browser
// journey (which is what registers the patient) is never called, and whatever was started is released.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..');
const dir = path.join(BACKEND, 'scripts', 'synthetic-e2e-orchestrator');
const gateLib = require(path.join(dir, 'isolationSelfTest'));
const evidenceLib = require(path.join(dir, 'egressEvidence'));
const { createPolicy } = require(path.join(dir, 'egressPolicy'));
const run = require(path.join(dir, 'run'));
const { establishIsolation } = require(path.join(dir, 'isolation'));
const { assertPortsFree } = require(path.join(dir, 'processManager'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synth-gate-'));
const child = (over = {}) => ({ isReady: () => true, hasExited: () => false, tail: () => [], ...over });

// A complete, healthy evidence file for api + worker.
function healthyEvidence(file, extra = []) {
  const lines = [
    { role: 'api', kind: 'guard_installed' }, { role: 'api', kind: 'guard_selftest_passed' }, { role: 'api', kind: 'database_identity_ok' },
    { role: 'worker', kind: 'guard_installed' }, { role: 'worker', kind: 'guard_selftest_passed' }, ...extra,
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify({ at: 'now', pid: 1, ...l })).join('\n') + '\n');
}

function healthyContext(over = {}) {
  const evidenceFile = path.join(tmp(), 'evidence.jsonl');
  healthyEvidence(evidenceFile);
  return {
    evidenceFile,
    children: { api: child(), worker: child() },
    proxy: { violations: () => [], stats: () => ({ denied: [], allowedHosts: [] }) },
    proxyPort: 1234,
    bundle: { apiUrl: 'http://localhost:4400', matchedFiles: ['a.js'] },
    web: { url: 'http://127.0.0.1:8481' },
    orchestratorGuard: { ok: true },
    local: { databaseUrl: 'mysql://u:p@localhost:3306/humancare_dev', clamav: { host: '127.0.0.1', port: 3310 }, apiUrl: 'http://localhost:4400' },
    probes: { tcpProbe: async () => true, httpStatus: async () => 200, proxyCanaryDenied: async () => true },
    ...over,
  };
}
const failedNames = (result) => result.checks.filter((c) => !c.ok).map((c) => c.name);

// ---- the gate: every requirement is a separate check, and any failure fails the gate ----------------------------------------
test('gate: a fully healthy isolation passes, and every promised check is present', async () => {
  const result = await gateLib.runGate(healthyContext());
  assert.strictEqual(result.ok, true, JSON.stringify(failedNames(result)));
  const names = result.checks.map((c) => c.name);
  for (const required of [
    'api_egress_guard_installed', 'api_egress_selftest_passed', 'worker_egress_guard_installed', 'worker_egress_selftest_passed',
    'api_database_identity_humancare_dev', 'worker_database_identity_humancare_dev', 'no_egress_violations_recorded', 'orchestrator_egress_guard_selftest',
    'browser_proxy_denies_bitrix_canary', 'web_bundle_targets_isolated_api', 'local_mysql_reachable', 'local_clamav_reachable', 'isolated_api_answers', 'isolated_web_served',
  ]) assert.ok(names.includes(required), `missing check ${required}`);
});

const GATE_FAILURES = [
  ['9. the API guard never reported installation', (c) => { fs.writeFileSync(c.evidenceFile, ''); }, 'api_egress_guard_installed'],
  ['the worker guard\'s self-test did not pass', (c) => { healthyEvidence(c.evidenceFile); fs.writeFileSync(c.evidenceFile, fs.readFileSync(c.evidenceFile, 'utf8').split('\n').filter((l) => !(l.includes('"worker"') && l.includes('selftest'))).join('\n')); }, 'worker_egress_selftest_passed'],
  ['the API never confirmed humancare_dev', (c) => { fs.writeFileSync(c.evidenceFile, fs.readFileSync(c.evidenceFile, 'utf8').split('\n').filter((l) => !l.includes('database_identity_ok')).join('\n')); }, 'api_database_identity_humancare_dev'],
  ['the worker is not ready (did not confirm its database)', (c) => { c.children.worker = child({ isReady: () => false }); }, 'worker_database_identity_humancare_dev'],
  ['a blocked Bitrix attempt was already recorded', (c) => { healthyEvidence(c.evidenceFile, [{ role: 'api', kind: 'blocked_connect', destination: 'portal.bitrix24.in' }]); }, 'no_egress_violations_recorded'],
  ['an unreadable evidence record', (c) => { fs.appendFileSync(c.evidenceFile, 'not json\n'); }, 'no_egress_violations_recorded'],
  ['the orchestrator\'s own guard self-test failed', (c) => { c.orchestratorGuard = { ok: false }; }, 'orchestrator_egress_guard_selftest'],
  ['the API process has exited', (c) => { c.children.api = child({ hasExited: () => true }); }, 'api_process_alive'],
  ['the worker process has exited', (c) => { c.children.worker = child({ hasExited: () => true }); }, 'worker_process_alive'],
  ['the browser proxy did not deny the Bitrix canary', (c) => { c.probes.proxyCanaryDenied = async () => false; }, 'browser_proxy_denies_bitrix_canary'],
  ['the web bundle was not verified to target the isolated API', (c) => { c.bundle = { apiUrl: 'x', matchedFiles: [] }; }, 'web_bundle_targets_isolated_api'],
  ['6. local MySQL is not reachable', (c) => { c.probes.tcpProbe = async (host, port) => port !== 3306; }, 'local_mysql_reachable'],
  ['7. ClamAV is not reachable', (c) => { c.probes.tcpProbe = async (host, port) => port !== 3310; }, 'local_clamav_reachable'],
  ['8. the isolated API does not answer', (c) => { c.probes.httpStatus = async (url) => (url.includes('4400') ? 0 : 200); }, 'isolated_api_answers'],
  ['the isolated API answers with a server error', (c) => { c.probes.httpStatus = async (url) => (url.includes('4400') ? 503 : 200); }, 'isolated_api_answers'],
  ['the isolated web server is not serving', (c) => { c.probes.httpStatus = async (url) => (url.includes('8481') ? 0 : 200); }, 'isolated_web_served'],
  ['a probe throws', (c) => { c.probes.tcpProbe = async () => { throw new Error('boom'); }; }, 'local_mysql_reachable'],
];
for (const [title, mutate, expectedFailure] of GATE_FAILURES) {
  test(`gate fails (and assertGate throws IsolationError) when: ${title}`, async () => {
    const ctx = healthyContext();
    mutate(ctx);
    const result = await gateLib.runGate(ctx);
    assert.strictEqual(result.ok, false);
    assert.ok(failedNames(result).includes(expectedFailure), `${expectedFailure} not among ${JSON.stringify(failedNames(result))}`);
    const ctx2 = healthyContext();
    mutate(ctx2);
    await assert.rejects(gateLib.assertGate(ctx2), (err) => err instanceof gateLib.IsolationError && /No patient account was created/.test(err.message));
  });
}

test('mid-run re-check: a violation, a dead child or a proxy denial of a Bitrix name turns "isolated" into "not isolated"', () => {
  const evidenceFile = path.join(tmp(), 'e.jsonl');
  healthyEvidence(evidenceFile);
  const base = { evidenceFile, children: { api: child(), worker: child() }, proxy: { violations: () => [] } };
  assert.deepStrictEqual(gateLib.checkStillIsolated(base), { ok: true, problems: [] });
  assert.strictEqual(gateLib.checkStillIsolated({ ...base, children: { api: child({ hasExited: () => true }), worker: child() } }).ok, false);
  assert.strictEqual(gateLib.checkStillIsolated({ ...base, proxy: { violations: () => [{ host: 'x.bitrix24.in', reason: 'bitrix_name_pattern' }] } }).ok, false);
  fs.appendFileSync(evidenceFile, `${JSON.stringify({ role: 'worker', kind: 'blocked_child_process', destination: 'spawn' })}\n`);
  assert.match(gateLib.checkStillIsolated(base).problems.join(' '), /blocked_child_process/);
});

test('evidence: the self-test canary is never a violation; unknown/garbled records are', () => {
  const s = evidenceLib.summarize([{ role: 'api', kind: 'selftest_block' }, { role: 'api', kind: 'proxy_selftest_denied' }], ['api']);
  assert.deepStrictEqual(s.violations, []);
  assert.strictEqual(evidenceLib.summarize([{ kind: 'unreadable_record' }], ['api']).violations.length, 1);
  assert.strictEqual(evidenceLib.summarize([{ role: 'api', kind: 'guard_selftest_failed' }], ['api']).violations.length, 1);
  assert.deepStrictEqual(evidenceLib.readAll(path.join(tmp(), 'missing.jsonl')), []);
});

// ---- ports ------------------------------------------------------------------------------------------------------------------------
const listenOn = (port, host) => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, host, () => resolve(s)); });

test('ports: 4000 and 4100 are refused outright, whether or not anything is listening on them', async () => {
  for (const port of [4000, 4100]) await assert.rejects(assertPortsFree([port]), (e) => e.code === 'port_unavailable' && /forbidden_port/.test(e.message));
});
test('ports: an occupied port is reported and nothing is started or stopped; a free one passes', async () => {
  const busy = await listenOn(0, '127.0.0.1');
  const busyPort = busy.address().port;
  await assert.rejects(assertPortsFree([busyPort]), (e) => e.code === 'port_unavailable' && new RegExp(`${busyPort} \\(in_use\\)`).test(e.message));
  busy.close();
  const probe = await listenOn(0, '127.0.0.1');
  const freePort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const [result] = await assertPortsFree([freePort]);
  assert.strictEqual(result.free, true);
});
test('isolation: if a required port is taken, establishIsolation fails BEFORE building any environment or starting anything', async () => {
  const busy = await listenOn(0, '127.0.0.1');
  const runDir = tmp();
  await assert.rejects(
    establishIsolation({ runDir, envFileValues: {}, policy: createPolicy({}), apiPort: busy.address().port, webPort: busy.address().port + 1, log: { log() {}, error() {} } }),
    (e) => e.code === 'port_unavailable',
  );
  busy.close();
  assert.deepStrictEqual(fs.readdirSync(runDir), [], 'nothing may be written before the ports are verified');
});

// ---- 11. isolation failure prevents patient registration ------------------------------------------------------------------
function stubs(extra = {}) {
  const calls = { journey: 0, isolation: 0, preflight: 0, stopAll: 0, locksTaken: 0 };
  const runsDir = tmp();
  const locksDir = path.join(runsDir, '.phone-locks');
  const overrides = {
    runsDir, locksDir,
    recoverOrphans: () => ({ terminated: [], skipped: [] }),
    runPreflight: async () => { calls.preflight += 1; return { database: 'humancare_dev', bitrixHost: null, envFileValues: {} }; },
    checkGeneralWorkerAbsent: () => {},
    loadPhonePool: () => ({ testCode: '000000', numbers: ['+917000000001'] }),
    generateSyntheticPdf: async ({ outDir }) => { const p = path.join(outDir, 'x.pdf'); fs.writeFileSync(p, 'pdf'); return p; },
    removeSyntheticPdf: (p) => fs.rmSync(p, { force: true }),
    runJourney: async () => { calls.journey += 1; throw new Error('journey stub reached'); },
    establishIsolation: async () => {
      calls.isolation += 1;
      return { web: { url: 'http://localhost:8481' }, egress: {}, summary: () => ({ ok: true }), isolationCheck: () => ({ ok: true, problems: [] }), stopAll: async () => { calls.stopAll += 1; } };
    },
    ...extra,
  };
  return { calls, overrides, runsDir, locksDir };
}
const ctx = { policy: createPolicy({}), orchestratorGuard: { ok: true }, envFileValues: {} };

test('11. a failed isolation gate prevents registration: the browser journey is never called and no phone number is locked', async () => {
  const { calls, overrides, locksDir } = stubs({
    establishIsolation: async () => { throw new gateLib.IsolationError('isolation gate failed: api_egress_selftest_passed. No patient account was created.'); },
  });
  const out = await run.orchestrate({}, { headless: true }, ctx, overrides);
  assert.strictEqual(calls.journey, 0, 'the journey (registration) must not run');
  assert.strictEqual(out.exitCode, 1);
  assert.strictEqual(out.report.overallOutcome, 'failed');
  assert.match(out.report.failures.join(' '), /isolation gate failed/);
  assert.strictEqual(out.report.requestId, null);
  assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0, 'no phone lock may be taken before isolation is proven');
});

test('11. a failed preflight stops everything before isolation is even attempted', async () => {
  const { calls, overrides } = stubs({ runPreflight: async () => { throw new Error('preflight: ClamAV is not reachable'); } });
  const out = await run.orchestrate({}, {}, ctx, overrides);
  assert.strictEqual(calls.isolation, 0);
  assert.strictEqual(calls.journey, 0);
  assert.strictEqual(out.exitCode, 1);
});

test('12. after a failure the isolation is released exactly once, the phone lock and fixture are released, and signal handlers are removed', async () => {
  const { calls, overrides, locksDir } = stubs();
  const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
  const out = await run.orchestrate({}, {}, ctx, overrides);
  assert.strictEqual(calls.journey, 1, 'with a proven isolation the journey is reached');
  assert.strictEqual(calls.stopAll, 1, 'everything started must be stopped exactly once');
  assert.strictEqual(out.exitCode, 1);
  assert.deepStrictEqual(fs.existsSync(locksDir) ? fs.readdirSync(locksDir) : [], [], 'the phone lock must be released');
  assert.deepStrictEqual({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }, before);
  assert.ok(!fs.readdirSync(path.join(overrides.runsDir, out.runId)).some((f) => f.endsWith('.pdf')), 'the synthetic fixture must be removed');
});

test('the report carries the isolation evidence and the honest limitations, and never a firewall section', async () => {
  const { overrides } = stubs();
  const out = await run.orchestrate({}, {}, ctx, overrides);
  assert.ok(out.report.isolation);
  assert.ok(!('firewall' in out.report));
  assert.match(out.report.networkIsolationLimitations, /not kernel-level isolation/);
  assert.match(out.report.networkIsolationLimitations, /No Windows Firewall rule was created/);
});

test('12. crash recovery terminates ONLY processes this tool started (own pid file + own preload + own entry); anything else is left alone', () => {
  const { recoverOrphans } = require(path.join(dir, 'processManager'));
  const runs = tmp();
  fs.mkdirSync(path.join(runs, 'old-run'));
  fs.writeFileSync(path.join(runs, 'old-run', 'pids.json'), JSON.stringify({ api: 111, worker: 222 }));
  fs.mkdirSync(path.join(runs, 'other-run'));
  fs.writeFileSync(path.join(runs, 'other-run', 'pids.json'), JSON.stringify({ api: 333, worker: 444 }));
  const killed = [];
  const result = recoverOrphans(runs, 'current', {
    listNodeProcesses: () => [
      { pid: 111, commandLine: 'node --require C:\\x\\egressGuard.preload.js C:\\x\\src\\synthetic-e2e-api.js' }, // ours
      { pid: 222, commandLine: 'node C:\\x\\src\\synthetic-e2e-worker.js' }, // the USER\'s own worker: no preload -> must NOT be touched
      { pid: 333, commandLine: 'node C:\\other\\server.js' }, // pid reuse by an unrelated process
      // 444 no longer exists
    ],
    kill: (pid) => killed.push(pid),
  });
  assert.deepStrictEqual(killed, [111]);
  assert.deepStrictEqual(result.terminated.map((t) => t.pid), [111]);
  assert.deepStrictEqual(result.skipped.map((s) => s.pid).sort(), [222, 333]);
  // a second pass does nothing (the pid file is marked recovered)
  assert.deepStrictEqual(recoverOrphans(runs, 'current', { listNodeProcesses: () => { throw new Error('should not enumerate'); }, kill: () => { throw new Error('should not kill'); } }), { terminated: [], skipped: [] });
});
