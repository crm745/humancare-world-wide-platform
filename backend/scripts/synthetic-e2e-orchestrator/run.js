#!/usr/bin/env node
// HumanCare Synthetic E2E Test Orchestrator — entry point. See README.md in this folder.
//
//   node scripts/synthetic-e2e-orchestrator/run.js [--headless] [--reuse-web-build <dir>]
//   node scripts/synthetic-e2e-orchestrator/run.js --gate-only [--reuse-web-build <dir>]   (isolation gate only: no phone lock, browser or patient)
//   node scripts/synthetic-e2e-orchestrator/run.js --recover                       (terminate this tool's own orphaned processes only)
//   node scripts/synthetic-e2e-orchestrator/run.js --cleanup <runId> [--apply]     (dry-run unless --apply)
//
// It orchestrates; it re-implements nothing: approval is the existing synthetic approval engine run by the existing
// dedicated worker (src/synthetic-e2e-worker.js); the marker is issued by the existing scripts/synthetic-mark.js.
//
// Isolation (see isolation.js): the orchestrator starts its OWN API (port 4400, entry src/synthetic-e2e-api.js), its OWN
// dedicated worker and its OWN web build (port 8481), each under an in-process egress guard, with Bitrix off and every
// Bitrix/SMTP/payment credential blank. It never attaches to or stops the normal dev API/Expo server or the payment E2E
// runner (port 4100). Fail closed: any unmet safety prerequisite aborts BEFORE a patient account exists, and everything it
// started is stopped in `finally` and on SIGINT/SIGTERM. No Windows Firewall rule is ever created.
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const ORCH_DIR = __dirname;
const BACKEND_ROOT = path.resolve(ORCH_DIR, '..', '..');
const RUNS_DIR = path.join(BACKEND_ROOT, '.synthetic-e2e-runs');
const LOCKS_DIR = path.join(RUNS_DIR, '.phone-locks');
const PHONE_POOL = path.join(ORCH_DIR, 'phone-pool.local.json');

const REMOVED_OPTIONS = ['--spawn-worker', '--web-url', '--api-url'];

function parseArgs(argv) {
  const o = { headless: false, recover: false, cleanup: null, apply: false, gateOnly: false, reuseWebBuild: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--headless') o.headless = true;
    else if (a === '--recover') o.recover = true;
    else if (a === '--cleanup') o.cleanup = argv[++i];
    else if (a === '--apply') o.apply = true;
    else if (a === '--gate-only') o.gateOnly = true;
    else if (a === '--reuse-web-build') {
      o.reuseWebBuild = argv[++i];
      if (!o.reuseWebBuild || o.reuseWebBuild.startsWith('--')) throw new Error('--reuse-web-build needs a directory');
    } else if (REMOVED_OPTIONS.includes(a)) throw new Error(`${a} was removed: the orchestrator always runs its own isolated API (port 4400), worker and web build (port 8481)`);
    else throw new Error(`unknown option ${a}`);
  }
  if (o.gateOnly && (o.recover || o.cleanup || o.apply)) throw new Error('--gate-only cannot be combined with --recover, --cleanup or --apply');
  if (o.gateOnly && o.headless) throw new Error('--headless has no meaning with --gate-only (no browser is launched)');
  if (o.reuseWebBuild && (o.recover || o.cleanup)) throw new Error('--reuse-web-build only applies to a run or --gate-only');
  return o;
}

function loadPhonePool() {
  if (!fs.existsSync(PHONE_POOL)) throw new Error('phone-pool.local.json is missing — copy phone-pool.local.json.example and list your Firebase TEST numbers (see README.md)');
  const pool = JSON.parse(fs.readFileSync(PHONE_POOL, 'utf8'));
  if (!pool.testCode || !Array.isArray(pool.numbers) || !pool.numbers.length) throw new Error('phone-pool.local.json needs "testCode" and a non-empty "numbers" array');
  return pool;
}

// DNS only (a name -> address query to the system resolver); no connection to the portal is made. Used once, BEFORE the
// guard is installed, to pin the portal's addresses into the egress policy. Failure is not fatal: the name-based block
// still applies, and a process that cannot resolve the name cannot reach it either.
async function resolvePortalAddresses(host) {
  if (!host) return [];
  const one = (fn) => new Promise((resolve) => { fn(host, (err, addrs) => resolve(err ? [] : addrs)); });
  const [v4, v6] = await Promise.all([one(dns.resolve4), one(dns.resolve6)]);
  return [...new Set([...v4, ...v6])];
}

