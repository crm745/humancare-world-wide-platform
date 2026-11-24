// Tests for --gate-only, the readiness-only worker, --reuse-web-build and the API-secret rule (node:test).
// Everything is stubbed or local: no database (fake Prisma objects only), no real API/worker/browser/Expo process, no network
// beyond loopback listeners on ephemeral ports, no firewall. A dummy loopback DATABASE_URL on a closed port is set FIRST so
// requiring the worker module can never name or reach a real database.
process.env.DATABASE_URL = 'mysql://nobody:nothing@127.0.0.1:1/humancare_dev';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..');
const dir = path.join(BACKEND, 'scripts', 'synthetic-e2e-orchestrator');
const run = require(path.join(dir, 'run'));
const webBuild = require(path.join(dir, 'webBuild'));
const childEnv = require(path.join(dir, 'childEnv'));
const processManager = require(path.join(dir, 'processManager'));
const reportLib = require(path.join(dir, 'report'));
const { establishIsolation } = require(path.join(dir, 'isolation'));
const { IsolationError } = require(path.join(dir, 'isolationSelfTest'));
const { createPolicy } = require(path.join(dir, 'egressPolicy'));
const { LIMITS, databaseOfUrl } = require(path.join(BACKEND, 'src', 'common', 'safety', 'synthetic-e2e-marker'));
const worker = require(path.join(BACKEND, 'src', 'synthetic-e2e-worker'));
const apiEntry = require(path.join(BACKEND, 'src', 'synthetic-e2e-api'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synth-gateonly-'));
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const GOOD_JS = 'var API="http://localhost:4400"||"http://localhost:4000";';
function goodBundle() { const d = tmp(); write(d, 'index.html', '<html></html>'); write(d, '_expo/static/js/web/entry-abc.js', GOOD_JS); return d; }
function snapshot(root) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { const st = fs.statSync(f); out.push(`${path.relative(root, f)}|${st.size}|${st.mtimeMs}`); } } };
  walk(root);
  return out.sort();
}
async function freePort() { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const { port } = s.address(); await new Promise((r) => s.close(r)); return port; }

// ======================================================================================================================
// 1. --gate-only
// ======================================================================================================================
test('argument parsing: --gate-only and --reuse-web-build, and the combinations that make no sense are refused', () => {
  assert.deepStrictEqual({ g: run.parseArgs(['--gate-only']).gateOnly, r: run.parseArgs(['--gate-only']).reuseWebBuild }, { g: true, r: null });
  assert.strictEqual(run.parseArgs(['--gate-only', '--reuse-web-build', 'C:/x/web']).reuseWebBuild, 'C:/x/web');
  assert.strictEqual(run.parseArgs(['--reuse-web-build', 'C:/x/web']).gateOnly, false);
  assert.throws(() => run.parseArgs(['--reuse-web-build']), /needs a directory/);
  assert.throws(() => run.parseArgs(['--reuse-web-build', '--gate-only']), /needs a directory/);
  assert.throws(() => run.parseArgs(['--gate-only', '--cleanup', 'r1']), /cannot be combined/);
  assert.throws(() => run.parseArgs(['--gate-only', '--recover']), /cannot be combined/);
  assert.throws(() => run.parseArgs(['--gate-only', '--headless']), /no browser/);
  assert.throws(() => run.parseArgs(['--recover', '--reuse-web-build', 'x']), /only applies/);
});

function gateOnlyStubs(extra = {}) {
  const calls = { preflight: 0, isolation: 0, stopAll: 0, isolationArgs: null, recover: 0, exit: [] };
  const runsDir = tmp();
  const stopRegistry = {};
  const overrides = {
    runsDir,
    recoverOrphans: () => { calls.recover += 1; return { terminated: [], skipped: [] }; },
    runPreflight: async () => { calls.preflight += 1; return { database: 'humancare_dev', bitrixHost: null, envFileValues: { SYNTHETIC_E2E_SECRET: 'FAKESECRETVALUE'.padEnd(40, 'x'), BITRIX24_WEBHOOK_URL: 'https://acme.bitrix24.in/rest/1/FAKEWEBHOOKTOKEN/' } }; },
    establishIsolation: async (args) => {
      calls.isolation += 1; calls.isolationArgs = args;
      return {
        summary: () => ({ mode: 'gate-only', gate: [{ name: 'api_egress_guard_installed', ok: true, detail: null }, { name: 'worker_database_identity_humancare_dev', ok: true, detail: null }] }),
        stopAll: async () => { calls.stopAll += 1; },
      };
    },
    exit: (code) => calls.exit.push(code),
    ...extra,
  };
  return { calls, overrides, runsDir, stopRegistry };
}
const ctx = { policy: createPolicy({}), orchestratorGuard: { ok: true }, envFileValues: {} };

