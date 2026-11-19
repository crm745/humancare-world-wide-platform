// What a PATIENT may see of an invoice and its payments, for the mobile app: the invoice summary inside GET /requests/me/:id and GET /invoices/:invoiceId
// (the status the app polls after Checkout). READ ONLY: nothing here writes, locks, calls Razorpay or completes a payment.
//
// OWNERSHIP is decided by the database path invoice -> Case -> service request -> user, in the query itself and again on the loaded row. An invoice of
// another patient, or one that does not exist, is the SAME answer (404 invoice_not_found): nothing tells the two apart. A DRAFT invoice is not the
// patient's to see yet and is treated as not found.
//
// WHAT IS RETURNED: amounts as exact decimal texts, the invoice status, the paid and balance figures computed from COMPLETED payment rows only (refunds
// never reopen a balance), whether the app may start a payment now (`payable`, with a short reason code when not), whether a payment is already open, and
// the payment rows reduced to id, kind, status, amount, currency and times. NEVER returned: gateway ids (order, payment, refund), idempotency keys, receipts,
// audit data, other patients' data, the Case or the request.
const { prisma } = require('../../db/prisma');
const store = require('./payment-orders.store');
const orders = require('./payment-orders.service');
const { isPaymentsEnabled, credentialProblem } = require('./razorpay-config');
const { toThousandths, formatAmount } = require('./payment-money');

// Exact decimal text of an amount: the currency's own form (INR "1500.00"), else the exact database form ("1500.001"); never rounded.
function amountText(thousandths, currency) {
  if (typeof thousandths !== 'bigint' || thousandths < 0n) return null;
  const own = formatAmount(thousandths, currency);
  if (own !== null) return own;
  const digits = thousandths.toString().padStart(4, '0');
  return `${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

const dateOnly = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);
const isoOrNull = (value) => (value ? new Date(value).toISOString() : null);

// The payment columns the view needs, and NOTHING else: the gateway ids, the idempotency key and the method are never even read from the database.
const PAYMENT_VIEW_FIELDS = { id: true, kind: true, status: true, amount: true, currency: true, transactedAt: true, createdAt: true };
const listPaymentRows = (db, invoiceId) => db.payment.findMany({ where: { invoiceId }, select: PAYMENT_VIEW_FIELDS, orderBy: { id: 'asc' } });

/**
 * Pure: the patient's view of one invoice. `invoice` is what store.loadInvoice returns; `payments` is every row of the invoice (the fields above).
 * `env` decides whether online payment is available at all (the same gates the order endpoint applies).
 */
function invoiceView(invoice, payments, { now = new Date(), env = process.env } = {}) {
  const amount = toThousandths(invoice.amount);
  if (amount === null) throw new Error('invoice amount is not an exact decimal');
  const paid = orders.netPaid(payments); // completed, non-refund rows only
  const balance = amount > paid ? amount - paid : 0n;
  const hasOpenPayment = payments.some((p) => p.kind === 'payment' && p.status === 'pending');

  let payableReason = null;
  if (!isPaymentsEnabled(env) || credentialProblem(env)) payableReason = 'payments_disabled';
  else if (invoice.status !== 'issued') payableReason = 'invoice_not_payable';
  else if (balance === 0n) payableReason = 'fully_paid';
  else payableReason = orders.eligibilityProblem(invoice, now); // null when payable

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber || null,
    status: invoice.status,
    amount: amountText(amount, invoice.currency),
    currency: invoice.currency,
    issueDate: dateOnly(invoice.issueDate),
    dueDate: dateOnly(invoice.dueDate),
    quotationVersion: invoice.quotation && invoice.quotation.versionNumber != null ? invoice.quotation.versionNumber : null, // the accepted quotation version this invoice belongs to
    allowPartialPayment: invoice.allowPartialPayment === true,
    paid: amountText(paid, invoice.currency),
    balance: amountText(balance, invoice.currency),
    payable: payableReason === null,
    payableReason,
    hasOpenPayment,
    payments: payments.map((p) => ({
      id: p.id, kind: p.kind, status: p.status, amount: amountText(toThousandths(p.amount), p.currency), currency: p.currency,
      transactedAt: isoOrNull(p.transactedAt), createdAt: isoOrNull(p.createdAt),
    })),
  };
}

// One invoice of THIS patient, or a 404. Draft invoices are not visible.
async function getInvoiceForPatient({ userId, invoiceId, db = prisma, now = new Date(), env = process.env }) {
  const id = orders.parseInvoiceId(invoiceId);
  if (id === null) throw orders.fail('invoice_not_found');
  const invoice = await store.loadInvoice(db, id);
  if (!orders.ownedBy(invoice, userId) || invoice.status === 'draft') throw orders.fail('invoice_not_found');
  const payments = await listPaymentRows(db, id);
  return invoiceView(invoice, payments, { now, env });
}

// The visible invoices of ONE request of THIS patient (oldest first). The ownership is in the query: another patient's request id yields [].
async function listInvoicesForRequest({ userId, requestId, db = prisma, now = new Date(), env = process.env }) {
  const rows = await db.invoice.findMany({
    where: { status: { not: 'draft' }, case: { serviceRequest: { id: Number(requestId), userId: Number(userId) } } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const views = [];
  for (const row of rows) {
    const invoice = await store.loadInvoice(db, row.id);
    if (!orders.ownedBy(invoice, Number(userId))) continue; // belt and braces: never return a row the loaded path does not confirm
    views.push(invoiceView(invoice, await listPaymentRows(db, row.id), { now, env }));
  }
  return views;
}

module.exports = { invoiceView, getInvoiceForPatient, listInvoicesForRequest, amountText };
