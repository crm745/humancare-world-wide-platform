// Dedicated background worker for PATIENT PUSH DELIVERY: `npm run start:worker:push`.
//
// It schedules exactly TWO jobs, both existing and unchanged, each on its own schedule and never on start:
//   * push-delivery (src/jobs/push-delivery.job.js), every 15 seconds: all delivery logic (claiming, re-checks, TTL, retries, receipts, the Expo
//     authentication pause, monitoring) stays in that job's service;
//   * case-stage-notification-reconcile (src/jobs/case-stage-notification-reconcile.job.js), every 3 minutes: creates the patient notification of an admin
//     case stage change whose notification step failed (in-app notification and its push deliveries, idempotent; see its module).
// This file only decides what runs in THIS process.
//
// Why a process of its own: src/worker.js refuses to start at all when the Bitrix24 settings are invalid, which would also stop push delivery. This process
// has no such dependency: it never loads the Bitrix configuration check, never requires src/worker.js and never requires src/jobs/index.js (the main job
// list), so no Bitrix, payment, invoice, quotation or scanning job can start here, and a Bitrix settings problem cannot stop it.
//
// This process is the ONLY scheduler of both jobs: neither is in src/jobs/index.js, so src/worker.js does not start them. Run exactly ONE
// of these (like the main worker: the delivery rows are fenced, so a second copy would not send twice, but each copy keeps its own Expo credential
// state and monitoring). A second start inside the same process is refused.
//
// Safety is unchanged and decided by the job itself, on every run: push delivery stays OFF unless PUSH_DELIVERY_ENABLED is exactly "true" and a valid Expo
// access token is configured, and it never runs in a test, scoped, integration or synthetic run. Starting this process builds no Expo client, makes no
// network call and reads no database: the job first runs 15 seconds after start, and does nothing at all while delivery is off.
//
// dotenv is loaded inside main() only, so this file can be required (by the tests) without reading the real backend/.env.
// `deps` exists for the unit tests: { skipDotenv, prisma, job, reconcileJob, createJobRunner, logStartup, log, exit, signals: false }.

const JOB_NAME = 'push-delivery';
let instance = null;

function main(deps = {}) {
  if (instance) return instance; // one scheduler per process
  // dotenv first: the database client and the job's own dependencies read their settings when they are loaded.
  if (!deps.skipDotenv) require('dotenv').config();

  const log = deps.log || console;
  const exit = deps.exit || ((code) => process.exit(code));
  const prisma = deps.prisma || require('./db/prisma').prisma;
  const job = deps.job || require('./jobs/push-delivery.job');
  const reconcileJob = deps.reconcileJob || require('./jobs/case-stage-notification-reconcile.job');
  const jobs = [job, reconcileJob];
  const createJobRunner = deps.createJobRunner || require('./jobs/job-runner').createJobRunner;
  const logStartup = deps.logStartup || require('./modules/notifications/push-delivery.monitor').logStartup;

  const runner = createJobRunner(jobs);
  let shuttingDown = false;

  // SIGTERM (process manager) and SIGINT (Ctrl+C): no new runs, let a run in progress finish, then close the database connection.
  // A second signal exits immediately. Same shape as src/worker.js.
  async function shutdown(signal) {
    if (shuttingDown) {
      log.error(`[push-worker] ${signal} received again, exiting without waiting.`);
      exit(1);
      return;
    }
    shuttingDown = true;
    log.log(`[push-worker] ${signal} received, waiting for the running job to finish.`);

    let exitCode = 0;
    try {
      await runner.stop();
    } catch (err) {
      exitCode = 1;
      log.error('[push-worker] Error while stopping the job:', err.message);
    }
    try {
      await prisma.$disconnect();
    } catch (err) {
      exitCode = 1;
      log.error('[push-worker] Error while closing the database connection:', err.message);
    }
    log.log('[push-worker] Stopped.');
    exit(exitCode);
  }

  if (deps.signals !== false) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  instance = { runner, shutdown, jobNames: jobs.map((j) => j.name) };
  try {
    runner.start();
    log.log(`[push-worker] Started jobs: ${jobs.map((j) => j.name).join(', ')}`);
    // One line saying whether delivery will run and, if not, why (flags and codes only: no client is built, nothing is sent, no secret is printed).
    try { logStartup({ log }); } catch { /* the status line must never stop the worker */ }
  } catch (err) {
    log.error('[push-worker] Could not start:', err.message);
    Promise.resolve(prisma.$disconnect()).catch(() => undefined).finally(() => exit(1));
  }
  return instance;
}

const resetForTests = () => { instance = null; };

if (require.main === module) main();

module.exports = { main, resetForTests, JOB_NAME };
