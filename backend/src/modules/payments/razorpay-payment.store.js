// The database half of applying a verified Razorpay event to Payment records: lookups, guarded completion of a payment, guarded completion or
// failure of an EXISTING refund, and the audit/flag trail. It is the store the (later) event processor will call. It does not parse events, does
// not read the inbox, does not call Razorpay and does not log.
//
// DECISIONS APPLIED (approved, not reopened):
//   D1  a verified capture on a locally failed / cancelled payment COMPLETES that payment and flags it for Operations (reason late_capture). It
//       never reopens the invoice and never creates an order.
//   D2  refunds are only ever UPDATED here (pending -> completed | failed). No refund row is created from an event. An unknown refund is flagged.
//   D3  transactedAt is the validated Razorpay event time. Missing / invalid -> nothing is completed; the case is flagged (quarantined).
//   Only completed kind="payment" rows count towards the invoice's paid balance; refunds never reopen a balance; an overpayment is kept and flagged.
//
// LOCKING (the M7 order, never reversed): INVOICE row first, then PAYMENT rows (in ascending id when more than one). Everything that was read before
// the locks is RE-READ after them, and every decision uses the re-read rows. Writes are conditional (`WHERE status = <expected>`) as a second fence.
// The invoice is locked first because the only unlocked read is "which invoice does this order / refund belong to"; its answer is re-verified.
//
// TRANSACTIONS: every guarded operation takes `db`. Given the Prisma client it opens its own transaction; given a transaction (what the processor
// will pass, so the inbox result commits with the change) it runs inside it. Any throw rolls everything back, including the audit rows. Flags that
// must survive a refusal are written in the same transaction as the (non-)change, so "refuse + flag" is atomic.
//
// OUTCOMES are returned, never thrown, for anything that is data-driven (a mismatch, a duplicate, an unknown id). Only database errors and programming
// errors (bad arguments) throw.
const { appendAuditLog } = require('../../common/audit/business-audit');
const { lockInvoice, lockPayment, loadInvoice } = require('./payment-orders.store');
const { toThousandths, fromMinorUnits, formatAmount } = require('./payment-money');

const ORDER_ID = /^order_[A-Za-z0-9]{1,58}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,60}$/;
const REFUND_ID = /^rfnd_[A-Za-z0-9]{1,60}$/;
const CURRENCY = /^[A-Z]{3}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.]{0,63}$/;

const ACTOR = Object.freeze({ type: 'system', id: null });
const SOURCE = 'razorpay_webhook';

const PAYMENT_FIELDS = {
  id: true, invoiceId: true, caseId: true, currency: true, kind: true, refundOfPaymentId: true, amount: true, status: true, method: true,
  externalReference: true, transactedAt: true, razorpayOrderId: true, createdAt: true, updatedAt: true,
};

const isMinor = (v) => Number.isSafeInteger(v) && v > 0;
const bad = (msg) => new RangeError(msg);

// ---- argument checks (programming errors; thrown before any query) ----------------------------------------------------------------------------
function requireId(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw bad(`${name} must be a positive whole number`);
}
function requireText(value, regex, name) {
  if (typeof value !== 'string' || !regex.test(value)) throw bad(`${name} is not a valid Razorpay id`);
}

// D3: the transaction time must be a real instant inside the same credible window the receiver uses (2001..2100). A Date or a strict ISO-8601 UTC
// string is accepted. Returns a Date or null. The store never substitutes the application clock.
function validTransactionTime(value) {
  let date = null;
  if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') date = new Date(value.getTime());
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) date = new Date(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  const t = date.getTime();
  return t >= 1_000_000_000_000 && t <= 4_102_444_800_000 ? date : null;
}

// ---- transaction helper ----------------------------------------------------------------------------------------------------------------------
// A Prisma interactive transaction has no $transaction; the client has. So this runs `fn` in the caller's transaction, or opens one.
function inTransaction(db, fn) {
  return typeof db.$transaction === 'function' ? db.$transaction((tx) => fn(tx)) : fn(db);
}

