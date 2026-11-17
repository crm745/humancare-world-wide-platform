// A PHASED, fixed-scope restoration of `_Test (1).pdf` (document 2663) to the EXISTING Bitrix24 Deal 21760 (CASE-3206), test database
// humancare_test. File 65616 (`test-sample (1).pdf`, document 2662, share 4) is on the Deal and must stay. The earlier share of document 2663
// (share 3, recorded as Bitrix file 65608) is stale: that file is gone from the Deal.
//
//   node scripts/e2e-restore-document-2663.js --phase revalidate                          read-only: database + ONE crm.item.get
//   node scripts/e2e-restore-document-2663.js --phase revoke    [--execute --confirm CASE-3206]   close stale share 3 (dry run by default)
//   node scripts/e2e-restore-document-2663.js --phase authorize [--execute --confirm CASE-3206]   authorize a NEW generation (dry run by default)
//   node scripts/e2e-restore-document-2663.js --phase attach    [--execute --confirm CASE-3206]   ONE crm.item.update (dry run by default)
//   node scripts/e2e-restore-document-2663.js --phase verify                              read-only: database + ONE crm.item.get
//
// Each phase checks the state the previous one must have left, and stops (with no write) when anything differs from it.
//   revoke    : the existing revokeShare service (an Admin revocation, audit and request event written by it) + ONE scoped pass of the existing
//               document worker for exactly that remove event. The worker reads the Deal (ONE crm.item.get); file 65608 is absent, so the share
//               is recorded as revoked / already_absent with NO Bitrix update. Any update is refused.
//   authorize : the existing authorizeShare service: a NEW share (generation 3, a new token) and its attach event. Bitrix is not contacted.
//   attach    : ONE scoped pass of the existing document worker for exactly the new attach event, with the corrected adapter: crm.item.get
//               immediately before, then EXACTLY ONE crm.item.update keeping file 65616 as a numeric { id } and adding the new file as
//               [name, base64], then the worker's own verification reads. An ambiguous answer, a vanished file or an unexpected id is
//               MANUAL REVIEW; nothing is adopted automatically; nothing is retried.
// Never used: crm.deal.update, the disabled attach scripts, the general worker, any other Deal, any other share, event or document.
// The Admin recorded on the revoke and authorize audit rows is Admin 820, the Admin who authorized and revoked this Case's earlier shares.
const crypto = require('crypto');
const { applyIsolatedEnv } = require('./e2e-env');

const TARGET = Object.freeze({
  caseId: 2206, caseReference: 'CASE-3206', requestId: 3845, documentId: 2663, documentName: '_Test (1).pdf', documentRequestId: 1, caseDocumentId: 707,
  staleShareId: 3, staleFileId: '65608', preservedFileId: '65616', preservedShareId: 4, preservedDocumentId: 2662,
  dealId: '21760', entityTypeId: 2, fileKey: 'ufCrm_1794832401', portalHost: 'b24-4orefh.bitrix24.in',
  adminId: 820, newGeneration: 3, newToken: 'HC-D2663G3-ac925426',
  revokeReason: 'Stale share: file 65608 is no longer on Bitrix Deal 21760. Closed so a new generation can be authorized.',
  maxReads: 3, maxUpdates: 1,
});
const PHASES = ['revalidate', 'revoke', 'authorize', 'attach', 'verify'];
const WRITE_PHASES = ['revoke', 'authorize', 'attach'];

class RunError extends Error {
  constructor(message) { super(`Restore document 2663: ${message}`); this.name = 'RunError'; }
}
const refuse = (message) => new RunError(message);
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parseArgs(argv) {
  const out = { phase: null, execute: false, confirmed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--phase') {
      out.phase = argv[i + 1];
      i += 1;
    } else if (arg === '--execute') out.execute = true;
    else if (arg === '--confirm') {
      if (argv[i + 1] !== TARGET.caseReference) throw refuse(`--confirm must be followed by ${TARGET.caseReference}.`);
      out.confirmed = true;
      i += 1;
    } else throw refuse(`unknown argument "${String(arg).slice(0, 30)}". Use: --phase <${PHASES.join('|')}> [--execute --confirm ${TARGET.caseReference}].`);
  }
  if (!PHASES.includes(out.phase)) throw refuse(`--phase must be one of ${PHASES.join(', ')}.`);
  if (out.execute && !out.confirmed) throw refuse(`--execute needs --confirm ${TARGET.caseReference}.`);
  if (out.confirmed && !out.execute) throw refuse('--confirm only applies together with --execute.');
  if (out.execute && !WRITE_PHASES.includes(out.phase)) throw refuse(`phase ${out.phase} is read-only; --execute is not accepted.`);
  return out;
}