test('gate-only success: gate report written, outcome gate_passed, exit 0, only what it started is stopped (once)', async () => {
  const { calls, overrides, runsDir } = gateOnlyStubs();
  const out = await run.runGateOnly({}, { gateOnly: true, reuseWebBuild: 'C:/x/web' }, ctx, overrides);
  assert.strictEqual(out.exitCode, 0);
  assert.strictEqual(out.report.outcome, 'gate_passed');
  assert.strictEqual(calls.stopAll, 1);
  assert.strictEqual(calls.isolationArgs.gateOnly, true, 'isolation must be established in gate-only mode (readiness-only worker)');
  assert.strictEqual(calls.isolationArgs.reuseWebBuild, 'C:/x/web');
  const files = fs.readdirSync(path.join(runsDir, out.runId)).sort();
  assert.deepStrictEqual(files, ['gate-report.json'], `gate-only must leave only its report; found ${files.join(', ')}`);
});

test('gate-only report states what ran and, explicitly, everything that did NOT run', async () => {
  const { overrides } = gateOnlyStubs();
  const out = await run.runGateOnly({}, { gateOnly: true }, ctx, overrides);
  const text = JSON.stringify(out.report);
  for (const phrase of ['phone lock', 'Playwright / Chromium', 'registration', 'approval records', 'document-scan job', 'synthetic-approval job', 'run-on-start']) assert.ok(text.includes(phrase), phrase);
  assert.ok(out.report.executed.some((e) => /READINESS-ONLY/.test(e)));
  assert.match(out.report.networkIsolationLimitations, /not kernel-level isolation/);
});

test('gate-only never leaks a secret, webhook or token into its report', async () => {
  const { overrides } = gateOnlyStubs();
  const out = await run.runGateOnly({}, { gateOnly: true }, ctx, overrides);
  const text = JSON.stringify(out.report);
  assert.ok(!/FAKESECRETVALUE|FAKEWEBHOOKTOKEN|bitrix24\.in\/rest/.test(text));
});

test('gate-only failure: gate_failed, exit 1, failing checks reported, nothing left running', async () => {
  const { calls, overrides } = gateOnlyStubs({
    establishIsolation: async () => { throw new IsolationError('isolation gate failed: api_egress_selftest_passed. No patient account was created.', [{ name: 'api_egress_selftest_passed', ok: false, detail: null }]); },
  });
  const out = await run.runGateOnly({}, { gateOnly: true }, ctx, overrides);
  assert.strictEqual(out.exitCode, 1);
  assert.strictEqual(out.report.outcome, 'gate_failed');
  assert.deepStrictEqual(out.report.gate.filter((c) => !c.ok).map((c) => c.name), ['api_egress_selftest_passed']);
  assert.strictEqual(calls.stopAll, 0, 'a failed establishIsolation releases itself; there is no handle to stop twice');
});

test('gate-only: a failed preflight stops before isolation is attempted', async () => {
  const { calls, overrides } = gateOnlyStubs({ runPreflight: async () => { throw new Error('preflight: general worker is running'); } });
  const out = await run.runGateOnly({}, { gateOnly: true }, ctx, overrides);
  assert.strictEqual(out.exitCode, 1);
  assert.strictEqual(calls.isolation, 0);
});

test('gate-only: if reading the summary fails after isolation was established, the isolation is STILL stopped', async () => {
  const { calls, overrides } = gateOnlyStubs({
    establishIsolation: async () => ({ summary: () => { throw new Error('summary exploded'); }, stopAll: async () => { calls.stopAll += 1; } }),
  });
  const out = await run.runGateOnly({}, { gateOnly: true }, ctx, overrides);
  assert.strictEqual(out.exitCode, 1);
  assert.strictEqual(calls.stopAll, 1);
});

