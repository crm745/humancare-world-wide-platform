// Phase 4: the invoice that follows an ACCEPTED Private Charter quotation, and the Admin authorization of a partial payment.
//
// NO PAYMENT HAPPENS HERE. No Razorpay call, no Bitrix call, no payment row. The quotation decision rules (patient-quotations.service.js) are not touched:
// an acceptance is final and committed BEFORE this runs, in its own earlier transaction. A failure here can never reverse or modify it; it is simply retried.
//
// ENSURE (ensureInvoiceForQuotation) - one transaction that locks the Case row (the same lock the decision, the Admin actions and the sync take):
//   1. an invoice for this quotation version already exists  -> returned as it is (created: false). Nothing is written, no second audit row.
//   2. otherwise the quotation must be ELIGIBLE: status 'accepted' (never rejected, published, withdrawn, superseded or any draft state), not superseded,
//      decided by the patient who owns the Case (patient path), clean scan, valid amount + currency, a Private Charter Case that is not closed;
//   3. the invoice is created with the quotation's Case, amount and currency copied EXACTLY (the decimal text, never a float, never rounded), source
//      'quotation', quotation_id = the accepted version (the database composite foreign key refuses any mismatch), status 'issued', partial payment OFF;
//   4. one audit row 'invoice.created' (unique key per invoice) in the same transaction.
//   Duplicates are impossible three ways over: the Case lock serialises callers, invoices.quotation_id is UNIQUE, and invoices (case_id, idempotency_key) is
//   UNIQUE. If a unique violation still occurs (lock bypassed by some other writer) the existing invoice is read back and returned.
// FAILURES: a business refusal is an HTTP-style error (statusCode + publicCode). An UNEXPECTED failure (database down, ...) leaves the accepted quotation
//   untouched, is logged by code only, and is recorded ONCE per quotation and error code as the audit row 'invoice.creation_failed' (Operations can list
//   accepted quotations that still have no invoice: listAcceptedWithoutInvoice). The recovery job and the patient's refresh both simply call ensure again.
const { prisma: defaultPrisma } = require('../../db/prisma');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { assertDealEligible } = require('../bitrix/deal-outbox');
const { toThousandths } = require('../payments/payment-money');

const CLOSED_CASE_STATUSES = new Set(['completed', 'cancelled']);
const INVOICE_SOURCE = 'quotation';
const INVOICE_STATUS = 'issued';
const MIN_AGE_MS = 30 * 1000; // the recovery sweep leaves a fresh acceptance to the request that made it

function httpError(statusCode, message, publicCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.publicCode = publicCode;
  return err;
}
const conflict = (code, message) => httpError(409, message, code);
const notFound = () => httpError(404, 'Quotation not found', 'quotation_not_found');

function buildContext(overrides = {}) {
  return { prisma: defaultPrisma, now: () => new Date(), log: console, ...overrides };
}

function idOf(value, make = notFound) {
  const text = String(value);
  if (!/^[1-9]\d{0,9}$/.test(text)) throw make();
  return Number(text);
}

const isUniqueViolation = (err) => Boolean(err) && err.code === 'P2002';
const utcDate = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// The invoice number is derived from the Case reference and the quotation VERSION, so a retry can only ever produce the same number (and invoice_number is UNIQUE).
const invoiceNumberOf = (caseRecord, quotation) => `INV-${caseRecord.referenceNumber}-V${quotation.versionNumber}`.slice(0, 64);
const idempotencyKeyOf = (quotationId) => `quotation-invoice:${quotationId}`;

// The exact decimal text of the quotation's money. Never rounded: a value that is not an exact decimal is refused.
function exactAmountText(value) {
  if (toThousandths(value) === null) return null;
  return typeof value === 'object' && typeof value.toFixed === 'function' ? value.toFixed(3) : String(value);
}