// The orchestrator itself holds no Bitrix/SMTP/payment credential once the file has been read: they are blanked in its
// own environment so the one child it starts directly (scripts/synthetic-mark.js, DB only) cannot inherit them either.
const BLANK_IN_ORCHESTRATOR = ['BITRIX24_WEBHOOK_URL', 'BITRIX_INBOUND_APPLICATION_TOKEN', 'BITRIX_ALLOWED_PORTAL_HOST', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = require('./config');
  const { createPolicy } = require('./egressPolicy');
  const egressGuard = require('./egressGuard');
  const processManager = require('./processManager');

  if (opts.recover) {
    const processGuard = require('./processGuard');
    const r = processManager.recoverOrphans(RUNS_DIR, 'none', { listNodeProcesses: processGuard.listNodeProcesses });
    console.log(JSON.stringify(r, null, 2));
    return r.skipped.length ? 1 : 0;
  }

  const envFileValues = config.readDotEnvFile(); // read-only
  const { webhookHost } = require('../../src/modules/bitrix/bitrix-config');
  const portalHost = webhookHost(envFileValues.BITRIX24_WEBHOOK_URL);
  const portalAddresses = await resolvePortalAddresses(portalHost);
  const policy = createPolicy({ blockedHosts: portalHost ? [portalHost] : [], blockedIps: portalAddresses });

  require('dotenv').config({ path: config.ENV_FILE }); // read-only; DATABASE_URL for this process's own Prisma
  for (const key of BLANK_IN_ORCHESTRATOR) process.env[key] = '';
  process.env.BITRIX_SYNC_ENABLED = 'false';
  const orchestratorGuard = egressGuard.install({ role: 'orchestrator', policy, allowChildProcess: true, allowWorkerThreads: true });

  const { prisma } = require('../../src/db/prisma');
  try {
    if (opts.cleanup) {
      const { runCleanup } = require('./cleanup');
      const result = await runCleanup(prisma, RUNS_DIR, opts.cleanup, { dryRun: !opts.apply });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    const context = { policy, orchestratorGuard, envFileValues, portalHost, portalAddressCount: portalAddresses.length };
    if (opts.gateOnly) return await runGateOnly(prisma, opts, context);
    return await orchestrate(prisma, opts, context);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

function defaultDeps() {
  const processGuard = require('./processGuard');
  const config = require('./config');
  return {
    runsDir: RUNS_DIR,
    locksDir: LOCKS_DIR,
    loadPhonePool,
    safety: require('./safety'),
    recoverOrphans: (runsDir, runId) => require('./processManager').recoverOrphans(runsDir, runId, { listNodeProcesses: processGuard.listNodeProcesses }),
    runPreflight: config.runPreflight,
    checkGeneralWorkerAbsent: config.checkGeneralWorkerAbsent,
    establishIsolation: require('./isolation').establishIsolation,
    generateSyntheticPdf: require('./fixtures').generateSyntheticPdf,
    removeSyntheticPdf: require('./fixtures').removeSyntheticPdf,
    runJourney: require('./browserJourney').runJourney,
    waitForCleanScan: require('./waitForScan').waitForCleanScan,
    waitForApproval: require('./waitForApproval').waitForApproval,
    resolveEligibleAdminId: require('./adminResolver').resolveEligibleAdminId,
    issueMarker: require('./issueMarker').issueMarker,
    verifyOutcome: require('./verify').verifyOutcome,
    exit: (code) => process.exit(code),
  };
}

// --gate-only: the isolation gate and NOTHING that touches a patient. It deliberately builds its own, minimal dependency set
// (no phone pool, no browser, no fixtures, no scan/approval waiters, no marker, no verification): the code below has no way to
// reach them. It starts the isolated API and a READINESS-ONLY worker, runs the gate, writes gate-report.json, and stops only
// what it started.
function gateOnlyDeps() {
  const processGuard = require('./processGuard');
  return {
    runsDir: RUNS_DIR,
    recoverOrphans: (runsDir, runId) => require('./processManager').recoverOrphans(runsDir, runId, { listNodeProcesses: processGuard.listNodeProcesses }),
    runPreflight: require('./config').runPreflight,
    establishIsolation: require('./isolation').establishIsolation,
    exit: (code) => process.exit(code),
  };
}

async function runGateOnly(prisma, opts, context, overrides = {}) {
  const { generateRunId } = require('./identity');
  const { buildGateReport, writeGateReport } = require('./report');
  const d = { ...gateOnlyDeps(), ...overrides };

  const runId = generateRunId();
  const runDir = path.join(d.runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const failures = [];
  let preflight = null;
  let isolationSummary = null;
  let handle = null;
  const registry = {};
  let stopped = false;
  const log = (m) => console.log(`[${runId}] ${m}`);

  const stopEverything = async () => {
    if (stopped) return;
    stopped = true;
    const stop = handle ? handle.stopAll : registry.stopAll; // a half-started isolation is stopped too
    if (stop) await stop().catch((e) => failures.push(`release error: ${e.message}`));
    log('isolated API, readiness-only worker, proxy and web server stopped');
  };
  const onSignal = () => { stopEverything().finally(() => d.exit(130)); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, onSignal);

  try {
    const rec = d.recoverOrphans(d.runsDir, runId);
    log(`orphan recovery: terminated=${rec.terminated.length} skipped=${rec.skipped.length}`);
    const pre = await d.runPreflight({ prisma });
    preflight = { database: pre.database, portalHostKnown: !!pre.bitrixHost, checks: 'passed' };
    handle = await d.establishIsolation({
      runDir, envFileValues: pre.envFileValues || context.envFileValues, policy: context.policy, orchestratorGuard: context.orchestratorGuard,
      log: console, gateOnly: true, reuseWebBuild: opts.reuseWebBuild || null, stopRegistry: registry,
    });
    isolationSummary = handle.summary();
    log('GATE PASSED: isolation established; no phone lock, browser or patient action was performed');
  } catch (err) {
    failures.push(`${err.name || 'Error'}: ${err.message}`);
    if (err && err.checks) isolationSummary = { gate: err.checks };
    log(`GATE FAILED: ${err.message}`);
  } finally {
    await stopEverything();
    for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig, onSignal);
  }

  const report = buildGateReport({ runId, startedAt, preflight, isolation: isolationSummary, failures });
  const reportPath = writeGateReport(runDir, report);
  log(`outcome: ${report.outcome} — report: ${reportPath}`);
  return { exitCode: report.outcome === 'gate_passed' ? 0 : 1, report, runId };
}

// `deps` exists so the safety ordering can be unit-tested with stubs (tests/isolation/isolation-gate.node-test.js): in
// particular, that when isolation cannot be established the browser journey (which is what registers the patient) is never
// called, and that everything started is released.
async function orchestrate(prisma, opts, context, overrides = {}) {
  const { generateRunId, buildIdentity } = require('./identity');
  const { buildReport, writeReport } = require('./report');
  const d = { ...defaultDeps(), ...overrides };

  const runId = generateRunId();
  const runDir = path.join(d.runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const failures = [];
  const ctx = { preflight: null, submission: null, scan: null, marker: null, approval: null, verification: null, isolation: null, cleanup: null };
  let phoneLock = null;
  let pdfPath = null;
  let handle = null;
  const registry = {};
  let stopped = false;
  const log = (m) => console.log(`[${runId}] ${m}`);

  const stopEverything = async () => {
    if (stopped) return;
    stopped = true;
    const stop = handle ? handle.stopAll : registry.stopAll; // a half-started isolation is stopped too
    if (stop) await stop().catch((e) => failures.push(`release error: ${e.message}`));
    log('isolated API, worker, proxy and web server stopped');
  };
  const onSignal = () => { stopEverything().finally(() => d.exit(130)); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, onSignal);

  try {
    // 1. terminate ONLY this tool's own orphaned processes from a crashed earlier run (never anything else)
    const rec = d.recoverOrphans(d.runsDir, runId);
    log(`orphan recovery: terminated=${rec.terminated.length} skipped=${rec.skipped.length}`);

    // 2. preflight — every gate, before any account exists
    const pre = await d.runPreflight({ prisma });
    ctx.preflight = { database: pre.database, portalHostKnown: !!pre.bitrixHost, checks: 'passed' };

    // 3. isolation: ports, sanitized environments, verified web bundle, guarded API + worker, gate. Fails closed.
    handle = await d.establishIsolation({ runDir, envFileValues: pre.envFileValues || context.envFileValues, policy: context.policy, orchestratorGuard: context.orchestratorGuard, log: console, reuseWebBuild: opts.reuseWebBuild || null, stopRegistry: registry });
    ctx.isolation = handle.summary();
    log('isolation established and the gate passed; no patient account exists yet');

    // 4. synthetic identity + locked Firebase test phone number
    const pool = d.loadPhonePool();
    let phone = null;
    for (const n of pool.numbers) {
      const lock = d.safety.tryAcquirePhoneLock(d.locksDir, n, runId);
      if (lock) { phoneLock = lock; phone = n; break; }
    }
    if (!phone) throw new Error('every phone number in the pool is locked by another run');
    const identity = buildIdentity(runId, phone);
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ runId, startedAt, identity: { patientName: identity.patientName, email: identity.email }, phoneLock: path.basename(phoneLock) }, null, 2));
    pdfPath = await d.generateSyntheticPdf({ runId, outDir: runDir });

    // 5. the real browser journey (through the isolated web build, the isolated API and the filtering proxy)
    const submission = await d.runJourney({
      webUrl: handle.web.url, identity, phone, testCode: pool.testCode, pdfPath, runDir, egress: handle.egress, headless: opts.headless, log,
    });
    d.safety.assertNotProtected(submission.requestId);
    ctx.submission = submission;
    log(`request submitted: id=${submission.requestId}`);

    const request = await prisma.serviceRequest.findUnique({ where: { id: submission.requestId }, select: { id: true, userId: true, user: { select: { email: true } } } });
    if (!request || request.user.email !== identity.email) throw new Error('the submitted request is not owned by this run\'s synthetic account — refusing to continue');

    // 6. wait for malware scan; re-check isolation each tick
    const guardTick = async () => {
      d.checkGeneralWorkerAbsent();
      const v = handle.isolationCheck();
      if (!v.ok) throw new Error(`network isolation lost mid-run: ${v.problems.join('; ')}`);
    };
    ctx.scan = await d.waitForCleanScan(prisma, submission.requestId, { onTick: guardTick });

    // 7. signed synthetic marker (existing script) -> existing engine approves via the dedicated worker
    const adminId = await d.resolveEligibleAdminId(prisma);
    ctx.marker = d.issueMarker({ requestId: submission.requestId, ownerId: request.userId, adminId, runId, documents: ctx.scan.length });
    ctx.approval = await d.waitForApproval(prisma, submission.requestId, { onTick: guardTick });

    // 8. authoritative read-only verification (includes a final isolation re-check)
    ctx.verification = await d.verifyOutcome(prisma, { requestId: submission.requestId, runId, isolationCheck: handle.isolationCheck });
    if (!ctx.verification.ok) failures.push(`verification failed: ${ctx.verification.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
  } catch (err) {
    failures.push(`${err.name || 'Error'}: ${err.message}`);
    log(`ABORTED: ${err.message}`);
  } finally {
    if (handle) { try { ctx.isolation = handle.summary(); } catch { /* keep the earlier summary */ } }
    await stopEverything();
    if (phoneLock) d.safety.releasePhoneLock(phoneLock, runId);
    if (pdfPath) d.removeSyntheticPdf(pdfPath);
    for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig, onSignal);
  }

  ctx.cleanup = { note: `not run automatically; to review: node scripts/synthetic-e2e-orchestrator/run.js --cleanup ${runId}` };
  const report = buildReport({ runId, startedAt, ...ctx, failures });
  const reportPath = writeReport(runDir, runId, report);
  log(`outcome: ${report.overallOutcome} — report: ${reportPath}`);
  return { exitCode: report.overallOutcome === 'passed' ? 0 : 1, report, runId };
}

if (require.main === module) {
  main().then((code) => process.exit(typeof code === 'object' ? code.exitCode : code), (err) => { console.error(`fatal: ${err.message}`); process.exit(2); });
}

module.exports = { parseArgs, loadPhonePool, orchestrate, runGateOnly, resolvePortalAddresses, RUNS_DIR };
