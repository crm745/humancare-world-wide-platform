// A fixed-scope, one-shot LIVE attachment of the JPEG `WhatsApp Image 2026-10-29 at 12.03.51 AM.jpeg` (document 2664, share 6, attach event 423)
// to the EXISTING Bitrix24 Deal 21760 (CASE-3206), test database humancare_test. Both PDFs already on the Deal (files 65616 and 65618) must stay.
//
//   node scripts/e2e-attach-document-2664.js --phase attach                                      DRY RUN (default): database + file checks + ONE crm.item.get
//   node scripts/e2e-attach-document-2664.js --phase attach --execute --confirm CASE-3206        ONE scoped worker pass: ONE crm.item.update
//   node scripts/e2e-attach-document-2664.js --phase verify                                      read-only: database + ONE crm.item.get
//
// It runs the existing document worker (runDealDocumentWorker) for exactly event 423 and Case 2206, with the corrected adapter: crm.item.get immediately
// before the update, then EXACTLY ONE crm.item.update keeping files 65616 and 65618 as numeric { id } entries and adding the JPEG as the documented
// [name, base64] pair, then the worker's own verification reads (every prior id still there, exactly one new id). An ambiguous answer, a vanished
// file or an unexpected id is MANUAL REVIEW: nothing is adopted automatically and nothing is retried. Never used: crm.deal.update, the disabled
// attach scripts, the general worker, any other Deal, share, event or document. Shares 3, 4 and 5 and events 416-422 are only READ.
const crypto = require('crypto');
const { applyIsolatedEnv } = require('./e2e-env');

const TARGET = Object.freeze({
  caseId: 2206, caseReference: 'CASE-3206', requestId: 3845,
  documentId: 2664, documentName: 'WhatsApp Image 2026-10-29 at 12.03.51 AM.jpeg', documentRequestId: 2, caseDocumentId: 708, detectedType: 'jpeg',
  shareId: 6, generation: 1, shareToken: 'HC-D2664G1-6beaf795', eventId: 423,
  dealId: '21760', entityTypeId: 2, fileKey: 'ufCrm_1794832401', portalHost: 'b24-4orefh.bitrix24.in',
  preservedFileIds: Object.freeze(['65616', '65618']),
  otherShares: Object.freeze([{ id: 4, documentId: 2662, fileId: '65616' }, { id: 5, documentId: 2663, fileId: '65618' }]),
  staleShareId: 3, staleFileId: '65608',
  maxReads: 3, maxUpdates: 1,
});
const PHASES = ['attach', 'verify'];

class RunError extends Error {
  constructor(message) { super(`Attach document 2664: ${message}`); this.name = 'RunError'; }
}
const refuse = (message) => new RunError(message);
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parseArgs(argv) {
  const out = { phase: null, execute: false, confirmed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--phase') { out.phase = argv[i + 1]; i += 1; } else if (arg === '--execute') out.execute = true;
    else if (arg === '--confirm') {
      if (argv[i + 1] !== TARGET.caseReference) throw refuse(`--confirm must be followed by ${TARGET.caseReference}.`);
      out.confirmed = true;
      i += 1;
    } else throw refuse(`unknown argument "${String(arg).slice(0, 30)}". Use: --phase <${PHASES.join('|')}> [--execute --confirm ${TARGET.caseReference}].`);
  }
  if (!PHASES.includes(out.phase)) throw refuse(`--phase must be one of ${PHASES.join(', ')}.`);
  if (out.execute && !out.confirmed) throw refuse(`--execute needs --confirm ${TARGET.caseReference}.`);
  if (out.confirmed && !out.execute) throw refuse('--confirm only applies together with --execute.');
  if (out.execute && out.phase !== 'attach') throw refuse(`phase ${out.phase} is read-only; --execute is not accepted.`);
  return out;
}

