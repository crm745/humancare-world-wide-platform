// A ONE-SHOT, document-only run of the Deal DOCUMENT worker for ONE fixed share in the test database (humancare_test).
// NOT src/worker.js and NOT e2e-worker.js: it never starts a scheduled job, never runs the Deal-creation worker, and never
// offers the Deal-create event (bitrix.deal.create) to anything.
//
//   node scripts/e2e-document-worker.js             DRY RUN (default): checks everything and prints the plan; claims and writes nothing
//   node scripts/e2e-document-worker.js --execute   ONE document-worker pass, limited to Case 2206
//
// Fixed target (change the constants below on purpose, never by a flag):
//   database humancare_test | CASE-3206 (id 2206) | request 3845 | document 2663 "_Test (1).pdf" | share 2
//   events 417 (attach, superseded by the revoke) and 418 (remove). Event 416 (bitrix.deal.create) must stay untouched.
//
// What --execute can and cannot do:
//   * Bitrix24 is NOT reachable: the worker gets an API object whose every method refuses, the webhook is blanked in the
//     worker's environment, and global fetch is replaced by a function that refuses. The pre-flight proves the share was never
//     sent to Bitrix (no file id, no recorded Deal file list), so the remove event finishes as "never_attached" without a call.
//   * BITRIX_ALLOWED_PORTAL_HOST is set to the one allowed portal and the webhook in .env.test must name exactly that host, or
//     the script stops (nothing is sent either way; this is a second lock for when a live client is wired in on purpose).
//   * The database is verified (DATABASE() = humancare_test, a humancare_test* user) at the start AND again right before the pass.
//   * Nothing authorizes, re-authorizes, revokes or retries a share. The only writes are the worker's own: claim, result, audit.
const { applyIsolatedEnv } = require('./e2e-env');

const TARGET = Object.freeze({
  caseId: 2206, caseReference: 'CASE-3206', requestId: 3845, documentId: 2663, documentName: '_Test (1).pdf', shareId: 2,
  attachEventId: 417, removeEventId: 418, dealCreateEventId: 416,
  portalHost: 'b24-4orefh.bitrix24.in',
});

class RunError extends Error {
  constructor(message) { super(`Document worker run: ${message}`); this.name = 'RunError'; }
}
const refuse = (message) => new RunError(message);

function parseArgs(argv) {
  const out = { execute: false };
  for (const arg of argv) {
    if (arg === '--execute') out.execute = true;
    else throw refuse(`unknown argument "${String(arg).slice(0, 30)}". The only option is --execute (the target is fixed in the script).`);
  }
  return out;
}

// Every method refuses: there is no way for the worker to reach Bitrix24 from this script.
function makeRefusingApi() {
  const calls = [];
  const refusing = (method) => async () => { calls.push(method); throw new Error(`Bitrix24 access is disabled in this script (${method}).`); };
  const api = { calls };
  for (const method of ['getDealFiles', 'updateDealFiles', 'createDeal', 'findDealsByReference', 'getDeal']) api[method] = refusing(method);
  return api;
}

const mine = (db, sql, ...args) => db.$queryRawUnsafe(sql, ...args);

