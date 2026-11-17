// A ONE-SHOT RECONCILIATION of ONE uncertain Bitrix24 attachment in the test database (humancare_test): the expired attempt of event 420
// (share 4, document 2662 "test-sample (1).pdf") on Deal 21760. It uses the document worker's EXISTING reconciliation / adoption path
// (deal-document-worker.service.js: recoverExpiredLeases -> ambiguous -> attachFlow "reconciling" -> adopt -> markAttached), which finds
// exactly one new file since share 4's recorded file_ids_before and records it. NOTHING IS UPLOADED OR UPDATED: the guarded Bitrix API
// refuses every method except the single read of the Deal.
//
//   node scripts/e2e-document-reconcile-sample.js                                  DRY RUN (default): checks everything, reads Deal 21760 ONCE
//                                                                                  (crm.deal.get). No claim, no write.
//   node scripts/e2e-document-reconcile-sample.js --execute --confirm CASE-3206    ONE worker pass limited to Case 2206 and event 420. The one read
//                                                                                  is made BEFORE the pass; the worker's own read of the Deal is
//                                                                                  answered from it (so the whole run is ONE crm.deal.get).
//
// Fixed target (change the constants on purpose, never by a flag):
//   database humancare_test | CASE-3206 (id 2206) | request 3845 | document 2662 | share 4 | event 420 | Deal 21760 | portal b24-4orefh.bitrix24.in
//   confirmed Bitrix file 65616 (seen in Bitrix24 as "HC-D2662G1-abce4555__test-sample _1_.pdf"); file 65608 (share 3) is GONE from the Deal.
//
// What it will write (all by the worker's own code, in one transaction under the lease fence):
//   event 420 -> ambiguous (lease recovery) -> processing -> completed; share 4 -> attached, bitrix_file_id 65616, attached_at;
//   two audit rows: "bitrix.deal.document.attached" (reason adopted_confirmed_by_person: prior file 65608 is gone, so the worker adopts 65616 only because this script
//   passes the person's confirmation of exactly that id for share 4) and "bitrix.deal.document.existing_files_missing" (confirmed_missing_1). Nothing else.
// What it will NOT do: revoke share 3, authorize another generation, touch event 419 or any other event, notify anyone, read the
//   document file, or call any Bitrix method except the one crm.deal.get.
// On any unexpected state or file list it stops BEFORE the pass, with no write.
const { applyIsolatedEnv } = require('./e2e-env');

const TARGET = Object.freeze({
  caseId: 2206, caseReference: 'CASE-3206', requestId: 3845, documentId: 2662, documentRequestId: null, caseDocumentId: 706,
  shareId: 4, generation: 1, shareToken: 'HC-D2662G1-abce4555', eventId: 420,
  dealId: '21760', categoryId: '38', fileField: 'UF_CRM_1794832401', referenceField: 'UF_CRM_1794548440549',
  portalHost: 'b24-4orefh.bitrix24.in',
  confirmedFileId: '65616', recordedFileIdsBefore: ['65608'],
  // Read-only: the earlier attachment (its file 65608 no longer exists in Bitrix; it is NOT repaired here).
  otherShareId: 3, otherDocumentId: 2663, otherFileId: '65608', otherEventId: 419,
  maxReads: 1,
});
// A PERSON identified file 65616 in Bitrix24 ("HC-D2662G1-abce4555__test-sample _1_.pdf"). The worker no longer adopts an id on its own when a prior file
// (65608) has gone from the Deal, so this explicit confirmation of exactly this id for exactly this share is passed to it.
const CONFIRMED_FILE_IDS = Object.freeze({ [TARGET.shareId]: TARGET.confirmedFileId });
const DOCUMENT_NAME = 'test-sample (1).pdf';

class RunError extends Error {
  constructor(message) { super(`Reconciliation (test-sample): ${message}`); this.name = 'RunError'; }
}
const refuse = (message) => new RunError(message);

