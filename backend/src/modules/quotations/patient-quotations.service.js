// The patient's side of a quotation (Phase 3): see the ONE active published quotation of their own request, open its PDF, accept it or reject it.
//
// WHAT A PATIENT CAN REACH
//   * only quotations of a Case that belongs to them (ownership is in the database query: Case -> service request -> user);
//   * only versions that were PUBLISHED to them: a draft, a confirmed or a withdrawn version does not exist as far as the patient can tell (404);
//   * only the ONE live version of the Case (published or accepted, not superseded). A newer published version replaces the old one;
//   * the PDF only while it is that live version, the scan is clean and the file still matches its hash. Never a storage key, a path or a link.
//
// DECISIONS (accept / reject) run in ONE transaction that locks the Case row (the same lock the Admin actions and the sync take), re-reads the version and
// writes with a compare-and-set on (id, status 'published', revision):
//   * the exact version id is in the URL: a decision can only ever be about THAT version. If a newer version was published meanwhile the old one is
//     superseded and the decision is refused (409 quotation_superseded);
//   * an expired quotation (validUntil passed) cannot be decided (409 quotation_expired); the expiry is computed, never stored;
//   * a decision is final: accepted and rejected versions never change again. Repeating the SAME decision by the SAME patient is a no-op (200, nothing
//     written); the opposite decision, or a decision by anyone else, is refused (409 quotation_already_decided);
//   * the patient id, the version and the time are stored on the row (decided_by_user_id, decided_at); a rejection stores its mandatory reason;
//   * one audit row per version and decision (unique key), written in the same transaction. The reason text is never put in the audit trail.
//   * NOTHING else happens: no invoice, no payment, no Bitrix call. (Creating the invoice from an accepted quotation is a later step.)
const { prisma: defaultPrisma } = require('../../db/prisma');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { assertDealEligible } = require('../bitrix/deal-outbox');
const { createLocalStorage } = require('../bitrix/quotation-storage');

const REASON_MIN = 3;
const REASON_MAX = 1000;
const CLOSED_CASE_STATUSES = new Set(['completed', 'cancelled']);
// Versions a patient may ever reach: they were published to them. A withdrawn version is no longer theirs to see.
const REACHABLE = new Set(['published', 'accepted', 'rejected', 'superseded']);

function httpError(statusCode, message, publicCode, extra) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (publicCode) err.publicCode = publicCode;
  if (extra) Object.assign(err, extra);
  return err;
}
const conflict = (code, message) => httpError(409, message, code);
const notFound = () => httpError(404, 'Quotation not found', 'quotation_not_found');

function buildContext(overrides = {}) {
  return { prisma: defaultPrisma, storage: null, now: () => new Date(), log: console, ...overrides };
}
const storageOf = (ctx) => ctx.storage || (ctx.storage = createLocalStorage());

function userIdOf(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) throw httpError(401, 'Please log in to continue.', 'not_signed_in');
  return id;
}
function idOf(value) {
  const text = String(value);
  if (!/^[1-9]\d{0,9}$/.test(text)) throw notFound();
  return Number(text);
}
function reasonOf(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < REASON_MIN || text.length > REASON_MAX) throw httpError(400, `Please give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`, 'reason_invalid');
  return text;
}

// The patient's own Case for a request, or a 404 that says nothing about whether it exists (another patient's request looks the same).
async function ownCaseForRequest(db, userId, requestId) {
  const caseRecord = await db.case.findFirst({ where: { serviceRequestId: idOf(requestId), serviceRequest: { userId } }, include: { serviceRequest: true } });
  if (!caseRecord) throw notFound();
  try { assertDealEligible(caseRecord, caseRecord.serviceRequest); } catch { throw notFound(); }
  return caseRecord;
}

