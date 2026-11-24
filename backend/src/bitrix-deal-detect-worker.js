// ONE-TIME runner that lets HumanCare notice what Operations did to ONE Bitrix24 Deal (the actual pipeline, Category 0) without the webhook, so the quotation sync has
// an event to deliver. It runs the existing reconcileDeals() and runInboxWorker(), narrowed to one Deal id, one Case id and one Case reference, and exits. It is not
// src/worker.js and never requires src/jobs/index.js, a job file or a timer. All rules and limits are in modules/bitrix/single-deal-detect.js.
//
//   node src/bitrix-deal-detect-worker.js --deal-id <D> --case-id <N> --case-reference CASE-<N> --expect-stage <STAGE>                      readiness only (default)
//   node src/bitrix-deal-detect-worker.js --once --deal-id <D> --case-id <N> --case-reference CASE-<N> --expect-stage <STAGE>              ONE detection pass
//   <STAGE> is exactly UC_R55CKV ("Quoted"), UC_9E9NRI ("Confirmed") or UC_HS6O2F ("Activate") or WON ("Case Completed") and must equal the Deal's live stage; any other value is refused.
// Needs (process environment only): BITRIX_DEAL_PROFILE=actual, BITRIX_SYNC_ENABLED, BITRIX_PRIVATE_CHARTER_DEAL_ENABLED and BITRIX_QUOTATION_SYNC_ENABLED all "true".
// WRITES (--once): the Deal link, one inbox row, one quotation outbox event, the Case stage, its stage event and audit rows in humancare_dev. Bitrix24: ONE read.
const path = require('path');

async function main(argv = process.argv.slice(2)) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true }); // inside main only; values already in the process environment win
  const { prisma } = require('./db/prisma');
  const api = require('./modules/bitrix/bitrix-deal.api');
  const { runCli } = require('./modules/bitrix/single-deal-detect');
  try {
    return await runCli({ argv, env: process.env, prisma, api });
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

module.exports = { main };
if (require.main === module) main().then((code) => { process.exitCode = code; });