// ---- the HTTP layer: the last check before a request leaves the machine ------------------------------------------------------------
// crm.item.get always; crm.item.update only when allowed, only ONCE, only for Deal 21760, only the Documents field, and only the exact list
// "keep numeric 65616, then ONE new [name, base64] pair".
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
      const keeps = Array.isArray(list) && list.length === 2 && list[0] && typeof list[0] === 'object' && !Array.isArray(list[0])
        && Object.keys(list[0]).join() === 'id' && list[0].id === Number(TARGET.preservedFileId);
      const pair = Array.isArray(list) && Array.isArray(list[1]) && list[1].length === 2 && list[1].every((p) => typeof p === 'string' && p !== '');
      if (!keeps || !pair) return deny(`the list must keep { id: ${TARGET.preservedFileId} } (numeric) and add exactly one [name, base64] pair`);
      state.updates += 1;
    } else return deny('only crm.item.get and crm.item.update are allowed');
    return nativeFetch(url, init);
  };
  return { guardedFetch, state };
}

// ---- the Bitrix surface the worker sees ----------------------------------------------------------------------------------------------
// Reads go through the REAL adapter (crm.item.get). `firstReadMustBe` is checked on the FIRST read of the pass only (before any update); later
// reads (the worker's verification) are returned as they are, for the worker to judge: that is what lets a changed list reach manual review
// instead of being thrown away.
function makeGuardedApi(realApi, env, fetchGuard, { firstReadMustBe, allowUpdate, expectedName, expectedSha256 }) {
  const { guardedFetch, state } = fetchGuard;
  const api = { state, BitrixDealCallError: realApi.BitrixDealCallError, reads: 0 };
  api.getDealFiles = async (dealId) => {
    if (String(dealId) !== TARGET.dealId) { state.refused.push('getDealFiles(other deal)'); throw new Error('Only Deal 21760 may be read.'); }
    api.reads += 1;
    const read = await realApi.getDealFiles(TARGET.dealId, { env, fetchImpl: guardedFetch });
    if (api.reads === 1 && firstReadMustBe && (read.status !== 'ok' || !sameList(read.ids, firstReadMustBe))) {
      state.refused.push('unexpected first read');
      throw new Error(`The Deal's files are not exactly [${firstReadMustBe.join(', ')}] before the update. Stopped before any change.`);
    }
    return read;
  };
  api.updateDealFiles = async (dealId, entries, options = {}) => {
    if (!allowUpdate) { state.refused.push('updateDealFiles'); throw new Error('No Bitrix update is allowed in this phase.'); }
    if (String(dealId) !== TARGET.dealId || options.allowEmpty) { state.refused.push('updateDealFiles(args)'); throw new Error('Only a non-empty list for Deal 21760 may be sent.'); }
    const ok = Array.isArray(entries) && entries.length === 2 && String(entries[0].id) === TARGET.preservedFileId && entries[0].fileData === undefined
      && Array.isArray(entries[1].fileData) && entries[1].id === undefined;
    if (!ok) { state.refused.push('updateDealFiles(shape)'); throw new Error(`The update must keep file ${TARGET.preservedFileId} and add exactly one new file.`); }
    const [name, base64] = entries[1].fileData;
    if (name !== expectedName) { state.refused.push('updateDealFiles(name)'); throw new Error('The new file name is not this share\'s.'); }
    if (typeof base64 !== 'string' || crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') !== expectedSha256) { state.refused.push('updateDealFiles(checksum)'); throw new Error('The new file does not match the document checksum.'); }
    return realApi.updateDealFiles(dealId, entries, { ...options, fetchImpl: guardedFetch });
  };
  for (const method of ['createDeal', 'findDealsByReference', 'getDeal']) {
    api[method] = async () => { state.refused.push(method); throw new Error(`Bitrix24 method ${method} is disabled in this script.`); };
  }
  return api;
}

// The worker's store with its door narrowed to ONE event of Case 2206. `allowCallEvidence` is false for the revoke pass (no Bitrix call is expected).
function makeScopedStore(realStore, eventId, { allowCallEvidence }) {
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
    markExternalCallStarted: async (...args) => {
      if (!allowCallEvidence) throw new Error('No external call may be started in this phase.');
      return realStore.markExternalCallStarted(...args);
    },
  };
}