function eligibility(q, caseRecord, { patientId }) {
  if (patientId != null && !['published', 'accepted', 'rejected', 'superseded'].includes(q.status)) throw notFound(); // not published to the patient: it does not exist for them
  if (q.status !== 'accepted') throw conflict('quotation_not_accepted', 'An invoice can only be created for an accepted quotation.');
  if (q.supersededAt || q.supersededById) throw conflict('quotation_superseded', 'A newer quotation has replaced this one.');
  if (!q.publishedAt || q.decidedByUserId == null || !q.decidedAt) throw conflict('quotation_ineligible', 'This quotation is not eligible for an invoice.');
  if (patientId != null && q.decidedByUserId !== patientId) throw conflict('quotation_ineligible', 'This quotation was not accepted by you.');
  if (q.scanStatus !== 'clean' || q.amount == null || q.currency == null || q.validationError) throw conflict('quotation_unavailable', 'This quotation is not available right now.');
  if (CLOSED_CASE_STATUSES.has(caseRecord.status)) throw conflict('case_closed', 'This request is closed.');
  try { assertDealEligible(caseRecord, caseRecord.serviceRequest); } catch { throw conflict('quotation_ineligible', 'This quotation is not eligible for an invoice.'); }
}

/** What Operations and the callers need of the invoice row. No payment data. */
function invoiceSummary(invoice) {
  return {
    id: invoice.id, caseId: invoice.caseId, quotationId: invoice.quotationId, invoiceNumber: invoice.invoiceNumber, status: invoice.status,
    amount: exactAmountText(invoice.amount), currency: invoice.currency, issueDate: invoice.issueDate ? new Date(invoice.issueDate).toISOString().slice(0, 10) : null,
    dueDate: invoice.dueDate ? new Date(invoice.dueDate).toISOString().slice(0, 10) : null, allowPartialPayment: invoice.allowPartialPayment === true,
  };
}

async function ensureInTransaction(ctx, { quotationId, patientId }) {
  return ctx.prisma.$transaction(async (tx) => {
    const first = await tx.caseQuotation.findUnique({ where: { id: quotationId } });
    if (!first) throw notFound();
    await tx.$queryRaw`SELECT id FROM cases WHERE id = ${first.caseId} FOR UPDATE`;
    const q = await tx.caseQuotation.findUnique({ where: { id: quotationId } }); // re-read under the lock
    const caseRecord = await tx.case.findFirst({
      where: { id: q.caseId, ...(patientId != null ? { serviceRequest: { userId: patientId } } : {}) },
      include: { serviceRequest: true },
    });
    if (!caseRecord) throw notFound(); // another patient's quotation looks exactly like a missing one

    const existing = await tx.invoice.findFirst({ where: { quotationId: q.id } });
    if (existing) return { created: false, invoice: existing };

    eligibility(q, caseRecord, { patientId });
    const amount = exactAmountText(q.amount);
    if (amount === null) throw conflict('quotation_unavailable', 'This quotation is not available right now.');
    const issued = utcDate(ctx.now());
    const invoice = await tx.invoice.create({
      data: {
        caseId: q.caseId, source: INVOICE_SOURCE, quotationId: q.id, invoiceNumber: invoiceNumberOf(caseRecord, q), amount, currency: q.currency,
        status: INVOICE_STATUS, issueDate: issued, dueDate: null, idempotencyKey: idempotencyKeyOf(q.id), allowPartialPayment: false,
      },
    });
    await appendAuditLog(tx, {
      caseId: caseRecord.id, entityType: 'invoice', entityId: String(invoice.id), action: 'invoice.created',
      actorType: patientId != null ? 'patient' : 'system', actorId: patientId != null ? String(patientId) : null, source: patientId != null ? 'mobile_app' : 'system',
      reasonCode: 'quotation_accepted', afterData: { invoiceId: invoice.id, quotationId: q.id, versionNumber: q.versionNumber, caseId: caseRecord.id, caseReference: caseRecord.referenceNumber, amount, currency: q.currency, status: INVOICE_STATUS },
      idempotencyKey: `invoice.created:${invoice.id}`, // one creation audit row per invoice, enforced by the database
    });
    return { created: true, invoice };
  }, { timeout: 30000, maxWait: 10000 });
}