async function ownCaseOf(db, userId, quotation) {
  const caseRecord = await db.case.findFirst({ where: { id: quotation.caseId, serviceRequest: { userId } }, include: { serviceRequest: true } });
  if (!caseRecord) throw notFound();
  try { assertDealEligible(caseRecord, caseRecord.serviceRequest); } catch { throw notFound(); }
  return caseRecord;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
const decimalText = (v) => (v == null ? null : typeof v === 'object' && typeof v.toFixed === 'function' ? v.toFixed(3) : String(v));
const isExpired = (q, now) => q.status === 'published' && Boolean(q.validUntil) && new Date(q.validUntil) <= now; // expired is computed, never stored

/** What the patient sees of a version. No admin, no storage key, no hash, no Bitrix data. */
function patientView(q, caseRecord, now) {
  const expired = isExpired(q, now);
  return {
    id: q.id, versionNumber: q.versionNumber, status: q.status,
    amount: decimalText(q.amount), currency: q.currency ?? null,
    validUntil: iso(q.validUntil), publishedAt: iso(q.publishedAt), decidedAt: iso(q.decidedAt), rejectionReason: q.status === 'rejected' ? q.rejectionReason ?? null : null,
    expired, fileAvailable: q.scanStatus === 'clean', sizeBytes: q.sizeBytes,
    canDecide: q.status === 'published' && !expired && !CLOSED_CASE_STATUSES.has(caseRecord.status),
  };
}

/** GET: the ONE active published quotation of the patient's request. { quotation, lastDecision }:
 *   quotation      the live version (published, or accepted by the patient), with `expired` and `canDecide`; null when there is none
 *   lastDecision   only when nothing is live and the newest version is one the patient REJECTED (so the app can say so); otherwise null */
async function getActiveQuotation({ userId, requestId }, deps) {
  const ctx = buildContext(deps);
  const user = userIdOf(userId);
  const caseRecord = await ownCaseForRequest(ctx.prisma, user, requestId);
  const now = ctx.now();
  const live = await ctx.prisma.caseQuotation.findFirst({ where: { caseId: caseRecord.id, liveSlot: 1, status: { in: ['published', 'accepted'] }, supersededAt: null }, orderBy: { versionNumber: 'desc' } });
  if (live) return { quotation: patientView(live, caseRecord, now), lastDecision: null };
  const head = await ctx.prisma.caseQuotation.findFirst({ where: { caseId: caseRecord.id }, orderBy: { versionNumber: 'desc' } });
  if (head && head.status === 'rejected' && head.publishedAt) {
    return { quotation: null, lastDecision: { versionNumber: head.versionNumber, status: 'rejected', decidedAt: iso(head.decidedAt), amount: decimalText(head.amount), currency: head.currency ?? null } };
  }
  return { quotation: null, lastDecision: null };
}

async function decide({ userId, quotationId, decision, reason }, deps) {
  const ctx = buildContext(deps);
  const user = userIdOf(userId);
  const id = idOf(quotationId);
  const why = decision === 'rejected' ? reasonOf(reason) : null;
  const result = await ctx.prisma.$transaction(async (tx) => {
    const first = await tx.caseQuotation.findUnique({ where: { id } });
    if (!first) throw notFound();
    await tx.$queryRaw`SELECT id FROM cases WHERE id = ${first.caseId} FOR UPDATE`;
    const q = await tx.caseQuotation.findUnique({ where: { id } }); // re-read under the lock
    const caseRecord = await ownCaseOf(tx, user, q);
    if (!REACHABLE.has(q.status)) throw notFound(); // draft, confirmed, withdrawn: not the patient's to see

    if (q.status === decision) {
      if (q.decidedByUserId === user) return { already: true, q, caseRecord };
      throw conflict('quotation_already_decided', `This quotation was already ${q.status}.`);
    }
    if (q.status === 'accepted' || q.status === 'rejected') throw conflict('quotation_already_decided', `This quotation was already ${q.status}. A decision cannot be changed.`);
    if (q.status === 'superseded' || q.supersededAt) throw conflict('quotation_superseded', 'A newer quotation has replaced this one. Please review the new quotation.');
    if (isExpired(q, ctx.now())) throw conflict('quotation_expired', 'This quotation has expired and can no longer be accepted or rejected.');
    if (CLOSED_CASE_STATUSES.has(caseRecord.status)) throw conflict('case_closed', 'This request is closed.');
    if (q.scanStatus !== 'clean' || q.amount == null || q.currency == null || q.validationError) throw conflict('quotation_unavailable', 'This quotation is not available right now.');

    const data = decision === 'accepted'
      ? { status: 'accepted', decidedByUserId: user, decidedAt: ctx.now() }
      : { status: 'rejected', liveSlot: null, decidedByUserId: user, decidedAt: ctx.now(), rejectionReason: why };
    const { count } = await tx.caseQuotation.updateMany({ where: { id: q.id, revision: q.revision, status: 'published' }, data: { ...data, revision: { increment: 1 } } });
    if (count !== 1) throw conflict('quotation_changed', 'This quotation changed. Please open it again.');
    const verb = decision === 'accepted' ? 'accepted' : 'rejected';
    await appendAuditLog(tx, {
      caseId: caseRecord.id, entityType: 'case_quotation', entityId: q.id, action: `quotation.${verb}`,
      actorType: 'patient', actorId: String(user), source: 'mobile_app', reasonCode: `patient_${verb}`,
      beforeData: { status: 'published' },
      afterData: { quotationId: q.id, versionNumber: q.versionNumber, caseId: caseRecord.id, caseReference: caseRecord.referenceNumber, status: verb }, // the reason text lives on the row only
      correlationId: `quotation:${q.id}:r${q.revision}`, idempotencyKey: `quotation.${verb}:${q.id}`, // one decision per version, enforced by the database
    });
    return { already: false, q, caseRecord };
  }, { timeout: 30000, maxWait: 10000 });

  const fresh = await ctx.prisma.caseQuotation.findUnique({ where: { id } });
  return { already: result.already, quotation: patientView(fresh, result.caseRecord, ctx.now()) };
}

const acceptQuotation = (args, deps) => decide({ ...args, decision: 'accepted' }, deps).then(({ already, quotation }) => ({ alreadyAccepted: already, quotation }));
const rejectQuotation = (args, deps) => decide({ ...args, decision: 'rejected' }, deps).then(({ already, quotation }) => ({ alreadyRejected: already, quotation }));

/** The PDF of the live quotation of the patient's own Case: only while it is published or accepted (never superseded, rejected or unpublished), clean and intact. Audited. */
async function resolvePatientQuotationFile({ userId, quotationId }, deps) {
  const ctx = buildContext(deps);
  const user = userIdOf(userId);
  const id = idOf(quotationId);
  const q = await ctx.prisma.caseQuotation.findUnique({ where: { id } });
  if (!q) throw notFound();
  const caseRecord = await ownCaseOf(ctx.prisma, user, q);
  if (!REACHABLE.has(q.status)) throw notFound();
  if (q.status === 'superseded' || q.status === 'rejected' || q.supersededAt || q.liveSlot !== 1) throw conflict('quotation_not_available', 'This quotation is no longer available.');
  if (q.scanStatus !== 'clean') throw conflict('quotation_not_available', 'This quotation is not available right now.');
  let buffer;
  try { buffer = await storageOf(ctx).readVerified(q.storageKey, q.sha256); } catch { throw conflict('quotation_not_available', 'This quotation is not available right now.'); }
  await appendAuditLog(ctx.prisma, {
    caseId: caseRecord.id, entityType: 'case_quotation', entityId: q.id, action: 'quotation.file_viewed', actorType: 'patient', actorId: String(user), source: 'mobile_app',
    reasonCode: 'patient_viewed_file', afterData: { quotationId: q.id, versionNumber: q.versionNumber, caseId: caseRecord.id, caseReference: caseRecord.referenceNumber }, idempotencyKey: null,
  });
  return { buffer, name: `${caseRecord.referenceNumber}-quotation-v${q.versionNumber}.pdf` };
}

module.exports = { getActiveQuotation, acceptQuotation, rejectQuotation, resolvePatientQuotationFile, patientView, REASON_MIN, REASON_MAX };
