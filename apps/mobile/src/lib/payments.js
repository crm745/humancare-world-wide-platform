// Hosted Razorpay payment for one invoice, from the phone's side. The backend is the only source of truth: the webhook and
// worker mark a payment completed. Nothing here — not a redirect, not the browser's result word — is ever treated as proof
// of payment; it only decides which message to show while the invoice is read back (GET /invoices/:invoiceId).
//
//   startPayment   Pay Now: order (idempotent) -> checkout session -> hosted Checkout in the system browser -> verify
//   resumePayment  the app was closed / came back: if an attempt was left open, verify it from the invoice
//   verifyPayment  bounded polling of the invoice; "paid" needs a completed payment AND a lower balance
//
// Every public result is { outcome, ... } and never throws. Outcomes:
//   paid        { fullyPaid }                 the backend confirms it
//   confirming                                paid at the gateway as far as we know, the backend has not confirmed yet
//   cancelled                                 the patient closed Checkout (the open order is kept: Pay Now resumes it)
//   failed      { messageKey }                the payment did not go through
//   uncertain   { messageKey }                we cannot tell whether the order was created: Pay Now retries with the SAME key
//   error       { messageKey, refresh }       a definite refusal; refresh means "reload the invoice, it changed"
//   busy                                      another attempt on this invoice is already running (duplicate tap)
import * as WebBrowser from 'expo-web-browser';
import { API_BASE_URL, apiGet, apiPost } from './api';
import { clearAttempt, getOrCreateAttempt, loadAttempt, updateAttempt } from './paymentAttempts';

export const RETURN_URL = 'humancare://payment-return';
const RETURN_RESULTS = ['submitted', 'failed', 'cancelled', 'unavailable', 'expired', 'returned'];
export const REQUEST_TIMEOUT_MS = 30000;
export const POLL_INTERVAL_MS = 3000;
export const POLLS_AFTER_RETURN = 20; // ~1 minute of waiting for a webhook
export const POLLS_AFTER_CANCEL = 3;
export const POLLS_ON_RESUME = 10;

// ---- small pure helpers ------------------------------------------------------------------------------------------------------

/** humancare://payment-return?invoice=761&result=submitted -> { invoiceId: '761', result: 'submitted' }. Any word that is
 * not on the list becomes 'returned'; a missing or non-numeric invoice is null. */
export function parsePaymentReturn(url) {
  const text = typeof url === 'string' ? url : '';
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1).split('#')[0] : '';
  const params = {};
  for (const pair of query.split('&')) {
    const [k, v = ''] = pair.split('=');
    if (!k) continue;
    try { params[decodeURIComponent(k)] = decodeURIComponent(v); } catch { /* skip a malformed pair */ }
  }
  return {
    invoiceId: /^\d{1,12}$/.test(params.invoice || '') ? params.invoice : null,
    result: RETURN_RESULTS.includes(params.result) ? params.result : 'returned',
  };
}

/** The backend's relative checkoutPath on the CONFIGURED api base. Anything that is not "/checkout/<token>" is refused, so
 * a response can never send the patient to another site. */
export function checkoutUrl(checkoutPath, base = API_BASE_URL) {
  if (typeof checkoutPath !== 'string' || !/^\/checkout\/[A-Za-z0-9._~-]{8,}$/.test(checkoutPath)) throw new Error('bad checkout path');
  return `${String(base).replace(/\/+$/, '')}${checkoutPath}`;
}

// Exact decimal-text comparison ("1500.00" vs "750.00"); never a float. null when either side is not a plain decimal.
export function compareDecimal(a, b) {
  const split = (x) => {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(typeof x === 'string' ? x.trim() : '');
    return m ? [m[1].replace(/^0+(?=\d)/, ''), m[2] || ''] : null;
  };
  const left = split(a);
  const right = split(b);
  if (!left || !right) return null;
  const width = Math.max(left[1].length, right[1].length);
  const l = left[0] + left[1].padEnd(width, '0');
  const r = right[0] + right[1].padEnd(width, '0');
  const len = Math.max(l.length, r.length);
  const L = l.padStart(len, '0');
  const R = r.padStart(len, '0');
  return L === R ? 0 : L < R ? -1 : 1;
}

const isZero = (text) => compareDecimal(text, '0') === 0;

/** What the invoice (from GET /invoices/:id) says about OUR payment. 'paid' only for a completed payment together with a balance
 * that went down (or the baseline unknown); 'failed' when the payment row is closed without being completed; else 'pending'. */
