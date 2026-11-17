// *** DISABLED (2026-11-17). DO NOT RUN. ***
// This script was written for the legacy Bitrix update path (crm.deal.get / crm.deal.update). The shared adapter now reads with crm.item.get and
// writes with crm.item.update, which this script's HTTP guard refuses, so a run would record the event as "ambiguous" although no call was made.
// Its event (420) and share (4) are also already settled. main() therefore stops at once, before the environment, the database or Bitrix is touched.
// A compatible, freshly fixed-scope script must be written for the next share/event.
// A ONE-SHOT, controlled LIVE attachment of ONE HumanCare document ("test-sample (1).pdf") to ONE Bitrix24 Deal (test database
// humancare_test). Independent of scripts/e2e-document-attach-live.js (which is fixed to document 2663 / share 3 / event 419 and
// is never touched by this one). NOT src/worker.js, NOT e2e-worker.js. It never starts a scheduled job and never offers any event
// except the one named below. The real document worker (runDealDocumentWorker) does the work, so its lease, evidence-before-call,
// fence, ambiguity and reconciliation rules all stay in force.
//
//   node scripts/e2e-document-attach-live-sample.js                                  DRY RUN (default): checks everything, reads Deal 21760 ONCE
//                                                                                    (crm.deal.get). No crm.deal.update, no claim, no write.
//   node scripts/e2e-document-attach-live-sample.js --execute --confirm CASE-3206    ONE worker pass: reads (at most 3 crm.deal.get) and EXACTLY
//                                                                                    ONE crm.deal.update for Deal 21760
//
// Fixed target (change the constants on purpose, never by a flag):
//   database humancare_test | CASE-3206 (id 2206) | request 3845 (REQ-4845) | document 2662 "test-sample (1).pdf" | share 4, generation 1
//   outbox event 420 (bitrix.deal.document.attach) | Deal 21760 | file field UF_CRM_1794832401 | portal b24-4orefh.bitrix24.in
//   Bitrix file 65608 (document 2663, share 3) is already on the Deal and MUST be kept.
//
// Safeguards, all checked before anything is sent:
//   * the database is verified (humancare_test, a humancare_test* user) at the start AND again right before the pass;
//   * the webhook in .env.test must name exactly the allowed host; BITRIX_ALLOWED_PORTAL_HOST is set to it for this process only;
//   * the worker's own scoped candidate query must return EXACTLY [420]; no other event of the Case may be open;
//   * share 3, event 419 and document 2663 are only READ: they must be as they are now (attached as file 65608 / completed) and are
//     compared again after the pass;
//   * the document is re-verified immediately before the attachment: still approved, scan clean, current, its checksum equals the
//     one recorded when the share was authorized, and the stored file's bytes hash to that checksum;
//   * every read of the Deal checks its id, its category, its Case reference AND that its Documents field still holds file 65608;
//   * the update must keep EVERY file id from the read just made, in order (so 65608 stays), plus exactly one new file whose bytes
//     hash to the document's checksum; the request body is checked again at the HTTP layer (host, method, Deal id, only the file field);
//   * no retry, no reconciliation write, no notification, no other Bitrix method.
const crypto = require('crypto');
const { applyIsolatedEnv } = require('./e2e-env');

const TARGET = Object.freeze({
  caseId: 2206, caseReference: 'CASE-3206', requestId: 3845, requestReference: 'REQ-4845',
  documentId: 2662, documentName: 'test-sample (1).pdf', documentRequestId: null, caseDocumentId: 706,
  shareId: 4, generation: 1, shareToken: 'HC-D2662G1-abce4555', eventId: 420,
  dealId: '21760', categoryId: '38', fileField: 'UF_CRM_1794832401', referenceField: 'UF_CRM_1794548440549',
  portalHost: 'b24-4orefh.bitrix24.in',
  preservedFileId: '65608',
  // Read-only: the earlier attachment that must not change.
  otherShareId: 3, otherDocumentId: 2663, otherEventId: 419,
  maxReads: 3, maxUpdates: 1,
});