test('gate-only interruption (Ctrl+C / SIGTERM) DURING start-up stops what was already started, once, then exits 130', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { calls, overrides } = gateOnlyStubs({
    establishIsolation: async ({ stopRegistry }) => {
      stopRegistry.stopAll = async () => { calls.stopAll += 1; }; // what the real establishIsolation publishes at once
      await gate; // still starting up
      throw new Error('interrupted while starting');
    },
  });
  const before = { i: process.listenerCount('SIGINT'), t: process.listenerCount('SIGTERM') };
  const pending = run.runGateOnly({}, { gateOnly: true }, ctx, overrides);
  await new Promise((r) => setTimeout(r, 50));
  process.emit('SIGINT');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(calls.stopAll, 1, 'the half-started isolation must be stopped on interruption');
  assert.deepStrictEqual(calls.exit, [130]);
  release();
  const out = await pending;
  assert.strictEqual(calls.stopAll, 1, 'never stopped twice');
  assert.strictEqual(out.exitCode, 1);
  assert.deepStrictEqual({ i: process.listenerCount('SIGINT'), t: process.listenerCount('SIGTERM') }, before, 'signal handlers removed');
});

test('full run interruption: the same early-stop path exists (stopRegistry), so a Ctrl+C during start-up cannot leave children behind', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let stopped = 0; const exits = [];
  const runsDir = tmp();
  const overrides = {
    runsDir, locksDir: path.join(runsDir, '.l'),
    recoverOrphans: () => ({ terminated: [], skipped: [] }),
    runPreflight: async () => ({ database: 'humancare_dev', bitrixHost: null, envFileValues: {} }),
    establishIsolation: async ({ stopRegistry }) => { stopRegistry.stopAll = async () => { stopped += 1; }; await gate; throw new Error('interrupted'); },
    exit: (c) => exits.push(c),
  };
  const pending = run.orchestrate({}, {}, ctx, overrides);
  await new Promise((r) => setTimeout(r, 50));
  process.emit('SIGTERM');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(stopped, 1);
  assert.deepStrictEqual(exits, [130]);
  release();
  const out = await pending;
  assert.strictEqual(stopped, 1);
  assert.strictEqual(out.exitCode, 1);
});

test('gate-only has no code path to the phone lock, browser, registration, fixtures, marker, scan/approval waiters or verification', () => {
  const src = fs.readFileSync(path.join(dir, 'run.js'), 'utf8');
  const start = src.indexOf('function gateOnlyDeps');
  const end = src.indexOf('async function orchestrate');
  assert.ok(start > 0 && end > start);
  const code = src.slice(start, end).replace(/\/\/.*$/gm, '');
  for (const forbidden of ['tryAcquirePhoneLock', 'loadPhonePool', 'phone-pool', 'safety', 'runJourney', 'browserJourney', 'playwright', 'chromium', 'generateSyntheticPdf', 'fixtures', 'issueMarker', 'waitForCleanScan', 'waitForApproval', 'resolveEligibleAdminId', 'verifyOutcome', 'serviceRequest', 'user.create', 'register']) {
    assert.ok(!code.includes(forbidden), `gate-only code references ${forbidden}`);
  }
  assert.ok(!/prisma\./.test(code), 'gate-only never touches the database through the orchestrator\'s Prisma (it only hands it to the read-only preflight)');
  assert.ok(!/require\('\.\/(browserJourney|safety|fixtures|issueMarker|waitForScan|waitForApproval|adminResolver|verify|cleanup)'\)/.test(code));
});

test('gate-only: importing and running it never loads Playwright (checked in a clean child process)', async () => {
  const { execFileSync } = require('child_process');
  const script = `
    process.env.DATABASE_URL = 'mysql://nobody:nothing@127.0.0.1:1/humancare_dev';
    const run = require(${JSON.stringify(path.join(dir, 'run'))});
    const overrides = { runsDir: ${JSON.stringify(tmp())}, recoverOrphans: () => ({ terminated: [], skipped: [] }), runPreflight: async () => ({ database: 'humancare_dev', envFileValues: {} }), establishIsolation: async () => ({ summary: () => ({ gate: [] }), stopAll: async () => {} }), exit() {} };
    run.runGateOnly({}, { gateOnly: true }, { policy: null, orchestratorGuard: null }, overrides).then(() => {
      const loaded = Object.keys(require.cache).filter((k) => /[\\\\/]playwright(-core)?[\\\\/]/.test(k) || /browserJourney|fixtures[\\\\/.]|issueMarker|waitForApproval|waitForScan/.test(k));
      console.log('LOADED:' + JSON.stringify(loaded.map((k) => k.split(/[\\\\/]/).slice(-2).join('/'))));
      process.exit(0);
    });
  `;
  const out = execFileSync(process.execPath, ['-e', script], { cwd: BACKEND, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }, windowsHide: true });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('LOADED:'));
  assert.ok(line, out.slice(0, 300));
  assert.deepStrictEqual(JSON.parse(line.slice(7)), [], 'gate-only must not even load the browser journey, Playwright or any patient-facing module');
});