function parseArgs(argv) {
  const out = { execute: false, confirmed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') out.execute = true;
    else if (arg === '--confirm') {
      if (argv[i + 1] !== TARGET.caseReference) throw refuse(`--confirm must be followed by ${TARGET.caseReference}.`);
      out.confirmed = true;
      i += 1;
    } else throw refuse(`unknown argument "${String(arg).slice(0, 30)}". Use: [--execute --confirm ${TARGET.caseReference}] (the target is fixed in the script).`);
  }
  if (out.execute && !out.confirmed) throw refuse(`--execute needs --confirm ${TARGET.caseReference}.`);
  if (out.confirmed && !out.execute) throw refuse('--confirm only applies together with --execute.');
  return out;
}

// ---- the HTTP layer: ONE crm.deal.get for Deal 21760, nothing else ---------------------------------------------------------------
function makeFetchGuard(nativeFetch, { maxReads = TARGET.maxReads } = {}) {
  const state = { reads: 0, refused: [] };
  const deny = (why) => { state.refused.push(why); throw new Error(`Guarded fetch: ${why}.`); };
  const guardedFetch = async (url, init) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return deny('unusable URL'); }
    if (parsed.hostname.toLowerCase() !== TARGET.portalHost) return deny('host is not the allowed portal');
    if (!init || init.method !== 'POST') return deny('POST only');
    if (!parsed.pathname.endsWith('/crm.deal.get.json')) return deny('only crm.deal.get is allowed');
    let body;
    try { body = JSON.parse(init.body); } catch { return deny('unreadable body'); }
    if (!body || String(body.id) !== TARGET.dealId) return deny('not Deal 21760');
    if (state.reads + 1 > maxReads) return deny('only one crm.deal.get request is allowed');
    state.reads += 1;
    return nativeFetch(url, init);
  };
  return { guardedFetch, state };
}

// The one read: the Deal must be 21760 / category 38 / this Case, and its Documents field must be EXACTLY the confirmed file.
// Anything else (another id, an extra file, an empty field) is an unexpected state: nothing may be written.
async function readExpectedDealFiles(realApi, env, guardedFetch) {
  const read = await realApi.getDeal(TARGET.dealId, { env, fetchImpl: guardedFetch });
  if (read.status !== 'ok') throw refuse(`the Deal could not be read (${read.status}${read.reason ? `: ${read.reason}` : ''}). Nothing was written.`);
  const deal = read.deal;
  if (String(deal.ID) !== TARGET.dealId) throw refuse('the answer is for another Deal. Nothing was written.');
  if (String(deal.CATEGORY_ID) !== TARGET.categoryId) throw refuse('the Deal is in another category. Nothing was written.');
  if (deal[TARGET.referenceField] !== TARGET.caseReference) throw refuse('the Deal does not carry this Case reference. Nothing was written.');
  const ids = realApi.fileIdsOf(deal[TARGET.fileField]);
  if (ids === null) throw refuse('the Documents field has an unexpected shape. Nothing was written.');
  if (JSON.stringify(ids) !== JSON.stringify([TARGET.confirmedFileId])) throw refuse(`the Documents field holds [${ids.join(', ')}], expected exactly [${TARGET.confirmedFileId}]. Nothing was written.`);
  return { status: 'ok', ids };
}

// The only Bitrix surface the worker sees: the already verified read (no second request); every other method refuses.
function makeGuardedApi(realApi, verifiedRead) {
  const state = { refused: [], reads: 0 };
  const api = {
    state,
    BitrixDealCallError: realApi.BitrixDealCallError,
    getDealFiles: async (dealId) => {
      if (String(dealId) !== TARGET.dealId) { state.refused.push('getDealFiles(other deal)'); throw new Error('Only Deal 21760 may be read.'); }
      state.reads += 1;
      return { status: verifiedRead.status, ids: [...verifiedRead.ids] };
    },
  };
  for (const method of ['createDeal', 'findDealsByReference', 'getDeal', 'updateDealFiles']) {
    api[method] = async () => { state.refused.push(method); throw new Error(`Bitrix24 method ${method} is disabled in this script.`); };
  }
  return api;
}