class RunError extends Error {
  constructor(message) { super(`Live document attachment (test-sample): ${message}`); this.name = 'RunError'; }
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

// ---- the HTTP layer: the last check before a request leaves the machine -------------------------------------------------------
// `allowUpdate` is false in the dry run. Counts requests per method; the body is checked (Deal id, and for an update only the file field).
function makeFetchGuard(nativeFetch, { allowUpdate, maxReads = TARGET.maxReads, maxUpdates = TARGET.maxUpdates }) {
  const state = { reads: 0, updates: 0, refused: [] };
  const deny = (why) => { state.refused.push(why); throw new Error(`Guarded fetch: ${why}.`); };
  const guardedFetch = async (url, init) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return deny('unusable URL'); }
    if (parsed.hostname.toLowerCase() !== TARGET.portalHost) return deny('host is not the allowed portal');
    if (!init || init.method !== 'POST') return deny('POST only');
    let body;
    try { body = JSON.parse(init.body); } catch { return deny('unreadable body'); }
    if (!body || String(body.id) !== TARGET.dealId) return deny('not Deal 21760');
    if (parsed.pathname.endsWith('/crm.deal.get.json')) {
      if (state.reads + 1 > maxReads) return deny('too many crm.deal.get requests');
      state.reads += 1;
    } else if (parsed.pathname.endsWith('/crm.deal.update.json')) {
      if (!allowUpdate) return deny('crm.deal.update is not allowed in this mode');
      if (state.updates + 1 > maxUpdates) return deny('only one crm.deal.update is allowed');
      const keys = body.fields && typeof body.fields === 'object' ? Object.keys(body.fields) : [];
      if (keys.length !== 1 || keys[0] !== TARGET.fileField || !Array.isArray(body.fields[TARGET.fileField])) return deny('an update may only set the Documents field');
      state.updates += 1;
    } else return deny('only crm.deal.get and crm.deal.update are allowed');
    return nativeFetch(url, init);
  };
  return { guardedFetch, state };
}

// A read of Deal 21760 that is verified before anyone may use its file ids: id, category and Case reference must match, and the
// Documents field must still hold the file that has to be preserved.
async function readVerifiedDealFiles(realApi, env, guardedFetch) {
  const read = await realApi.getDeal(TARGET.dealId, { env, fetchImpl: guardedFetch });
  if (read.status !== 'ok') return { status: read.status, reason: read.reason };
  const deal = read.deal;
  if (String(deal.ID) !== TARGET.dealId) throw new Error('Deal check failed: the answer is for another Deal.');
  if (String(deal.CATEGORY_ID) !== TARGET.categoryId) throw new Error('Deal check failed: wrong category.');
  if (deal[TARGET.referenceField] !== TARGET.caseReference) throw new Error('Deal check failed: the Deal does not carry this Case reference.');
  const ids = realApi.fileIdsOf(deal[TARGET.fileField]);
  if (ids === null) return { status: 'uncertain', reason: 'unexpected_files_shape' };
  if (!ids.includes(TARGET.preservedFileId)) throw new Error(`Deal check failed: the Documents field does not hold file ${TARGET.preservedFileId}.`);
  return { status: 'ok', ids };
}