// Operations can find a failure afterwards: ONE audit row per quotation and error code, however many retries fail the same way.
async function recordFailure(ctx, quotationId, err) {
  const code = String((err && (err.publicCode || err.code || err.name)) || 'Error').toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, 40) || 'error';
  try {
    const q = await ctx.prisma.caseQuotation.findUnique({ where: { id: quotationId } });
    await appendAuditLog(ctx.prisma, {
      caseId: q ? q.caseId : null, entityType: 'case_quotation', entityId: String(quotationId), action: 'invoice.creation_failed', actorType: 'system', source: 'system',
      reasonCode: code, afterData: { quotationId, ...(q ? { versionNumber: q.versionNumber } : {}) }, idempotencyKey: `invoice.creation_failed:${quotationId}:${code}`,
    });
  } catch (auditErr) {
    if (!isUniqueViolation(auditErr)) ctx.log.error(`[invoice] could not record the failure for quotation ${quotationId}: ${(auditErr && (auditErr.code || auditErr.name)) || 'Error'}`);
  }
}

/** Idempotent. `userId` = the patient (patient path: ownership is checked); omit it for the system recovery path.
 *  Resolves { created, invoice } (invoice = invoiceSummary). Business refusals throw 404/409 errors with a publicCode. */
async function ensureInvoiceForQuotation({ quotationId, userId = null }, deps) {
  const ctx = buildContext(deps);
  const id = idOf(quotationId);
  let patientId = null;
  if (userId != null) {
    patientId = Number(userId);
    if (!Number.isInteger(patientId) || patientId < 1) throw httpError(401, 'Please log in to continue.', 'not_signed_in');
  }
  try {
    const { created, invoice } = await ensureInTransaction(ctx, { quotationId: id, patientId });
    return { created, invoice: invoiceSummary(invoice) };
  } catch (err) {
    if (isUniqueViolation(err)) { // another writer won the race: hand back the invoice it made
      const existing = await ctx.prisma.invoice.findFirst({ where: { quotationId: id } });
      if (existing) return { created: false, invoice: invoiceSummary(existing) };
    }
    if (!err || !err.statusCode) {
      ctx.log.error(`[invoice] creation failed for quotation ${id}: ${(err && (err.code || err.name)) || 'Error'}`);
      await recordFailure(ctx, id, err);
    }
    throw err;
  }
}

/** The patient's retry / refresh: ensures the invoice for the patient's own accepted quotation. */
const ensureInvoiceForPatient = ({ userId, quotationId }, deps) => {
  if (userId == null) throw httpError(401, 'Please log in to continue.', 'not_signed_in');
  return ensureInvoiceForQuotation({ quotationId, userId }, deps);
};

/** True when the Case's live accepted quotation has no invoice yet (the app shows "being prepared"). Ownership is in the query. */
async function isInvoicePending({ userId, requestId }, deps) {
  const ctx = buildContext(deps);
  const accepted = await ctx.prisma.caseQuotation.findFirst({
    where: { status: 'accepted', supersededAt: null, case: { serviceRequestId: Number(requestId), serviceRequest: { userId: Number(userId) } } },
    orderBy: { versionNumber: 'desc' },
    select: { id: true },
  });
  if (!accepted) return null;
  const invoice = await ctx.prisma.invoice.findFirst({ where: { quotationId: accepted.id }, select: { id: true } });
  return invoice ? null : { quotationId: accepted.id };
}

/** Recovery sweep (system): accepted, live quotations with no invoice, older than a short grace period. Each is ensured on its own; one failure never stops the rest. */
async function sweepAcceptedWithoutInvoice(deps = {}, { limit = 25 } = {}) {
  const ctx = buildContext(deps);
  const olderThan = new Date(ctx.now().getTime() - MIN_AGE_MS);
  const rows = await listAcceptedWithoutInvoice(ctx, { olderThan, limit });
  const result = { found: rows.length, created: 0, failed: 0 };
  for (const row of rows) {
    try {
      const { created } = await ensureInvoiceForQuotation({ quotationId: row.id }, ctx);
      if (created) result.created += 1;
    } catch { result.failed += 1; }
  }
  return result;
}

