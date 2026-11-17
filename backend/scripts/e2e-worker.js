// The GUARDED Deal worker for the test database (humancare_test). NOT src/worker.js: that one loads the development .env and
// runs every scheduled job. This one is a one-shot run for the Cases you name, with a fake Bitrix24 API by default.
//
//   node scripts/e2e-worker.js --case-ids 2210,2211              DRY RUN: checks the Cases and prints the plan, claims nothing
//   node scripts/e2e-worker.js --case-ids 2210 --execute         one worker pass over those Cases only, fake Bitrix24 API
//   node scripts/e2e-worker.js --case-ids 2210 --execute --live  real Bitrix24 client: needs BITRIX_ALLOWED_PORTAL_HOST naming a
//                                                                SANDBOX portal; the live portal is refused
//
// Loads ONLY backend/.env.test (see e2e-env.js), refuses unless the safety guard passes, and asks the database server to
// confirm it is humancare_test before doing anything. It never starts the inbox, reconcile, retry or scan jobs, never touches an
// event or inbox row outside the named Cases, and never changes process.env. See src/modules/bitrix/deal-worker-harness.js.
const fs = require('fs');
const path = require('path');
const { applyIsolatedEnv } = require('./e2e-env');
const harness = require('../src/modules/bitrix/deal-worker-harness');

async function main(argv) {
  const options = harness.parseArgs(argv);
  const env = applyIsolatedEnv(); // validates the test environment before Prisma is loaded

  const { prisma } = require('../src/db/prisma');
  const { verifyLiveDatabase } = require('../src/common/safety/test-database-guard');
  const { assertBitrixConfiguration } = require('../src/modules/bitrix/bitrix-config');
  const { runDealWorker } = require('../src/modules/bitrix/deal-worker.service');
  const store = require('../src/modules/bitrix/deal-outbox.store');
  const realApi = require('../src/modules/bitrix/bitrix-deal.api');

  try {
    const live = await verifyLiveDatabase(prisma);
    console.log(`Guarded Deal worker: database ${live.database}, account ${live.account}; scope: Case ${options.caseIds.join(', ')}; ${options.live ? 'LIVE client' : 'fake Bitrix24 API'}.`);

    const plan = await harness.assertScopeEligible(prisma, options.caseIds);
    for (const item of plan) console.log(`  case ${item.caseId}: request ${item.requestId}, event ${item.eventId} (${item.eventStatus})`);

    const workerEnvironment = harness.workerEnv(env, { live: options.live });
    let api;
    if (options.live) {
      const liveHost = harness.developmentWebhookHost(path.join(__dirname, '..', '.env'), (file) => fs.readFileSync(file, 'utf8'));
      harness.assertLiveAllowed(env, liveHost);
      assertBitrixConfiguration(workerEnvironment);
      api = realApi;
    } else {
      api = harness.makeFakeBitrixApi();
    }

    const candidates = [];
    for (const status of ['pending', 'ambiguous']) candidates.push(...(await store.findCandidateIds(prisma, status, 50, { caseIds: options.caseIds })));
    console.log(`  the worker would offer ${candidates.length} event(s): ${candidates.join(', ') || 'none'}.`);
    if (!options.execute) {
      console.log('Dry run: nothing was claimed or written. Add --execute to run one pass.');
      return;
    }

    const restoreFetch = options.live ? () => {} : harness.blockNetwork();
    let result;
    try {
      result = await runDealWorker({ prisma, api, env: workerEnvironment, log: console, scope: { caseIds: options.caseIds } });
    } finally {
      restoreFetch();
    }
    console.log(`Pass finished: ${JSON.stringify(result)}.`);
    if (api.isFake) console.log(`Fake Bitrix24 API calls: ${api.calls.length} (${api.calls.map((c) => c.method).join(', ') || 'none'}).`);
    for (const item of plan) {
      const [event] = await prisma.$queryRawUnsafe('SELECT status, attempts, last_error FROM integration_outbox WHERE id = ?', item.eventId);
      console.log(`  event ${item.eventId}: ${event.status}, attempts ${event.attempts}${event.last_error ? `, ${String(event.last_error).slice(0, 80)}` : ''}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
