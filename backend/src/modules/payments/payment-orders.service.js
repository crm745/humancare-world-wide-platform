// Razorpay order creation for an issued, quotation-linked invoice. ONE HumanCare Payment row = ONE Razorpay order.
//
// Three phases; no database lock is ever held while Razorpay is called:
//   A  reserve  (one transaction, invoice row locked): re-check everything, replay an earlier request with the same Idempotency-Key,
//               refuse a second open order, compute the amount on the SERVER, insert a pending Payment (no order id yet) + audit.
//   B  gateway  (no transaction): create the Razorpay order with receipt "HCP<paymentId>" and the amount as an integer in the
//               currency's smallest unit.
//   C  attach   (one transaction, invoice then payment locked): set razorpay_order_id ONCE; if the invoice or its quotation became
//               invalid meanwhile, cancel the local row and flag the external order for reconciliation.
// The pending row without an order id is itself the "open order" marker, so a concurrent request cannot slip in during phase B.
//
// Outcomes of phase B are classified (razorpay.api.js): DEFINITIVE (nothing was created) closes the row as failed; AMBIGUOUS (it may
// exist) leaves the row pending and is recovered BY RECEIPT, never by creating a second order. A row may be recovered only after one
// minute, and only by one caller at a time (a compare-and-set on updated_at is the claim). The state of a Payment is changed here ONLY
// by order creation, its failure/cancellation and the unused-order timeout; completion belongs to the future webhook. The mobile
// app's checkout result is never trusted.
//
// Lock order: invoice FIRST, then the payment row (the quotation is only read), as in M7.
const { prisma } = require('../../db/prisma');
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const store = require('./payment-orders.store');
const { isPaymentsEnabled, credentialProblem, publicKeyId, paymentsEnvironmentId } = require('./razorpay-config');
const { createOrder, findOrdersByReceipt, fetchOrder, RazorpayCallError } = require('./razorpay.api');
const { ORDER_CURRENCIES, toThousandths, parseRequestAmount, formatAmount, toMinorUnits } = require('./payment-money');

const KEY_PREFIX = 'rzp-order:';
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const RECOVERY_MIN_AGE_MS = 60 * 1000; // a pending row without an order id may be recovered after one minute
const UNUSED_ORDER_TIMEOUT_MS = 30 * 60 * 1000; // an order nobody has touched for 30 minutes may be closed (after asking the gateway)
const SWEEP_LIMIT = 20;

const ERRORS = Object.freeze({
  invoice_not_found: [404, 'Invoice not found.'],
  invoice_not_payable: [409, 'This invoice cannot be paid online right now.'],
  invoice_overdue: [409, 'This invoice is past its due date. Please contact support.'],
  quotation_not_active: [409, 'The quotation for this invoice is no longer active.'],
  currency_unsupported: [409, 'This currency cannot be paid online.'],
  open_order_exists: [409, 'A payment is already in progress for this invoice.'],
  partial_not_authorized: [403, 'Partial payment has not been authorized for this invoice.'],
  amount_invalid: [400, 'The amount is not valid.'],
  request_invalid: [400, 'The request is not valid.'],
  idempotency_key_invalid: [400, 'A valid Idempotency-Key header is required.'],
  idempotency_conflict: [409, 'This Idempotency-Key was already used for a different request.'],
  payments_disabled: [503, 'Online payments are not available.'],
  gateway_unavailable: [502, 'The payment service is unavailable. Please try again.'],
});
const UNCERTAIN_MESSAGE = 'Your payment is being set up. Please try again in a minute with the same Idempotency-Key.';

function fail(publicCode) {
  const [statusCode, message] = ERRORS[publicCode];
  const err = new Error(message);
  err.statusCode = statusCode;
  err.publicCode = publicCode;
  return err;
}

const receiptOf = (paymentId) => `HCP${paymentId}`;
// Returned by attachOrder when the order id is already stored on ANOTHER payment row (unique index): nothing was attached and a person must look.
const DUPLICATE_ORDER = Symbol('duplicate_order');

