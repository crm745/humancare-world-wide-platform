// Razorpay Orders API client (create an order, find orders by receipt, read one order). Native fetch, no SDK. It follows
// bitrix-deal.api.js: a 15 s timeout covering the body, no redirects, a fixed allowlisted host, and EVERY failure classified:
//
//   outcome "definitive"  Razorpay (or our own guard) refused the call, or it never left this server: no order was created.
//   outcome "ambiguous"   the request may have reached Razorpay and the order may exist: a timeout, a lost connection, a 5xx, an
//                         unreadable answer, or an answer that does not match what was asked. The caller must NEVER create a second
//                         order; it recovers by RECEIPT instead.
//
// SECRETS: the Key Secret is read from the environment here and only here, for the Basic authorization header of one request. Nothing
// in this file logs, returns or puts into an error: the header, the Key Secret, a URL, or any text from Razorpay's response body. Errors
// carry a short code and (for Razorpay API errors) Razorpay's own error CODE, which must look like an identifier.
// Automatic capture is an account setting in the Razorpay Dashboard (Test Mode); no capture parameter is sent here.
const { isPaymentsEnabled, credentialProblem, ENVIRONMENT_ID_PATTERN } = require('./razorpay-config');

const API_HOST = 'api.razorpay.com';
const API_BASE = `https://${API_HOST}/v1`; // fixed, never read from the environment, so it cannot be redirected elsewhere
const REQUEST_TIMEOUT_MS = 15000;
const ORDER_ID = /^order_[A-Za-z0-9]{1,58}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,60}$/;
const RECEIPT =/^HCP[1-9]\d{0,9}$/; // "HCP" + the HumanCare payment id; at most 13 characters (Razorpay allows 40)
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);
const LIST_PAGE = 10;

class RazorpayCallError extends Error {
  constructor(outcome, code, detail) {
    super(detail ? `Razorpay call: ${code} (${detail})` : `Razorpay call: ${code}`);
    this.name = 'RazorpayCallError';
    this.outcome = outcome; // "definitive" | "ambiguous"
    this.code = code;
    this.detail = detail || ''; // only ever "HTTP <status>[ <ERROR_CODE>]" or a network error code: validated above, never Razorpay text
  }
}

const redirectRejection = (err) => /redirect/i.test(String(err && err.message)) || /redirect/i.test(String(err && err.cause && err.cause.message));

// One request. Resolves the parsed JSON body of a 2xx answer; rejects with RazorpayCallError otherwise.
async function call(method, path, { body, env = process.env, fetchImpl = (...args) => fetch(...args), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!isPaymentsEnabled(env)) throw new RazorpayCallError('definitive', 'switch_off');
  const problem = credentialProblem(env);
  if (problem) throw new RazorpayCallError('definitive', 'not_configured', problem);

  const url = new URL(`${API_BASE}${path}`);
  if (url.protocol !== 'https:' || url.hostname !== API_HOST || url.username || url.password || url.port) throw new RazorpayCallError('definitive', 'host_not_allowed');

  const authorization = `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetchImpl(url.toString(), {
      method,
      headers: { Authorization: authorization, Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: 'error', // a redirect is never followed
      signal: controller.signal,
    });
    text = await res.text(); // inside the timer: a stalled body is also a timeout
  } catch (err) {
    if (err && err.name === 'AbortError') throw new RazorpayCallError('ambiguous', 'timeout');
    const code = err && (err.code || (err.cause && err.cause.code));
    if (NOT_SENT_CODES.has(code)) throw new RazorpayCallError('definitive', 'not_sent', code);
    if (redirectRejection(err)) throw new RazorpayCallError('ambiguous', 'redirect_rejected');
    throw new RazorpayCallError('ambiguous', 'network_error', typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code) ? code : '');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  const status = res.status;
  if (status >= 500 || status === 408) throw new RazorpayCallError('ambiguous', 'server_error', `HTTP ${status}`);
  if (status === 401 || status === 403) throw new RazorpayCallError('definitive', 'gateway_auth', `HTTP ${status}`);
  if (status === 404) throw new RazorpayCallError('definitive', 'not_found');
  if (status === 429) throw new RazorpayCallError('definitive', 'rate_limited');
  if (status >= 300) {
    const apiCode = data && data.error && typeof data.error.code === 'string' && ERROR_CODE.test(data.error.code) ? data.error.code : '';
    throw new RazorpayCallError('definitive', 'gateway_error', `HTTP ${status}${apiCode ? ` ${apiCode}` : ''}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new RazorpayCallError('ambiguous', 'unreadable_response');
  return data;
}