// ---- establishIsolation, with fake process starters (no real child, no database) ---------------------------------------------------
const FAKE_ENV_FILE = {
  DATABASE_URL: 'mysql://app:pw@localhost:3306/humancare_dev', JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40),
  FIREBASE_SERVICE_ACCOUNT_PATH: 'C:/keys/fake.json', PHONE_OTP_PROVIDER: 'firebase', SYNTHETIC_E2E_SECRET: 's'.repeat(40),
  CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '3310', BITRIX24_WEBHOOK_URL: 'https://acme.bitrix24.in/rest/1/FAKE/', SMTP_PASS: 'FAKE',
};
function fakeChild(role, env, over = {}) {
  const lines = role === 'api'
    ? ['guard_installed', 'guard_selftest_passed', 'database_identity_ok']
    : ['guard_installed', 'guard_selftest_passed'];
  fs.appendFileSync(env.HC_EGRESS_EVIDENCE, lines.map((kind) => JSON.stringify({ at: 'now', pid: 1, role, kind })).join('\n') + '\n');
  const state = { stops: 0 };
  return { role, pid: 4242, isReady: () => true, hasExited: () => false, tail: () => [], stop: async () => { state.stops += 1; }, state, ...over };
}
async function isolate({ gateOnly, reuse, evidenceMutator, probes } = {}) {
  const runDir = tmp();
  const apiPort = await freePort(); const webPort = await freePort();
  const calls = { startWorker: [], startApi: 0, prepare: [], exporter: 0 };
  const kids = {};
  const deps = {
    startWorker: ({ env, readinessOnly }) => { calls.startWorker.push({ readinessOnly, env }); kids.worker = fakeChild('worker', env); return kids.worker; },
    startApi: ({ env }) => { calls.startApi += 1; kids.api = fakeChild('api', env); if (evidenceMutator) evidenceMutator(env.HC_EGRESS_EVIDENCE); return kids.api; },
    prepareBundle: (args) => { calls.prepare.push(args); return webBuild.prepareBundle({ ...args, exporter: async () => { calls.exporter += 1; write(args.runDir, 'web-dist/index.html', 'x'); write(args.runDir, 'web-dist/_expo/static/js/web/e.js', GOOD_JS); } }); },
    probes: probes || { tcpProbe: async () => true, httpStatus: async () => 200 },
  };
  const stopRegistry = {};
  const attempt = establishIsolation({
    runDir, envFileValues: FAKE_ENV_FILE, policy: createPolicy({ blockedHosts: ['acme.bitrix24.in'] }), orchestratorGuard: { selfTestPromise: Promise.resolve({ ok: true }) },
    log: { log() {}, error() {} }, apiPort, webPort, gateOnly, reuseWebBuild: reuse || null, deps, stopRegistry,
  });
  return { attempt, calls, kids, apiPort, webPort, runDir, stopRegistry };
}

test('gate-only starts the worker in READINESS-ONLY mode; a normal run starts it normally; the API is started the same way in both', async () => {
  const g = await isolate({ gateOnly: true, reuse: goodBundle() });
  const gh = await g.attempt;
  assert.deepStrictEqual(g.calls.startWorker.map((c) => c.readinessOnly), [true]);
  assert.strictEqual(g.calls.startApi, 1);
  assert.strictEqual(gh.summary().mode, 'gate-only');
  await gh.stopAll();
  const n = await isolate({ gateOnly: false });
  const nh = await n.attempt;
  assert.deepStrictEqual(n.calls.startWorker.map((c) => c.readinessOnly), [false]);
  assert.strictEqual(n.calls.exporter, 1, 'without --reuse-web-build the bundle IS exported (fresh)');
  assert.strictEqual(nh.summary().mode, 'full');
  await nh.stopAll();
});

test('gate-only with --reuse-web-build never exports; the worker env equals the normal worker env (only the start-up flag differs)', async () => {
  const bundle = goodBundle();
  const before = snapshot(bundle);
  const g = await isolate({ gateOnly: true, reuse: bundle });
  const h = await g.attempt;
  assert.strictEqual(g.calls.exporter, 0, 'expo export must not run when a verified bundle is reused');
  assert.strictEqual(g.calls.prepare[0].reuseDir, bundle);
  assert.strictEqual(h.summary().bundle.reused, true);
  await h.stopAll();
  assert.deepStrictEqual(snapshot(bundle), before, 'the reused export directory must be left exactly as it was');
  const envBuilt = g.calls.startWorker[0].env;
  assert.strictEqual(envBuilt.BITRIX_SYNC_ENABLED, 'false');
  assert.strictEqual(envBuilt.BITRIX24_WEBHOOK_URL, '');
});