// Whether an order found by receipt really belongs to THIS payment, in THIS environment. The receipt ("HCP<paymentId>") is only a search key: the
// same receipt can exist in another environment that shares the Razorpay account. Before an order is attached its notes must carry, as exact
// text, ALL THREE of: this payment's id (hc_payment_id), this invoice's id (hc_invoice_id) and this environment's id (hc_environment, equal to
// PAYMENTS_ENVIRONMENT_ID). Returns a short, specific reason code, or null when all three match:
//   order_notes_missing           no notes, or the payment id / invoice id note is absent or not text
//   order_environment_missing     the environment note is absent or not text
//   order_environment_mismatch    the order belongs to another environment (checked before the ids: it is the cross-environment signal)
//   order_notes_mismatch          this environment, but another payment or invoice (padded, zero-padded and look-alike values included)
// There is no partial credit: any other result means "do not attach".
function notesProblem(order, payment, environmentId) {
  const notes = order.notes;
  const isText = (value) => typeof value === 'string';
  if (!notes || !isText(notes.hc_payment_id) || !isText(notes.hc_invoice_id)) return 'order_notes_missing';
  if (!isText(notes.hc_environment)) return 'order_environment_missing';
  if (!environmentId || notes.hc_environment !== environmentId) return 'order_environment_mismatch';
  if (notes.hc_payment_id !== String(payment.id) || notes.hc_invoice_id !== String(payment.invoiceId)) return 'order_notes_mismatch';
  return null;
}
const gatewayOptions = (ctx) => ({ env: ctx.env, ...(ctx.fetchImpl && { fetchImpl: ctx.fetchImpl }) }); // options for the gateway client

// ---- pure rules -----------------------------------------------------------------------------------------------------------------

function parseInvoiceId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= 2147483647 ? id : null;
}

// { mode: "full" } | { mode: "partial", amountText }. Anything else (an unknown key such as "currency", a numeric amount) is refused.
function parseBody(body) {
  const b = body === undefined || body === null ? {} : body;
  if (typeof b !== 'object' || Array.isArray(b)) throw fail('request_invalid');
  for (const key of Object.keys(b)) if (key !== 'mode' && key !== 'amount') throw fail('request_invalid');
  const mode = b.mode === undefined ? 'full' : b.mode;
  if (mode !== 'full' && mode !== 'partial') throw fail('request_invalid');
  if (mode === 'full') {
    if (b.amount !== undefined) throw fail('request_invalid');
    return { mode };
  }
  if (typeof b.amount !== 'string') throw fail('amount_invalid'); // a JSON number is never accepted
  return { mode, amountText: b.amount };
}

const ownedBy = (invoice, userId) => Boolean(invoice && invoice.case && invoice.case.serviceRequest && Number(invoice.case.serviceRequest.userId) === userId);