// ---- current reads (inside a transaction, AFTER the locks) -------------------------------------------------------------------------------------
// InnoDB's default isolation is REPEATABLE READ: a plain SELECT inside a transaction reads the snapshot taken at the transaction's FIRST read, so a
// "re-read after locking" through the ordinary Prisma API would NOT see a row another transaction committed while we waited for the lock (verified
// on real MySQL: it produced a double completion and a refund total that ignored a concurrent refund). SELECT ... FOR UPDATE is a CURRENT read: it
// returns the latest committed row. So every read the guarded operations decide on, after the locks, is a locking read of rows already locked by us
// (invoice first, so nothing here can deadlock with another writer that follows the same order).
const toInt = (v) => (v === null || v === undefined ? null : Number(v));
function shapePayment(r) {
  if (!r) return null;
  return {
    id: Number(r.id), invoiceId: Number(r.invoiceId), caseId: Number(r.caseId), currency: r.currency, kind: r.kind, refundOfPaymentId: toInt(r.refundOfPaymentId),
    amount: r.amount, status: r.status, method: r.method ?? null, externalReference: r.externalReference ?? null, transactedAt: r.transactedAt ?? null,
    razorpayOrderId: r.razorpayOrderId ?? null,
  };
}
async function currentPayment(tx, id) {
  const rows = await tx.$queryRaw`
    SELECT id, invoice_id AS invoiceId, case_id AS caseId, currency, kind, refund_of_payment_id AS refundOfPaymentId, amount, status, method,
           external_reference AS externalReference, transacted_at AS transactedAt, razorpay_order_id AS razorpayOrderId
    FROM payments WHERE id = ${id} FOR UPDATE`;
  return shapePayment(rows[0]);
}
async function currentInvoice(tx, id) {
  const rows = await tx.$queryRaw`SELECT id, case_id AS caseId, status, amount, currency FROM invoices WHERE id = ${id} FOR UPDATE`;
  const r = rows[0];
  return r ? { id: Number(r.id), caseId: Number(r.caseId), status: r.status, amount: r.amount, currency: r.currency } : null;
}
async function currentCompletedRows(tx, invoiceId) {
  return tx.$queryRaw`SELECT kind, amount FROM payments WHERE invoice_id = ${invoiceId} AND status = 'completed' ORDER BY id FOR UPDATE`;
}
async function currentCompletedRefundRows(tx, originalPaymentId) {
  return tx.$queryRaw`SELECT amount FROM payments WHERE kind = 'refund' AND refund_of_payment_id = ${originalPaymentId} AND status = 'completed' ORDER BY id FOR UPDATE`;
}

// ---- lookups (read only; usable on the client or inside a transaction) -------------------------------------------------------------------------

// The Razorpay payment row of an order id (kind "payment"), or null.
function findPaymentByOrderId(db, razorpayOrderId) {
  requireText(razorpayOrderId, ORDER_ID, 'razorpayOrderId');
  return db.payment.findUnique({ where: { razorpayOrderId }, select: PAYMENT_FIELDS });
}

// Refund rows carrying a Razorpay refund id. The unique key is (invoice, kind, reference), so in theory the same reference could exist on two
// invoices; that is reported as "ambiguous" and never guessed. Resolves { outcome: 'none' | 'found' | 'ambiguous', refund }.
async function findRefundByExternalReference(db, razorpayRefundId) {
  requireText(razorpayRefundId, REFUND_ID, 'razorpayRefundId');
  const rows = await db.payment.findMany({ where: { kind: 'refund', externalReference: razorpayRefundId }, select: PAYMENT_FIELDS, orderBy: { id: 'asc' }, take: 2 });
  if (rows.length === 0) return { outcome: 'none', refund: null };
  if (rows.length > 1) return { outcome: 'ambiguous', refund: null };
  return { outcome: 'found', refund: rows[0] };
}

// The original (kind "payment") payment a refund row points at, or null. The composite foreign key guarantees it is a payment of the same invoice.
function findOriginalPaymentOfRefund(db, refund) {
  if (!refund || refund.refundOfPaymentId == null) return Promise.resolve(null);
  return db.payment.findUnique({ where: { id: refund.refundOfPaymentId }, select: PAYMENT_FIELDS });
}

// The Razorpay payment row whose gateway payment id is `razorpayPaymentId` (kind "payment"), or null; more than one is "ambiguous" (not guessed).
async function findPaymentByGatewayPaymentId(db, razorpayPaymentId) {
  requireText(razorpayPaymentId, PAYMENT_ID, 'razorpayPaymentId');
  const rows = await db.payment.findMany({ where: { kind: 'payment', externalReference: razorpayPaymentId, razorpayOrderId: { not: null } }, select: PAYMENT_FIELDS, orderBy: { id: 'asc' }, take: 2 });
  if (rows.length === 0) return { outcome: 'none', payment: null };
  if (rows.length > 1) return { outcome: 'ambiguous', payment: null };
  return { outcome: 'found', payment: rows[0] };
}

// The invoice with its Case (and the Case's service request owner/key) for validation. Same shape the order service uses.
const loadInvoiceContext = (db, invoiceId) => loadInvoice(db, invoiceId);

