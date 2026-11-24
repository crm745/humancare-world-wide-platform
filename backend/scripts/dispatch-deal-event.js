// Dispatches ONE named Deal outbox event to Bitrix24 through the existing Deal worker, without starting the general worker (src/worker.js) or any of its other
// jobs. See src/modules/bitrix/single-event-dispatch.js for the guarantees.
//
//   DRY RUN (default; read-only, no claim, no call):
//     npm run dispatch:deal-event -- --event-id 53 --case-reference CASE-1206 --request-reference REQ-1208
//   DISPATCH (needs the process environment of a Deal worker; see the module header):
//     npm run dispatch:deal-event -- --event-id 53 --case-reference CASE-1206 --request-reference REQ-1208 --execute [--max-minutes 6]
//
// All three identifiers are mandatory. backend/.env is READ (dotenv, variables already in the process win) and never written. Output: the outcome, the
// event and Case ids and references, statuses and the Deal id; never a credential, URL or patient value. Exit code 0 = dry run ready / completed.
require('dotenv').config({ quiet: true });
const single = require('../src/modules/bitrix/single-event-dispatch');

const USAGE = 'Usage: dispatch-deal-event --event-id <id> --case-reference CASE-<n> --request-reference REQ-<n> [--execute] [--max-minutes <1-30>]';

async function main(argv) {
  const parsed = single.parseArgs(argv);
  if (parsed.error) { console.error(`dispatch-deal-event: ${parsed.error}. ${USAGE}`); return 2; }

  // Required only here, never at import: the Deal worker, the real Prisma client and the ONE shared gateway (its limiter is sized from the environment).
  const { prisma } = require('../src/db/prisma');
  const { runDealWorker } = require('../src/modules/bitrix/deal-worker.service');
  const { sharedDispatcher } = require('../src/modules/bitrix/queue/dispatcher');
  try {
    const result = await single.dispatchSingleEvent({
      prisma, env: process.env, log: console, gateway: sharedDispatcher(), runWorker: runDealWorker, ...parsed,
    });
    const t = result.target || {};
    console.log(JSON.stringify({
      outcome: result.outcome, ...(result.problems && { problems: result.problems }), ...(result.environmentProblems && { environmentProblems: result.environmentProblems, readyToExecute: result.ready }),
      target: t.eventId ? { eventId: t.eventId, caseId: t.caseId, caseReference: t.caseReference, requestId: t.requestId, requestReference: t.requestReference, profile: t.profile } : undefined,
      ...(result.state && { state: { status: result.state.status, attempts: result.state.attempts, lastError: result.state.lastError, dealId: result.state.dealId, categoryId: result.state.categoryId, stageId: result.state.stageId, linkProfile: result.state.linkProfile, syncStatus: result.state.syncStatus } }),
      ...(result.passes && { passes: result.passes }),
      otherEventsTouchedBefore: result.otherEventsTouchedBefore, otherEventsTouchedAfter: result.otherEventsTouchedAfter,
    }, null, 2));
    // 0 = a dry run that is ready to execute, or a completed dispatch. Everything else (refused, already dispatched, not ready, failed, manual review, incomplete) is 1.
    return result.outcome === 'completed' || (result.outcome === 'dry_run' && result.ready === true) ? 0 : 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`dispatch-deal-event: unexpected ${err && err.name ? err.name : 'error'}`); process.exit(1); });
}

module.exports = { main };
