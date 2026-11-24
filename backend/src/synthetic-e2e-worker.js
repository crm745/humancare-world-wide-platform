// Dedicated, isolated background worker for the HumanCare synthetic E2E approval workflow.
//
// Schedules exactly ONE job: the EXISTING scan-request-documents job (src/jobs/scan-request-documents.job.js),
// unchanged, on its own unchanged schedule (on startup, then every 60 seconds). That job already does two things,
// neither altered by this file: it scans due request documents with ClamAV, and (inert unless configured) calls
// sweepSyntheticApprovals(), which carries every synthetic-E2E safeguard itself - marker signature, claim/fencing,
// retry spacing, failure limit, expiry (see src/common/safety/synthetic-e2e-marker.js and
// src/modules/request-review/synthetic-approval.js). This file adds nothing to that logic; it only decides what
// runs in THIS process, and refuses to start it at all unless the synthetic-E2E configuration is safely in place.
//
// It is NOT src/worker.js and never requires it. It never requires src/jobs/index.js (the full job list) either:
// only src/jobs/scan-request-documents.job.js is required, so no Bitrix, payment, invoice, quotation,
// security-log-purge or admin-audit-purge job can ever start in this process, whatever src/jobs/index.js lists.
//
// dotenv is loaded inside main() only, never at module scope, so this file can be required (for its pure,
// testable exports) without ever reading the real backend/.env - the same convention as scripts/synthetic-mark.js
// and scripts/synthetic-approve.js.
//
//   npm run start:worker:synthetic-e2e

const { LIMITS, databaseOfUrl, secretOf } = require('./common/safety/synthetic-e2e-marker');
const scanRequestDocumentsJob = require('./jobs/scan-request-documents.job');

// The only job this process ever schedules.
const JOBS = [scanRequestDocumentsJob];

// Every configuration problem that can be decided WITHOUT touching the database. Pure; returns short codes, empty
// when all of these pass (the live database identity is still checked separately by confirmDatabase()).
function configurationProblems(env = process.env) {
  const problems = [];
  if (env.SYNTHETIC_E2E_AUTO_APPROVE !== 'true') problems.push('auto_approve_disabled');
  if (env.NODE_ENV === 'production') problems.push('production_refused');
  if (!secretOf(env)) problems.push('secret_missing');
  if (databaseOfUrl(env.DATABASE_URL) !== LIMITS.DATABASE) problems.push('database_not_identified');
  return problems;
}

// The one check that needs the database itself: the server must confirm it is humancare_dev, exactly as the
// approval engine does before it ever touches a request (synthetic-approval.js's confirmDatabase).
async function confirmDatabase(prisma) {
  try {
    const rows = await prisma.$queryRaw`SELECT DATABASE() AS db`;
    return Boolean(rows && rows[0] && rows[0].db === LIMITS.DATABASE);
  } catch {
    return false;
  }
}

// Fails closed: throws (naming every problem) unless every required safety check holds.
async function assertSafeToRun(prisma, env = process.env) {
  const problems = configurationProblems(env);
  if (!problems.length && !(await confirmDatabase(prisma))) problems.push('database_not_identified');
  if (problems.length) throw Object.assign(new Error(`refused: ${problems.join(', ')}`), { problems });
}

// Readiness-only mode (`--readiness-only`), used by the synthetic E2E orchestrator's --gate-only check: the worker validates
// its configuration, opens its Prisma connection and confirms SELECT DATABASE() = humancare_dev - exactly the checks above - and
// then stays IDLE. It never creates the job runner, so nothing is scheduled: no run-on-start run, no interval, no scan, no
// approval sweep. The normal path below is unchanged.
const READINESS_ONLY_FLAG = '--readiness-only';
const READINESS_MESSAGE = 'Readiness only: configuration and database identity (humancare_dev) confirmed; no job is scheduled or run.';
const isReadinessOnly = (argv = process.argv) => argv.slice(2).includes(READINESS_ONLY_FLAG);

// `deps` exists for the unit tests (a fake Prisma, a spy job runner, no dotenv, no signal handlers, no real exit).
async function main(deps = {}) {
  const argv = deps.argv || process.argv;
  const exit = deps.exit || ((code) => process.exit(code));
  // dotenv first: db/prisma and the job's own dependencies read their settings at require time.
  if (!deps.skipDotenv) require('dotenv').config();
  const prisma = deps.prisma || require('./db/prisma').prisma;

  try {
    await assertSafeToRun(prisma);
  } catch (err) {
    console.error(`[synthetic-e2e-worker] Could not start: ${err.message}`);
    await prisma.$disconnect().catch(() => undefined);
    exit(1);
    return undefined;
  }

  if (isReadinessOnly(argv)) {
    console.log(`[synthetic-e2e-worker] ${READINESS_MESSAGE}`);
    const keepAlive = deps.keepAlive === false ? null : setInterval(() => {}, 60 * 1000); // idle only; runs no job
    const stop = async () => {
      if (keepAlive) clearInterval(keepAlive);
      await prisma.$disconnect().catch(() => undefined);
      exit(0);
    };
    if (deps.signals !== false) {
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    }
    return { readinessOnly: true, stop };
  }

  const createJobRunner = deps.createJobRunner || require('./jobs/job-runner').createJobRunner;
  const runner = createJobRunner(JOBS);
  let shuttingDown = false;

  // SIGTERM (process manager) and SIGINT (Ctrl+C): no new runs, let a run in progress finish, then close the
  // database connection. A second signal exits immediately. Same shape as src/worker.js.
  async function shutdown(signal) {
    if (shuttingDown) {
      console.error(`[synthetic-e2e-worker] ${signal} received again, exiting without waiting.`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`[synthetic-e2e-worker] ${signal} received, waiting for the running job to finish.`);

    let exitCode = 0;
    try {
      await runner.stop();
    } catch (err) {
      exitCode = 1;
      console.error('[synthetic-e2e-worker] Error while stopping the job:', err.message);
    }
    try {
      await prisma.$disconnect();
    } catch (err) {
      exitCode = 1;
      console.error('[synthetic-e2e-worker] Error while closing the database connection:', err.message);
    }
    console.log('[synthetic-e2e-worker] Stopped.');
    process.exit(exitCode);
  }

  if (deps.signals !== false) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  try {
    runner.start();
    console.log(`[synthetic-e2e-worker] Started jobs: ${JOBS.map((job) => job.name).join(', ')}`);
  } catch (err) {
    console.error('[synthetic-e2e-worker] Could not start:', err.message);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[synthetic-e2e-worker] Unexpected error:', err.message);
    process.exit(1);
  });
}

module.exports = { JOBS, READINESS_ONLY_FLAG, READINESS_MESSAGE, isReadinessOnly, configurationProblems, confirmDatabase, assertSafeToRun, main };