// ---- the HTTP layer ------------------------------------------------------------------------------------------------------------------
// crm.item.update only when allowed, ONCE, for Deal 21760, only the Documents field, and only the exact list: numeric 65616, numeric 65618, ONE pair.
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
    if (!body || body.entityTypeId !== TARGET.entityTypeId) return deny('only entityTypeId 2 (Deal) is allowed');
    if (body.id !== Number(TARGET.dealId)) return deny('not Deal 21760 (a numeric id is required)');
    if (parsed.pathname.endsWith('/crm.item.get.json')) {
      if (state.reads + 1 > maxReads) return deny('too many crm.item.get requests');
      state.reads += 1;
    } else if (parsed.pathname.endsWith('/crm.item.update.json')) {
      if (!allowUpdate) return deny('crm.item.update is not allowed in this phase');
      if (state.updates + 1 > maxUpdates) return deny('only one crm.item.update is allowed');
      const keys = body.fields && typeof body.fields === 'object' ? Object.keys(body.fields) : [];
      if (keys.length !== 1 || keys[0] !== TARGET.fileKey) return deny('an update may only set the Documents field');
      const list = body.fields[TARGET.fileKey];
      const keeps = Array.isArray(list) && list.length === TARGET.preservedFileIds.length + 1
        && TARGET.preservedFileIds.every((id, i) => list[i] && typeof list[i] === 'object' && !Array.isArray(list[i]) && Object.keys(list[i]).join() === 'id' && list[i].id === Number(id));
      const pair = Array.isArray(list) && Array.isArray(list[list.length - 1]) && list[list.length - 1].length === 2 && list[list.length - 1].every((p) => typeof p === 'string' && p !== '');
      if (!keeps || !pair) return deny(`the list must keep ${TARGET.preservedFileIds.map((id) => `{ id: ${id} }`).join(' and ')} (numeric, in this order) and add exactly one [name, base64] pair`);
      state.updates += 1;
    } else return deny('only crm.item.get and crm.item.update are allowed');
    return nativeFetch(url, init);
  };
  return { guardedFetch, state };
}