// The worker's store, with its door narrowed to Case 2206 and event 420. Everything else is the real store.
function makeScopedStore(realStore) {
  const only = [TARGET.eventId];
  return {
    ...realStore,
    findCandidateIds: async (db, status, limit, scope) => {
      const ids = await realStore.findCandidateIds(db, status, limit, scope);
      if (JSON.stringify(ids) !== JSON.stringify([]) && JSON.stringify(ids) !== JSON.stringify(only)) throw new Error(`The worker offered [${ids.join(', ')}], not only event ${TARGET.eventId}. Stopped before any claim.`);
      return ids;
    },
    claim: async (db, args) => {
      if (args.id !== TARGET.eventId) throw new Error(`Refusing to claim event ${args.id}.`);
      return realStore.claim(db, args);
    },
    // A reconciliation makes no Bitrix call, so the "external call started" evidence is never written again.
    markExternalCallStarted: async () => { throw new Error('No external call may be started by this script.'); },
  };
}

// ---- database pre-flight (read-only) ------------------------------------------------------------------------------------------
const rows = (db, sql, ...args) => db.$queryRawUnsafe(sql, ...args);

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Pure: the problems with event 420 (an expired lease with the call started; nothing else).
function eventProblems(e, { leaseExpired }) {
  const p = [];
  if (!e || e.event_type !== 'bitrix.deal.document.attach' || e.entity_id !== `${TARGET.shareId}:attach:1`) return [`event ${TARGET.eventId} is not the attach event of share ${TARGET.shareId}`];
  if (e.status !== 'processing') p.push(`event ${TARGET.eventId} is "${e.status}", not "processing"`);
  if (!leaseExpired) p.push('the event lease has not expired (another process may still be working)');
  if (e.external_call_started_at == null) p.push('the event has no external_call_started_at');
  if (Number(e.attempts) !== 1) p.push(`the event has ${e.attempts} attempts, expected 1`);
  return p;
}

// Pure: share 4 (attaching, never recorded a file, the pre-upload list exactly ["65608"]) and share 3 (still pointing at 65608).
function shareProblems(share4, share3) {
  const p = [];
  if (!share4) p.push(`share ${TARGET.shareId} not found`);
  else {
    if (share4.status !== 'attaching') p.push(`share ${TARGET.shareId} is "${share4.status}", not "attaching"`);
    if (share4.bitrixFileId != null) p.push(`share ${TARGET.shareId} already has a Bitrix file id`);
    if (!Array.isArray(share4.fileIdsBefore) || !sameList(share4.fileIdsBefore.map(String), TARGET.recordedFileIdsBefore)) p.push(`share ${TARGET.shareId} file_ids_before is not exactly ["${TARGET.recordedFileIdsBefore.join('", "')}"]`);
    if (share4.requestDocumentId !== TARGET.documentId || share4.generation !== TARGET.generation || share4.shareToken !== TARGET.shareToken) p.push(`share ${TARGET.shareId} is not generation ${TARGET.generation} of document ${TARGET.documentId}`);
    if (share4.tryCount !== 1) p.push(`share ${TARGET.shareId} try_count is ${share4.tryCount}, expected 1`);
  }
  if (!share3 || String(share3.bitrixFileId) !== TARGET.otherFileId || share3.requestDocumentId !== TARGET.otherDocumentId) p.push(`share ${TARGET.otherShareId} no longer references file ${TARGET.otherFileId}`);
  else if (share3.status !== 'attached') p.push(`share ${TARGET.otherShareId} is "${share3.status}", not "attached"`);
  return p;
}