// The only Bitrix surface the worker sees. Reads are verified; the update is checked against the read just made.
function makeGuardedApi(realApi, env, fetchGuard, expectedSha256) {
  const { guardedFetch, state } = fetchGuard;
  let lastReadIds = null;
  const api = {
    state,
    BitrixDealCallError: realApi.BitrixDealCallError,
    getDealFiles: async (dealId) => {
      if (String(dealId) !== TARGET.dealId) { state.refused.push('getDealFiles(other deal)'); throw new Error('Only Deal 21760 may be read.'); }
      const read = await readVerifiedDealFiles(realApi, env, guardedFetch);
      if (read.status === 'ok') lastReadIds = read.ids;
      return read;
    },
    updateDealFiles: async (dealId, entries, options = {}) => {
      if (String(dealId) !== TARGET.dealId) { state.refused.push('updateDealFiles(other deal)'); throw new Error('Only Deal 21760 may be updated.'); }
      if (options.allowEmpty) { state.refused.push('updateDealFiles(allowEmpty)'); throw new Error('An empty file list is never sent by this script.'); }
      if (!lastReadIds || !Array.isArray(entries) || entries.length !== lastReadIds.length + 1) { state.refused.push('updateDealFiles(shape)'); throw new Error('The update must be the last read list plus exactly one new file.'); }
      const keep = entries.slice(0, -1);
      if (keep.some((entry, i) => !entry || entry.fileData !== undefined || String(entry.id) !== String(lastReadIds[i]))) { state.refused.push('updateDealFiles(keep)'); throw new Error('Every existing file id must be kept, in order.'); }
      if (!keep.some((entry) => String(entry.id) === TARGET.preservedFileId)) { state.refused.push('updateDealFiles(preserved)'); throw new Error(`File ${TARGET.preservedFileId} must stay on the Deal.`); }
      const add = entries[entries.length - 1];
      const [name, base64] = add && Array.isArray(add.fileData) ? add.fileData : [];
      if (typeof name !== 'string' || !name.startsWith(`${TARGET.shareToken}__`) || !name.toLowerCase().endsWith('.pdf')) { state.refused.push('updateDealFiles(name)'); throw new Error('The new file name is not this share\'s.'); }
      if (typeof base64 !== 'string' || crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') !== expectedSha256) { state.refused.push('updateDealFiles(checksum)'); throw new Error('The new file does not match the document checksum.'); }
      return realApi.updateDealFiles(dealId, entries, { ...options, fetchImpl: guardedFetch });
    },
  };
  for (const method of ['createDeal', 'findDealsByReference', 'getDeal']) {
    api[method] = async () => { state.refused.push(method); throw new Error(`Bitrix24 method ${method} is disabled in this script.`); };
  }
  return api;
}

// ---- database pre-flight (read-only) ------------------------------------------------------------------------------------------
const rows = (db, sql, ...args) => db.$queryRawUnsafe(sql, ...args);

async function loadDocumentAndShare(prisma) {
  const document = await prisma.requestDocument.findUnique({ where: { id: TARGET.documentId } });
  const share = await prisma.bitrixDealDocument.findUnique({ where: { id: TARGET.shareId } });
  return { document, share };
}

function documentProblems(document, share) {
  const p = [];
  if (!document) return [`document ${TARGET.documentId} not found`];
  if (document.serviceRequestId !== TARGET.requestId || document.originalName !== TARGET.documentName) p.push(`the document is not "${TARGET.documentName}" of request ${TARGET.requestId}`);
  if (document.documentRequestId !== TARGET.documentRequestId || document.caseDocumentId !== TARGET.caseDocumentId) p.push('the document request or Case document link changed');
  if (document.scanStatus !== 'clean') p.push(`the virus scan is "${document.scanStatus}", not clean`);
  if (document.reviewStatus !== 'approved') p.push(`the document is "${document.reviewStatus}", not approved`);
  if (document.supersededAt) p.push('the document was replaced by a newer one');
  if (!document.sha256) p.push('the document has no checksum');
  if (share && document.sha256 !== share.sha256) p.push('the checksum changed since the share was authorized');
  return p;
}

// What must not change (read-only): the earlier attachment of document 2663.
const otherAttachmentProblems = (otherShare, otherEvent) => {
  const p = [];
  if (!otherShare || otherShare.status !== 'attached' || String(otherShare.bitrixFileId) !== TARGET.preservedFileId || otherShare.requestDocumentId !== TARGET.otherDocumentId) p.push(`share ${TARGET.otherShareId} is not attached as file ${TARGET.preservedFileId}`);
  if (!otherEvent || otherEvent.status !== 'completed') p.push(`event ${TARGET.otherEventId} is not completed`);
  return p;
};

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

  const { document, share } = await loadDocumentAndShare(prisma);
  problems.push(...documentProblems(document, share));
  if (!share) problems.push(`share ${TARGET.shareId} not found`);
  else {
    if (Number(share.dealLinkId) !== Number(c.link_id) || share.requestDocumentId !== TARGET.documentId) problems.push('the share is not for this document and Deal link');
    if (share.generation !== TARGET.generation || share.shareToken !== TARGET.shareToken) problems.push(`the share is not generation ${TARGET.generation} of this document`);
    if (share.status !== 'authorized') problems.push(`the share is "${share.status}", not "authorized"`);
    if (share.tryCount !== 1 || share.attempts !== 0) problems.push('the share has already been tried');
    if (share.bitrixFileId != null || share.fileIdsBefore != null) problems.push('the share may already have been sent to Bitrix24');
  }
  const shares = await prisma.bitrixDealDocument.findMany({ where: { requestDocumentId: TARGET.documentId }, select: { id: true, status: true } });
  if (shares.some((s) => s.id !== TARGET.shareId && s.status !== 'revoked')) problems.push('another active share exists for this document');

  const events = await rows(prisma,
    'SELECT id, event_type, entity_id, status, attempts, external_call_started_at, locked_until, last_error FROM integration_outbox WHERE case_id = ? ORDER BY id', TARGET.caseId);
  const target = events.find((e) => Number(e.id) === TARGET.eventId);
  if (!target || target.event_type !== 'bitrix.deal.document.attach' || target.entity_id !== `${TARGET.shareId}:attach:1`) problems.push(`event ${TARGET.eventId} is not the attach event of share ${TARGET.shareId}`);
  else if (target.status !== 'pending' || Number(target.attempts) !== 0 || target.external_call_started_at != null || target.locked_until != null || target.last_error != null) {
    problems.push(`event ${TARGET.eventId} is not a clean pending event (status ${target.status}, attempts ${target.attempts})`);
  }
  const open = events.filter((e) => ['pending', 'ambiguous', 'processing'].includes(e.status)).map((e) => Number(e.id));
  if (JSON.stringify(open) !== JSON.stringify([TARGET.eventId])) problems.push(`open events of the Case are [${open.join(', ')}], expected exactly [${TARGET.eventId}]`);

  const otherShare = await prisma.bitrixDealDocument.findUnique({ where: { id: TARGET.otherShareId } });
  problems.push(...otherAttachmentProblems(otherShare, events.find((e) => Number(e.id) === TARGET.otherEventId)));

  const scope = { caseIds: [TARGET.caseId] };
  const offered = [...(await store.findCandidateIds(prisma, 'pending', 50, scope)), ...(await store.findCandidateIds(prisma, 'ambiguous', 50, scope))];
  if (JSON.stringify(offered) !== JSON.stringify([TARGET.eventId])) problems.push(`the worker would offer [${offered.join(', ')}], expected exactly [${TARGET.eventId}]`);

  if (problems.length) throw refuse(`pre-flight failed (${problems.join('; ')}). Nothing was run.`);
  return { document, share, offered, others: events.filter((e) => Number(e.id) !== TARGET.eventId) };
}

