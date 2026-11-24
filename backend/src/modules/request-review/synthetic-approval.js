// Automatic approval of SYNTHETIC E2E requests only (see src/common/safety/synthetic-e2e-marker.js for the marker).
//
// A request enters this path only when ALL of these hold; for every other request the entry points return before approving anything:
//   gate 0  the server is configured for it (SYNTHETIC_E2E_AUTO_APPROVE=true, SYNTHETIC_E2E_SECRET set, not production, DATABASE_URL names
//           humancare_dev on a local host, and the server itself confirms DATABASE() = humancare_dev). Otherwise this module is inert.
//   gate 1  the request has a synthetic_e2e_marked event (only the operator script writes one). A real request has none.
//   gate 2  that event carries a valid HMAC signature bound to this request, its owner and this database, and is neither expired,
//           revoked, nor consumed.
// The approval itself is done by the EXISTING reviewDocument and approveRequest services, unchanged. This module only decides WHEN, and
// records what it did. It writes events but never edits a document, a request or a Case itself.
//
// Concurrency: the request row lock (SELECT ... FOR UPDATE, the same one the services take) serialises every state change. A run first
// CLAIMS the request with a short transaction (an approval_started event holding a random token). Because reviewDocument and
// approveRequest open their own transactions, the claim cannot be held across them; instead a FENCE (lock, re-read events, verify the
// marker again and that this token still holds the claim) runs before EVERY operation. A claim older than five minutes is expired, and a
// new run resumes with a new token; the old holder is fenced out at its next check. Every operation is also idempotent in the services
// (an approved document is skipped, an approved request returns "already approved", and the Deal event has a unique key per Case), so
// even a stale holder cannot produce a second approval or a second Bitrix outbox event.
//
// Audit: the services keep writing their own events (actor: the operator admin named in the marker, because that is what they record).
// To make clear this was AUTOMATIC, every step also writes a synthetic_e2e_* event (system actor) naming the initiating admin.
const crypto = require('crypto');
const { ACTION, ALL_ACTIONS, LIMITS, databaseOfUrl, secretOf, deriveState, holdsClaim } = require('../../common/safety/synthetic-e2e-marker');

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const SHA256 = /^[a-f0-9]{64}$/;

class ClaimLost extends Error {
  constructor() { super('claim_lost'); this.name = 'ClaimLost'; }
}

const clip = (value, max = 40) => String(value).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, max);
const codeOf = (err) => clip((err && (err.publicCode || err.statusCode || err.code)) || 'error');

// ---- the document rules the marker's count is checked against (pure) ---------------------------------------------------------------
// A document counts toward expectedDocuments only if it is CURRENT (not replaced), belongs to the request itself (not a post-approval
// document request), passed ClamAV (clean), has a recorded checksum and size, is an allowed type, and is not rejected. Duplicates of the
// same content count once. Every current document must qualify (a pending, infected, failed, errored or rejected one blocks), and the
// existing approvalBlockers still apply on top. Whether a file is the RIGHT kind of document cannot be judged by a machine; the count only
// stops duplicates, replaced, unscanned, rejected and unusable files from standing in for a missing one.
function qualifies(d) {
  return d.supersededAt == null && d.documentRequestId == null && d.scanStatus === 'clean'
    && (d.reviewStatus === 'pending' || d.reviewStatus === 'approved')
    && typeof d.sha256 === 'string' && SHA256.test(d.sha256) && d.sizeBytes > 0 && ALLOWED_MIME.has(d.mimeType);
}

function evaluateDocuments(request, documents, mark, approvalBlockers) {
  const current = documents.filter((d) => d.supersededAt == null);
  const blockers = approvalBlockers(request, current).filter((b) => b.code !== 'awaiting_review');
  if (blockers.length) return { ok: false, code: String(blockers[0].code) };
  if (current.some((d) => !qualifies(d))) return { ok: false, code: 'document_not_ready' };
  const distinct = new Set(current.map((d) => d.sha256));
  if (distinct.size < mark.expectedDocuments) return { ok: false, code: 'documents_missing', have: distinct.size, need: mark.expectedDocuments };
  return { ok: true, pending: current.filter((d) => d.reviewStatus === 'pending'), have: distinct.size };
}