function documentProblems(document, share) {
  const p = [];
  if (!document) return [`document ${TARGET.documentId} not found`];
  if (document.serviceRequestId !== TARGET.requestId || document.originalName !== DOCUMENT_NAME) p.push(`the document is not "${DOCUMENT_NAME}" of request ${TARGET.requestId}`);
  if (document.documentRequestId !== TARGET.documentRequestId || document.caseDocumentId !== TARGET.caseDocumentId) p.push('the document request or Case document link changed');
  if (document.scanStatus !== 'clean') p.push(`the virus scan is "${document.scanStatus}", not clean`);
  if (document.reviewStatus !== 'approved') p.push(`the document is "${document.reviewStatus}", not approved`);
  if (document.supersededAt) p.push('the document was replaced by a newer one');
  if (!document.sha256) p.push('the document has no checksum');
  if (share && document.sha256 !== share.sha256) p.push('the checksum differs from the one recorded on the share');
  return p;
}

async function preflight(prisma, store) {
  const problems = [];
  const [c] = await rows(prisma,
    `SELECT c.id, c.reference_number, c.service_request_id, sr.service_key, sr.review_status, l.id AS link_id, l.bitrix_deal_id, l.file_locked_until
     FROM cases c JOIN service_requests sr ON sr.id = c.service_request_id LEFT JOIN bitrix_deal_links l ON l.case_id = c.id WHERE c.id = ?`, TARGET.caseId);
  if (!c) throw refuse(`case ${TARGET.caseId} not found. Nothing was run.`);
  if (c.reference_number !== TARGET.caseReference) problems.push(`case ${TARGET.caseId} is not ${TARGET.caseReference}`);
  if (Number(c.service_request_id) !== TARGET.requestId) problems.push(`case is not linked to request ${TARGET.requestId}`);
  if (c.service_key !== 'privatecharter') problems.push('not a Private Charter request');
  if (c.review_status !== 'approved') problems.push('the request is not approved');
  if (String(c.bitrix_deal_id) !== TARGET.dealId) problems.push(`the Case's Deal id is not ${TARGET.dealId}`);
  if (c.file_locked_until != null && new Date(c.file_locked_until).getTime() > Date.now()) problems.push('the Deal file lease is held by another process');

  const events = await rows(prisma,
    `SELECT id, event_type, entity_id, status, attempts, last_error, external_call_started_at, locked_until, (locked_until IS NOT NULL AND locked_until <= UTC_TIMESTAMP(3)) AS lease_expired
     FROM integration_outbox WHERE case_id = ? ORDER BY id`, TARGET.caseId);
  const e = events.find((x) => Number(x.id) === TARGET.eventId);
  problems.push(...eventProblems(e, { leaseExpired: Boolean(e && Number(e.lease_expired) === 1) }));
  const open = events.filter((x) => ['pending', 'ambiguous', 'processing'].includes(x.status)).map((x) => Number(x.id));
  if (!sameList(open, [TARGET.eventId])) problems.push(`open events of the Case are [${open.join(', ')}], expected exactly [${TARGET.eventId}]`);
  const other = events.find((x) => Number(x.id) === TARGET.otherEventId);
  if (!other || other.status !== 'completed') problems.push(`event ${TARGET.otherEventId} is not completed`);

  const share4 = await prisma.bitrixDealDocument.findUnique({ where: { id: TARGET.shareId } });
  const share3 = await prisma.bitrixDealDocument.findUnique({ where: { id: TARGET.otherShareId } });
  problems.push(...shareProblems(share4, share3));
  if (share4 && Number(share4.dealLinkId) !== Number(c.link_id)) problems.push('share 4 belongs to another Deal link');
  const document = await prisma.requestDocument.findUnique({ where: { id: TARGET.documentId } });
  problems.push(...documentProblems(document, share4));

  // After the lease recovery (expired + call started -> ambiguous) the worker's own query must offer only event 420. The recovery is
  // not run here (it writes); right now nothing is pending or ambiguous, and the scoped store narrows the door again during the pass.
  const scope = { caseIds: [TARGET.caseId] };
  const offeredNow = [...(await store.findCandidateIds(prisma, 'pending', 50, scope)), ...(await store.findCandidateIds(prisma, 'ambiguous', 50, scope))];
  if (offeredNow.length) problems.push(`the worker already offers [${offeredNow.join(', ')}]; expected nothing before the lease recovery`);

  if (problems.length) throw refuse(`pre-flight failed (${problems.join('; ')}). Nothing was run.`);
  return { event: e, share4, share3, others: events.filter((x) => Number(x.id) !== TARGET.eventId) };
}