test('cleanup on success: API and worker stopped once each, proxy and web server closed (ports free again)', async () => {
  const g = await isolate({ gateOnly: true, reuse: goodBundle() });
  const h = await g.attempt;
  await h.stopAll();
  await h.stopAll(); // idempotent
  assert.strictEqual(g.kids.api.state.stops, 1);
  assert.strictEqual(g.kids.worker.state.stops, 1);
  const web = await processManager.checkPortFree(g.webPort);
  assert.strictEqual(web.free, true, 'the web server must be closed');
});

test('cleanup on failure: a failed gate stops everything that was started and rejects with IsolationError', async () => {
  const g = await isolate({
    gateOnly: true, reuse: goodBundle(),
    evidenceMutator: (file) => fs.appendFileSync(file, `${JSON.stringify({ role: 'api', kind: 'blocked_connect', destination: 'x.bitrix24.in' })}\n`),
  });
  await assert.rejects(g.attempt, (e) => e instanceof IsolationError && /no_egress_violations_recorded/.test(e.message));
  assert.strictEqual(g.kids.api.state.stops, 1);
  assert.strictEqual(g.kids.worker.state.stops, 1);
  assert.strictEqual((await processManager.checkPortFree(g.webPort)).free, true);
});

test('an invalid reused bundle is rejected BEFORE anything is started', async () => {
  const bad = tmp();
  write(bad, 'index.html', 'x'); write(bad, 'a.js', 'var API="http://localhost:4000";');
  const g = await isolate({ gateOnly: true, reuse: bad });
  await assert.rejects(g.attempt, { code: 'bundle_api_url_missing' });
  assert.deepStrictEqual([g.calls.startApi, g.calls.startWorker.length], [0, 0]);
  assert.strictEqual((await processManager.checkPortFree(g.webPort)).free, true);
});

// ======================================================================================================================
// 2. the readiness-only worker
// ======================================================================================================================
// A Prisma stand-in that records every call and throws on anything but the one read-only identity query and disconnect.
function strictPrisma(dbName, record) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === '$queryRaw') return async (...args) => { record.push(['$queryRaw', String((args[0] && args[0].join ? args[0].join('?') : args[0]) || '').trim()]); return [{ db: dbName }]; };
      if (prop === '$disconnect') return async () => { record.push(['$disconnect']); };
      if (prop === 'then') return undefined;
      throw new Error(`UNEXPECTED prisma access: ${String(prop)}`);
    },
  });
}
const WORKER_ENV = () => childEnv.buildChildEnv({ role: 'worker', envFileValues: FAKE_ENV_FILE, policy: createPolicy({}), evidenceFile: 'x', databaseOfUrl, requiredDatabase: LIMITS.DATABASE });

test('readiness-only worker: confirms humancare_dev with ONE read-only SELECT DATABASE() and then idles - no job runner is ever created', async (t) => {
  const job = worker.JOBS[0];
  const originalRun = job.run;
  let jobRuns = 0;
  job.run = async () => { jobRuns += 1; };
  t.after(() => { job.run = originalRun; });
  Object.assign(process.env, { SYNTHETIC_E2E_AUTO_APPROVE: 'true', SYNTHETIC_E2E_SECRET: 's'.repeat(40), NODE_ENV: 'development' });
  const calls = []; let runnersCreated = 0; const exits = [];
  const result = await worker.main({
    argv: ['node', 'worker.js', '--readiness-only'], prisma: strictPrisma('humancare_dev', calls), skipDotenv: true, signals: false, keepAlive: false,
    createJobRunner: () => { runnersCreated += 1; throw new Error('a job runner must never be created in readiness-only mode'); }, exit: (c) => exits.push(c),
  });
  assert.strictEqual(result.readinessOnly, true);
  assert.strictEqual(runnersCreated, 0);
  assert.strictEqual(jobRuns, 0);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['$queryRaw'], 'exactly one database call, and it is the identity query');
  assert.match(calls[0][1], /SELECT DATABASE\(\)/i);
  assert.deepStrictEqual(exits, []);
  await result.stop();
  assert.deepStrictEqual(calls.map((c) => c[0]), ['$queryRaw', '$disconnect']);
  assert.deepStrictEqual(exits, [0]);
});