// An order object as Razorpay returned it, checked against what we asked for. Returns the few fields we use, or null.
function readOrder(item, { receipt, currency, amountMinor } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (typeof item.id !== 'string' || !ORDER_ID.test(item.id)) return null;
  if (item.entity !== undefined && item.entity !== 'order') return null;
  if (receipt !== undefined && item.receipt !== receipt) return null;
  if (currency !== undefined && item.currency !== currency) return null;
  if (amountMinor !== undefined && item.amount !== amountMinor) return null;
  if (!Number.isSafeInteger(item.amount) || item.amount <= 0) return null;
  return {
    orderId: item.id,
    status: typeof item.status === 'string' ? item.status : null, // "created" | "attempted" | "paid"
    amountMinor: item.amount,
    currency: typeof item.currency === 'string' ? item.currency : null,
    amountPaidMinor: Number.isSafeInteger(item.amount_paid) ? item.amount_paid : 0,
    attempts: Number.isSafeInteger(item.attempts) ? item.attempts : 0,
    // The order's notes exactly as Razorpay returned them (or null): recovery compares hc_payment_id / hc_invoice_id before it attaches an order.
    notes: item.notes && typeof item.notes === 'object' && !Array.isArray(item.notes) ? item.notes : null,
  };
}

// Creates ONE order. The caller owns idempotency: call it at most once per HumanCare payment row, and never again after an
// ambiguous outcome (recover by receipt). Resolves { orderId, status, amountMinor, currency }.
async function createOrder({ amountMinor, currency, receipt, notes }, options) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new RazorpayCallError('definitive', 'amount_invalid');
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new RazorpayCallError('definitive', 'currency_invalid');
  if (typeof receipt !== 'string' || !RECEIPT.test(receipt)) throw new RazorpayCallError('definitive', 'receipt_invalid');
  // Notes carry HumanCare identifiers only: the payment id, the invoice id and the environment id. Recovery later requires all three to match,
  // so all three are REQUIRED here. Never a name, phone, e-mail or medical detail.
  const safeNotes = {};
  const provided = notes || {};
  for (const required of ['hc_payment_id', 'hc_invoice_id', 'hc_environment']) if (!(required in provided)) throw new RazorpayCallError('definitive', 'notes_invalid');
  for (const [key, value] of Object.entries(provided)) {
    if (!/^hc_[a-z_]{1,29}$/.test(key)) throw new RazorpayCallError('definitive', 'notes_invalid');
    if (key === 'hc_environment') {
      if (typeof value !== 'string' || !ENVIRONMENT_ID_PATTERN.test(value)) throw new RazorpayCallError('definitive', 'notes_invalid');
      safeNotes[key] = value;
    } else if (Number.isSafeInteger(value) && value > 0) {
      safeNotes[key] = String(value);
    } else {
      throw new RazorpayCallError('definitive', 'notes_invalid');
    }
  }
  const data = await call('POST', '/orders', { body: { amount: amountMinor, currency, receipt, notes: safeNotes }, ...options });
  const order = readOrder(data, { receipt, currency, amountMinor });
  // Razorpay said OK but the order is not the one we asked for: it may well exist, so this is ambiguous, never a failure.
  if (!order) throw new RazorpayCallError('ambiguous', 'order_mismatch');
  return order;
}

// Looks for orders whose receipt is EXACTLY `receipt`. Resolves { status, orders }:
//   "single"     exactly one verified order
//   "multiple"   two or more (a person must decide)
//   "none"       a clean, complete, empty answer
//   "uncertain"  anything else: the lookup failed, the page may be truncated, or Razorpay returned orders that do not carry the
//                receipt (the filter may not be honoured). Never "none".
async function findOrdersByReceipt(receipt, options) {
  if (typeof receipt !== 'string' || !RECEIPT.test(receipt)) return { status: 'uncertain', orders: [], reason: 'receipt_invalid' };
  let data;
  try {
    data = await call('GET', `/orders?receipt=${encodeURIComponent(receipt)}&count=${LIST_PAGE}`, options);
  } catch (err) {
    return { status: 'uncertain', orders: [], reason: (err && err.code) || 'lookup_failed' };
  }
  if (!Array.isArray(data.items)) return { status: 'uncertain', orders: [], reason: 'unexpected_shape' };
  if (data.items.length >= LIST_PAGE) return { status: 'uncertain', orders: [], reason: 'truncated' };
  const orders = [];
  for (const item of data.items) {
    const order = readOrder(item, { receipt });
    if (!order) return { status: 'uncertain', orders: [], reason: 'unexpected_order' };
    orders.push(order);
  }
  if (orders.length === 0) return { status: 'none', orders };
  return { status: orders.length === 1 ? 'single' : 'multiple', orders };
}

