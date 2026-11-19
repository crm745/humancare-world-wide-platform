// TEST-ONLY: reconciles ONE Bitrix24 Deal (21802, CASE-4037, Case 3037, Category 38) into humancare_test.
//
//   node scripts/e2e-reconcile-single-deal.js                                         DRY RUN: reads the Deal from Bitrix24 (read-only) and the database, verifies
//                                                                                     everything and prints the exact stage id and what WOULD change; writes nothing
//   node scripts/e2e-reconcile-single-deal.js --execute --expect-stage C38:XXXXX      applies it; refuses unless the Deal's CURRENT stage id is exactly the one given
//   options: --no-push (skip the best-effort Expo push that normally follows a patient-visible stage)
//
// Refuses unless EVERY guard passes, before it connects to anything it could change:
//   - the environment comes from backend/.env.test ONLY (see e2e-env.js); NODE_ENV is "test"; the Bitrix switches are turned ON IN MEMORY for this
//     process only (the file is never written) and quotation synchronization is forced OFF; the Bitrix portal must be on the allowlist
//   - DATABASE_URL must name humancare_test on THIS machine, with the test account and a loopback host (test-database-guard)
//   - the database SERVER must then confirm it is humancare_test, as an account confined to humancare_test, on the URL's port (integration-runner-guard)
//   - the session lock must be held by a LIVE e2e session, or is taken (and released) by this script; a stale lock is refused
// It starts no job runner, calls no one but Bitrix24 (ONE crm.deal.get), never Razorpay, registers no webhook and opens no tunnel. See lib/single-deal-reconcile.js.
const fs = require('fs');
const { buildIsolatedEnv } = require('./e2e-env');

const refusal = (code) => { console.error(`Refused: ${code}. See the header of scripts/e2e-reconcile-single-deal.js.`); process.exit(1); };

function holderAlive(lockFile) {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    process.kill(Number(info.pid), 0);
    return true;
  } catch (err) { return Boolean(err && err.code === 'EPERM'); }
}

async function main(argv) {
  const lib = require('./lib/single-deal-reconcile');
  let options;
  try { options = lib.parseArgs(argv); } catch (err) { return refusal(err.code || 'arguments_invalid'); }

  const env = buildIsolatedEnv(); // .env.test only; validates the URL, mail and uploads rules or throws
  env.BITRIX_SYNC_ENABLED = 'true';
  env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED = 'true';
  env.BITRIX_QUOTATION_SYNC_ENABLED = 'false';
  const configProblems = require('../src/modules/bitrix/bitrix-config').bitrixConfigurationProblems(env);
  if (configProblems.length) return refusal('bitrix_configuration_not_valid');
  if (!env.BITRIX24_WEBHOOK_URL) return refusal('bitrix_webhook_not_configured');
  Object.assign(process.env, env);

  const guard = require('../src/common/safety/integration-runner-guard');
  const target = require('../src/common/safety/test-database-guard').assertTestDatabaseUrl(env.DATABASE_URL);
  const { prisma } = require('../src/db/prisma');

  let release = null;
  try {
    const live = await guard.verifyLiveIdentity(prisma, { expectedPort: target.port });
    console.log(`Single-Deal reconcile: database ${live.database}, account ${live.account}, ${options.execute ? 'EXECUTE' : 'dry run'}; Deal ${lib.TARGET.dealId}, ${lib.TARGET.caseReference}.`);
    if (fs.existsSync(guard.SESSION_LOCK)) {
      if (!holderAlive(guard.SESSION_LOCK)) return refusal('stale_session_lock');
    } else if (options.execute) {
      release = guard.acquireSessionLock();
    }

    const result = await lib.runSingleDeal(options, { prisma, api: require('../src/modules/bitrix/bitrix-deal.api'), env, log: console });
    console.log(JSON.stringify(result.facts, null, 2));
    if (!result.facts.mapping.approved) console.log('The Deal\'s current stage is NOT an approved Category 38 stage; --execute would refuse.');
    if (!options.execute) {
      console.log(`Dry run: nothing was written. To apply, re-run with: --execute --expect-stage ${result.facts.deal.stageId}`);
    } else if (result.nothingToApply) {
      console.log('Nothing to apply: HumanCare already holds this stage and modified time.');
    } else {
      console.log(`Reconcile pass: ${JSON.stringify(result.reconciled)}; inbox pass: ${JSON.stringify(result.processed)}.`);
      console.log(`Other inbox rows and deal links unchanged: ${result.othersUnchanged ? 'YES' : 'NO - INVESTIGATE'} (${result.others.inbox} inbox rows, ${result.others.links} links not touched).`);
    }
  } finally {
    if (release) release();
    await prisma.$disconnect();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`Single-Deal reconcile failed: ${(err && (err.code || err.name)) || 'error'}.`); // a code only: never a message that could quote data
  process.exit(1);
});
