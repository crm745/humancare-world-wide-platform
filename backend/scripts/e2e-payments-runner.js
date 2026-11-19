// The isolated Razorpay TEST MODE runner: the HTTP API plus ONLY the Razorpay webhook inbox job, against humancare_test, on this machine.
//
//   node scripts/e2e-payments-runner.js            CHECK: validates everything and says READY or names the problem codes; starts nothing
//   node scripts/e2e-payments-runner.js --run      starts the API on http://localhost:<PORT from .env.test> and the Razorpay worker (every 10 s)
//
// NOT src/server.js and NOT src/worker.js: those load the development .env and (the worker) run every scheduled job, Bitrix included. This runner:
//   - loads backend/.env.test ONLY (e2e-env.js) and forces BOTH Bitrix switches off in memory (the file is never read for writing, never changed)
//   - refuses unless DATABASE_URL names humancare_test on this machine, the database SERVER confirms it (account confined to humancare_test, loopback, the
//     URL's port) and the payment configuration is complete and in TEST MODE (rzp_test_ key, PAYMENTS_ENABLED=true, an environment id, a webhook secret)
//   - while running, holds the session lock, so an ordinary Jest run (which EMPTIES every table of humancare_test) cannot start and destroy seeded data
//   - starts no job but razorpay-webhook-inbox; no Bitrix, scan, purge or order-recovery job. The order endpoint and the worker call no one except Razorpay's
//     order API (when a patient taps Pay); the webhook receiver is POST /integrations/razorpay/webhook
// It prints configuration STATUS only (fixed codes): never a key, secret, signature, payload or personal data.
const { buildPaymentsRunnerEnv, runnerProblems } = require('./lib/e2e-payments-runner');

async function main(argv) {
  const run = argv.includes('--run');
  const unknown = argv.filter((a) => a !== '--run');
  if (unknown.length) throw Object.assign(new Error('unknown argument'), { code: 'unknown_argument' });

  const env = buildPaymentsRunnerEnv(); // validates the URL, mail and uploads rules or throws, before anything else
  Object.assign(process.env, env);

  const problems = runnerProblems(env);
  if (problems.length) {
    console.error(`Payments runner NOT ready: ${problems.join(', ')}. Nothing was started.`);
    process.exit(1);
  }

  const guard = require('../src/common/safety/integration-runner-guard');
  const target = require('../src/common/safety/test-database-guard').assertTestDatabaseUrl(env.DATABASE_URL);
  const { prisma } = require('../src/db/prisma'); // after the environment is applied

  let release = null;
  try {
    const live = await guard.verifyLiveIdentity(prisma, { expectedPort: target.port });
    console.log(`Payments runner: database ${live.database}, account ${live.account}; Bitrix forced off; Razorpay Test Mode configuration complete.`);
    if (!run) {
      console.log('READY (check only). Start it with --run.');
      await prisma.$disconnect();
      return;
    }

    release = guard.acquireSessionLock();
    const { app } = require('../src/app');
    const { createJobRunner } = require('../src/jobs/job-runner');
    const razorpayJob = require('../src/jobs/razorpay-webhook-inbox.job');
    const port = Number(env.PORT);

    const server = app.listen(port, 'localhost', () => {
      console.log(`Payments runner listening on http://localhost:${port}. Webhook: POST /integrations/razorpay/webhook. Worker: ${razorpayJob.name} every ${razorpayJob.intervalMs / 1000} s.`);
    });
    server.on('error', (err) => {
      console.error(`Payments runner could not listen on port ${port}: ${err.code || err.name}`);
      if (release) release();
      process.exit(1);
    });
    const jobs = createJobRunner([razorpayJob]);
    jobs.start();

    let stopping = false;
    const stop = async () => {
      if (stopping) process.exit(1);
      stopping = true;
      try { await jobs.stop(); } catch { /* the runner logs its own safe code */ }
      server.close(async () => {
        try { await prisma.$disconnect(); } finally { if (release) release(); process.exit(0); }
      });
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (err) {
    if (release) release();
    await prisma.$disconnect().catch(() => {});
    throw err;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`Payments runner refused to start: ${(err && (err.code || err.name)) || 'error'}.`); // a code only, never a message
  process.exit(1);
});