// ---- database state (read-only) ------------------------------------------------------------------------------------------------------
const rows = (db, sql, ...args) => db.$queryRawUnsafe(sql, ...args);
const ACTIVE = ['authorized', 'attaching', 'attached', 'ambiguous', 'failed'];

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
  const admin = await rows(prisma, "SELECT id FROM admin_users WHERE id = ? AND status = 'active'", TARGET.adminId);
  return { c, doc, shares, events, admin };
}

// Problems common to every phase: the Case, the preserved share 4, the document, no open event (except where a phase expects one).
function commonProblems(st, { openEventIds = [] } = {}) {
  const p = [];
  const { c } = st;
  if (!c) return ['case 2206 not found'];
  if (c.reference_number !== TARGET.caseReference || Number(c.service_request_id) !== TARGET.requestId) p.push('the Case or request is not CASE-3206 / request 3845');
  if (c.service_key !== 'privatecharter' || c.review_status !== 'approved') p.push('the request is not an approved Private Charter request');
  if (String(c.bitrix_deal_id) !== TARGET.dealId) p.push(`the Case's Deal id is not ${TARGET.dealId}`);
  if (c.file_locked_until != null && new Date(c.file_locked_until).getTime() > Date.now()) p.push('the Deal file lease is held by another process');
  if (st.admin.length !== 1) p.push(`Admin ${TARGET.adminId} not found or not active`);
  const s4 = st.shares.find((s) => s.id === TARGET.preservedShareId);
  if (!s4 || s4.status !== 'attached' || String(s4.bitrixFileId) !== TARGET.preservedFileId || s4.requestDocumentId !== TARGET.preservedDocumentId) p.push(`share ${TARGET.preservedShareId} is not attached as file ${TARGET.preservedFileId}`);
  const open = st.events.filter((e) => ['pending', 'ambiguous', 'processing'].includes(e.status)).map((e) => Number(e.id));
  if (!sameList(open, openEventIds)) p.push(`open events of the Case are [${open.join(', ')}], expected [${openEventIds.join(', ')}]`);
  return p;
}

// What each phase requires of the state it starts from.
function phaseProblems(phase, st) {
  const p = [];
  const docShares = st.shares.filter((s) => s.requestDocumentId === TARGET.documentId);
  const stale = st.shares.find((s) => s.id === TARGET.staleShareId);
  const fresh = docShares.find((s) => s.generation >= TARGET.newGeneration);
  if (phase === 'revalidate' || phase === 'revoke') {
    p.push(...commonProblems(st));
    p.push(...documentProblems(st.doc));
    if (!stale || stale.status !== 'attached' || String(stale.bitrixFileId) !== TARGET.staleFileId) p.push(`share ${TARGET.staleShareId} is not "attached" as the stale file ${TARGET.staleFileId}`);
    if (fresh) p.push('a newer generation already exists');
  } else if (phase === 'authorize') {
    p.push(...commonProblems(st));
    p.push(...documentProblems(st.doc));
    if (!stale || stale.status !== 'revoked') p.push(`share ${TARGET.staleShareId} is not revoked yet`);
    if (docShares.some((s) => ACTIVE.includes(s.status) || s.status === 'revoking')) p.push('document 2663 still has an active or revoking share');
    if (fresh) p.push('a newer generation already exists');
  } else if (phase === 'attach') {
    const open = st.events.filter((e) => ['pending', 'ambiguous', 'processing'].includes(e.status));
    const ev = open.length === 1 ? open[0] : null;
    p.push(...commonProblems(st, { openEventIds: ev ? [Number(ev.id)] : [] }));
    p.push(...documentProblems(st.doc, fresh && fresh.sha256));
    if (!fresh || fresh.generation !== TARGET.newGeneration || fresh.shareToken !== TARGET.newToken) p.push(`there is no generation ${TARGET.newGeneration} share with token ${TARGET.newToken}`);
    else {
      if (fresh.status !== 'authorized' || fresh.tryCount !== 1 || fresh.attempts !== 0 || fresh.bitrixFileId != null || fresh.fileIdsBefore != null) p.push('the new share is not a fresh, never-sent "authorized" share');
      if (!ev || ev.event_type !== 'bitrix.deal.document.attach' || ev.entity_id !== `${fresh.id}:attach:1` || ev.status !== 'pending' || Number(ev.attempts) !== 0 || ev.external_call_started_at != null || ev.locked_until != null) p.push('the only open event is not the clean pending attach event of the new share');
    }
    if (!stale || stale.status !== 'revoked') p.push(`share ${TARGET.staleShareId} is not revoked`);
  } else if (phase === 'verify') {
    p.push(...commonProblems(st));
  }
  return p;
}

