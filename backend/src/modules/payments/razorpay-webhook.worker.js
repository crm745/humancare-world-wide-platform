// The scheduled entry point of the Razorpay webhook inbox worker: ONE pass = the gates, then processBatch (recover expired leases, claim due Razorpay
// events, apply each in its own transaction). All payment rules live in razorpay-webhook.processor.js and razorpay-payment.store.js; the claim, lease, retry
// and fenced-result rules live in razorpay-webhook.inbox.store.js. This file only decides WHETHER to run and reports safely. It never calls Razorpay.
//
// GATES (all read from the environment at call time, nothing cached), in this order. Any failure means NOTHING is processed and the database is not touched:
//   PAYMENTS_ENABLED          exactly "true"
//   PAYMENTS_ENVIRONMENT_ID   present and valid
//   RAZORPAY_WEBHOOK_SECRET   present, valid and SEPARATE from RAZORPAY_KEY_SECRET
// The API credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are deliberately NOT required: the worker never calls the Razorpay API.
// Events simply stay in the inbox until the configuration is right; nothing is lost.
//
// SAFE REPORTING: the only things this file ever logs or returns about a problem are the fixed codes below (a short lowercase code from our own configuration
// checks) and event COUNTS. A secret, a payload, an id or an exception message is never written. An exception from a pass is not caught here: it goes to the
// job runner, which logs the job name and a safe error code only (see jobs/job-runner.js).
//
// ONE AT A TIME: the job runner already skips a tick while the job is still running; this module adds its own guard so a pass can never overlap another pass
// in the same process however it is invoked. Run exactly one worker process (worker.js); across processes the inbox claim and lease keep two workers from
// ever applying the same event.
const crypto = require('crypto');
const { isPaymentsEnabled } = require('./razorpay-config');
const { webhookConfigProblem } = require('./razorpay-webhook.config');
const processor = require('./razorpay-webhook.processor');

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

// The reason the worker will not run, or null when it may. A fixed code only: never a value.
function workerGateProblem(env = process.env) {
  if (!isPaymentsEnabled(env)) return 'payments_disabled';
  const problem = webhookConfigProblem(env);
  if (problem === null) return null;
  return typeof problem === 'string' && SAFE_CODE.test(problem) ? problem : 'configuration_invalid';
}

// A safe status for an operator or a health check: { active, code } where code is null when active.
function workerStatus(env = process.env) {
  const code = workerGateProblem(env);
  return { active: code === null, code };
}

// A worker id that is unique to this process and valid for the inbox lease (letters, digits and . _ : - only, at most 64).
let cachedWorkerId = null;
function workerId() {
  if (!cachedWorkerId) cachedWorkerId = `rzp-wh-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  return cachedWorkerId;
}

let running = false; // one pass at a time within this process
let lastReported; // the last status code that was logged: the status is logged when it CHANGES, not every ten seconds

function report(logger, code) {
  if (code === lastReported) return;
  lastReported = code;
  if (code === null) logger.log('[razorpay-webhook] worker active.');
  else logger.warn(`[razorpay-webhook] not processing events: ${code}.`);
}

/**
 * One scheduled pass. Resolves { active, code } when the gates are closed, { active: true, skipped: 'already_running' } when a pass is in progress, or
 * { active: true, ...tally } (counts only) after a pass. Database errors propagate to the job runner.
 * Options exist for tests: env, db (a Prisma client), logger, deps (passed to the processor), limit.
 */
async function runRazorpayWebhookWorker({ env = process.env, db, logger = console, deps, limit } = {}) {
  const code = workerGateProblem(env);
  report(logger, code);
  if (code !== null) return { active: false, code };

  if (running) return { active: true, skipped: 'already_running' };
  running = true;
  try {
    const client = db || require('../../db/prisma').prisma; // loaded only when a pass really runs
    const tally = await processor.processBatch(client, { workerId: workerId(), env, ...(limit && { limit }), ...(deps && { deps }) });
    if (tally.claimed > 0) {
      const counts = ['claimed', 'processed', 'ignored', 'received', 'failed', 'lease_lost', 'unrecorded']
        .map((key) => `${key}=${Number.isSafeInteger(tally[key]) ? tally[key] : 0}`).join(' ');
      logger.log(`[razorpay-webhook] pass: ${counts}`);
    }
    return { active: true, ...tally };
  } finally {
    running = false;
  }
}

// For tests only: forgets the logged status and the process-wide state.
function resetForTests() { running = false; lastReported = undefined; cachedWorkerId = null; }

module.exports = { runRazorpayWebhookWorker, workerStatus, workerGateProblem, workerId, resetForTests };
