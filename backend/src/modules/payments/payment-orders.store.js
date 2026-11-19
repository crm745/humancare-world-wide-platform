// The database half of Razorpay order creation. Every function takes `db`: the Prisma client or, for anything that must be atomic, a
// transaction. Nothing here calls Razorpay. The locking order is INVOICE FIRST, then the payment row (the M7 discipline): the quotation
// row is only READ (never locked), so this code can never be one side of a deadlock with a future quotation replacement, which locks
// the quotation and then the invoice.
const { appendAuditLog } = require('../../common/audit/business-audit');

// SELECT ... FOR UPDATE on the invoice row, held until the transaction ends.
async function lockInvoice(tx, invoiceId) {
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
}

async function lockPayment(tx, paymentId) {
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
}

// The invoice with what the eligibility rules and the ownership check need, and nothing else.
function loadInvoice(db, invoiceId) {
  return db.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true, caseId: true, source: true, status: true, amount: true, currency: true, dueDate: true, quotationId: true, allowPartialPayment: true, invoiceNumber: true, issueDate: true,
      quotation: { select: { id: true, status: true, supersededAt: true, versionNumber: true } },
      case: { select: { id: true, status: true, closedAt: true, serviceRequest: { select: { userId: true, serviceKey: true } } } },
    },
  });
}

const PAYMENT_FIELDS = {
  id: true, invoiceId: true, caseId: true, currency: true, kind: true, amount: true, status: true, method: true, razorpayOrderId: true,
  externalReference: true, idempotencyKey: true, createdAt: true, updatedAt: true,
};

function listPayments(db, invoiceId) {
  return db.payment.findMany({ where: { invoiceId }, select: PAYMENT_FIELDS, orderBy: { id: 'asc' } });
}

function loadPayment(db, paymentId) {
  return db.payment.findUnique({ where: { id: paymentId }, select: PAYMENT_FIELDS });
}

function insertPendingPayment(db, { invoiceId, caseId, currency, amount, idempotencyKey }) {
  return db.payment.create({
    data: { invoiceId, caseId, currency, kind: 'payment', status: 'pending', method: 'razorpay', amount, idempotencyKey, razorpayOrderId: null },
    select: PAYMENT_FIELDS,
  });
}

// Sets the Razorpay order id ONCE: only while the row is still pending and has no order id. Returns true when it was written.
async function attachOrderId(db, paymentId, razorpayOrderId) {
  const result = await db.payment.updateMany({ where: { id: paymentId, status: 'pending', razorpayOrderId: null }, data: { razorpayOrderId } });
  return result.count === 1;
}

// pending -> failed | cancelled, only while the row is still pending. Returns true when it was written.
async function closePending(db, paymentId, status) {
  const result = await db.payment.updateMany({ where: { id: paymentId, status: 'pending' }, data: { status } });
  return result.count === 1;
}

// Pending Razorpay payment rows that never got an order id and are older than `olderThan` (recovery candidates).
function findWithoutOrder(db, { olderThan, limit }) {
  return db.payment.findMany({
    where: { kind: 'payment', status: 'pending', method: 'razorpay', razorpayOrderId: null, updatedAt: { lt: olderThan } },
    select: PAYMENT_FIELDS, orderBy: { id: 'asc' }, take: limit,
  });
}

// Pending Razorpay payment rows with an order id that have not been touched since `olderThan` (unused-order timeout candidates).
function findStaleWithOrder(db, { olderThan, limit }) {
  return db.payment.findMany({
    where: { kind: 'payment', status: 'pending', method: 'razorpay', razorpayOrderId: { not: null }, updatedAt: { lt: olderThan } },
    select: PAYMENT_FIELDS, orderBy: { id: 'asc' }, take: limit,
  });
}

// Business audit entry written in the SAME transaction as the change. Only allow-listed keys (identifiers and short values).
function audit(db, { caseId, paymentId, action, actorType, actorId, reasonCode, data, idempotencyKey }) {
  return appendAuditLog(db, {
    caseId, entityType: 'payment', entityId: String(paymentId), action, actorType, actorId: actorId == null ? null : String(actorId),
    source: actorType === 'patient' ? 'mobile_app' : 'system', reasonCode, afterData: data, idempotencyKey,
  });
}

module.exports = {
  lockInvoice, lockPayment, loadInvoice, listPayments, loadPayment, insertPendingPayment, attachOrderId, closePending,
  findWithoutOrder, findStaleWithOrder, audit,
};
