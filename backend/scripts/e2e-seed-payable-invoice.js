// TEST-ONLY seed: makes one Private Charter request payable in humancare_test (one accepted quotation + one issued invoice).
//
//   node scripts/e2e-seed-payable-invoice.js --request-id 12 --user-id 5                      DRY RUN: checks and prints the plan, writes nothing
//   node scripts/e2e-seed-payable-invoice.js --request-id 12 --user-id 5 --execute            writes the rows
//   options: --amount 1500.00 (default)  --currency INR (default)  --due-days 30  --allow-partial
//
// Refuses unless EVERY guard passes, before it connects to anything it could change:
//   - the environment comes from backend/.env.test ONLY (see e2e-env.js); NODE_ENV is "test"; both Bitrix switches are forced OFF in memory
//   - DATABASE_URL must name humancare_test on THIS machine, with the test account and a loopback host (test-database-guard)
//   - the database SERVER must then confirm it is humancare_test, as an account confined to humancare_test, on the URL's port (integration-runner-guard)
//   - the session lock is taken (it also stops an ordinary Jest run, which would EMPTY these tables, while this runs) and released afterwards
// It never reads or changes .env or .env.test, never calls Razorpay or Bitrix, and prints only ids, amounts and short codes (no secret, no personal data).
const { buildIsolatedEnv } = require('./e2e-env');

function usage(code) {
  console.error(`Seed refused: ${code}. See the header of scripts/e2e-seed-payable-invoice.js.`);
  process.exit(1);
}

async function main(argv) {
  const lib = require('./lib/payable-invoice-seed');
  let options;
  try { options = lib.parseArgs(argv); } catch (err) { return usage(err.code || 'arguments_invalid'); }

  const env = buildIsolatedEnv(); // .env.test only; validates the URL, mail and uploads rules or throws
  env.BITRIX_SYNC_ENABLED = 'false';
  env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED = 'false';
  Object.assign(process.env, env);

  const guard = require('../src/common/safety/integration-runner-guard');
  const target = require('../src/common/safety/test-database-guard').assertTestDatabaseUrl(env.DATABASE_URL);
  const { prisma } = require('../src/db/prisma');

  let release = null;
  try {
    const live = await guard.verifyLiveIdentity(prisma, { expectedPort: target.port });
    console.log(`Seed: database ${live.database}, account ${live.account}, ${options.execute ? 'EXECUTE' : 'dry run'}.`);
    if (options.execute) release = guard.acquireSessionLock();
    const result = await lib.runSeed(prisma, options);
    console.log(`Plan: request ${result.plan.requestId}, case ${result.plan.caseId}, quotation version ${result.plan.versionNumber}, ${options.amountText} ${options.currency}.`);
    if (!result.executed) console.log('Dry run: nothing was written. Add --execute to write.');
    else {
      const c = result.created;
      console.log(`Created: invoice ${c.invoiceId}, quotation ${c.quotationId}, deal link ${c.linkId}, admin ${c.adminId}, marker ${c.marker}.`);
      console.log(`The patient can now pay invoice ${c.invoiceId}.`);
    }
  } finally {
    if (release) release();
    await prisma.$disconnect();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`Seed failed: ${(err && (err.code || err.name)) || 'error'}.`); // a code only: never a message that could quote data
  process.exit(1);
});
