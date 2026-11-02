// Background worker: `npm run start:worker`. Runs the scheduled jobs in src/jobs as their
// own process, separate from the API (server.js) and never importing the Express app.
// It must run on the same host as the API for now: the Bitrix retry reads uploaded medical
// reports from backend/uploads. Run exactly one worker — the retry has no claim on a row,
// so two workers could create the same Bitrix lead twice.
//
// dotenv first: some modules read their settings at import time (bitrix.service.js).
require('dotenv').config();

const { prisma } = require('./db/prisma');
const { createJobRunner } = require('./jobs/job-runner');
const { jobs } = require('./jobs');

const runner = createJobRunner(jobs);
let shuttingDown = false;

// SIGTERM (process manager) and SIGINT (Ctrl+C): no new runs, let a run in progress
// finish, then close the database connection. A second signal exits immediately.
async function shutdown(signal) {
  if (shuttingDown) {
    console.error(`[worker] ${signal} received again, exiting without waiting.`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[worker] ${signal} received, waiting for running jobs to finish.`);

  let exitCode = 0;
  try {
    await runner.stop();
  } catch (err) {
    exitCode = 1;
    console.error('[worker] Error while stopping jobs:', err.message);
  }
  try {
    await prisma.$disconnect();
  } catch (err) {
    exitCode = 1;
    console.error('[worker] Error while closing the database connection:', err.message);
  }
  console.log('[worker] Stopped.');
  process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  runner.start();
  console.log(`[worker] Started jobs: ${jobs.map((job) => job.name).join(', ')}`);
} catch (err) {
  console.error('[worker] Could not start:', err.message);
  prisma.$disconnect().finally(() => process.exit(1));
}