// The document's file is read and hashed: it must still be exactly what was authorized. Local only (no Bitrix).
async function verifyFileBytes(prisma, readVerifiedFile) {
  const { document, share } = await loadDocumentAndShare(prisma);
  const problems = documentProblems(document, share);
  if (problems.length) throw refuse(`the document is no longer eligible (${problems.join('; ')}).`);
  const bytes = await readVerifiedFile(document); // also checks the stored size and checksum
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== document.sha256) throw refuse('the stored file does not match its checksum.');
  return { document, bytes };
}

async function snapshot(prisma) {
  const [event] = await rows(prisma, 'SELECT id, status, attempts, last_error, external_call_started_at FROM integration_outbox WHERE id = ?', TARGET.eventId);
  const share = await prisma.bitrixDealDocument.findUnique({ where: { id: TARGET.shareId }, select: { status: true, bitrixFileId: true, attempts: true, tryCount: true, lastError: true, attachedAt: true } });
  const other = await prisma.bitrixDealDocument.findUnique({ where: { id: TARGET.otherShareId }, select: { status: true, bitrixFileId: true, attachedAt: true, tryCount: true } });
  const events = await rows(prisma, 'SELECT id, status, attempts FROM integration_outbox WHERE case_id = ? ORDER BY id', TARGET.caseId);
  return { event, share, other, events };
}