export function evaluateInvoice(invoice, { paymentId, baselineBalance }) {
  const payments = Array.isArray(invoice && invoice.payments) ? invoice.payments : [];
  const mine = payments.find((p) => p && p.kind === 'payment' && p.id === paymentId);
  if (!mine) return { state: 'pending' };
  if (mine.status === 'completed') {
    const lower = baselineBalance ? compareDecimal(invoice.balance, baselineBalance) === -1 : typeof invoice.balance === 'string';
    return lower ? { state: 'paid', fullyPaid: isZero(invoice.balance) } : { state: 'pending' };
  }
  if (mine.status === 'pending') return { state: 'pending' };
  return { state: 'failed' };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MESSAGE_FOR_CODE = {
  invoice_not_payable: 'payable_reason_invoice_not_payable',
  invoice_overdue: 'payable_reason_invoice_overdue',
  quotation_not_active: 'payable_reason_quotation_not_active',
  currency_unsupported: 'payable_reason_currency_unsupported',
  payments_disabled: 'payable_reason_payments_disabled',
  rate_limited: 'payment_rate_limited',
  no_open_payment: 'payment_no_open',
};
export const messageKeyFor = (err) => MESSAGE_FOR_CODE[err && err.code] || 'payment_error_generic';

async function postWithTimeout(path, body, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await apiPost(path, body, { ...(headers ? { headers } : {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- one attempt at a time per invoice -----------------------------------------------------------------------------------------
const running = new Set();
/** Runs `task` unless one is already running for this invoice (a second tap, a second screen): then { outcome: 'busy' }. */
export async function runExclusive(invoiceId, task) {
  const id = String(invoiceId);
  if (running.has(id)) return { outcome: 'busy' };
  running.add(id);
  try {
    return await task();
  } finally {
    running.delete(id);
  }
}
export const isRunning = (invoiceId) => running.has(String(invoiceId));

// ---- verifying from the invoice ------------------------------------------------------------------------------------------------

/** Polls GET /invoices/:id, bounded. A failed poll (network, rate limit) is skipped, not fatal. `shouldStop()` ends it early
 * (the screen was left); the attempt stays saved so it is picked up again later. */
export async function verifyPayment({ invoiceId, attempt, hint, maxPolls, intervalMs = POLL_INTERVAL_MS, sleep = defaultSleep, shouldStop = () => false }) {
  const polls = maxPolls || (hint === 'cancelled' ? POLLS_AFTER_CANCEL : hint === 'failed' ? 2 : POLLS_AFTER_RETURN);
  for (let i = 0; i < polls; i += 1) {
    if (shouldStop()) return { outcome: 'confirming', stopped: true };
    let invoice = null;
    try {
      ({ invoice } = await apiGet(`/invoices/${invoiceId}`));
    } catch { /* try again on the next poll */ }
    if (invoice) {
      const seen = evaluateInvoice(invoice, attempt);
      if (seen.state === 'paid') {
        await clearAttempt(invoiceId);
        return { outcome: 'paid', fullyPaid: seen.fullyPaid, invoice };
      }
      if (seen.state === 'failed') {
        await clearAttempt(invoiceId);
        return { outcome: 'failed', messageKey: 'payment_failed', invoice };
      }
    }
    if (i < polls - 1) await sleep(intervalMs);
  }
  // Still pending at the backend. For a cancel or a reported failure the order stays open (Pay Now resumes it); otherwise the
  // payment may simply be waiting for its webhook.
  if (hint === 'cancelled') return { outcome: 'cancelled' };
  if (hint === 'failed') return { outcome: 'failed', messageKey: 'payment_failed', open: true };
  return { outcome: 'confirming' };
}

// ---- Pay Now --------------------------------------------------------------------------------------------------------------------

// Step 1: the order. Resolves { ok: true, paymentId } or { ok: false, result }.
async function ensureOrder(invoice, attempt) {
  let data;
  try {
    data = await postWithTimeout(`/invoices/${invoice.id}/payment-orders`, { mode: 'full' }, { 'Idempotency-Key': attempt.key });
  } catch (err) {
    const status = err && err.status;
    // A refusal that created nothing: the attempt is over.
    if (err.code === 'open_order_exists') return adoptOpenOrder(invoice);
    if (err.code === 'idempotency_conflict') { await clearAttempt(invoice.id); return { ok: false, result: { outcome: 'error', messageKey: 'payment_error_generic', refresh: true } }; }
    if ([400, 403, 404, 409, 503].includes(status) && (status !== 503 || err.code === 'payments_disabled')) {
      await clearAttempt(invoice.id);
      return { ok: false, result: { outcome: 'error', messageKey: messageKeyFor(err), refresh: true } };
    }
    // Everything else (no answer, a timeout, 429, 5xx, 502 gateway) leaves us not knowing: keep the key, try again later with it.
    return { ok: false, result: { outcome: 'uncertain', messageKey: err.code === 'rate_limited' ? 'payment_rate_limited' : 'payment_uncertain' } };
  }
  if (data && data.code === 'gateway_uncertain') return { ok: false, result: { outcome: 'uncertain', messageKey: 'payment_uncertain' } };
  if (!data || data.paymentId == null) return { ok: false, result: { outcome: 'uncertain', messageKey: 'payment_uncertain' } };
  if (data.status === 'completed') return { ok: true, paymentId: data.paymentId, completed: true };
  if (data.status !== 'pending' || !data.razorpay) {
    // The same attempt (same key) already ended at the server: a closed order never reopens. The next tap is a new attempt.
    await clearAttempt(invoice.id);
    return { ok: false, result: { outcome: 'failed', messageKey: 'payment_order_closed', refresh: true } };
  }
  return { ok: true, paymentId: data.paymentId };
}

// Another attempt (a lost key, a reinstall) already has an open payment on this invoice: use it, create nothing.
async function adoptOpenOrder(invoice) {
  try {
    const { invoice: fresh } = await apiGet(`/invoices/${invoice.id}`);
    const open = (fresh.payments || []).find((p) => p.kind === 'payment' && p.status === 'pending');
    if (open) return { ok: true, paymentId: open.id };
  } catch { /* fall through */ }
  return { ok: false, result: { outcome: 'error', messageKey: 'payment_error_generic', refresh: true } };
}

// Step 3: the system browser. Resolves the browser's word ('submitted', 'cancelled' ...) or throws if it could not open.
async function runCheckout(url) {
  const result = await WebBrowser.openAuthSessionAsync(url, RETURN_URL);
  if (result.type === 'success') return parsePaymentReturn(result.url).result;
  if (result.type === 'cancel' || result.type === 'dismiss') return 'cancelled';
  if (result.type === 'locked') throw new Error('browser locked');
  return 'returned';
}

/** Pay Now for `invoice` (a backend invoice: id, balance). `requestId` is remembered so a return link can find the screen. */
export function startPayment({ invoice, requestId = null, sleep, shouldStop }) {
  return runExclusive(invoice.id, async () => {
    let attempt;
    try {
      attempt = await getOrCreateAttempt(invoice.id, { requestId, baselineBalance: invoice.balance });
    } catch {
      return { outcome: 'error', messageKey: 'payment_error_generic' }; // the key could not be saved: no order request is made
    }

    const order = await ensureOrder(invoice, attempt);
    if (!order.ok) return order.result;
    attempt = (await updateAttempt(invoice.id, { phase: 'order', paymentId: order.paymentId })) || { ...attempt, paymentId: order.paymentId };
    if (order.completed) return verifyPayment({ invoiceId: invoice.id, attempt, hint: 'submitted', sleep, shouldStop });

    let url;
    try {
      const session = await postWithTimeout(`/invoices/${invoice.id}/checkout-sessions`, {});
      url = checkoutUrl(session.checkoutPath);
    } catch (err) {
      if (err && err.code === 'no_open_payment') {
        await clearAttempt(invoice.id);
        return { outcome: 'error', messageKey: 'payment_no_open', refresh: true };
      }
      const definite = err && [403, 404, 409, 503].includes(err.status);
      return { outcome: 'error', messageKey: definite ? messageKeyFor(err) : 'payment_checkout_failed', refresh: !!definite };
    }

    await updateAttempt(invoice.id, { phase: 'checkout', hint: null });
    let hint;
    try {
      hint = await runCheckout(url);
    } catch {
      await updateAttempt(invoice.id, { phase: 'order' });
      return { outcome: 'error', messageKey: 'payment_browser_failed' };
    }
    await updateAttempt(invoice.id, { hint });
    return verifyPayment({ invoiceId: invoice.id, attempt, hint, sleep, shouldStop });
  });
}

/** The app was closed or came back: if Checkout was opened for this invoice and never confirmed, verify it from the invoice.
 * Resolves null when there is nothing to resume (so the screen shows nothing new). */
export async function resumePayment({ invoiceId, sleep, shouldStop }) {
  if (!invoiceId || isRunning(invoiceId)) return null;
  const attempt = await loadAttempt(invoiceId);
  if (!attempt || attempt.phase !== 'checkout' || attempt.paymentId == null) return null;
  const result = await runExclusive(invoiceId, () => verifyPayment({ invoiceId, attempt, hint: attempt.hint || 'returned', maxPolls: POLLS_ON_RESUME, sleep, shouldStop }));
  return result.outcome === 'busy' ? null : result;
}

/** The deep link humancare://payment-return was opened: remember what the browser said and tell the caller which request to show. */
export async function handlePaymentReturn(url) {
  const { invoiceId, result } = parsePaymentReturn(url);
  if (!invoiceId) return { invoiceId: null, requestId: null };
  const attempt = await loadAttempt(invoiceId);
  if (attempt && attempt.phase === 'checkout') await updateAttempt(invoiceId, { hint: result });
  return { invoiceId, requestId: attempt ? attempt.requestId : null };
}
