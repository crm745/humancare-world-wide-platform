// Safe reconciliation of ONE Razorpay payment whose webhook never arrived. Logic for scripts/reconcile-razorpay-payment.js (testable: every collaborator
// can be injected, nothing here reads a file or the environment at import).
//
// The flow never writes a Payment or an Invoice itself. It READS the HumanCare rows and asks Razorpay (GET only) about the payment and its order;
// when EVERY check passes it turns what Razorpay said into the same allow-listed `payment.captured` event the webhook receiver would have stored
// (classifyEvent), stores it in the existing integration inbox under a deterministic id, claims THAT ONE row and runs it through the existing
// processor (processClaim) -> payment store (locks, guards, audit, overpayment flags). Dry run (the default) does only the reads.
//
// A refusal is a short code and never carries a value: no key, secret, header, Razorpay text or personal data.
const crypto = require('crypto');

const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,60}$/;
const ORDER_ID = /^order_[A-Za-z0-9]{1,58}$/;
const REQUIRED_DATABASE = 'humancare_dev';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PRIVATE_CHARTER_KEY = 'privatecharter';
const SOURCE = 'razorpay';

class Refusal extends Error {
  constructor(code, reason) { super(code); this.name = 'Refusal'; this.code = code; this.reason = reason || null; }
}
// `reason` is only ever one of OUR short codes (the API client's classification, e.g. "gateway_auth"), never Razorpay text.
const refuse = (code, reason) => { throw new Refusal(code, reason); };
const SAFE_REASON = /^[a-z][a-z0-9_]{0,40}$/;
const SAFE_DETAIL = /^[A-Za-z0-9_ ]{1,60}$/; // "HTTP 400 BAD_REQUEST_ERROR"
const safeReason = (r, detail) => {
  if (typeof r !== 'string' || !SAFE_REASON.test(r)) return undefined;
  return typeof detail === 'string' && SAFE_DETAIL.test(detail) ? `${r}: ${detail}` : r;
};

// ---- arguments ------------------------------------------------------------------------------------------------------------------------------
// --payment-id pay_x --internal-payment-id N [--order-id order_x] [--invoice-id N] [--apply]
function parseArgs(argv) {
  const out = { apply: false };
  const names = { '--payment-id': 'razorpayPaymentId', '--internal-payment-id': 'internalPaymentId', '--order-id': 'expectedOrderId', '--invoice-id': 'expectedInvoiceId' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') { if (out.apply) refuse('argument_repeated'); out.apply = true; continue; }
    const key = names[arg];
    if (!key) refuse('unknown_argument');
    if (out[key] !== undefined) refuse('argument_repeated');
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) refuse('argument_value_missing');
    out[key] = value;
    i += 1;
  }
  if (!PAYMENT_ID.test(out.razorpayPaymentId || '')) refuse('payment_id_invalid');
  if (!/^[1-9]\d{0,9}$/.test(out.internalPaymentId || '')) refuse('internal_payment_id_invalid');
  out.internalPaymentId = Number(out.internalPaymentId);
  if (out.expectedOrderId !== undefined && !ORDER_ID.test(out.expectedOrderId)) refuse('order_id_invalid');
  if (out.expectedInvoiceId !== undefined) {
    if (!/^[1-9]\d{0,9}$/.test(out.expectedInvoiceId)) refuse('invoice_id_invalid');
    out.expectedInvoiceId = Number(out.expectedInvoiceId);
  }
  return out;
}