async function main(argv) {
  throw refuse('this script is DISABLED: it is incompatible with the crm.item.update adapter. Nothing was run.');
  // eslint-disable-next-line no-unreachable
  const options = parseArgs(argv);
  const env = applyIsolatedEnv(); // validates the test environment before Prisma is loaded

  const { prisma } = require('../src/db/prisma');
  const { verifyLiveDatabase } = require('../src/common/safety/test-database-guard');
  const { webhookHost, bitrixHostProblem, assertBitrixConfiguration } = require('../src/modules/bitrix/bitrix-config');
  const store = require('../src/modules/bitrix/deal-document.store');
  const realApi = require('../src/modules/bitrix/bitrix-deal.api');
  const { readVerifiedFile } = require('../src/modules/request-review/request-review.files');
  const { runDealDocumentWorker } = require('../src/modules/bitrix/deal-document-worker.service');
  const harness = require('../src/modules/bitrix/deal-worker-harness');

  const nativeFetch = globalThis.fetch;
  try {
    const live = await verifyLiveDatabase(prisma);
    console.log(`Live document attachment (test-sample): database ${live.database}, account ${live.account}; ${options.execute ? 'EXECUTE' : 'DRY RUN'}.`);

    // Portal lock. The host only is printed; the webhook itself never is.
    if (webhookHost(env.BITRIX24_WEBHOOK_URL) !== TARGET.portalHost) throw refuse('the webhook host in .env.test is not the allowed portal. Nothing was run.');
    const workerEnvironment = harness.workerEnv({ ...env, BITRIX_ALLOWED_PORTAL_HOST: TARGET.portalHost }, { live: true });
    const hostProblem = bitrixHostProblem(workerEnvironment);
    if (hostProblem) throw refuse(`the portal lock failed (${hostProblem}). Nothing was run.`);
    assertBitrixConfiguration(workerEnvironment);
    console.log(`  portal lock: webhook host equals ${TARGET.portalHost}; allowlist set for this process only.`);

    const plan = await preflight(prisma, store);
    const local = await verifyFileBytes(prisma, readVerifiedFile);
    console.log(`  case ${TARGET.caseId} (${TARGET.caseReference}), document ${TARGET.documentId}, share ${TARGET.shareId} (generation ${TARGET.generation}, ${plan.share.status}), Deal ${TARGET.dealId}.`);
    console.log(`  document: scan clean, review approved, ${local.bytes.length} bytes, checksum verified against the share.`);
    console.log(`  the worker would offer exactly: ${plan.offered.join(', ')}; the Case's other events stay untouched (${plan.others.map((e) => `${e.id} ${e.status}`).join(', ') || 'none'}); share ${TARGET.otherShareId} / file ${TARGET.preservedFileId} is only read.`);

    // Replace global fetch for this process: only the guard (which holds the real one) can reach the network.
    const fetchGuard = makeFetchGuard(nativeFetch, { allowUpdate: options.execute });
    globalThis.fetch = () => Promise.reject(new Error('Network access is disabled in this script (use the guarded client).'));

    if (!options.execute) {
      // The one read-only crm.deal.get of the dry run (it also requires file 65608 to be on the Deal).
      const read = await readVerifiedDealFiles(realApi, workerEnvironment, fetchGuard.guardedFetch);
      if (read.status !== 'ok') throw refuse(`the Deal could not be read (${read.status}${read.reason ? `: ${read.reason}` : ''}).`);
      console.log(`  Deal ${TARGET.dealId}: id, category ${TARGET.categoryId} and Case reference confirmed; the Documents field holds ${read.ids.length} file(s): [${read.ids.join(', ')}], including ${TARGET.preservedFileId}.`);
      console.log(`  a live run would send ONE crm.deal.update keeping those ${read.ids.length} id(s) (in this order) plus one new file named ${TARGET.shareToken}__....pdf.`);
      console.log(`Dry run: ${fetchGuard.state.reads} crm.deal.get request, 0 crm.deal.update; nothing was claimed or written. Add --execute --confirm CASE-3206 for the live run.`);
      return;
    }

    // Verify again immediately before the pass, then re-check the plan. The worker re-verifies the document at send time through readFile.
    await verifyLiveDatabase(prisma);
    await preflight(prisma, store);
    const before = await snapshot(prisma);

    const api = makeGuardedApi(realApi, workerEnvironment, fetchGuard, local.document.sha256);
    // Called by the worker right before it reads the Deal: approval, scan, checksum and the stored bytes are checked again.
    const readFile = async () => (await verifyFileBytes(prisma, readVerifiedFile)).bytes;
    const result = await runDealDocumentWorker({
      prisma, api, env: workerEnvironment, log: console, scope: { caseIds: [TARGET.caseId] }, notify: async () => {}, readFile,
    });
    console.log(`Pass finished: ${JSON.stringify(result)}; crm.deal.get requests: ${fetchGuard.state.reads}; crm.deal.update requests: ${fetchGuard.state.updates}; refused: ${[...fetchGuard.state.refused, ...api.state.refused].join(', ') || 'none'}.`);

    const after = await snapshot(prisma);
    console.log(`  event ${TARGET.eventId}: ${after.event.status}, attempts ${after.event.attempts}${after.event.last_error ? `, ${String(after.event.last_error).slice(0, 60)}` : ''}`);
    console.log(`  share ${TARGET.shareId}: ${after.share.status}, bitrix_file_id ${after.share.bitrixFileId == null ? 'null' : after.share.bitrixFileId}, attempts ${after.share.attempts}${after.share.lastError ? `, ${String(after.share.lastError).slice(0, 60)}` : ''}`);
    const untouched = before.events.filter((e) => Number(e.id) !== TARGET.eventId).every((b) => {
      const a = after.events.find((e) => Number(e.id) === Number(b.id));
      return a && a.status === b.status && Number(a.attempts) === Number(b.attempts);
    }) && JSON.stringify(before.other) === JSON.stringify(after.other);
    if (!untouched) { console.error(`WARNING: another event of the Case, or share ${TARGET.otherShareId}, changed. Stop and investigate.`); process.exitCode = 2; }
    if (fetchGuard.state.updates !== 1) { console.error(`WARNING: crm.deal.update requests: ${fetchGuard.state.updates} (expected exactly 1). Stop and investigate; do not re-run.`); process.exitCode = 2; }
    if (after.share.status === 'ambiguous' || after.event.status === 'ambiguous') console.error('NOTE: the outcome is ambiguous. Do NOT re-run this script; the worker reconciles by reading the Deal.');
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

module.exports = { main, parseArgs, makeFetchGuard, makeGuardedApi, readVerifiedDealFiles, documentProblems, otherAttachmentProblems, TARGET };