async function snapshot(prisma) {
  const st = await loadState(prisma);
  const audit = await rows(prisma, "SELECT id, entity_id, action, reason_code FROM audit_logs WHERE entity_type = 'bitrix_deal_document' ORDER BY id");
  return { ...st, audit };
}

const show = (st, audit) => {
  for (const s of st.shares) console.log(`  share ${s.id}: document ${s.requestDocumentId}, generation ${s.generation}, ${s.status}, bitrix_file_id ${s.bitrixFileId == null ? 'null' : s.bitrixFileId}`);
  for (const e of st.events.filter((x) => String(x.event_type).startsWith('bitrix.deal.document'))) console.log(`  event ${e.id}: ${e.event_type} ${e.entity_id} ${e.status}${e.last_error ? ` (${String(e.last_error).slice(0, 50)})` : ''}`);
  if (audit) for (const a of audit.filter((x) => ['3', '4', ...st.shares.map((s) => String(s.id))].includes(String(x.entity_id)))) console.log(`  audit ${a.id}: share ${a.entity_id} ${a.action} (${a.reason_code || ''})`);
};

// ---- main ---------------------------------------------------------------------------------------------------------------------------------
async function main(argv) {
  const options = parseArgs(argv);
  const env = applyIsolatedEnv(); // validates the test environment before Prisma is loaded

  const { prisma } = require('../src/db/prisma');
  const { verifyLiveDatabase } = require('../src/common/safety/test-database-guard');
  const { webhookHost, bitrixHostProblem, assertBitrixConfiguration } = require('../src/modules/bitrix/bitrix-config');
  const realStore = require('../src/modules/bitrix/deal-document.store');
  const realApi = require('../src/modules/bitrix/bitrix-deal.api');
  const { readVerifiedFile } = require('../src/modules/request-review/request-review.files');
  const { authorizeShare, revokeShare } = require('../src/modules/bitrix/deal-document.service');
  const { runDealDocumentWorker } = require('../src/modules/bitrix/deal-document-worker.service');
  const harness = require('../src/modules/bitrix/deal-worker-harness');

  const nativeFetch = globalThis.fetch;
  try {
    const live = await verifyLiveDatabase(prisma);
    console.log(`Restore document 2663: database ${live.database}; phase ${options.phase}; ${options.execute ? 'EXECUTE' : (WRITE_PHASES.includes(options.phase) ? 'DRY RUN' : 'READ-ONLY')}.`);
    if (webhookHost(env.BITRIX24_WEBHOOK_URL) !== TARGET.portalHost) throw refuse('the webhook host in .env.test is not the allowed portal. Nothing was run.');
    const workerEnvironment = harness.workerEnv({ ...env, BITRIX_ALLOWED_PORTAL_HOST: TARGET.portalHost }, { live: true });
    const hostProblem = bitrixHostProblem(workerEnvironment);
    if (hostProblem) throw refuse(`the portal lock failed (${hostProblem}). Nothing was run.`);
    assertBitrixConfiguration(workerEnvironment);

    // Step 1 of every phase: the state the phase needs, from the database.
    let st = await loadState(prisma);
    let problems = phaseProblems(options.phase, st);
    if (problems.length) throw refuse(`the state is not what phase ${options.phase} needs (${problems.join('; ')}). Nothing was run.`);
    console.log(`  database state OK for phase ${options.phase}.`);

    const fetchGuard = makeFetchGuard(nativeFetch, { allowUpdate: options.phase === 'attach' && options.execute });
    globalThis.fetch = () => Promise.reject(new Error('Network access is disabled in this script (use the guarded client).'));
    const readDeal = () => realApi.getDealFiles(TARGET.dealId, { env: workerEnvironment, fetchImpl: fetchGuard.guardedFetch });

    // The Deal read: phases revalidate and verify read it; the dry runs of the write phases read it once too (not the authorize phase).
    if (options.phase === 'revalidate' || options.phase === 'verify' || (!options.execute && options.phase !== 'authorize') || (options.execute && options.phase === 'revoke')) {
      const read = await readDeal();
      if (read.status !== 'ok') throw refuse(`the Deal could not be read (${read.status}${read.reason ? `: ${read.reason}` : ''}).`);
      console.log(`  Deal ${TARGET.dealId} (crm.item.get): file ids [${read.ids.join(', ')}].`);
      if (options.phase === 'verify') {
        const fresh = st.shares.find((s) => s.requestDocumentId === TARGET.documentId && s.generation === TARGET.newGeneration);
        const checks = [];
        const add = (ok, text) => checks.push({ ok, text });
        add(read.ids.includes(TARGET.preservedFileId), `file ${TARGET.preservedFileId} is still on the Deal`);
        add(read.ids.length === 2, 'the Deal holds exactly two files');
        const added = read.ids.filter((id) => id !== TARGET.preservedFileId);
        add(added.length === 1 && added[0] !== TARGET.staleFileId, `exactly one other file, and it is not the stale ${TARGET.staleFileId} (got [${added.join(', ')}])`);
        add(Boolean(fresh) && fresh.status === 'attached' && added.length === 1 && String(fresh.bitrixFileId) === added[0], 'the new share is attached and its recorded file id is that file');
        const stale = st.shares.find((s) => s.id === TARGET.staleShareId);
        add(Boolean(stale) && stale.status === 'revoked', `share ${TARGET.staleShareId} is revoked`);
        const s4 = st.shares.find((s) => s.id === TARGET.preservedShareId);
        add(Boolean(s4) && s4.status === 'attached' && String(s4.bitrixFileId) === TARGET.preservedFileId, `share ${TARGET.preservedShareId} is still attached as ${TARGET.preservedFileId}`);
        const snap = await snapshot(prisma);
        show(snap, snap.audit);
        for (const ch of checks) console.log(`  ${ch.ok ? 'PASS' : 'FAIL'}  ${ch.text}`);
        if (checks.some((ch) => !ch.ok)) process.exitCode = 2;
      } else {
        const need = [TARGET.preservedFileId];
        if (!sameList(read.ids, need)) throw refuse(`the Deal's files are [${read.ids.join(', ')}], expected exactly [${need.join(', ')}]. Nothing was changed.`);
        console.log(`  Deal files are exactly [${need.join(', ')}]: ${TARGET.staleFileId} is absent, ${TARGET.preservedFileId} is present.`);
      }
      if (!options.execute) {
        console.log(`Done: ${fetchGuard.state.reads} crm.item.get request, 0 update; nothing was written.${WRITE_PHASES.includes(options.phase) ? ` Add --execute --confirm ${TARGET.caseReference} to run phase ${options.phase}.` : ''}`);
        return;
      }
    } else if (!options.execute) {
      console.log(`Dry run (phase ${options.phase}): would call authorizeShare for document ${TARGET.documentId} (a new generation ${TARGET.newGeneration}). Nothing was written. Add --execute --confirm ${TARGET.caseReference}.`);
      return;
    }

    // ---- EXECUTE ----
    await verifyLiveDatabase(prisma);
    const scope = { caseIds: [TARGET.caseId] };
    if (options.phase === 'revoke') {
      const result = await revokeShare({ requestId: TARGET.requestId, shareId: TARGET.staleShareId, adminId: TARGET.adminId, reason: TARGET.revokeReason });
      console.log(`  revokeShare: share ${result.share.id} -> ${result.share.status}.`);
      st = await loadState(prisma);
      const removeEvent = st.events.find((e) => e.status === 'pending' && e.event_type === 'bitrix.deal.document.remove' && e.entity_id === `${TARGET.staleShareId}:remove:2`);
      if (!removeEvent) throw refuse('the remove event was not created as expected. Stop and inspect.');
      console.log(`  remove event ${removeEvent.id} created; one scoped worker pass for exactly that event follows.`);
      const api = makeGuardedApi(realApi, workerEnvironment, fetchGuard, { firstReadMustBe: [TARGET.preservedFileId], allowUpdate: false });
      const out = await runDealDocumentWorker({
        prisma, api, env: workerEnvironment, log: console, scope, notify: async () => {}, store: makeScopedStore(realStore, Number(removeEvent.id), { allowCallEvidence: false }),
        readFile: async () => { throw new Error('This script never reads a document file in this phase.'); },
      });
      console.log(`Pass finished: ${JSON.stringify(out)}; crm.item.get requests: ${fetchGuard.state.reads}; crm.item.update requests: ${fetchGuard.state.updates}; refused: ${[...fetchGuard.state.refused, ...api.state.refused].join(', ') || 'none'}.`);
      const snap = await snapshot(prisma);
      show(snap, snap.audit);
      const stale = snap.shares.find((s) => s.id === TARGET.staleShareId);
      const revoked = snap.audit.find((a) => a.action === 'bitrix.deal.document.revoked' && String(a.entity_id) === String(TARGET.staleShareId));
      if (!stale || stale.status !== 'revoked' || !revoked || revoked.reason_code !== 'already_absent' || fetchGuard.state.updates !== 0) { console.error('WARNING: the stale share was not closed as revoked / already_absent. Stop and inspect.'); process.exitCode = 2; }
      else console.log(`  OK: share ${TARGET.staleShareId} is revoked, recorded as already_absent, with no Bitrix update.`);
    } else if (options.phase === 'authorize') {
      const result = await authorizeShare({ requestId: TARGET.requestId, documentId: TARGET.documentId, adminId: TARGET.adminId, readFile: readVerifiedFile });
      console.log(`  authorizeShare: share ${result.share.id}, generation ${result.share.generation}, ${result.share.status}, already authorized: ${result.alreadyAuthorized}.`);
      st = await loadState(prisma);
      const problems2 = phaseProblems('attach', st);
      const snap = await snapshot(prisma);
      show(snap, snap.audit);
      if (problems2.length) { console.error(`WARNING: the new share or its event is not as expected (${problems2.join('; ')}).`); process.exitCode = 2; } else console.log('  OK: a new generation-3 share with its pending attach event exists; nothing was sent to Bitrix.');
    } else if (options.phase === 'attach') {
      const fresh = st.shares.find((s) => s.requestDocumentId === TARGET.documentId && s.generation === TARGET.newGeneration);
      const ev = st.events.find((e) => e.status === 'pending');
      const doc = st.doc;
      const { remoteFileName } = require('../src/modules/bitrix/deal-document-worker.service');
      const expectedName = remoteFileName(fresh, doc.originalName);
      const before = await snapshot(prisma);
      const api = makeGuardedApi(realApi, workerEnvironment, fetchGuard, { firstReadMustBe: [TARGET.preservedFileId], allowUpdate: true, expectedName, expectedSha256: doc.sha256 });
      // The worker re-verifies approval, scan, checksum and the stored bytes right before it reads the Deal.
      const readFile = async () => {
        const fresh2 = await prisma.requestDocument.findUnique({ where: { id: TARGET.documentId } });
        const p2 = documentProblems(fresh2, fresh.sha256);
        if (p2.length) throw refuse(`the document is no longer eligible (${p2.join('; ')}).`);
        const bytes = await readVerifiedFile(fresh2);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== fresh2.sha256) throw refuse('the stored file does not match its checksum.');
        return bytes;
      };
      console.log(`  attaching: share ${fresh.id} (token ${fresh.shareToken}), event ${ev.id}; one pass, one crm.item.update.`);
      const out = await runDealDocumentWorker({
        prisma, api, env: workerEnvironment, log: console, scope, notify: async () => {}, readFile, store: makeScopedStore(realStore, Number(ev.id), { allowCallEvidence: true }),
      });
      console.log(`Pass finished: ${JSON.stringify(out)}; crm.item.get requests: ${fetchGuard.state.reads}; crm.item.update requests: ${fetchGuard.state.updates}; refused: ${[...fetchGuard.state.refused, ...api.state.refused].join(', ') || 'none'}.`);
      const snap = await snapshot(prisma);
      show(snap, snap.audit);
      const after = snap.shares.find((s) => s.id === fresh.id);
      const s4b = before.shares.find((s) => s.id === TARGET.preservedShareId);
      const s4a = snap.shares.find((s) => s.id === TARGET.preservedShareId);
      if (fetchGuard.state.updates !== 1) { console.error(`WARNING: crm.item.update requests: ${fetchGuard.state.updates} (expected exactly 1). Do not re-run; inspect.`); process.exitCode = 2; }
      if (!after || after.status !== 'attached') { console.error(`NOTE: the new share is "${after && after.status}", not attached. Manual review needed; do NOT re-run this phase.`); process.exitCode = 2; }
      if (JSON.stringify(s4b) !== JSON.stringify(s4a)) { console.error(`WARNING: share ${TARGET.preservedShareId} changed. Stop and inspect.`); process.exitCode = 2; }
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

module.exports = { main, parseArgs, makeFetchGuard, makeGuardedApi, makeScopedStore, documentProblems, commonProblems, phaseProblems, TARGET, PHASES };