// ---- the database this may touch -------------------------------------------------------------------------------------------------------------
// A short code when DATABASE_URL / NODE_ENV are not the local development database, or null. Never contains a value.
function environmentProblem(env) {
  if (env.NODE_ENV === 'test' || env.NODE_ENV === 'production') return 'node_env_not_development';
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { return 'database_url_invalid'; }
  if (url.protocol !== 'mysql:') return 'database_url_invalid';
  if (!LOCAL_HOSTS.has(url.hostname)) return 'database_host_not_local';
  if (decodeURIComponent(url.pathname.replace(/^\//, '')) !== REQUIRED_DATABASE) return 'database_not_humancare_dev';
  return null;
}

// ---- collaborators (defaults are loaded lazily so a test never loads the Prisma client) -----------------------------------------------------
function defaultDeps() {
  const api = require('../../src/modules/payments/razorpay.api');
  const paymentStore = require('../../src/modules/payments/razorpay-payment.store');
  const inboxStore = require('../../src/modules/payments/razorpay-webhook.inbox.store');
  const processor = require('../../src/modules/payments/razorpay-webhook.processor');
  const { loadInvoice } = require('../../src/modules/payments/payment-orders.store');
  return {
    fetchPayment: api.fetchPayment,
    fetchOrder: api.fetchOrder,
    findPaymentByGatewayPaymentId: paymentStore.findPaymentByGatewayPaymentId,
    loadInvoice,
    storeEvent: inboxStore.storeEvent,
    claim: inboxStore.claim,
    processClaim: processor.processClaim,
  };
}

const PAYMENT_SELECT = { id: true, invoiceId: true, caseId: true, currency: true, kind: true, amount: true, status: true, externalReference: true, razorpayOrderId: true };

/**
 * @param options { razorpayPaymentId, internalPaymentId, expectedOrderId?, expectedInvoiceId?, apply }
 * @param ctx     { db, env, fetchImpl?, deps? }
 * Resolves { status, ... }:
 *   'dry_run'   every check passed; nothing was written
 *   'applied'   the capture was processed (outcome 'completed')
 *   'refused'   a check failed ({ code, passed }); nothing was written
 *   'not_applied' stored but the processor did not complete it ({ code, outcome, inbox })
 */
async function reconcile(options, ctx) {
  const { db, env } = ctx;
  const deps = ctx.deps || defaultDeps(); // a test injects ALL of them
  const config = require('../../src/modules/payments/razorpay-config');
  const money = require('../../src/modules/payments/payment-money');
  const { classifyEvent } = require('../../src/modules/payments/razorpay-webhook.events');
  const passed = [];
  const ok = (code) => passed.push(code);

  try {
    // 1. Environment: the development database only, payments configured (Test Mode keys are enforced by credentialProblem), no guessing.
    const envProblem = environmentProblem(env);
    if (envProblem) refuse(envProblem);
    const [{ db: dbName } = {}] = await db.$queryRaw`SELECT DATABASE() AS db`;
    if (dbName !== REQUIRED_DATABASE) refuse('database_not_humancare_dev');
    ok('database_is_humancare_dev');
    if (!config.isPaymentsEnabled(env)) refuse('payments_disabled');
    if (config.credentialProblem(env)) refuse('payments_not_configured');
    ok('payments_configured');

    // 2. The HumanCare payment: a pending Razorpay payment row with no gateway reference.
    const payment = await db.payment.findUnique({ where: { id: options.internalPaymentId }, select: PAYMENT_SELECT });
    if (!payment) refuse('payment_not_found');
    if (payment.kind !== 'payment') refuse('not_a_payment_row');
    if (!payment.razorpayOrderId) refuse('payment_has_no_order');
    if (payment.status === 'completed') refuse(payment.externalReference === options.razorpayPaymentId ? 'already_completed_same_payment' : 'payment_already_completed');
    if (payment.status !== 'pending') refuse('payment_not_pending');
    if (payment.externalReference) refuse('payment_reference_present');
    ok('payment_pending_without_reference');
    if (options.expectedOrderId && options.expectedOrderId !== payment.razorpayOrderId) refuse('order_id_mismatch');
    if (options.expectedInvoiceId && options.expectedInvoiceId !== payment.invoiceId) refuse('invoice_id_mismatch');

    // 3. The invoice owns the payment, is issued and agrees on currency and amount.
    const invoice = await deps.loadInvoice(db, payment.invoiceId);
    if (!invoice) refuse('invoice_not_found');
    if (invoice.id !== payment.invoiceId || invoice.caseId !== payment.caseId) refuse('invoice_ownership_mismatch');
    const serviceRequest = invoice.case && invoice.case.serviceRequest;
    if (!serviceRequest || serviceRequest.serviceKey !== PRIVATE_CHARTER_KEY) refuse('invoice_not_payable');
    if (invoice.status !== 'issued') refuse('invoice_not_issued');
    if (invoice.currency !== payment.currency) refuse('currency_mismatch');
    const expected = money.toThousandths(payment.amount);
    if (expected === null || expected !== money.toThousandths(invoice.amount)) refuse('amount_mismatch');
    ok('invoice_owns_payment_and_agrees');

    // 4. The gateway payment id is not already attached to any HumanCare payment.
    const known = await deps.findPaymentByGatewayPaymentId(db, options.razorpayPaymentId);
    if (known.outcome !== 'none') refuse('gateway_payment_id_already_used');
    ok('gateway_payment_id_unused');

    // 5. Razorpay says: this payment, captured, for this order, this amount and currency, not refunded.
    const looked = await deps.fetchPayment(options.razorpayPaymentId, { env, fetchImpl: ctx.fetchImpl });
    if (looked.status !== 'ok') refuse(`gateway_payment_${looked.status}`, safeReason(looked.reason, looked.detail));
    const remote = looked.payment;
    if (remote.paymentId !== options.razorpayPaymentId) refuse('payment_id_mismatch');
    if (remote.orderId !== payment.razorpayOrderId) refuse('order_id_mismatch');
    if (remote.status !== 'captured' || remote.captured !== true) refuse('payment_not_captured');
    if (remote.amountRefundedMinor !== 0) refuse('payment_refunded');
    if (remote.currency !== payment.currency || remote.currency !== invoice.currency) refuse('currency_mismatch');
    const received = money.fromMinorUnits(remote.amountMinor, remote.currency);
    if (received === null || received !== expected) refuse('amount_mismatch');
    if (!Number.isSafeInteger(remote.createdAtSeconds)) refuse('created_at_invalid');
    ok('gateway_payment_captured_and_matches');

    // 6. The order: same amount and currency; its notes (when present) name THIS payment, THIS invoice and THIS environment.
    const order = await deps.fetchOrder(payment.razorpayOrderId, { env, fetchImpl: ctx.fetchImpl });
    if (order.status !== 'ok') refuse(`gateway_order_${order.status}`, safeReason(order.reason));
    if (order.order.orderId !== payment.razorpayOrderId) refuse('order_id_mismatch');
    if (order.order.currency !== payment.currency || money.fromMinorUnits(order.order.amountMinor, order.order.currency) !== expected) refuse('order_amount_mismatch');
    const notes = order.order.notes;
    let notesChecked = false;
    if (notes) {
      if (notes.hc_payment_id !== String(payment.id) || notes.hc_invoice_id !== String(invoice.id)) refuse('order_notes_mismatch');
      if (notes.hc_environment !== undefined && notes.hc_environment !== config.paymentsEnvironmentId(env)) refuse('order_environment_mismatch');
      notesChecked = true;
    }
    ok(notesChecked ? 'order_matches_and_notes_verified' : 'order_matches_notes_unavailable');

    // 7. The event the webhook would have delivered, built from the VERIFIED facts only, through the existing classifier.
    const facts = { id: remote.paymentId, order_id: remote.orderId, amount: remote.amountMinor, currency: remote.currency, status: 'captured' };
    const envelope = { event: 'payment.captured', created_at: remote.createdAtSeconds, payload: { payment: { entity: facts } } };
    const bodySha256 = crypto.createHash('sha256').update(JSON.stringify({ reconciled: facts, created_at: remote.createdAtSeconds })).digest('hex');
    const event = classifyEvent(envelope, { bodySha256, eventIdSource: 'reconciliation' });
    if (event.malformed || event.status !== 'received' || event.entityId !== payment.razorpayOrderId) refuse('event_not_classifiable');
    const externalEventId = `reconcile:${remote.paymentId}`;
    ok('event_classified');

    const summary = {
      internalPaymentId: payment.id, invoiceId: invoice.id, caseId: payment.caseId, invoiceNumber: invoice.invoiceNumber || null,
      razorpayPaymentId: remote.paymentId, razorpayOrderId: remote.orderId, amountMinor: remote.amountMinor, currency: remote.currency,
      method: remote.method, externalEventId, orderNotesVerified: notesChecked,
    };
    const existing = await db.integrationInbox.findUnique({ where: { source_externalEventId: { source: SOURCE, externalEventId } }, select: { id: true, status: true } });

    if (!options.apply) return { status: 'dry_run', passed, summary, inbox: existing ? { id: existing.id, status: existing.status } : null };

    // 8. APPLY: store through the existing inbox (a duplicate id is a no-op), claim THAT ONE row, process it with the existing processor.
    await deps.storeEvent(db, {
      externalEventId, eventType: event.eventType, entityType: event.entityType, entityId: event.entityId,
      occurredAt: event.occurredAt, payload: event.payload, status: event.status, lastError: event.lastError,
    });
    const row = await db.integrationInbox.findUnique({ where: { source_externalEventId: { source: SOURCE, externalEventId } }, select: { id: true, status: true } });
    if (!row) refuse('inbox_row_missing');
    if (row.status !== 'received') return { status: 'not_applied', code: `inbox_row_${row.status}`, outcome: null, passed, summary, inbox: { id: row.id, status: row.status } };
    const claim = await deps.claim(db, { id: row.id, workerId: `reconcile-${process.pid}` });
    if (!claim) return { status: 'not_applied', code: 'inbox_row_not_claimable', outcome: null, passed, summary, inbox: { id: row.id, status: row.status } };
    const result = await deps.processClaim(db, claim, { env });
    const after = await db.payment.findUnique({ where: { id: payment.id }, select: { status: true, externalReference: true } });
    const done = result.status === 'processed' && result.outcome === 'completed';
    return {
      status: done ? 'applied' : 'not_applied', code: result.code || null, outcome: result.outcome || null, passed, summary,
      inbox: { id: row.id, status: result.status }, paymentAfter: after ? { status: after.status, externalReference: after.externalReference } : null,
    };
  } catch (err) {
    if (err instanceof Refusal) return { status: 'refused', code: err.code, ...(err.reason && { reason: err.reason }), passed };
    throw err;
  }
}

module.exports = { parseArgs, environmentProblem, reconcile, Refusal, REQUIRED_DATABASE };