// Exact (BigInt thousandths) totals of COMPLETED rows of an invoice. `paid` counts kind "payment" only; `refunded` is informational and is never
// subtracted: refunds do not reopen an invoice balance.
async function completedTotals(db, invoiceId, { current = false } = {}) {
  requireId(invoiceId, 'invoiceId');
  const rows = current
    ? await currentCompletedRows(db, invoiceId)
    : await db.payment.findMany({ where: { invoiceId, status: 'completed' }, select: { id: true, kind: true, amount: true }, orderBy: { id: 'asc' } });
  let paid = 0n;
  let refunded = 0n;
  for (const row of rows) {
    const t = toThousandths(row.amount);
    if (t === null) throw new Error('payment amount is not an exact decimal');
    if (row.kind === 'payment') paid += t;
    else if (row.kind === 'refund') refunded += t;
  }
  return { paid, refunded, paymentCount: rows.filter((r) => r.kind === 'payment').length };
}

// Completed refunds already recorded against ONE original payment, as BigInt thousandths. `current: true` = a locking current read (inside a
// transaction, after the locks).
async function completedRefundTotalOf(db, originalPaymentId, { current = false } = {}) {
  requireId(originalPaymentId, 'originalPaymentId');
  const rows = current
    ? await currentCompletedRefundRows(db, originalPaymentId)
    : await db.payment.findMany({ where: { kind: 'refund', refundOfPaymentId: originalPaymentId, status: 'completed' }, select: { amount: true }, orderBy: { id: 'asc' } });
  return rows.reduce((sum, row) => {
    const t = toThousandths(row.amount);
    if (t === null) throw new Error('refund amount is not an exact decimal');
    return sum + t;
  }, 0n);
}

// Pure: how far completed payments exceed the invoice amount. `overpaid` is 0n when they do not. Refunds are not netted off.
function overpaymentOf(invoiceAmount, paidThousandths) {
  const amount = toThousandths(invoiceAmount);
  if (amount === null || typeof paidThousandths !== 'bigint') throw new TypeError('exact amounts are required');
  return { invoiceAmount: amount, paid: paidThousandths, overpaid: paidThousandths > amount ? paidThousandths - amount : 0n };
}

// The overpayment of an invoice from its completed payment rows.
async function calculateInvoiceOverpayment(db, invoiceId) {
  const invoice = await loadInvoiceContext(db, invoiceId);
  if (!invoice) return null;
  const { paid } = await completedTotals(db, invoiceId);
  return overpaymentOf(invoice.amount, paid);
}