test('readiness-only worker: no run-on-start run and no interval run - even after 10 minutes of (mocked) time', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const job = worker.JOBS[0];
  const originalRun = job.run;
  let jobRuns = 0;
  job.run = async () => { jobRuns += 1; };
  t.after(() => { job.run = originalRun; });
  Object.assign(process.env, { SYNTHETIC_E2E_AUTO_APPROVE: 'true', SYNTHETIC_E2E_SECRET: 's'.repeat(40), NODE_ENV: 'development' });
  const calls = [];
  const result = await worker.main({ argv: ['node', 'w.js', '--readiness-only'], prisma: strictPrisma('humancare_dev', calls), skipDotenv: true, signals: false, keepAlive: true, exit() {} });
  t.mock.timers.tick(10 * 60 * 1000); // ten minutes: ten interval periods of the job (intervalMs is 60 s)
  assert.strictEqual(jobRuns, 0, 'the scan/approval job must not run, on start or on its interval');
  await result.stop();
  assert.deepStrictEqual(calls.map((c) => c[0]), ['$queryRaw', '$disconnect']);
});

test('readiness-only worker: the wrong database (or any error) refuses to start, runs no job and creates no runner', async (t) => {
  Object.assign(process.env, { SYNTHETIC_E2E_AUTO_APPROVE: 'true', SYNTHETIC_E2E_SECRET: 's'.repeat(40), NODE_ENV: 'development' });
  for (const prisma of [strictPrisma('humancare_test', []), { $queryRaw: async () => { throw new Error('boom'); }, $disconnect: async () => {} }]) {
    let runners = 0; const exits = [];
    const result = await worker.main({ argv: ['node', 'w.js', '--readiness-only'], prisma, skipDotenv: true, signals: false, keepAlive: false, createJobRunner: () => { runners += 1; }, exit: (c) => exits.push(c) });
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(exits, [1]);
    assert.strictEqual(runners, 0);
  }
});