const utcDay = (value) => { const d = new Date(value); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const isOverdue = (dueDate, now) => Boolean(dueDate) && utcDay(now) > utcDay(dueDate);

// The public error code naming why this invoice may not receive a new payment order, or null.
function eligibilityProblem(invoice, now) {
  const serviceRequest = invoice.case && invoice.case.serviceRequest;
  if (!serviceRequest || serviceRequest.serviceKey !== PRIVATE_CHARTER_KEY) return 'invoice_not_payable';
  if (invoice.source !== 'quotation' || invoice.status !== 'issued' || invoice.quotationId == null) return 'invoice_not_payable';
  if (!invoice.quotation || invoice.quotation.status !== 'accepted' || invoice.quotation.supersededAt) return 'quotation_not_active';
  if (invoice.case.closedAt || invoice.case.status === 'cancelled') return 'invoice_not_payable';
  if (isOverdue(invoice.dueDate, now)) return 'invoice_overdue';
  if (!ORDER_CURRENCIES.has(invoice.currency)) return 'currency_unsupported';
  return null;
}

// What has been PAID on the invoice, in thousandths: completed payment rows only. A refund (kind "refund") never reduces it, because
// refunds do not reopen an invoice's balance (approved rule): money returned to a patient does not make the invoice payable again.
// Used for both a new reservation and the idempotency replay check, so they always agree.
function netPaid(payments) {
  let total = 0n;
  for (const p of payments) {
    if (p.status !== 'completed' || p.kind === 'refund') continue;
    const amount = toThousandths(p.amount);
    if (amount === null) continue;
    total += amount;
  }
  return total;
}

// A replay must be the SAME request: a full payment of the balance that existed when the row was made, or the same partial amount.
function assertReplayMatches(invoice, payments, mine, request) {
  const stored = toThousandths(mine.amount);
  const before = toThousandths(invoice.amount) - netPaid(payments.filter((p) => p.id < mine.id));
  if (request.mode === 'full') {
    if (stored !== before) throw fail('idempotency_conflict');
    return;
  }
  const asked = parseRequestAmount(request.amountText, mine.currency);
  if (asked === null) throw fail('amount_invalid');
  if (asked !== stored || stored >= before) throw fail('idempotency_conflict');
}

// What the app receives. Only the public Key ID and the order; never a secret, a receipt or a gateway response.
function respond(payment, env) {
  const amount = formatAmount(toThousandths(payment.amount), payment.currency);
  const body = { paymentId: payment.id, invoiceId: payment.invoiceId, status: payment.status, amount, currency: payment.currency };
  if (payment.razorpayOrderId && payment.status === 'pending') {
    const keyId = publicKeyId(env);
    const minor = toMinorUnits(toThousandths(payment.amount), payment.currency);
    if (!keyId || minor === null) throw fail('gateway_unavailable');
    body.razorpay = { keyId, orderId: payment.razorpayOrderId, amount: minor, currency: payment.currency };
  }
  return body;
}

const uncertain = (payment) => ({ outcome: 'uncertain', paymentId: payment.id, invoiceId: payment.invoiceId, message: UNCERTAIN_MESSAGE });

// ---- transactions ---------------------------------------------------------------------------------------------------------------

// Phase A.
async function reserve(ctx, { userId, invoiceId, key, request }) {
  const storedKey = `${KEY_PREFIX}${key}`;
  return ctx.db.$transaction(async (tx) => {
    await store.lockInvoice(tx, invoiceId);
    const invoice = await store.loadInvoice(tx, invoiceId);
    if (!ownedBy(invoice, userId)) throw fail('invoice_not_found');
    const payments = await store.listPayments(tx, invoiceId);

    const mine = payments.find((p) => p.idempotencyKey === storedKey);
    if (mine) {
      assertReplayMatches(invoice, payments, mine, request);
      // An existing order that would hand the app its checkout details is only returned while the invoice and quotation are STILL
      // payable (due date, status, quotation, Case...). Otherwise nothing is returned and nothing is changed: the row, its Razorpay order
      // and its audit trail stay exactly as they are (this throw writes nothing). A closed row returns only its status, as before.
      if (mine.status === 'pending' && mine.razorpayOrderId) {
        const stale = eligibilityProblem(invoice, ctx.now());
        if (stale) throw fail(stale);
      }
      return { kind: 'replay', payment: mine, invoice };
    }

    const problem = eligibilityProblem(invoice, ctx.now());
    if (problem) throw fail(problem);
    if (payments.some((p) => p.kind === 'payment' && p.status === 'pending')) throw fail('open_order_exists');

    const remaining = toThousandths(invoice.amount) - netPaid(payments);
    if (remaining <= 0n) throw fail('invoice_not_payable');
    let amount;
    if (request.mode === 'full') {
      amount = remaining;
    } else {
      if (!invoice.allowPartialPayment) throw fail('partial_not_authorized');
      amount = parseRequestAmount(request.amountText, invoice.currency);
      // A partial payment must be LESS than the balance (paying all of it is the "full" mode); that also keeps replays unambiguous.
      if (amount === null || amount >= remaining) throw fail('amount_invalid');
    }
    if (toMinorUnits(amount, invoice.currency) === null) throw fail('amount_invalid'); // would need rounding

    const payment = await store.insertPendingPayment(tx, {
      invoiceId, caseId: invoice.caseId, currency: invoice.currency, amount: formatAmount(amount, invoice.currency), idempotencyKey: storedKey,
    });
    await store.audit(tx, {
      caseId: invoice.caseId, paymentId: payment.id, action: 'payment.order_reserved', actorType: ctx.actor.type, actorId: ctx.actor.id,
      data: { paymentId: payment.id, invoiceId, amount: formatAmount(amount, invoice.currency), currency: invoice.currency, mode: request.mode },
    });
    return { kind: 'new', payment, invoice };
  });
}

// A pending row that gets no order: closed (failed | cancelled) with a short reason, in its own transaction.
async function closeRow(ctx, payment, status, action, reasonCode) {
  await ctx.db.$transaction(async (tx) => {
    await store.lockInvoice(tx, payment.invoiceId);
    await store.lockPayment(tx, payment.id);
    const closed = await store.closePending(tx, payment.id, status);
    if (closed) {
      await store.audit(tx, {
        caseId: payment.caseId, paymentId: payment.id, action, actorType: ctx.actor.type, actorId: ctx.actor.id, reasonCode,
        data: { paymentId: payment.id, invoiceId: payment.invoiceId, status },
      });
    }
  });
}

// Writes a once-only audit flag (a person or the reconciliation must look at it). A repeated flag is a no-op (unique idempotency key).
async function flag(ctx, payment, action, reasonCode, orderId) {
  try {
    await store.audit(ctx.db, {
      caseId: payment.caseId, paymentId: payment.id, action, actorType: ctx.actor.type, actorId: ctx.actor.id, reasonCode,
      idempotencyKey: `${action.replace(/^payment\./, '')}:${orderId || payment.id}`,
      data: { paymentId: payment.id, invoiceId: payment.invoiceId, ...(orderId && { razorpayOrderId: orderId }) },
    });
  } catch (err) {
    if (!(err && err.code === 'P2002')) throw err;
  }
}

// Phase C. Resolves the payment as it is after the attempt. Throws a public error AFTER the transaction has committed its cleanup.
async function attachOrder(ctx, payment, order, action = 'payment.order_created') {
  const result = await ctx.db.$transaction(async (tx) => {
    await store.lockInvoice(tx, payment.invoiceId);
    await store.lockPayment(tx, payment.id);
    const current = await store.loadPayment(tx, payment.id);
    const invoice = await store.loadInvoice(tx, payment.invoiceId);
    const orphan = async (reason) => store.audit(tx, {
      caseId: payment.caseId, paymentId: payment.id, action: 'payment.order_orphaned', actorType: ctx.actor.type, actorId: ctx.actor.id, reasonCode: reason,
      idempotencyKey: `order_orphaned:${order.orderId}`,
      data: { paymentId: payment.id, invoiceId: payment.invoiceId, razorpayOrderId: order.orderId },
    }).catch((err) => { if (!(err && err.code === 'P2002')) throw err; });

    if (current.razorpayOrderId) { // never overwrite an existing order id: the existing order wins, the new one is flagged
      if (current.razorpayOrderId !== order.orderId) await orphan('order_already_attached');
      return { payment: current };
    }
    if (current.status !== 'pending') {
      await orphan('payment_not_pending');
      return { problem: 'invoice_not_payable' };
    }
    const problem = invoice ? eligibilityProblem(invoice, ctx.now()) : 'invoice_not_payable';
    if (problem) { // the invoice or quotation changed while Razorpay was being called: cancel locally, flag the external order
      await store.closePending(tx, payment.id, 'cancelled');
      await orphan(problem);
      return { problem };
    }
    let written;
    try {
      written = await store.attachOrderId(tx, payment.id, order.orderId);
    } catch (err) {
      // The unique index on razorpay_order_id refused it: this order id already belongs to another payment row. Nothing is attached, the raw
      // database error goes no further, and nothing else is written in this transaction; the caller flags it for reconciliation.
      if (err && err.code === 'P2002') return { duplicate: true };
      throw err;
    }
    if (!written) {
      await orphan('attach_lost');
      return { problem: 'invoice_not_payable' };
    }
    await store.audit(tx, {
      caseId: payment.caseId, paymentId: payment.id, action, actorType: ctx.actor.type, actorId: ctx.actor.id,
      data: { paymentId: payment.id, invoiceId: payment.invoiceId, razorpayOrderId: order.orderId, currency: payment.currency },
    });
    return { payment: await store.loadPayment(tx, payment.id) };
  });
  if (result.duplicate) {
    await flag(ctx, payment, 'payment.order_review_required', 'order_id_already_attached', order.orderId);
    return DUPLICATE_ORDER;
  }
  if (result.problem) throw fail(result.problem);
  return result.payment;
}

// ---- gateway phase --------------------------------------------------------------------------------------------------------------

// Phase B then C for a row that has no order yet. Resolves { outcome: "ok", payment } | { outcome: "uncertain", ... }.
async function createAndAttach(ctx, payment) {
  const amountMinor = toMinorUnits(toThousandths(payment.amount), payment.currency);
  let order;
  try {
    order = await createOrder(
      { amountMinor, currency: payment.currency, receipt: receiptOf(payment.id), notes: { hc_payment_id: payment.id, hc_invoice_id: payment.invoiceId, hc_environment: paymentsEnvironmentId(ctx.env) } },
      gatewayOptions(ctx),
    );
  } catch (err) {
    if (err instanceof RazorpayCallError && err.outcome === 'definitive') {
      ctx.log.error(`[payments] order creation refused: ${err.code}`);
      await closeRow(ctx, payment, 'failed', 'payment.order_failed', err.code);
      throw fail('gateway_unavailable');
    }
    // Ambiguous (or an unexpected error after the request may have left): the order may exist. Keep the row pending, never create again.
    ctx.log.error(`[payments] order creation outcome unknown: ${err instanceof RazorpayCallError ? err.code : (err && err.name) || 'error'}`);
    await flag(ctx, payment, 'payment.order_uncertain', err instanceof RazorpayCallError ? err.code : 'unexpected_error');
    return uncertain(payment);
  }
  const attached = await attachOrder(ctx, payment, order);
  if (attached === DUPLICATE_ORDER) return uncertain(payment);
  return { outcome: 'ok', payment: attached };
}

// A pending row WITHOUT an order id: find the order by its receipt before anything else. `create` is true for a client retry (a
// confirmed "no such order" may create it now) and false for the background sweep (a confirmed "no such order" closes the row).
async function resumeWithoutOrder(ctx, payment, { create }) {
  if (ctx.now().getTime() - new Date(payment.updatedAt).getTime() < RECOVERY_MIN_AGE_MS) return uncertain(payment);
  // The claim: only the caller that moves updated_at away from the value it read may go on, so two retries never both create.
  const claim = await ctx.db.payment.updateMany({
    where: { id: payment.id, status: 'pending', razorpayOrderId: null, updatedAt: payment.updatedAt }, data: { updatedAt: ctx.now() },
  });
  if (claim.count !== 1) return uncertain(payment);

  const found = await findOrdersByReceipt(receiptOf(payment.id), gatewayOptions(ctx));
  if (found.status === 'single') {
    const order = found.orders[0];
    // Identity first: the order must carry THIS payment's id, THIS invoice's id and THIS environment's id. Otherwise it is never attached, never
    // replaced by a new order, and Operations are told (with the specific reason).
    const identity = notesProblem(order, payment, paymentsEnvironmentId(ctx.env));
    if (identity) {
      await flag(ctx, payment, 'payment.order_review_required', identity, order.orderId);
      return uncertain(payment);
    }
    const minor = toMinorUnits(toThousandths(payment.amount), payment.currency);
    if (order.amountMinor !== minor || order.currency !== payment.currency) {
      await flag(ctx, payment, 'payment.order_review_required', 'order_mismatch', order.orderId);
      return uncertain(payment);
    }
    const attached = await attachOrder(ctx, payment, order, 'payment.order_recovered');
    if (attached === DUPLICATE_ORDER) return uncertain(payment);
    return { outcome: 'ok', payment: attached };
  }
  if (found.status === 'multiple') {
    await flag(ctx, payment, 'payment.order_review_required', 'multiple_orders');
    return uncertain(payment);
  }
  if (found.status !== 'none') return uncertain(payment); // the lookup itself failed: nothing is assumed

  if (!create) { // sweep: Razorpay has no such order, and nobody is waiting for one
    await closeRow(ctx, payment, 'failed', 'payment.order_failed', 'order_never_created');
    return { outcome: 'closed', payment };
  }
  // Confirmed absent: re-check the invoice under the lock, then create it.
  const problem = await ctx.db.$transaction(async (tx) => {
    await store.lockInvoice(tx, payment.invoiceId);
    await store.lockPayment(tx, payment.id);
    const current = await store.loadPayment(tx, payment.id);
    if (!current || current.status !== 'pending' || current.razorpayOrderId) return 'invoice_not_payable';
    const invoice = await store.loadInvoice(tx, payment.invoiceId);
    const found2 = invoice ? eligibilityProblem(invoice, ctx.now()) : 'invoice_not_payable';
    if (found2) await store.closePending(tx, payment.id, 'cancelled');
    return found2;
  });
  if (problem) throw fail(problem);
  return createAndAttach(ctx, payment);
}

// ---- public entry points --------------------------------------------------------------------------------------------------------

const baseContext = ({ db = prisma, env = process.env, fetchImpl, now = () => new Date(), log = console, actor }) => ({ db, env, fetchImpl, now, log, actor });

/**
 * POST /invoices/:invoiceId/payment-orders. `invoiceId` and `idempotencyKey` are the raw strings from the URL and the header.
 * Resolves { outcome: "ok", created, payload } or { outcome: "uncertain", ... }. Throws errors with statusCode and publicCode.
 */
async function createPaymentOrder({ userId, invoiceId: rawInvoiceId, idempotencyKey, body, db, env, fetchImpl, now, log }) {
  const ctx = baseContext({ db, env, fetchImpl, now, log, actor: { type: 'patient', id: userId } });
  if (!isPaymentsEnabled(ctx.env)) throw fail('payments_disabled');
  const problem = credentialProblem(ctx.env);
  if (problem) {
    ctx.log.error(`[payments] the gateway is not configured: ${problem}`);
    throw fail('gateway_unavailable');
  }
  const request = parseBody(body);
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw fail('idempotency_key_invalid');
  const invoiceId = parseInvoiceId(rawInvoiceId);
  if (invoiceId === null || !Number.isInteger(userId) || userId < 1) throw fail('invoice_not_found');

  // A cheap, lock-free ownership check first, so a stranger never takes a lock on someone else's invoice.
  if (!ownedBy(await store.loadInvoice(ctx.db, invoiceId), userId)) throw fail('invoice_not_found');

  let reserved;
  for (let attempt = 0; ; attempt += 1) {
    try {
      reserved = await reserve(ctx, { userId, invoiceId, key: idempotencyKey, request });
      break;
    } catch (err) {
      // A unique-key collision means another request with the same key got in first: the second pass is a replay.
      if (err && err.code === 'P2002' && attempt === 0) continue;
      throw err;
    }
  }

  const { payment } = reserved;
  const created = reserved.kind === 'new';
  let result;
  if (payment.razorpayOrderId || payment.status !== 'pending') result = { outcome: 'ok', payment };
  else if (created) result = await createAndAttach(ctx, payment);
  else result = await resumeWithoutOrder(ctx, payment, { create: true });

  if (result.outcome === 'uncertain') return result;
  return { outcome: 'ok', created, payload: respond(result.payment, ctx.env) };
}

// ---- background sweeps (no client waiting) --------------------------------------------------------------------------------------

// Pending rows older than a minute that never got an order id: find the order by receipt; attach it, or (if there is none) close the row.
async function recoverPendingOrders(options = {}) {
  const ctx = baseContext({ ...options, actor: { type: 'system', id: null } });
  if (!isPaymentsEnabled(ctx.env) || credentialProblem(ctx.env)) return { skipped: true };
  const rows = await store.findWithoutOrder(ctx.db, { olderThan: new Date(ctx.now().getTime() - RECOVERY_MIN_AGE_MS), limit: SWEEP_LIMIT });
  const counts = { checked: rows.length, attached: 0, closed: 0, uncertain: 0, errors: 0 };
  for (const row of rows) {
    try {
      const result = await resumeWithoutOrder(ctx, row, { create: false });
      if (result.outcome === 'ok') counts.attached += 1;
      else if (result.outcome === 'closed') counts.closed += 1;
      else counts.uncertain += 1;
    } catch (err) {
      counts.errors += 1;
      ctx.log.error(`[payments] recovery failed: ${(err && (err.publicCode || err.name)) || 'error'}`);
    }
  }
  return counts;
}

// The unused-order timeout. An order untouched for 30 minutes is closed locally ONLY after Razorpay says it was never attempted or paid:
// local age alone never closes anything. An attempted or paid order is left alone (a paid one is flagged for the webhook/reconciliation).
// Razorpay is not asked to cancel the order (no cancellation API is assumed); a payment that arrives later is evidence to preserve
// and flag, which the webhook task handles.
async function closeStaleOrders(options = {}) {
  const ctx = baseContext({ ...options, actor: { type: 'system', id: null } });
  if (!isPaymentsEnabled(ctx.env) || credentialProblem(ctx.env)) return { skipped: true };
  const rows = await store.findStaleWithOrder(ctx.db, { olderThan: new Date(ctx.now().getTime() - UNUSED_ORDER_TIMEOUT_MS), limit: SWEEP_LIMIT });
  const counts = { checked: rows.length, closed: 0, left: 0, flagged: 0, errors: 0 };
  for (const row of rows) {
    try {
      const looked = await fetchOrder(row.razorpayOrderId, gatewayOptions(ctx));
      if (looked.status !== 'ok') { counts.left += 1; continue; } // not found or unreachable: nothing is assumed
      const { order } = looked;
      if (order.status === 'paid' || order.amountPaidMinor > 0) {
        await flag(ctx, row, 'payment.order_paid_unreconciled', 'paid_at_gateway', row.razorpayOrderId);
        counts.flagged += 1;
      } else if (order.status === 'created' && order.attempts === 0) {
        await closeRow(ctx, row, 'cancelled', 'payment.order_timeout', 'unused_order_timeout');
        counts.closed += 1;
      } else {
        counts.left += 1; // attempted: a customer may be mid-payment
      }
    } catch (err) {
      counts.errors += 1;
      ctx.log.error(`[payments] timeout check failed: ${(err && (err.publicCode || err.name)) || 'error'}`);
    }
  }
  return counts;
}

async function runPaymentOrderMaintenance(options = {}) {
  const recovered = await recoverPendingOrders(options);
  const closed = await closeStaleOrders(options);
  return { recovered, closed };
}

module.exports = {
  createPaymentOrder, recoverPendingOrders, closeStaleOrders, runPaymentOrderMaintenance,
  // exported for tests
  fail, parseBody, parseInvoiceId, eligibilityProblem, netPaid, isOverdue, receiptOf, notesProblem, ownedBy,
  KEY_PREFIX, RECOVERY_MIN_AGE_MS, UNUSED_ORDER_TIMEOUT_MS,
};