/** Operations view: accepted, live quotations that still have no invoice (a creation failure or one not yet retried). Identifiers and state only. */
async function listAcceptedWithoutInvoice(deps = {}, { olderThan = null, limit = 50 } = {}) {
  const ctx = buildContext(deps);
  const rows = await ctx.prisma.caseQuotation.findMany({
    where: { status: 'accepted', supersededAt: null, invoices: { none: {} }, ...(olderThan ? { decidedAt: { lte: olderThan } } : {}) },
    orderBy: { id: 'asc' }, take: limit,
    select: { id: true, caseId: true, versionNumber: true, decidedAt: true },
  });
  return rows.map((r) => ({ id: r.id, caseId: r.caseId, versionNumber: r.versionNumber, acceptedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null }));
}

/** Admin only: allow partial payment on one invoice. Records WHO (admin id) and WHEN. The default for every invoice stays "full payment only".
 *  Repeating it is a no-op (the first authorization, its admin and time are kept). */
async function authorizePartialPayment({ invoiceId, adminId, adminRole }, deps) {
  const ctx = buildContext(deps);
  const id = idOf(invoiceId, () => httpError(404, 'Invoice not found', 'invoice_not_found'));
  const admin = Number(adminId);
  if (!Number.isInteger(admin) || admin < 1) throw httpError(401, 'Invalid admin session', 'admin_required');
  const { already, invoice } = await ctx.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
    const row = await tx.invoice.findUnique({ where: { id } });
    if (!row) throw httpError(404, 'Invoice not found', 'invoice_not_found');
    if (row.source !== INVOICE_SOURCE || row.status !== INVOICE_STATUS) throw conflict('invoice_not_payable', 'Partial payment can only be authorized on an issued quotation invoice.');
    if (row.allowPartialPayment) return { already: true, invoice: row };
    const at = ctx.now();
    const { count } = await tx.invoice.updateMany({ where: { id, allowPartialPayment: false }, data: { allowPartialPayment: true, partialPaymentAuthorizedByAdminId: admin, partialPaymentAuthorizedAt: at } });
    if (count !== 1) throw conflict('invoice_changed', 'This invoice changed. Please open it again.');
    await appendAuditLog(tx, {
      caseId: row.caseId, entityType: 'invoice', entityId: String(id), action: 'invoice.partial_payment_authorized', actorType: 'admin', actorId: String(admin),
      actorRole: adminRole ? String(adminRole).slice(0, 32) : null, source: 'admin_portal', reasonCode: 'admin_authorized', beforeData: { status: row.status },
      afterData: { invoiceId: id, quotationId: row.quotationId, caseId: row.caseId, status: row.status }, idempotencyKey: `invoice.partial_payment_authorized:${id}`,
    });
    return { already: false, invoice: { ...row, allowPartialPayment: true, partialPaymentAuthorizedByAdminId: admin, partialPaymentAuthorizedAt: at } };
  }, { timeout: 30000, maxWait: 10000 });
  return { alreadyAuthorized: already, invoice: { ...invoiceSummary(invoice), partialPaymentAuthorizedByAdminId: invoice.partialPaymentAuthorizedByAdminId, partialPaymentAuthorizedAt: invoice.partialPaymentAuthorizedAt ? new Date(invoice.partialPaymentAuthorizedAt).toISOString() : null } };
}

module.exports = {
  ensureInvoiceForQuotation, ensureInvoiceForPatient, isInvoicePending, sweepAcceptedWithoutInvoice, listAcceptedWithoutInvoice, authorizePartialPayment,
  invoiceNumberOf, idempotencyKeyOf,
};