// Read-only. Throws with a short code per problem; returns what it saw so the plan can be printed.
async function preflight(db, store) {
  const problems = [];
  const [caseRow] = await mine(db,
    `SELECT c.id, c.reference_number, c.service_request_id, sr.service_key, sr.review_status, l.id AS link_id, l.bitrix_deal_id, l.file_locked_until
     FROM cases c JOIN service_requests sr ON sr.id = c.service_request_id LEFT JOIN bitrix_deal_links l ON l.case_id = c.id WHERE c.id = ?`, TARGET.caseId);
  if (!caseRow) throw refuse(`case ${TARGET.caseId} not found. Nothing was run.`);
  if (caseRow.reference_number !== TARGET.caseReference) problems.push(`case ${TARGET.caseId} is not ${TARGET.caseReference}`);
  if (Number(caseRow.service_request_id) !== TARGET.requestId) problems.push(`case is not linked to request ${TARGET.requestId}`);
  if (caseRow.review_status !== 'approved') problems.push('the request is not approved');
  if (caseRow.link_id == null) problems.push('no Deal link');

  const [share] = await mine(db,
    `SELECT s.id, s.request_document_id, s.status, s.try_count, s.bitrix_file_id, s.file_ids_before, s.deal_link_id, d.original_name
     FROM bitrix_deal_documents s JOIN request_documents d ON d.id = s.request_document_id WHERE s.id = ?`, TARGET.shareId);
  if (!share) problems.push(`share ${TARGET.shareId} not found`);
  else {
    if (Number(share.request_document_id) !== TARGET.documentId || share.original_name !== TARGET.documentName) problems.push(`share ${TARGET.shareId} is not for document ${TARGET.documentId} "${TARGET.documentName}"`);
    if (Number(share.deal_link_id) !== Number(caseRow.link_id)) problems.push('the share belongs to another Deal link');
    if (share.status !== 'revoking') problems.push(`the share is "${share.status}", not "revoking" (this script only finishes a pending revocation)`);
    if (share.bitrix_file_id != null || share.file_ids_before != null) problems.push('the share may have been sent to Bitrix24 (file id or file list recorded); a removal could then need a real Bitrix call, which this script does not allow');
  }

  // Every event of the Case: the document events that are still open must be exactly 417 and 418; 416 must be untouched.
  const events = await mine(db,
    `SELECT id, event_type, status, attempts, external_call_started_at, locked_until FROM integration_outbox WHERE case_id = ? ORDER BY id`, TARGET.caseId);
  const open = events.filter((e) => store.EVENT_TYPES.includes(e.event_type) && ['pending', 'ambiguous', 'processing'].includes(e.status));
  const openIds = open.map((e) => Number(e.id)).sort((a, b) => a - b);
  if (JSON.stringify(openIds) !== JSON.stringify([TARGET.attachEventId, TARGET.removeEventId])) problems.push(`open document events are [${openIds.join(', ')}], expected exactly [${TARGET.attachEventId}, ${TARGET.removeEventId}]`);
  for (const e of open) {
    if (e.status !== 'pending' || Number(e.attempts) !== 0 || e.external_call_started_at != null || e.locked_until != null) problems.push(`event ${e.id} is not a clean pending event (status ${e.status}, attempts ${e.attempts})`);
  }
  const create = events.find((e) => Number(e.id) === TARGET.dealCreateEventId);
  if (!create || create.event_type !== 'bitrix.deal.create') problems.push(`event ${TARGET.dealCreateEventId} is not the bitrix.deal.create event`);

  // What the worker's own candidate query would offer for this scope (this is the real query it uses).
  const scope = { caseIds: [TARGET.caseId] };
  const offered = [...(await store.findCandidateIds(db, 'pending', 50, scope)), ...(await store.findCandidateIds(db, 'ambiguous', 50, scope))].sort((a, b) => a - b);
  if (JSON.stringify(offered) !== JSON.stringify([TARGET.attachEventId, TARGET.removeEventId])) problems.push(`the worker would offer [${offered.join(', ')}], expected exactly [${TARGET.attachEventId}, ${TARGET.removeEventId}]`);
  if (offered.includes(TARGET.dealCreateEventId)) problems.push('the worker would offer the Deal-create event');

  if (problems.length) throw refuse(`pre-flight failed (${problems.join('; ')}). Nothing was run.`);
  return { caseRow, share, events, offered, createEvent: create };
}

async function snapshot(db) {
  const rows = await mine(db, 'SELECT id, event_type, status, attempts, last_error, external_call_started_at FROM integration_outbox WHERE case_id = ? ORDER BY id', TARGET.caseId);
  const [share] = await mine(db, 'SELECT id, status, try_count, attempts, last_error, revoked_at, bitrix_file_id FROM bitrix_deal_documents WHERE id = ?', TARGET.shareId);
  return { events: rows, share };
}