async function snapshot(prisma) {
  const events = await rows(prisma, 'SELECT id, status, attempts, last_error, locked_by, external_call_started_at FROM integration_outbox WHERE case_id = ? ORDER BY id', TARGET.caseId);
  const share4 = await prisma.bitrixDealDocument.findUnique({ where: { id: TARGET.shareId }, select: { status: true, bitrixFileId: true, attempts: true, tryCount: true, lastError: true, attachedAt: true } });
  const share3 = await prisma.bitrixDealDocument.findUnique({ where: { id: TARGET.otherShareId }, select: { status: true, bitrixFileId: true, attachedAt: true, tryCount: true, revokedAt: true } });
  const audit = await rows(prisma, "SELECT id, action, reason_code FROM audit_logs WHERE entity_type = 'bitrix_deal_document' AND entity_id = ? ORDER BY id", String(TARGET.shareId));
  return { events, share4, share3, audit };
}

async function main(argv) {
  const options = parseArgs(argv);
  const env = applyIsolatedEnv(); // validates the test environment before Prisma is loaded

  const { prisma } = require('../src/db/prisma');
  const { verifyLiveDatabase } = require('../src/common/safety/test-database-guard');
  const { webhookHost, bitrixHostProblem, assertBitrixConfiguration } = require('../src/modules/bitrix/bitrix-config');
  const realStore = require('../src/modules/bitrix/deal-document.store');
  const realApi = require('../src/modules/bitrix/bitrix-deal.api');
  const { runDealDocumentWorker } = require('../src/modules/bitrix/deal-document-worker.service');
  const harness = require('../src/modules/bitrix/deal-worker-harness');

  const nativeFetch = globalThis.fetch;
  try {
    const live = await verifyLiveDatabase(prisma);
    console.log(`Reconciliation (test-sample): database ${live.database}, account ${live.account}; ${options.execute ? 'EXECUTE' : 'DRY RUN'}.`);

    if (webhookHost(env.BITRIX24_WEBHOOK_URL) !== TARGET.portalHost) throw refuse('the webhook host in .env.test is not the allowed portal. Nothing was run.');
    const workerEnvironment = harness.workerEnv({ ...env, BITRIX_ALLOWED_PORTAL_HOST: TARGET.portalHost }, { live: true });
    const hostProblem = bitrixHostProblem(workerEnvironment);
    if (hostProblem) throw refuse(`the portal lock failed (${hostProblem}). Nothing was run.`);
    assertBitrixConfiguration(workerEnvironment);
    console.log(`  portal lock: webhook host equals ${TARGET.portalHost}; allowlist set for this process only.`);

    const plan = await preflight(prisma, realStore);
    console.log(`  event ${TARGET.eventId}: processing, lease expired, call started ${new Date(plan.event.external_call_started_at).toISOString()}; share ${TARGET.shareId}: attaching, no file id, file_ids_before ["${TARGET.recordedFileIdsBefore.join('", "')}"]; share ${TARGET.otherShareId} still references ${TARGET.otherFileId}.`);
    console.log(`  document ${TARGET.documentId} (${DOCUMENT_NAME}): clean, approved, current, checksum equals share ${TARGET.shareId}'s.`);

    // Only the guard (which holds the real fetch) can reach the network, and only for ONE crm.deal.get.
    const fetchGuard = makeFetchGuard(nativeFetch);
    globalThis.fetch = () => Promise.reject(new Error('Network access is disabled in this script (use the guarded client).'));

    const verified = await readExpectedDealFiles(realApi, workerEnvironment, fetchGuard.guardedFetch);
    console.log(`  Deal ${TARGET.dealId}: id, category ${TARGET.categoryId} and Case reference confirmed; the Documents field holds exactly [${verified.ids.join(', ')}].`);
    console.log(`  reconciliation would record: share ${TARGET.shareId} attached as file ${TARGET.confirmedFileId} (exactly one new file since ["${TARGET.recordedFileIdsBefore.join('", "')}"]), event ${TARGET.eventId} completed, audit rows "bitrix.deal.document.attached" (adopted_confirmed_by_person) and "bitrix.deal.document.existing_files_missing" (confirmed_missing_1).`);
    console.log('  it will NOT revoke share 3, authorize another generation, touch event 419 or any other event, read the document, notify, or send any Bitrix update.');
    if (!options.execute) {
      console.log(`Dry run: ${fetchGuard.state.reads} crm.deal.get request, 0 update; nothing was claimed or written. Add --execute --confirm CASE-3206 for the reconciliation.`);
      return;
    }

    // Verify again immediately before the pass; any change since the read above stops the run before a write.
    await verifyLiveDatabase(prisma);
    await preflight(prisma, realStore);
    const before = await snapshot(prisma);

    const api = makeGuardedApi(realApi, verified);
    const result = await runDealDocumentWorker({
      prisma, api, env: workerEnvironment, log: console, scope: { caseIds: [TARGET.caseId] }, notify: async () => {}, store: makeScopedStore(realStore), confirmedFileIds: { ...CONFIRMED_FILE_IDS },
      readFile: async () => { throw new Error('This script never reads the document file.'); },
    });
    console.log(`Pass finished: ${JSON.stringify(result)}; crm.deal.get requests: ${fetchGuard.state.reads}; worker reads answered from the verified read: ${api.state.reads}; refused: ${[...fetchGuard.state.refused, ...api.state.refused].join(', ') || 'none'}.`);

    const after = await snapshot(prisma);
    const ev = after.events.find((e) => Number(e.id) === TARGET.eventId);
    console.log(`  event ${TARGET.eventId}: ${ev.status}, attempts ${ev.attempts}${ev.last_error ? `, ${String(ev.last_error).slice(0, 60)}` : ''}`);
    console.log(`  share ${TARGET.shareId}: ${after.share4.status}, bitrix_file_id ${after.share4.bitrixFileId == null ? 'null' : after.share4.bitrixFileId}, attached_at ${after.share4.attachedAt ? 'set' : 'null'}`);
    console.log(`  audit rows for share ${TARGET.shareId}: ${after.audit.map((a) => `${a.action}${a.reason_code ? `(${a.reason_code})` : ''}`).join(', ')}`);
    const othersUntouched = before.events.filter((e) => Number(e.id) !== TARGET.eventId).every((b) => {
      const a = after.events.find((e) => Number(e.id) === Number(b.id));
      return a && a.status === b.status && Number(a.attempts) === Number(b.attempts);
    }) && JSON.stringify(before.share3) === JSON.stringify(after.share3);
    if (!othersUntouched) { console.error(`WARNING: another event, or share ${TARGET.otherShareId}, changed. Stop and investigate.`); process.exitCode = 2; }
    if (after.share4.status !== 'attached' || String(after.share4.bitrixFileId) !== TARGET.confirmedFileId || ev.status !== 'completed') {
      console.error('WARNING: the reconciliation did not complete as expected. Do not re-run blindly; inspect the event and share first.');
      process.exitCode = 2;
    }
  } finally {
    globalThis.fetch = nativeFetch;
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  main, parseArgs, makeFetchGuard, readExpectedDealFiles, makeGuardedApi, makeScopedStore, eventProblems, shareProblems, documentProblems, TARGET, DOCUMENT_NAME, CONFIRMED_FILE_IDS,
};