// Reads one order (its status says whether it was attempted or paid). Resolves { status: "ok", order } | { status: "not_found" } |
// { status: "uncertain" }. Never throws for a gateway problem.
async function fetchOrder(orderId, options) {
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return { status: 'uncertain', reason: 'order_id_invalid' };
  let data;
  try {
    data = await call('GET', `/orders/${orderId}`, options);
  } catch (err) {
    if (err && err.code === 'not_found') return { status: 'not_found' };
    return { status: 'uncertain', reason: (err && err.code) || 'lookup_failed' };
  }
  const order = readOrder(data);
  if (!order || order.orderId !== orderId) return { status: 'uncertain', reason: 'unexpected_order' };
  return { status: 'ok', order };
}

// A payment object as Razorpay returned it, reduced to the few fields reconciliation compares, or null when it is not a well-formed payment.
function readPayment(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (typeof item.id !== 'string' || !PAYMENT_ID.test(item.id)) return null;
  if (item.entity !== undefined && item.entity !== 'payment') return null;
  if (typeof item.order_id !== 'string' || !ORDER_ID.test(item.order_id)) return null;
  if (!Number.isSafeInteger(item.amount) || item.amount <= 0) return null;
  if (typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency)) return null;
  if (typeof item.status !== 'string' || !/^[a-z_]{1,24}$/.test(item.status)) return null;
  if (typeof item.captured !== 'boolean') return null;
  const refunded = item.amount_refunded === undefined || item.amount_refunded === null ? 0 : item.amount_refunded;
  if (!Number.isSafeInteger(refunded) || refunded < 0) return null;
  return {
    paymentId: item.id,
    orderId: item.order_id,
    amountMinor: item.amount,
    currency: item.currency,
    status: item.status, // "created" | "authorized" | "captured" | "refunded" | "failed"
    captured: item.captured,
    amountRefundedMinor: refunded,
    createdAtSeconds: Number.isSafeInteger(item.created_at) ? item.created_at : null,
    method: typeof item.method === 'string' && /^[a-z_]{1,24}$/.test(item.method) ? item.method : null,
  };
}

// Reads ONE payment (GET only: nothing is created, captured or refunded). Resolves { status: "ok", payment } | { status: "not_found" } |
// { status: "uncertain", reason }. Never throws for a gateway problem. The payment returned must be the one asked for.
async function fetchPayment(paymentId, options) {
  if (typeof paymentId !== 'string' || !PAYMENT_ID.test(paymentId)) return { status: 'uncertain', reason: 'payment_id_invalid' };
  let data;
  try {
    data = await call('GET', `/payments/${paymentId}`, options);
  } catch (err) {
    if (err && err.code === 'not_found') return { status: 'not_found' };
    return { status: 'uncertain', reason: (err && err.code) || 'lookup_failed', ...(err && err.detail && { detail: err.detail }) };
  }
  const payment = readPayment(data);
  if (!payment || payment.paymentId !== paymentId) return { status: 'uncertain', reason: 'unexpected_payment' };
  return { status: 'ok', payment };
}

// Lists the payment attempts of ONE order (GET only). Resolves { status: "ok", payments } | { status: "not_found" } | { status: "uncertain", reason }.
// Every item must be a well-formed payment of THIS order; anything else, or a page that may be truncated, is "uncertain" (never a partial list).
async function fetchOrderPayments(orderId, options) {
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return { status: 'uncertain', reason: 'order_id_invalid' };
  let data;
  try {
    data = await call('GET', `/orders/${orderId}/payments`, options);
  } catch (err) {
    if (err && err.code === 'not_found') return { status: 'not_found' };
    return { status: 'uncertain', reason: (err && err.code) || 'lookup_failed', ...(err && err.detail && { detail: err.detail }) };
  }
  if (!Array.isArray(data.items)) return { status: 'uncertain', reason: 'unexpected_shape' };
  if (data.items.length >= 100) return { status: 'uncertain', reason: 'truncated' };
  const payments = [];
  for (const item of data.items) {
    const payment = readPayment(item);
    if (!payment || payment.orderId !== orderId) return { status: 'uncertain', reason: 'unexpected_payment' };
    payments.push(payment);
  }
  return { status: 'ok', payments };
}

module.exports = { createOrder, findOrdersByReceipt, fetchOrder, fetchPayment, fetchOrderPayments, RazorpayCallError, API_HOST, ORDER_ID, PAYMENT_ID, RECEIPT };