const show = (s) => {
  for (const e of s.events) console.log(`  event ${e.id} ${e.event_type}: ${e.status}, attempts ${e.attempts}${e.last_error ? `, ${String(e.last_error).slice(0, 60)}` : ''}`);
  console.log(`  share ${s.share.id}: ${s.share.status}, try ${s.share.try_count}, revoked_at ${s.share.revoked_at ? 'set' : 'null'}, bitrix_file_id ${s.share.bitrix_file_id == null ? 'null' : 'set'}`);
};

async function main(argv) {
  const options = parseArgs(argv);
  const env = applyIsolatedEnv(); // validates the test environment before Prisma is loaded

  const { prisma } = require('../src/db/prisma');
  const { verifyLiveDatabase } = require('../src/common/safety/test-database-guard');
  const { webhookHost, assertBitrixConfiguration } = require('../src/modules/bitrix/bitrix-config');
  const store = require('../src/modules/bitrix/deal-document.store');
  const { runDealDocumentWorker } = require('../src/modules/bitrix/deal-document-worker.service');
  const harness = require('../src/modules/bitrix/deal-worker-harness');

  try {
    const live = await verifyLiveDatabase(prisma);
    console.log(`Document worker run: database ${live.database}, account ${live.account}; ${options.execute ? 'EXECUTE' : 'DRY RUN'}.`);

    // Portal lock: the webhook in .env.test must name the one allowed portal. The host only; the webhook itself is never printed.
    const host = webhookHost(env.BITRIX24_WEBHOOK_URL);
    if (host !== TARGET.portalHost) throw refuse('the webhook host in .env.test is not the allowed portal. Nothing was run.');
    const allowed = { ...env, BITRIX_ALLOWED_PORTAL_HOST: TARGET.portalHost };
    // In memory only. workerEnv(.., { live: false }) switches the worker on and BLANKS the webhook: there is nothing to send to.
    const workerEnvironment = harness.workerEnv(allowed, { live: false });
    assertBitrixConfiguration(workerEnvironment);
    console.log(`  portal lock: webhook host equals ${TARGET.portalHost}; Bitrix24 access is disabled in this script.`);

    const plan = await preflight(prisma, store);
    console.log(`  case ${TARGET.caseId} (${TARGET.caseReference}), request ${TARGET.requestId}, document ${TARGET.documentId}, share ${TARGET.shareId} (${plan.share.status}); Deal id ${plan.caseRow.bitrix_deal_id == null ? 'none' : 'set'}.`);
    console.log(`  the worker would offer exactly: ${plan.offered.join(', ')}; event ${TARGET.dealCreateEventId} (bitrix.deal.create) is not offered and stays ${plan.createEvent.status}.`);
    console.log(`  expected: event ${TARGET.attachEventId} finishes as superseded_event (no upload); event ${TARGET.removeEventId} marks the share revoked as never_attached (no Bitrix call).`);
    if (!options.execute) {
      console.log('Dry run: nothing was claimed or written. Add --execute to run one pass.');
      return;
    }

    // Verify again immediately before the pass, then re-check the plan (nothing may have changed since the first check).
    await verifyLiveDatabase(prisma);
    await preflight(prisma, store);
    const before = await snapshot(prisma);

    const api = makeRefusingApi();
    const restoreFetch = harness.blockNetwork();
    let result;
    try {
      result = await runDealDocumentWorker({
        prisma, api, env: workerEnvironment, log: console, scope: { caseIds: [TARGET.caseId] }, notify: async () => {},
      });
    } finally {
      restoreFetch();
    }
    console.log(`Pass finished: ${JSON.stringify(result)}; Bitrix24 calls attempted: ${api.calls.length}.`);
    const after = await snapshot(prisma);
    show(after);
    const create = after.events.find((e) => Number(e.id) === TARGET.dealCreateEventId);
    const createBefore = before.events.find((e) => Number(e.id) === TARGET.dealCreateEventId);
    if (!create || create.status !== createBefore.status || Number(create.attempts) !== Number(createBefore.attempts)) {
      console.error(`WARNING: event ${TARGET.dealCreateEventId} changed. Stop and investigate.`);
      process.exitCode = 2;
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

module.exports = { main, parseArgs, preflight, makeRefusingApi, TARGET };