function createEngine(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const log = deps.log || console;
  const getPrisma = () => deps.prisma || require('../../db/prisma').prisma;
  const getServices = () => deps.services || require('./request-review.service');
  let databaseConfirmed = false;

  // mode 'auto': the server's automatic path. mode 'recovery': the guarded script (it checks its own opt-in).
  function enabled(mode) {
    if (!secretOf(env) || env.NODE_ENV === 'production') return false;
    if (databaseOfUrl(env.DATABASE_URL) !== LIMITS.DATABASE) return false;
    return mode === 'recovery' ? env.ALLOW_SYNTHETIC_APPROVAL === 'true' : env.SYNTHETIC_E2E_AUTO_APPROVE === 'true';
  }

  async function confirmDatabase(prisma) {
    if (databaseConfirmed) return true;
    try {
      const rows = await prisma.$queryRaw`SELECT DATABASE() AS db`;
      databaseConfirmed = Boolean(rows && rows[0] && rows[0].db === LIMITS.DATABASE);
    } catch {
      databaseConfirmed = false;
    }
    return databaseConfirmed;
  }

  const readEvents = (db, requestId) => db.requestEvent.findMany({ where: { serviceRequestId: requestId, action: { in: ALL_ACTIONS } }, orderBy: { id: 'asc' } });
  const stateOf = (events, requestId) => deriveState(events, { secret: secretOf(env), requestId, now: now() });
  const writeEvent = (db, requestId, action, detail, actorType = 'system') => db.requestEvent.create({ data: { serviceRequestId: requestId, action, actorType, actorId: null, detail } });
  async function lockAndLoad(tx, requestId) {
    await tx.$queryRaw`SELECT id FROM service_requests WHERE id = ${requestId} FOR UPDATE`;
    return tx.serviceRequest.findUnique({ where: { id: requestId } });
  }
  const audit = (mark, extra = {}) => ({ markSig: mark.sig, runId: mark.runId, automatic: true, initiatedByAdminId: mark.adminId, ...extra });

  // request-level conditions (not about documents)
  async function requestProblem(tx, request, mark) {
    if (!request) return 'request_not_found';
    if (request.serviceKey !== LIMITS.PRIVATE_CHARTER_KEY) return 'not_private_charter';
    if (request.userId !== mark.ownerUserId) return 'wrong_owner';
    if (!String(request.patientName || '').startsWith(LIMITS.NAME_PREFIX)) return 'not_synthetic';
    if ((await tx.serviceRequest.count({ where: { userId: mark.ownerUserId } })) !== 1) return 'owner_has_other_requests';
    return null;
  }

  // ---- step 1: claim (one short transaction under the request lock) ---------------------------------------------------------------
  async function tryClaim(prisma, requestId) {
    const { approvalBlockers } = getServices();
    return prisma.$transaction(async (tx) => {
      const request = await lockAndLoad(tx, requestId);
      const derived = stateOf(await readEvents(tx, requestId), requestId);
      if (derived.state === 'expired' && derived.recorded === false) {
        await writeEvent(tx, requestId, ACTION.EXPIRED, audit(derived.mark, { reason: 'expired' }));
        return { outcome: 'expired' };
      }
      if (derived.state !== 'active') return { outcome: derived.state };
      if (derived.failures >= LIMITS.MAX_FAILURES) {
        await writeEvent(tx, requestId, ACTION.REVOKED, audit(derived.mark, { reason: 'attempts_exhausted', failures: derived.failures }));
        return { outcome: 'revoked' };
      }
      const problem = await requestProblem(tx, request, derived.mark);
      if (problem) return { outcome: 'refused', code: problem };
      if (request.reviewStatus === 'approved') {
        await writeEvent(tx, requestId, ACTION.CONSUMED, audit(derived.mark, { outcome: 'already_approved' }));
        return { outcome: 'consumed' };
      }
      if (request.reviewStatus !== 'in_review') return { outcome: 'waiting', code: 'not_in_review' };
      if (derived.claim && derived.claim.live) return { outcome: 'claimed_elsewhere' };
      if (derived.lastFailureAt && now() - derived.lastFailureAt < LIMITS.RETRY_SPACING_MS) return { outcome: 'retry_later' };
      const documents = await tx.requestDocument.findMany({ where: { serviceRequestId: requestId, supersededAt: null }, orderBy: { id: 'asc' } });
      const ready = evaluateDocuments(request, documents, derived.mark, approvalBlockers);
      if (!ready.ok) return { outcome: 'waiting', code: ready.code };
      const token = crypto.randomBytes(16).toString('hex');
      await writeEvent(tx, requestId, ACTION.STARTED, audit(derived.mark, { token, attempt: derived.failures + 1 }));
      return { outcome: 'claimed', token, mark: derived.mark };
    }, { timeout: 15000, maxWait: 10000 });
  }

  // ---- the fence: runs before EVERY approval operation ----------------------------------------------------------------------------
  const fence = (prisma, requestId, token) => prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM service_requests WHERE id = ${requestId} FOR UPDATE`;
    const derived = stateOf(await readEvents(tx, requestId), requestId);
    if (!holdsClaim(derived, token)) throw new ClaimLost();
    return derived;
  }, { timeout: 15000, maxWait: 10000 });

  async function recordFailure(prisma, requestId, token, err, stage) {
    return prisma.$transaction(async (tx) => {
      await lockAndLoad(tx, requestId);
      const derived = stateOf(await readEvents(tx, requestId), requestId);
      if (derived.state !== 'active') return;
      await writeEvent(tx, requestId, ACTION.FAILED, audit(derived.mark, { token, stage, code: codeOf(err), attempt: derived.failures + 1 }));
      if (derived.failures + 1 >= LIMITS.MAX_FAILURES) {
        await writeEvent(tx, requestId, ACTION.REVOKED, audit(derived.mark, { reason: 'attempts_exhausted', failures: derived.failures + 1 }));
      }
    }, { timeout: 15000, maxWait: 10000 });
  }

  async function consume(prisma, requestId, token, outcome) {
    return prisma.$transaction(async (tx) => {
      await lockAndLoad(tx, requestId);
      const derived = stateOf(await readEvents(tx, requestId), requestId);
      if (derived.state !== 'active') return; // consumed / revoked / expired already: nothing more to write
      await writeEvent(tx, requestId, ACTION.CONSUMED, audit(derived.mark, { token, outcome }));
    }, { timeout: 15000, maxWait: 10000 });
  }

  // ---- the entry point -----------------------------------------------------------------------------------------------------------
  async function processRequest(rawRequestId, { mode = 'auto' } = {}) {
    try {
      if (!enabled(mode)) return { entered: false, outcome: 'disabled' };
      const requestId = Number(rawRequestId);
      if (!Number.isInteger(requestId) || requestId < 1) return { entered: false, outcome: 'bad_request_id' };
      const prisma = getPrisma();

      // gate 1: one indexed read; a real request has no synthetic events and leaves here, having written nothing
      const first = await readEvents(prisma, requestId);
      if (first.length === 0) return { entered: false, outcome: 'not_synthetic' };
      // gate 2: the signature
      const early = stateOf(first, requestId);
      if (early.state === 'none') return { entered: false, outcome: 'not_synthetic' };
      if (early.state === 'invalid') return { entered: false, outcome: 'marker_invalid' };
      if (!(await confirmDatabase(prisma))) return { entered: false, outcome: 'database_not_identified' };

      const claim = await tryClaim(prisma, requestId);
      if (claim.outcome !== 'claimed') return { entered: true, outcome: claim.outcome, ...(claim.code && { code: claim.code }) };

      const { token, mark } = claim;
      const { reviewDocument, approveRequest, approvalBlockers } = getServices();
      let stage = 'claim';
      try {
        stage = 'fence';
        await fence(prisma, requestId, token);
        const request = await prisma.serviceRequest.findUnique({ where: { id: requestId } });
        const documents = await prisma.requestDocument.findMany({ where: { serviceRequestId: requestId, supersededAt: null }, orderBy: { id: 'asc' } });
        const ready = evaluateDocuments(request, documents, mark, approvalBlockers);
        if (!ready.ok) throw Object.assign(new Error('documents_changed'), { publicCode: ready.code });

        stage = 'document_review';
        for (const document of ready.pending) {
          await fence(prisma, requestId, token);
          try {
            await reviewDocument({ requestId, documentId: document.id, adminId: mark.adminId, decision: 'approved' });
          } catch (err) {
            if (!(err && err.publicCode === 'already_decided')) throw err;
          }
          await writeEvent(prisma, requestId, ACTION.DOC_APPROVED, audit(mark, { token, documentId: document.id }));
        }

        stage = 'request_approval';
        await fence(prisma, requestId, token);
        const result = await approveRequest({ requestId, adminId: mark.adminId });
        const outcome = result && result.alreadyApproved ? 'already_approved' : 'approved';
        await consume(prisma, requestId, token, outcome);
        return { entered: true, outcome };
      } catch (err) {
        if (err instanceof ClaimLost) return { entered: true, outcome: 'claim_lost' };
        await recordFailure(prisma, requestId, token, err, stage).catch(() => undefined);
        log.warn(`[synthetic-e2e] request ${requestId}: ${stage} failed (${codeOf(err)}); it will be retried.`);
        return { entered: true, outcome: 'failed', code: codeOf(err), stage };
      }
    } catch (err) {
      log.warn(`[synthetic-e2e] unexpected error (${codeOf(err)}).`);
      return { entered: false, outcome: 'error', code: codeOf(err) };
    }
  }

  // Requests with an unfinished marker, for the periodic sweep. Real requests have no marked event and are never listed.
  async function sweep({ limit = 20, mode = 'auto' } = {}) {
    try {
      if (!enabled(mode)) return { processed: 0, results: [] };
      const prisma = getPrisma();
      const marked = await prisma.requestEvent.findMany({ where: { action: ACTION.MARKED }, select: { serviceRequestId: true }, distinct: ['serviceRequestId'], orderBy: { serviceRequestId: 'asc' }, take: 200 });
      const ids = marked.map((r) => r.serviceRequestId);
      if (!ids.length) return { processed: 0, results: [] };
      const finished = await prisma.requestEvent.findMany({ where: { serviceRequestId: { in: ids }, action: { in: [ACTION.CONSUMED, ACTION.REVOKED, ACTION.EXPIRED] } }, select: { serviceRequestId: true } });
      const done = new Set(finished.map((r) => r.serviceRequestId));
      const results = [];
      for (const id of ids.filter((x) => !done.has(x)).slice(0, limit)) results.push({ requestId: id, ...(await processRequest(id, { mode })) });
      return { processed: results.length, results };
    } catch {
      return { processed: 0, results: [] };
    }
  }

  // Read-only diagnosis for the recovery script's --dry-run: codes and counts only, never patient data.
  async function diagnose(rawRequestId, { mode = 'recovery' } = {}) {
    if (!enabled(mode)) return { outcome: 'disabled' };
    const requestId = Number(rawRequestId);
    const prisma = getPrisma();
    if (!(await confirmDatabase(prisma))) return { outcome: 'database_not_identified' };
    const events = await readEvents(prisma, requestId);
    const derived = stateOf(events, requestId);
    if (derived.state !== 'active') return { outcome: derived.state === 'none' ? 'not_synthetic' : derived.state === 'invalid' ? 'marker_invalid' : derived.state };
    const request = await prisma.serviceRequest.findUnique({ where: { id: requestId } });
    const problem = await requestProblem(prisma, request, derived.mark);
    if (problem) return { outcome: 'refused', code: problem };
    const documents = await prisma.requestDocument.findMany({ where: { serviceRequestId: requestId, supersededAt: null } });
    const ready = evaluateDocuments(request, documents, derived.mark, getServices().approvalBlockers);
    return {
      outcome: 'active', failures: derived.failures, claimLive: Boolean(derived.claim && derived.claim.live), requestStatus: request.reviewStatus,
      expectedDocuments: derived.mark.expectedDocuments, ready: ready.ok, ...(ready.ok ? {} : { code: ready.code }),
    };
  }

  return { processRequest, sweep, diagnose, enabled };
}

let shared = null;
const engine = () => shared || (shared = createEngine());

// The two call sites use these. Neither ever throws and neither can change the caller's result.
const autoApproveIfSynthetic = (requestId) => engine().processRequest(requestId, { mode: 'auto' });
const sweepSyntheticApprovals = (options) => engine().sweep({ ...options, mode: 'auto' });

module.exports = { createEngine, autoApproveIfSynthetic, sweepSyntheticApprovals, evaluateDocuments, qualifies, ClaimLost };