test('readiness-only worker: the flag is the ONLY thing that selects it, and the job definition (scan, run on start, 60 s) is untouched', () => {
  assert.strictEqual(worker.isReadinessOnly(['node', 'w.js']), false);
  assert.strictEqual(worker.isReadinessOnly(['node', 'w.js', '--readiness-only']), true);
  assert.strictEqual(worker.isReadinessOnly(['node', '--readiness-only', 'w.js']), false, 'node\'s own arguments are not the worker\'s');
  assert.deepStrictEqual(worker.JOBS.map((j) => j.name), ['scan-request-documents']);
  assert.strictEqual(worker.JOBS[0].runOnStart, true);
  assert.strictEqual(worker.JOBS[0].intervalMs, 60 * 1000);
  const src = fs.readFileSync(path.join(BACKEND, 'src', 'synthetic-e2e-worker.js'), 'utf8');
  const readiness = src.indexOf('if (isReadinessOnly(argv))');
  const runner = src.indexOf('createJobRunner(JOBS)');
  assert.ok(readiness > 0 && runner > readiness, 'the readiness-only branch must return before the job runner is created');
  const branch = src.slice(readiness, src.indexOf('const createJobRunner'));
  assert.ok(/return \{ readinessOnly: true/.test(branch) && !/runner|JOBS\[|\.run\(/.test(branch));
});

test('normal worker behaviour is unchanged: without the flag the runner IS created and started (with a fake runner here, so no job runs)', async () => {
  Object.assign(process.env, { SYNTHETIC_E2E_AUTO_APPROVE: 'true', SYNTHETIC_E2E_SECRET: 's'.repeat(40), NODE_ENV: 'development' });
  const events = [];
  const calls = [];
  await worker.main({
    argv: ['node', 'w.js'], prisma: strictPrisma('humancare_dev', calls), skipDotenv: true, signals: false,
    createJobRunner: (jobs) => { events.push(['create', jobs.map((j) => j.name)]); return { start: () => events.push(['start']), stop: async () => {} }; }, exit() {},
  });
  assert.deepStrictEqual(events, [['create', ['scan-request-documents']], ['start']]);
});

test('the orchestrator passes --readiness-only to the worker only in gate-only mode (pure argument list)', () => {
  const entry = childEnv.WORKER_ENTRY;
  assert.deepStrictEqual(processManager.buildSpawnArgs({ entry }).slice(-1), [entry]);
  assert.deepStrictEqual(processManager.buildSpawnArgs({ entry, extraArgs: [processManager.READINESS_ONLY_FLAG] }).slice(-2), [entry, '--readiness-only']);
  assert.strictEqual(processManager.buildSpawnArgs({ entry })[0], '--require', 'the egress guard is always loaded first');
  assert.ok(processManager.READY_READINESS_ONLY_WORKER.test(worker.READINESS_MESSAGE));
  assert.ok(!processManager.READY_READINESS_ONLY_WORKER.test('[synthetic-e2e-worker] Started jobs: scan-request-documents'), 'a worker that started jobs must never count as ready in gate-only mode');
});

// ======================================================================================================================
// 3. --reuse-web-build
// ======================================================================================================================
test('reuse: a valid, verified export is accepted without rebuilding, clearing anything, or modifying a single file', async () => {
  const dirPath = goodBundle();
  const before = snapshot(dirPath);
  let exports = 0;
  const { outDir, bundle } = await webBuild.prepareBundle({ runDir: tmp(), reuseDir: dirPath, exporter: async () => { exports += 1; } });
  assert.strictEqual(exports, 0);
  assert.strictEqual(bundle.reused, true);
  assert.strictEqual(bundle.apiUrl, 'http://localhost:4400');
  assert.strictEqual(fs.realpathSync(outDir), fs.realpathSync(dirPath));
  assert.ok(bundle.matchedFiles.length === 1 && bundle.builtAt);
  assert.deepStrictEqual(snapshot(dirPath), before);
});

test('reuse: without a directory the bundle is exported fresh (exactly once) into the run folder and verified', async () => {
  let exports = 0; const runDir = tmp();
  const { outDir, bundle } = await webBuild.prepareBundle({ runDir, exporter: async ({ outDir: o }) => { exports += 1; write(o, 'index.html', 'x'); write(o, '_expo/static/js/web/e.js', GOOD_JS); } });
  assert.strictEqual(exports, 1);
  assert.strictEqual(outDir, path.join(runDir, 'web-dist'));
  assert.strictEqual(bundle.reused, false);
});

const REJECTED = [
  ['a directory that does not exist', () => path.join(tmp(), 'nope'), 'bundle_missing'],
  ['a path that is a file, not a directory', () => { const d = tmp(); write(d, 'f.txt', 'x'); return path.join(d, 'f.txt'); }, 'reuse_dir_not_directory'],
  ['an empty directory', () => tmp(), 'bundle_empty'],
  ['a bundle built for the NORMAL API (port 4000)', () => { const d = tmp(); write(d, 'index.html', 'x'); write(d, 'a.js', 'var API="http://localhost:4000";'); return d; }, 'bundle_api_url_missing'],
  ['a bundle for port 44001 (the URL must be EXACTLY :4400)', () => { const d = tmp(); write(d, 'index.html', 'x'); write(d, 'a.js', 'var API="http://localhost:44001";'); return d; }, 'bundle_api_url_missing'],
  ['a bundle for another host', () => { const d = tmp(); write(d, 'index.html', 'x'); write(d, 'a.js', 'var API="http://example.test:4400";'); return d; }, 'bundle_api_url_missing'],
  ['a bundle that also names port 4100', () => { const d = tmp(); write(d, 'index.html', 'x'); write(d, 'a.js', 'a="http://localhost:4400"; b="http://localhost:4100/pay"'); return d; }, 'bundle_names_forbidden_port'],
  ['a bundle with no index.html', () => { const d = tmp(); write(d, 'a.js', GOOD_JS); return d; }, 'bundle_files_missing'],
  ['an unexpanded %TEMP% path', () => '%TEMP%\\hc-web-verify', 'reuse_dir_unexpanded'],
  ['an empty path', () => '', 'reuse_dir_missing'],
  ['the mobile app source directory', () => path.join(webBuild.MOBILE_ROOT, 'src'), 'reuse_dir_in_source'],
  ['the mobile app root', () => webBuild.MOBILE_ROOT, 'reuse_dir_in_source'],
  ['the backend source directory', () => path.join(BACKEND, 'src'), 'reuse_dir_in_source'],
];
for (const [title, make, code] of REJECTED) {
  test(`reuse is REJECTED for ${title}`, async () => {
    let exports = 0;
    await assert.rejects(webBuild.prepareBundle({ runDir: tmp(), reuseDir: make(), exporter: async () => { exports += 1; } }), { code });
    assert.strictEqual(exports, 0, 'a rejected reuse must not silently fall back to a rebuild');
  });
}

test('reuse: a stale-bundle rejection tells the operator to ask before clearing any shared cache, and nothing is cleared', async () => {
  const d = tmp(); write(d, 'index.html', 'x'); write(d, 'a.js', 'var API="http://localhost:4000";');
  await assert.rejects(webBuild.prepareBundle({ runDir: tmp(), reuseDir: d }), (e) => /Ask the operator before clearing any shared cache/.test(e.message));
});

test('reuse never touches Expo, Metro or the mobile app: no export argument list is built and no --clear exists anywhere', () => {
  const src = fs.readFileSync(path.join(dir, 'webBuild.js'), 'utf8');
  const reuse = src.slice(src.indexOf('function assertReusableDirectory'), src.indexOf('const MIME'));
  assert.ok(!/spawn|runExport\(|exportArgs|--clear|writeFile|appendFile|mkdir|copyFile|rename|unlink|rmSync/.test(reuse.replace(/exporter\(\{ outDir, log \}\)/, '').replace(/\/\/.*$/gm, '').replace(/runExport \}/, '')));
  assert.ok(!webBuild.exportArgs('x').includes('--clear'));
});

// ======================================================================================================================
// 4. the API never holds the synthetic approval secret
// ======================================================================================================================
test('API secret: the API child environment carries NO synthetic secret even though backend/.env has one; the worker keeps it', () => {
  const build = (role) => childEnv.buildChildEnv({ role, envFileValues: FAKE_ENV_FILE, policy: createPolicy({}), evidenceFile: 'x', databaseOfUrl, requiredDatabase: LIMITS.DATABASE });
  const apiEnv = build('api');
  assert.strictEqual(apiEnv.SYNTHETIC_E2E_SECRET, '');
  assert.ok(!JSON.stringify(apiEnv).includes(FAKE_ENV_FILE.SYNTHETIC_E2E_SECRET), 'the secret value appears nowhere in the API environment');
  assert.strictEqual(build('worker').SYNTHETIC_E2E_SECRET, FAKE_ENV_FILE.SYNTHETIC_E2E_SECRET);
  assert.deepStrictEqual(childEnv.childEnvProblems(apiEnv, 'api'), []);
});

test('API secret: a NON-EMPTY secret in the API environment is rejected by the orchestrator validator and by the API\'s own start-up check', () => {
  const env = childEnv.buildChildEnv({ role: 'api', envFileValues: FAKE_ENV_FILE, policy: createPolicy({}), evidenceFile: 'x', databaseOfUrl, requiredDatabase: LIMITS.DATABASE });
  const leaked = { ...env, SYNTHETIC_E2E_SECRET: 'z'.repeat(40) };
  assert.ok(childEnv.childEnvProblems(leaked, 'api').includes('synthetic_secret_present_in_api'));
  const original = Object.getOwnPropertyDescriptor(net.Socket.prototype.connect, 'name');
  Object.defineProperty(net.Socket.prototype.connect, 'name', { value: 'guardedConnect', configurable: true });
  try {
    assert.deepStrictEqual(apiEntry.apiConfigurationProblems(env), []);
    assert.ok(apiEntry.apiConfigurationProblems(leaked).includes('synthetic_secret_present_in_api'));
    assert.ok(apiEntry.apiConfigurationProblems({ ...env, SYNTHETIC_E2E_SECRET: ' ' }).includes('synthetic_secret_present_in_api'), 'even a whitespace value is not "blank"');
    // and the API refuses to start: assertApiSafeToRun throws before it would ever listen
    return assert.rejects(apiEntry.assertApiSafeToRun({ $queryRaw: async () => [{ db: 'humancare_dev' }] }, leaked), /synthetic_secret_present_in_api/);
  } finally {
    Object.defineProperty(net.Socket.prototype.connect, 'name', original);
  }
});

test('the gate-only report object type exists and has exactly the documented sections', () => {
  const r = reportLib.buildGateReport({ runId: 'x', startedAt: 'now', isolation: { gate: [{ name: 'a', ok: true }] } });
  assert.deepStrictEqual(Object.keys(r).sort(), ['completedAt', 'executed', 'failures', 'gate', 'isolation', 'mode', 'networkIsolationLimitations', 'notExecuted', 'outcome', 'preflight', 'runId', 'startedAt'].sort());
  assert.strictEqual(r.outcome, 'gate_passed');
  assert.strictEqual(reportLib.buildGateReport({ runId: 'x', startedAt: 'now', isolation: { gate: [{ name: 'a', ok: false }] } }).outcome, 'gate_failed');
  assert.strictEqual(reportLib.buildGateReport({ runId: 'x', startedAt: 'now', isolation: null }).outcome, 'gate_failed');
});