// ---- the Bitrix surface the worker sees ----------------------------------------------------------------------------------------------------
// The FIRST read must be exactly [65616, 65618] (checked before any update); later reads (the worker's verification) are returned for the worker to judge.
function makeGuardedApi(realApi, env, fetchGuard, { allowUpdate, expectedName, expectedSha256 }) {
  const { guardedFetch, state } = fetchGuard;
  const api = { state, BitrixDealCallError: realApi.BitrixDealCallError, reads: 0 };
  api.getDealFiles = async (dealId) => {
    if (String(dealId) !== TARGET.dealId) { state.refused.push('getDealFiles(other deal)'); throw new Error('Only Deal 21760 may be read.'); }
    api.reads += 1;
    const read = await realApi.getDealFiles(TARGET.dealId, { env, fetchImpl: guardedFetch });
    if (api.reads === 1 && (read.status !== 'ok' || !sameList(read.ids, TARGET.preservedFileIds))) {
      state.refused.push('unexpected first read');
      throw new Error(`The Deal's files are not exactly [${TARGET.preservedFileIds.join(', ')}] before the update. Stopped before any change.`);
    }
    return read;
  };
  api.updateDealFiles = async (dealId, entries, options = {}) => {
    if (!allowUpdate) { state.refused.push('updateDealFiles'); throw new Error('No Bitrix update is allowed in this phase.'); }
    if (String(dealId) !== TARGET.dealId || options.allowEmpty) { state.refused.push('updateDealFiles(args)'); throw new Error('Only a non-empty list for Deal 21760 may be sent.'); }
    const keep = Array.isArray(entries) ? entries.slice(0, -1) : [];
    const add = Array.isArray(entries) ? entries[entries.length - 1] : null;
    const ok = Array.isArray(entries) && entries.length === TARGET.preservedFileIds.length + 1
      && TARGET.preservedFileIds.every((id, i) => keep[i] && String(keep[i].id) === id && keep[i].fileData === undefined)
      && add && Array.isArray(add.fileData) && add.id === undefined;
    if (!ok) { state.refused.push('updateDealFiles(shape)'); throw new Error(`The update must keep files ${TARGET.preservedFileIds.join(' and ')} (in order) and add exactly one new file.`); }
    const [name, base64] = add.fileData;
    if (name !== expectedName) { state.refused.push('updateDealFiles(name)'); throw new Error('The new file name is not this share\'s.'); }
    if (typeof base64 !== 'string' || crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') !== expectedSha256) { state.refused.push('updateDealFiles(checksum)'); throw new Error('The new file does not match the document checksum.'); }
    return realApi.updateDealFiles(dealId, entries, { ...options, fetchImpl: guardedFetch });
  };
  for (const method of ['createDeal', 'findDealsByReference', 'getDeal']) {
    api[method] = async () => { state.refused.push(method); throw new Error(`Bitrix24 method ${method} is disabled in this script.`); };
  }
  return api;
}

// The worker's store with its door narrowed to ONE event of Case 2206.
function makeScopedStore(realStore, eventId) {
  return {
    ...realStore,
    findCandidateIds: async (db, status, limit, scope) => {
      const ids = await realStore.findCandidateIds(db, status, limit, scope);
      if (ids.some((id) => id !== eventId)) throw new Error(`The worker offered [${ids.join(', ')}], not only event ${eventId}. Stopped before any claim.`);
      return ids;
    },
    claim: async (db, args) => {
      if (args.id !== eventId) throw new Error(`Refusing to claim event ${args.id}.`);
      return realStore.claim(db, args);
    },
  };
}

// ---- database state (read-only) -------------------------------------------------------------------------------------------------------------
const rows = (db, sql, ...args) => db.$queryRawUnsafe(sql, ...args);

function documentProblems(doc, sha256) {
  if (!doc) return [`document ${TARGET.documentId} not found`];
  const p = [];
  if (doc.serviceRequestId !== TARGET.requestId || doc.originalName !== TARGET.documentName) p.push(`the document is not "${TARGET.documentName}" of request ${TARGET.requestId}`);
  if (doc.documentRequestId !== TARGET.documentRequestId || doc.caseDocumentId !== TARGET.caseDocumentId) p.push('the document request or Case document link changed');
  if (doc.scanStatus !== 'clean') p.push(`the virus scan is "${doc.scanStatus}", not clean`);
  if (doc.reviewStatus !== 'approved') p.push(`the document is "${doc.reviewStatus}", not approved`);
  if (doc.supersededAt) p.push('the document was replaced by a newer one');
  if (!doc.sha256) p.push('the document has no checksum');
  if (sha256 !== undefined && doc.sha256 !== sha256) p.push('the checksum differs from the one on the share');
  return p;
}

async function loadState(prisma) {
  const [c] = await rows(prisma,
    `SELECT c.id, c.reference_number, c.service_request_id, sr.service_key, sr.review_status, l.id AS link_id, l.bitrix_deal_id, l.file_locked_until
     FROM cases c JOIN service_requests sr ON sr.id = c.service_request_id LEFT JOIN bitrix_deal_links l ON l.case_id = c.id WHERE c.id = ?`, TARGET.caseId);
  const doc = await prisma.requestDocument.findUnique({ where: { id: TARGET.documentId } });
  const shares = await prisma.bitrixDealDocument.findMany({ where: { dealLinkId: c ? Number(c.link_id) : -1 }, orderBy: { id: 'asc' } });
  const events = await rows(prisma,
    'SELECT id, event_type, entity_id, status, attempts, last_error, external_call_started_at, locked_until FROM integration_outbox WHERE case_id = ? ORDER BY id', TARGET.caseId);
  return { c, doc, shares, events };
}

// What the attach phase needs: the exact share, event and document, the two earlier PDFs attached as recorded, nothing else open.
function attachProblems(st) {
  const p = [];
  const { c } = st;
  if (!c) return ['case 2206 not found'];
  if (c.reference_number !== TARGET.caseReference || Number(c.service_request_id) !== TARGET.requestId) p.push('the Case or request is not CASE-3206 / request 3845');
  if (c.service_key !== 'privatecharter' || c.review_status !== 'approved') p.push('the request is not an approved Private Charter request');
  if (String(c.bitrix_deal_id) !== TARGET.dealId) p.push(`the Case's Deal id is not ${TARGET.dealId}`);
  if (c.file_locked_until != null && new Date(c.file_locked_until).getTime() > Date.now()) p.push('the Deal file lease is held by another process');
  const share = st.shares.find((s) => s.id === TARGET.shareId);
  p.push(...documentProblems(st.doc, share && share.sha256));
  if (!share) p.push(`share ${TARGET.shareId} not found`);
  else {
    if (share.requestDocumentId !== TARGET.documentId || share.generation !== TARGET.generation || share.shareToken !== TARGET.shareToken || Number(share.dealLinkId) !== Number(c.link_id)) p.push(`share ${TARGET.shareId} is not generation ${TARGET.generation} of document ${TARGET.documentId} on this Deal link`);
    if (share.detectedType !== TARGET.detectedType) p.push(`share ${TARGET.shareId} is not a ${TARGET.detectedType}`);
    if (share.status !== 'authorized' || share.tryCount !== 1 || share.attempts !== 0 || share.bitrixFileId != null || share.fileIdsBefore != null) p.push(`share ${TARGET.shareId} is not a fresh, never-sent "authorized" share`);
  }
  if (st.shares.filter((s) => s.requestDocumentId === TARGET.documentId && s.id !== TARGET.shareId && s.status !== 'revoked').length) p.push('another active share exists for this document');
  for (const o of TARGET.otherShares) {
    const s = st.shares.find((x) => x.id === o.id);
    if (!s || s.status !== 'attached' || String(s.bitrixFileId) !== o.fileId || s.requestDocumentId !== o.documentId) p.push(`share ${o.id} is not attached as file ${o.fileId}`);
  }
  const stale = st.shares.find((s) => s.id === TARGET.staleShareId);
  if (!stale || stale.status !== 'revoked') p.push(`share ${TARGET.staleShareId} is not revoked`);
  const open = st.events.filter((e) => ['pending', 'ambiguous', 'processing'].includes(e.status));
  const ev = st.events.find((e) => Number(e.id) === TARGET.eventId);
  if (!ev || ev.event_type !== 'bitrix.deal.document.attach' || ev.entity_id !== `${TARGET.shareId}:attach:1`) p.push(`event ${TARGET.eventId} is not the attach event of share ${TARGET.shareId}`);
  else if (ev.status !== 'pending' || Number(ev.attempts) !== 0 || ev.external_call_started_at != null || ev.locked_until != null || ev.last_error != null) p.push(`event ${TARGET.eventId} is not a clean pending event (status ${ev.status}, attempts ${ev.attempts})`);
  if (!sameList(open.map((e) => Number(e.id)), [TARGET.eventId])) p.push(`open events of the Case are [${open.map((e) => e.id).join(', ')}], expected exactly [${TARGET.eventId}]`);
  return p;
}

async function snapshot(prisma) {
  const st = await loadState(prisma);
  const audit = await rows(prisma, "SELECT id, entity_id, action, reason_code FROM audit_logs WHERE entity_type = 'bitrix_deal_document' ORDER BY id");
  return { ...st, audit };
}

const show = (snap) => {
  for (const s of snap.shares) console.log(`  share ${s.id}: document ${s.requestDocumentId}, generation ${s.generation}, ${s.status}, bitrix_file_id ${s.bitrixFileId == null ? 'null' : s.bitrixFileId}`);
  for (const e of snap.events.filter((x) => Number(x.id) >= 419)) console.log(`  event ${e.id}: ${e.event_type} ${e.entity_id} ${e.status}${e.last_error ? ` (${String(e.last_error).slice(0, 50)})` : ''}`);
  for (const a of snap.audit.filter((x) => ['5', '6'].includes(String(x.entity_id)))) console.log(`  audit ${a.id}: share ${a.entity_id} ${a.action} (${a.reason_code || ''})`);
};

// ---- main -----------------------------------------------------------------------------------------------------------------------------------
async function main(argv) {
  const options = parseArgs(argv);
  const env = applyIsolatedEnv(); // validates the test environment before Prisma is loaded

  const { prisma } = require('../src/db/prisma');
  const { verifyLiveDatabase } = require('../src/common/safety/test-database-guard');
  const { webhookHost, bitrixHostProblem, assertBitrixConfiguration } = require('../src/modules/bitrix/bitrix-config');
  const realStore = require('../src/modules/bitrix/deal-document.store');
  const realApi = require('../src/modules/bitrix/bitrix-deal.api');
  const { readVerifiedFile } = require('../src/modules/request-review/request-review.files');
  const { detectFileType } = require('../src/modules/documents/file-type');
  const { runDealDocumentWorker, remoteFileName } = require('../src/modules/bitrix/deal-document-worker.service');
  const harness = require('../src/modules/bitrix/deal-worker-harness');

  const nativeFetch = globalThis.fetch;
  try {
    const live = await verifyLiveDatabase(prisma);
    console.log(`Attach document 2664: database ${live.database}; phase ${options.phase}; ${options.execute ? 'EXECUTE' : (options.phase === 'attach' ? 'DRY RUN' : 'READ-ONLY')}.`);
    if (webhookHost(env.BITRIX24_WEBHOOK_URL) !== TARGET.portalHost) throw refuse('the webhook host in .env.test is not the allowed portal. Nothing was run.');
    const workerEnvironment = harness.workerEnv({ ...env, BITRIX_ALLOWED_PORTAL_HOST: TARGET.portalHost }, { live: true });
    const hostProblem = bitrixHostProblem(workerEnvironment);
    if (hostProblem) throw refuse(`the portal lock failed (${hostProblem}). Nothing was run.`);
    assertBitrixConfiguration(workerEnvironment);

    const st = await loadState(prisma);
    if (options.phase === 'attach') {
      const problems = attachProblems(st);
      if (problems.length) throw refuse(`the state is not what the attach phase needs (${problems.join('; ')}). Nothing was run.`);
      console.log(`  database state OK: document ${TARGET.documentId}, share ${TARGET.shareId} (generation ${TARGET.generation}, authorized, token ${TARGET.shareToken}), event ${TARGET.eventId} pending.`);
    }

    // The stored file must still be exactly what was authorized (local only).
    const verifyBytes = async () => {
      const doc = await prisma.requestDocument.findUnique({ where: { id: TARGET.documentId } });
      const share = await prisma.bitrixDealDocument.findUnique({ where: { id: TARGET.shareId } });
      const p = documentProblems(doc, share && share.sha256);
      if (p.length) throw refuse(`the document is no longer eligible (${p.join('; ')}).`);
      const bytes = await readVerifiedFile(doc); // checks the stored size and checksum
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== doc.sha256) throw refuse('the stored file does not match its checksum.');
      if (detectFileType(bytes) !== TARGET.detectedType) throw refuse(`the file's own bytes are not a ${TARGET.detectedType}.`);
      return { doc, share, bytes };
    };

    const fetchGuard = makeFetchGuard(nativeFetch, { allowUpdate: options.phase === 'attach' && options.execute });
    globalThis.fetch = () => Promise.reject(new Error('Network access is disabled in this script (use the guarded client).'));
    const readDeal = () => realApi.getDealFiles(TARGET.dealId, { env: workerEnvironment, fetchImpl: fetchGuard.guardedFetch });

    if (options.phase === 'verify') {
      const read = await readDeal();
      if (read.status !== 'ok') throw refuse(`the Deal could not be read (${read.status}${read.reason ? `: ${read.reason}` : ''}).`);
      console.log(`  Deal ${TARGET.dealId} (crm.item.get): file ids [${read.ids.join(', ')}].`);
      const snap = await snapshot(prisma);
      show(snap);
      const share = snap.shares.find((s) => s.id === TARGET.shareId);
      const added = read.ids.filter((id) => !TARGET.preservedFileIds.includes(id));
      const checks = [];
      const add = (ok, text) => checks.push({ ok, text });
      add(TARGET.preservedFileIds.every((id) => read.ids.includes(id)), `files ${TARGET.preservedFileIds.join(' and ')} are still on the Deal`);
      add(read.ids.length === TARGET.preservedFileIds.length + 1, `the Deal holds exactly ${TARGET.preservedFileIds.length + 1} files`);
      add(added.length === 1 && added[0] !== TARGET.staleFileId, `exactly one new file, not the stale ${TARGET.staleFileId} (got [${added.join(', ')}])`);
      add(Boolean(share) && share.status === 'attached' && added.length === 1 && String(share.bitrixFileId) === added[0], `share ${TARGET.shareId} is attached and its recorded file id is that file`);
      const ev = snap.events.find((e) => Number(e.id) === TARGET.eventId);
      add(Boolean(ev) && ev.status === 'completed', `event ${TARGET.eventId} is completed`);
      add(snap.audit.some((a) => String(a.entity_id) === String(TARGET.shareId) && a.action === 'bitrix.deal.document.attached'), `an attached audit entry exists for share ${TARGET.shareId}`);
      for (const o of TARGET.otherShares) { const s = snap.shares.find((x) => x.id === o.id); add(Boolean(s) && s.status === 'attached' && String(s.bitrixFileId) === o.fileId, `share ${o.id} is still attached as ${o.fileId}`); }
      add(snap.events.filter((e) => ['pending', 'ambiguous', 'processing'].includes(e.status)).length === 0, 'no event of the Case is open');
      for (const ch of checks) console.log(`  ${ch.ok ? 'PASS' : 'FAIL'}  ${ch.text}`);
      console.log(`Done: ${fetchGuard.state.reads} crm.item.get request, 0 update; nothing was written.`);
      if (checks.some((ch) => !ch.ok)) process.exitCode = 2;
      return;
    }

    // ---- attach ----
    const local = await verifyBytes();
    console.log(`  document: scan clean, review approved, ${local.bytes.length} bytes, a real ${TARGET.detectedType}, checksum verified against the share.`);
    const expectedName = remoteFileName(local.share, local.doc.originalName);
    const preRead = await readDeal();
    if (preRead.status !== 'ok') throw refuse(`the Deal could not be read (${preRead.status}${preRead.reason ? `: ${preRead.reason}` : ''}). Nothing was changed.`);
    console.log(`  Deal ${TARGET.dealId} (crm.item.get): file ids [${preRead.ids.join(', ')}].`);
    if (!sameList(preRead.ids, TARGET.preservedFileIds)) throw refuse(`the Deal's files are [${preRead.ids.join(', ')}], expected exactly [${TARGET.preservedFileIds.join(', ')}]. Nothing was changed.`);
    console.log(`  both PDFs are present as numeric ids; a live run would send ONE crm.item.update keeping them and adding one file named ${expectedName.slice(0, TARGET.shareToken.length + 2)}....jpg.`);
    if (!options.execute) {
      console.log(`Dry run: ${fetchGuard.state.reads} crm.item.get request, 0 update; nothing was claimed or written. Add --execute --confirm ${TARGET.caseReference} for the live attach.`);
      return;
    }

    await verifyLiveDatabase(prisma);
    const recheck = attachProblems(await loadState(prisma));
    if (recheck.length) throw refuse(`the state changed (${recheck.join('; ')}). Nothing was run.`);
    const before = await snapshot(prisma);
    const api = makeGuardedApi(realApi, workerEnvironment, fetchGuard, { allowUpdate: true, expectedName, expectedSha256: local.doc.sha256 });
    // Called by the worker right before it reads the Deal: approval, scan, checksum, type and the stored bytes are checked again.
    const readFile = async () => (await verifyBytes()).bytes;
    console.log(`  attaching: share ${TARGET.shareId}, event ${TARGET.eventId}; one pass, one crm.item.update.`);
    const out = await runDealDocumentWorker({
      prisma, api, env: workerEnvironment, log: console, scope: { caseIds: [TARGET.caseId] }, notify: async () => {}, readFile, store: makeScopedStore(realStore, TARGET.eventId),
    });
    console.log(`Pass finished: ${JSON.stringify(out)}; crm.item.get requests (including the pre-read): ${fetchGuard.state.reads}; crm.item.update requests: ${fetchGuard.state.updates}; refused: ${[...fetchGuard.state.refused, ...api.state.refused].join(', ') || 'none'}.`);
    const snap = await snapshot(prisma);
    show(snap);
    const after = snap.shares.find((s) => s.id === TARGET.shareId);
    const untouched = [...TARGET.otherShares.map((o) => o.id), TARGET.staleShareId].every((id) => JSON.stringify(before.shares.find((s) => s.id === id)) === JSON.stringify(snap.shares.find((s) => s.id === id)))
      && before.events.filter((e) => Number(e.id) !== TARGET.eventId).every((b) => { const a = snap.events.find((e) => Number(e.id) === Number(b.id)); return a && a.status === b.status && Number(a.attempts) === Number(b.attempts); });
    if (!untouched) { console.error('WARNING: another share or event changed. Stop and inspect.'); process.exitCode = 2; }
    if (fetchGuard.state.updates !== 1) { console.error(`WARNING: crm.item.update requests: ${fetchGuard.state.updates} (expected exactly 1). Do not re-run; inspect.`); process.exitCode = 2; }
    if (!after || after.status !== 'attached') { console.error(`NOTE: share ${TARGET.shareId} is "${after && after.status}", not attached. Manual review needed; do NOT re-run this phase.`); process.exitCode = 2; }
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

module.exports = { main, parseArgs, makeFetchGuard, makeGuardedApi, makeScopedStore, documentProblems, attachProblems, TARGET, PHASES };