// ---- audit support -----------------------------------------------------------------------------------------------------------------------------
// Everything is written with the existing business audit writer (allow-listed keys, short values, same transaction). There is no free text:
// reasons are short lowercase codes. The unique key (entity, idempotency key) makes every entry once-only; a repeat is a no-op.
// Exact decimal text of an amount for the evidence: the currency's own form when it fits (INR "1500.00"), else the exact database form
// ("1500.001"), so a figure that needs more digits than the currency has is still recorded exactly, never rounded and never dropped.
function text(thousandths, currency) {
  if (typeof thousandths !== 'bigint' || thousandths < 0n) return null;
  const own = formatAmount(thousandths, currency);
  if (own !== null) return own;
  const digits = thousandths.toString().padStart(4, '0');
  return `${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

async function writeOnce(db, entry) {
  try {
    await appendAuditLog(db, { actorType: ACTOR.type, actorId: ACTOR.id, source: SOURCE, ...entry });
    return true;
  } catch (err) {
    if (err && err.code === 'P2002') return false; // already recorded
    throw err;
  }
}

function auditPayment(db, row, { action, reasonCode, data, key, previousStatus }) {
  return writeOnce(db, {
    caseId: row.caseId, entityType: 'payment', entityId: String(row.id), action, reasonCode,
    beforeData: previousStatus ? { status: previousStatus } : undefined,
    afterData: { paymentId: row.id, invoiceId: row.invoiceId, ...data }, idempotencyKey: key,
  });
}

// Operations reconciliation flag: a once-only audit entry with reconciliationRequired = true. Attached to the payment row concerned.
function flagPayment(db, row, reasonCode, data, key) {
  return auditPayment(db, row, { action: 'payment.reconciliation_required', reasonCode, data: { ...data, reconciliationRequired: true }, key: `recon:${key}` });
}

// A flag for a refund event that matches no refund row but whose original payment IS known: attached to that payment.
// An event whose refund AND payment are both unknown is NOT flagged (most likely another environment's traffic: no noisy alerts).

// ---- completing a payment ----------------------------------------------------------------------------------------------------------------------

/**
 * Applies a verified `payment.captured` to the Razorpay payment row of `orderId`.
 *
 * input: { razorpayOrderId, razorpayPaymentId, amountMinor (integer, smallest unit), currency, transactedAt (Date | ISO string), eventType }
 *
 * Outcomes:
 *   unknown_order        no payment row has this order id (nothing written; the caller decides, other environments are not alerted)
 *   quarantined          transactedAt missing/invalid (D3): nothing completed, flagged invalid_transaction_time
 *   not_a_payment        the row is not a kind "payment" row: flagged
 *   currency_mismatch    event currency differs from the payment / invoice: flagged, not completed
 *   amount_mismatch      event amount differs from the payment amount: flagged, not completed
 *   completed            pending -> completed (flags: overpayment when completed payments now exceed the invoice; invoice_not_issued)
 *   late_capture         failed | cancelled -> completed, flagged late_capture (D1); the invoice is NOT reopened
 *   duplicate_capture    already completed with the SAME gateway payment id: nothing written
 *   different_payment_id already completed (or carrying another reference) with a DIFFERENT gateway payment id: nothing overwritten, flagged
 *   reference_conflict   the gateway payment id is already on another payment of this invoice: flagged, nothing written
 *   not_capturable       any other state (should not happen): flagged
 * Resolves { outcome, paymentId, invoiceId, flagged, overpaid } (overpaid as exact decimal text when > 0).
 */
function completePaymentFromCapture(db, input) {
  const { razorpayOrderId, razorpayPaymentId, amountMinor, currency, eventType } = input || {};
  requireText(razorpayOrderId, ORDER_ID, 'razorpayOrderId');
  requireText(razorpayPaymentId, PAYMENT_ID, 'razorpayPaymentId');
  requireText(currency, CURRENCY, 'currency');
  requireText(eventType, EVENT_TYPE, 'eventType');
  if (!isMinor(amountMinor)) throw bad('amountMinor must be a positive whole number');
  const when = validTransactionTime(input.transactedAt);

  return inTransaction(db, async (tx) => {
    // 1. The only unlocked read: which invoice does this order belong to?
    const first = await findPaymentByOrderId(tx, razorpayOrderId);
    if (!first) return { outcome: 'unknown_order', paymentId: null, invoiceId: null, flagged: false };

    // 2. Lock: INVOICE, then PAYMENT.
    await lockInvoice(tx, first.invoiceId);
    await lockPayment(tx, first.id);

    // 3. Re-read everything the decision uses.
    const payment = await currentPayment(tx, first.id);
    const invoice = payment ? await currentInvoice(tx, payment.invoiceId) : null;
    if (!payment || !invoice || payment.invoiceId !== first.invoiceId || payment.razorpayOrderId !== razorpayOrderId) {
      return { outcome: 'unknown_order', paymentId: null, invoiceId: null, flagged: false }; // the row changed under us; nothing is guessed
    }

    const base = { outcome: null, paymentId: payment.id, invoiceId: payment.invoiceId, flagged: false };
    const evidence = { razorpayOrderId, razorpayPaymentId, eventType };
    const flag = async (outcome, reason, extra = {}) => {
      await flagPayment(tx, payment, reason, { ...evidence, ...extra }, `${reason}:${razorpayPaymentId}`);
      return { ...base, outcome, flagged: true };
    };

    // 4. Validate the current state.
    if (!when) return flag('quarantined', 'invalid_transaction_time');
    if (payment.kind !== 'payment') return flag('not_a_payment', 'not_a_payment_row');

    const expected = toThousandths(payment.amount);
    const received = fromMinorUnits(amountMinor, currency);
    if (currency !== payment.currency || currency !== invoice.currency) {
      return flag('currency_mismatch', 'currency_mismatch', { currency: payment.currency, receivedCurrency: currency });
    }
    if (expected === null || received === null || expected !== received) {
      return flag('amount_mismatch', 'amount_mismatch', { currency, expectedAmount: text(expected, currency), receivedAmount: text(received, currency) });
    }

    // Existing evidence is never overwritten.
    if (payment.externalReference && payment.externalReference !== razorpayPaymentId) {
      return flag('different_payment_id', 'different_payment_id', { existingRazorpayPaymentId: payment.externalReference, status: payment.status });
    }
    if (payment.status === 'completed') {
      // externalReference equals the received id here (the CHECK guarantees a completed Razorpay row has one). Benign: a once-only note, no flag.
      await auditPayment(tx, payment, {
        action: 'payment.duplicate_capture', reasonCode: 'duplicate_capture', data: { ...evidence, duplicateCapture: true }, key: `duplicate:${razorpayPaymentId}`,
      });
      return { ...base, outcome: 'duplicate_capture' };
    }
    const late = payment.status === 'failed' || payment.status === 'cancelled';
    if (payment.status !== 'pending' && !late) return flag('not_capturable', 'payment_not_capturable', { status: payment.status });

    // 5. The conditional write (second fence) and the audit, in this transaction.
    let changed;
    try {
      changed = await tx.payment.updateMany({
        where: { id: payment.id, status: payment.status, kind: 'payment', razorpayOrderId, OR: [{ externalReference: null }, { externalReference: razorpayPaymentId }] },
        data: { status: 'completed', externalReference: razorpayPaymentId, transactedAt: when },
      });
    } catch (err) {
      if (err && err.code === 'P2002') return flag('reference_conflict', 'payment_id_on_other_payment'); // (invoice, kind, reference) is unique
      throw err;
    }
    if (changed.count !== 1) throw new Error('payment changed while locked'); // cannot happen under the locks; roll back rather than guess

    const completedRow = { ...payment, status: 'completed' };
    await auditPayment(tx, completedRow, {
      action: late ? 'payment.late_capture_completed' : 'payment.completed', reasonCode: late ? 'late_capture' : 'webhook_capture', previousStatus: payment.status,
      data: { ...evidence, status: 'completed', previousStatus: payment.status, currency, amount: text(received, currency), ...(late && { lateCapture: true }) },
      key: `capture:${razorpayPaymentId}`,
    });
    let flagged = false;
    if (late) {
      await flagPayment(tx, completedRow, 'late_capture', { ...evidence, previousStatus: payment.status, lateCapture: true }, `late_capture:${razorpayPaymentId}`);
      flagged = true;
    }
    if (invoice.status !== 'issued') {
      await flagPayment(tx, completedRow, 'invoice_not_issued', { ...evidence }, `invoice_not_issued:${razorpayPaymentId}`);
      flagged = true;
    }

    // 6. Overpayment from the COMPLETED rows (this one included, as it is now written inside this transaction).
    const { paid } = await completedTotals(tx, payment.invoiceId, { current: true });
    const over = overpaymentOf(invoice.amount, paid);
    let overpaid;
    if (over.overpaid > 0n) {
      overpaid = text(over.overpaid, currency);
      await flagPayment(tx, completedRow, 'overpayment', {
        ...evidence, currency, overpayment: true, expectedAmount: text(over.invoiceAmount, currency), receivedAmount: text(over.paid, currency),
      }, `overpayment:${razorpayPaymentId}`);
      flagged = true;
    }
    return { ...base, outcome: late ? 'late_capture' : 'completed', flagged, ...(overpaid && { overpaid }) };
  });
}

// ---- a failed payment ATTEMPT and the order.paid reconciliation signal ------------------------------------------------------------------------------

// Applies a verified `payment.failed`: one attempt under the order failed. Razorpay allows several attempts per order, so the HumanCare payment keeps its
// status (pending stays pending), the invoice is untouched and no reference is written (a failed attempt must never become the payment's evidence). Only
// an audit note is written, once per gateway payment id. The relationship is validated first: the order is ours, the row is a payment, the currency and the
// amount are the ones the order was created with.
//
// input: { razorpayOrderId, razorpayPaymentId, amountMinor, currency, eventType }
// Outcomes: unknown_order | not_a_payment | currency_mismatch | amount_mismatch (flagged) | attempt_recorded.
function recordPaymentAttemptFailed(db, input) {
  const { razorpayOrderId, razorpayPaymentId, amountMinor, currency, eventType } = input || {};
  requireText(razorpayOrderId, ORDER_ID, 'razorpayOrderId');
  requireText(razorpayPaymentId, PAYMENT_ID, 'razorpayPaymentId');
  requireText(currency, CURRENCY, 'currency');
  requireText(eventType, EVENT_TYPE, 'eventType');
  if (!isMinor(amountMinor)) throw bad('amountMinor must be a positive whole number');

  return inTransaction(db, async (tx) => {
    const first = await findPaymentByOrderId(tx, razorpayOrderId);
    if (!first) return { outcome: 'unknown_order', paymentId: null, invoiceId: null, flagged: false };
    await lockInvoice(tx, first.invoiceId);
    await lockPayment(tx, first.id);
    const payment = await currentPayment(tx, first.id);
    if (!payment || payment.invoiceId !== first.invoiceId || payment.razorpayOrderId !== razorpayOrderId) return { outcome: 'unknown_order', paymentId: null, invoiceId: null, flagged: false };

    const base = { outcome: null, paymentId: payment.id, invoiceId: payment.invoiceId, flagged: false };
    const evidence = { razorpayOrderId, razorpayPaymentId, eventType };
    const flag = async (outcome, reason, extra = {}) => {
      await flagPayment(tx, payment, reason, { ...evidence, ...extra }, `${reason}:${razorpayPaymentId}`);
      return { ...base, outcome, flagged: true };
    };
    if (payment.kind !== 'payment') return flag('not_a_payment', 'not_a_payment_row');
    if (currency !== payment.currency) return flag('currency_mismatch', 'currency_mismatch', { currency: payment.currency, receivedCurrency: currency });
    const expected = toThousandths(payment.amount);
    const received = fromMinorUnits(amountMinor, currency);
    if (expected === null || received === null || expected !== received) {
      return flag('amount_mismatch', 'amount_mismatch', { currency, expectedAmount: text(expected, currency), receivedAmount: text(received, currency) });
    }
    await auditPayment(tx, payment, {
      action: 'payment.attempt_failed', reasonCode: 'gateway_attempt_failed', key: `attempt_failed:${razorpayPaymentId}`,
      data: { ...evidence, status: payment.status, currency, amount: text(received, currency) },
    });
    return { ...base, outcome: 'attempt_recorded' };
  });
}

// Applies a verified `order.paid`: RECONCILIATION ONLY. It never completes a payment and never changes one; it writes audit evidence and, when the local
// record disagrees with the gateway, a flag. A payment that is not completed YET is normal (order.paid and payment.captured travel separately), so with
// options.final = false that case returns `order_paid_pending_capture` without writing anything, and the caller retries; on the final attempt it is flagged.
//
// input: { razorpayOrderId, amountMinor (amount_paid; may be 0), eventType }
// Outcomes: unknown_order | not_a_payment | order_paid_pending_capture | order_paid_unreconciled | order_paid_amount_mismatch (flagged) | order_paid_recorded.
function recordOrderPaid(db, input, { final = true } = {}) {
  const { razorpayOrderId, amountMinor, eventType } = input || {};
  requireText(razorpayOrderId, ORDER_ID, 'razorpayOrderId');
  requireText(eventType, EVENT_TYPE, 'eventType');
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw bad('amountMinor must be a whole number');

  return inTransaction(db, async (tx) => {
    const first = await findPaymentByOrderId(tx, razorpayOrderId);
    if (!first) return { outcome: 'unknown_order', paymentId: null, invoiceId: null, flagged: false };
    await lockInvoice(tx, first.invoiceId);
    await lockPayment(tx, first.id);
    const payment = await currentPayment(tx, first.id);
    if (!payment || payment.invoiceId !== first.invoiceId || payment.razorpayOrderId !== razorpayOrderId) return { outcome: 'unknown_order', paymentId: null, invoiceId: null, flagged: false };

    const base = { outcome: null, paymentId: payment.id, invoiceId: payment.invoiceId, flagged: false };
    const evidence = { razorpayOrderId, eventType };
    const expected = toThousandths(payment.amount);
    const received = fromMinorUnits(amountMinor, payment.currency);
    const amounts = { currency: payment.currency, expectedAmount: text(expected, payment.currency), receivedAmount: text(received, payment.currency) };
    const flag = async (outcome, reason, extra = {}) => {
      await flagPayment(tx, payment, reason, { ...evidence, ...amounts, ...extra }, `${reason}:${razorpayOrderId}`);
      return { ...base, outcome, flagged: true };
    };
    if (payment.kind !== 'payment') return flag('not_a_payment', 'not_a_payment_row');
    if (payment.status !== 'completed') {
      if (!final) return { ...base, outcome: 'order_paid_pending_capture' };
      return flag('order_paid_unreconciled', 'order_paid_not_completed', { status: payment.status });
    }
    if (expected === null || received === null || expected !== received) return flag('order_paid_amount_mismatch', 'order_paid_amount_mismatch');
    await auditPayment(tx, payment, {
      action: 'payment.order_paid_observed', reasonCode: 'order_paid_event', key: `order_paid:${razorpayOrderId}`,
      data: { ...evidence, status: payment.status, ...amounts },
    });
    return { ...base, outcome: 'order_paid_recorded' };
  });
}

// ---- refunds (EXISTING rows only) ---------------------------------------------------------------------------------------------------------------

// The refund flag for an event that matches no existing refund row. Attached to the original payment when THAT is known; otherwise nothing is
// written (see above). Runs inside the caller's transaction, under the invoice lock of that payment.
async function flagUnknownRefund(tx, { razorpayRefundId, razorpayPaymentId, eventType, currency, amountMinor }, found) {
  const lookup = await findPaymentByGatewayPaymentId(tx, razorpayPaymentId);
  if (lookup.outcome !== 'found') return { outcome: found.outcome === 'ambiguous' ? 'ambiguous_refund' : 'unknown_refund', paymentId: null, refundId: null, invoiceId: null, flagged: false };
  await lockInvoice(tx, lookup.payment.invoiceId);
  await lockPayment(tx, lookup.payment.id);
  const payment = await currentPayment(tx, lookup.payment.id);
  if (!payment) return { outcome: found.outcome === 'ambiguous' ? 'ambiguous_refund' : 'unknown_refund', paymentId: null, refundId: null, invoiceId: null, flagged: false };
  const received = fromMinorUnits(amountMinor, currency);
  await flagPayment(tx, payment, found.outcome === 'ambiguous' ? 'ambiguous_refund' : 'unknown_refund', {
    razorpayPaymentId, razorpayRefundId, eventType, refundInconsistency: true, currency, receivedAmount: text(received, currency),
  }, `${found.outcome === 'ambiguous' ? 'ambiguous_refund' : 'unknown_refund'}:${razorpayRefundId}`);
  return { outcome: found.outcome === 'ambiguous' ? 'ambiguous_refund' : 'unknown_refund', paymentId: payment.id, refundId: null, invoiceId: payment.invoiceId, flagged: true };
}

/**
 * Records the result of a verified refund event against an EXISTING refund row. `result` is 'completed' (refund.processed) or 'failed' (refund.failed).
 *
 * input: { razorpayRefundId, razorpayPaymentId, amountMinor, currency, transactedAt (needed for 'completed'), eventType }
 *
 * options.final (default true): when false, the two outcomes that waiting may resolve (unknown_refund for a missing row, original_not_completed)
 * are returned WITHOUT any write or flag, so the caller can retry; pass true on the last attempt and they are flagged as described below.
 * Outcomes: unknown_refund | ambiguous_refund (flagged when the original payment is known) | quarantined (completed without a valid time) |
 *   refund_row_invalid | original_not_found | original_not_completed | payment_id_mismatch | currency_mismatch | amount_mismatch |
 *   refund_exceeds_payment | state_conflict (flagged, nothing changed) | already_completed | already_failed (no-ops) | completed | failed.
 * A refund never changes the invoice. Resolves { outcome, refundId, paymentId (the original), invoiceId, flagged }.
 */
function settleRefund(db, result, input, { final = true } = {}) {
  if (result !== 'completed' && result !== 'failed') throw bad("result must be 'completed' or 'failed'");
  const { razorpayRefundId, razorpayPaymentId, amountMinor, currency, eventType } = input || {};
  requireText(razorpayRefundId, REFUND_ID, 'razorpayRefundId');
  requireText(razorpayPaymentId, PAYMENT_ID, 'razorpayPaymentId');
  requireText(currency, CURRENCY, 'currency');
  requireText(eventType, EVENT_TYPE, 'eventType');
  if (!isMinor(amountMinor)) throw bad('amountMinor must be a positive whole number');
  const when = result === 'completed' ? validTransactionTime(input.transactedAt) : null;

  return inTransaction(db, async (tx) => {
    // 1. The only unlocked read: which refund row (hence invoice)?
    const found = await findRefundByExternalReference(tx, razorpayRefundId);
    // Not final yet: a refund event may simply have arrived before its (existing) refund row was committed. Nothing is locked, written or flagged;
    // the caller retries later and passes final = true on its last attempt. An AMBIGUOUS reference is never waited for.
    if (found.outcome === 'none' && !final) return { outcome: 'unknown_refund', refundId: null, paymentId: null, invoiceId: null, flagged: false };
    if (found.outcome !== 'found') return flagUnknownRefund(tx, { razorpayRefundId, razorpayPaymentId, eventType, currency, amountMinor }, found);
    const first = found.refund;
    if (first.refundOfPaymentId == null) return { outcome: 'refund_row_invalid', refundId: first.id, paymentId: null, invoiceId: first.invoiceId, flagged: false };

    // 2. Lock: INVOICE, then the PAYMENT rows in ascending id (the original and the refund).
    await lockInvoice(tx, first.invoiceId);
    for (const id of [first.id, first.refundOfPaymentId].sort((a, b) => a - b)) await lockPayment(tx, id);

    // 3. Re-read.
    const refund = await currentPayment(tx, first.id);
    const original = refund && refund.refundOfPaymentId != null ? await currentPayment(tx, refund.refundOfPaymentId) : null;
    if (!refund || refund.kind !== 'refund' || refund.externalReference !== razorpayRefundId || refund.invoiceId !== first.invoiceId || refund.refundOfPaymentId !== first.refundOfPaymentId) {
      return { outcome: 'unknown_refund', refundId: null, paymentId: null, invoiceId: null, flagged: false }; // changed under us
    }
    const base = { outcome: null, refundId: refund.id, paymentId: refund.refundOfPaymentId, invoiceId: refund.invoiceId, flagged: false };
    const evidence = { razorpayPaymentId, razorpayRefundId, eventType };
    const flag = async (outcome, reason, extra = {}) => {
      await flagPayment(tx, refund, reason, { ...evidence, refundInconsistency: true, ...extra }, `${reason}:${razorpayRefundId}:${result}`);
      return { ...base, outcome, flagged: true };
    };

    // 4. Validate.
    if (!original || original.kind !== 'payment' || original.invoiceId !== refund.invoiceId) return flag('original_not_found', 'original_payment_missing');
    if (original.status !== 'completed' && !final) return { ...base, outcome: 'original_not_completed', flagged: false }; // the capture may still be on its way
    if (original.status !== 'completed') return flag('original_not_completed', 'original_not_completed', { status: original.status });
    if (original.externalReference !== razorpayPaymentId) return flag('payment_id_mismatch', 'refund_payment_mismatch', { existingRazorpayPaymentId: original.externalReference });
    if (currency !== refund.currency || currency !== original.currency) return flag('currency_mismatch', 'currency_mismatch', { currency: refund.currency, receivedCurrency: currency });

    const expected = toThousandths(refund.amount);
    const received = fromMinorUnits(amountMinor, currency);
    if (expected === null || received === null || expected !== received) {
      return flag('amount_mismatch', 'amount_mismatch', { currency, expectedAmount: text(expected, currency), receivedAmount: text(received, currency) });
    }

    // The same result twice is a no-op; the opposite result on a closed refund is an inconsistency that is flagged, never applied.
    if (refund.status === result) return { ...base, outcome: result === 'completed' ? 'already_completed' : 'already_failed' };
    if (refund.status !== 'pending') return flag('state_conflict', 'refund_state_conflict', { status: refund.status });

    if (result === 'completed') {
      if (!when) return flag('quarantined', 'invalid_transaction_time');
      // Cumulative refunds, this one included, must not exceed the original payment.
      const already = await completedRefundTotalOf(tx, original.id, { current: true });
      const originalAmount = toThousandths(original.amount);
      if (originalAmount === null || already + expected > originalAmount) {
        return flag('refund_exceeds_payment', 'refund_exceeds_payment', {
          currency, expectedAmount: text(originalAmount, currency), receivedAmount: text(already + expected, currency),
        });
      }
    }

    // 5. Conditional write + audit.
    const changed = await tx.payment.updateMany({
      where: { id: refund.id, kind: 'refund', status: 'pending', externalReference: razorpayRefundId },
      data: result === 'completed' ? { status: 'completed', transactedAt: when } : { status: 'failed' },
    });
    if (changed.count !== 1) throw new Error('refund changed while locked');
    await auditPayment(tx, { ...refund, status: result }, {
      action: result === 'completed' ? 'payment.refund_completed' : 'payment.refund_failed', reasonCode: 'webhook_refund', previousStatus: 'pending',
      data: { ...evidence, status: result, previousStatus: 'pending', currency, amount: text(received, currency) },
      key: `refund:${razorpayRefundId}:${result}`,
    });
    return { ...base, outcome: result };
  });
}

const completeRefund = (db, input, options) => settleRefund(db, 'completed', input, options);
const failRefund = (db, input, options) => settleRefund(db, 'failed', input, options);

module.exports = {
  // lookups
  findPaymentByOrderId, findRefundByExternalReference, findOriginalPaymentOfRefund, findPaymentByGatewayPaymentId, loadInvoiceContext,
  completedTotals, completedRefundTotalOf, overpaymentOf, calculateInvoiceOverpayment,
  // guarded operations
  completePaymentFromCapture, recordPaymentAttemptFailed, recordOrderPaid, completeRefund, failRefund,
  // helpers
  validTransactionTime, PAYMENT_FIELDS, ACTOR, SOURCE,
};
