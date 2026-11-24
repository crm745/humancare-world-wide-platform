// Hosted Razorpay Standard Checkout, backend side: (1) an authenticated patient asks for a checkout SESSION for the payment they already started,
// (2) the HumanCare-hosted page redeems it exactly once, (3) the browser's return is turned into a redirect back to the app.
//
// WHAT THIS NEVER DOES:
//   - create a Razorpay order or a Payment (orders come only from POST /invoices/:invoiceId/payment-orders and are reused here)
//   - call Razorpay, hold an API secret or a webhook secret, or read a webhook
//   - change any Payment, Invoice or Case. Completion belongs EXCLUSIVELY to the verified webhook processor. What the browser reports (a callback, a
//     redirect, a result word) is only ever used to choose WHICH MESSAGE the app shows while it polls GET /invoices/:invoiceId.
//
// SINGLE USE (WITH A 30-SECOND REPLAY FOR THE SAME BROWSER LOAD) WITHOUT A MIGRATION: redeeming a session writes ONE audit row (entity "payment", action payment.checkout_opened) whose idempotency key is
// "checkout:<session id>". audit_logs is unique on (entityType, entityId, idempotencyKey), so the database decides, atomically, which of several
// simultaneous requests wins; a duplicate key (Prisma P2002) means the session was already used. The row is also the audit trail of the checkout.
// Nothing is deleted, so a used session can never become valid again.
const { prisma } = require('../../db/prisma');
const store = require('./payment-orders.store');
const orders = require('./payment-orders.service');
const { isPaymentsEnabled, credentialProblem, publicKeyId } = require('./razorpay-config');
const { toThousandths, toMinorUnits } = require('./payment-money');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { signToken, verifyToken, KINDS } = require('./checkout-session.token');

const APP_RETURN = 'humancare://payment-return';
// The ONLY result words the app is ever told. Informational: the app still waits for the backend (the webhook) to say the invoice is paid.
//   submitted    a payment was submitted at Razorpay (success redirect): the app should poll
//   failed       the payment failed or Razorpay reported an error
//   cancelled    the patient closed Checkout
//   unavailable  Checkout could not be opened (expired, used, not payable any more, not configured)
//   expired      the return link had expired
//   returned     the patient came back with no information
const RESULTS = Object.freeze(['submitted', 'failed', 'cancelled', 'unavailable', 'expired', 'returned']);
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,60}$/;
// A browser may ask for the SAME address more than once while it is still opening it (Safari sends the navigation again within a second, without
// a Referer). So a token that was redeemed only moments ago is answered again with the same page; anything later is "used". The window starts at the
// audit row written by the first redemption, so it is measured by the database's own record, not by anything the request says.
const REPLAY_WINDOW_MS = 30 * 1000;
const CLOCK_SKEW_MS = 5 * 1000;

function failure(statusCode, publicCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.publicCode = publicCode;
  return err;
}
const noOpenPayment = () => failure(409, 'no_open_payment', 'There is no open payment for this invoice. Please start the payment first.');

// ---- 1. the session (authenticated patient) ----------------------------------------------------------------------------------------------------------

/**
 * Resolves { checkoutPath, expiresAt }. `checkoutPath` is RELATIVE ("/checkout/<token>"): the app puts its own API address in front, so the server never
 * has to trust a Host header to build a link. Throws the same public errors as the order endpoint where the rules are the same (404 for another
 * patient's invoice, 409 not payable ...), plus 409 no_open_payment when there is no pending Razorpay payment to check out.
 */
async function createCheckoutSession({ userId, invoiceId, db = prisma, env = process.env, now = () => new Date() }) {
  const id = orders.parseInvoiceId(invoiceId);
  if (id === null) throw orders.fail('invoice_not_found');
  const invoice = await store.loadInvoice(db, id);
  if (!orders.ownedBy(invoice, userId) || invoice.status === 'draft') throw orders.fail('invoice_not_found');
  if (!isPaymentsEnabled(env) || credentialProblem(env)) throw orders.fail('payments_disabled');
  const problem = orders.eligibilityProblem(invoice, now());
  if (problem) throw orders.fail(problem);

  const payments = await store.listPayments(db, id);
  const open = payments.find((p) => p.kind === 'payment' && p.status === 'pending' && p.razorpayOrderId);
  if (!open) throw noOpenPayment();

  const signed = signToken(KINDS.session, { userId, invoiceId: id, paymentId: open.id }, { env, now: now() });
  if (!signed) throw orders.fail('payments_disabled'); // no signing key configured
  return { checkoutPath: `/checkout/${signed.token}`, expiresAt: signed.expiresAt.toISOString() };
}

// ---- 2. redeeming the session (the hosted page; no login, the token is the capability) ------------------------------------------------------------------

/**
 * Resolves one of
 *   { outcome: 'ready', config }                                  config = ONLY public checkout data (see below)
 *   { outcome: 'invalid' | 'expired' | 'used' | 'unavailable', invoiceId? }
 * `config` = { keyId, orderId, amount (integer, smallest unit), currency, invoiceId, returnToken }. Nothing else is ever given to the browser: no
 * secret, no signature, no payment row id, no personal data, no API response.
 * The token is validated, the payment and invoice are re-read and re-checked against it, and only then is it CONSUMED; a session that fails any
 * check is not consumed. Whatever the reason, the page never learns more than the outcome word.
 */
async function openCheckout({ token, db = prisma, env = process.env, now = () => new Date() }) {
  const checked = verifyToken(KINDS.session, token, { env, now: now() });
  if (!checked.ok) {
    if (checked.code === 'expired') return { outcome: 'expired', invoiceId: checked.claims.invoiceId };
    return { outcome: checked.code === 'unconfigured' ? 'unavailable' : 'invalid' };
  }
  const { userId, invoiceId, paymentId, jti } = checked.claims;

  const keyId = publicKeyId(env);
  if (!isPaymentsEnabled(env) || !keyId) return { outcome: 'unavailable', invoiceId };

  // The invoice must still belong to THIS patient and still be payable, and the payment must still be the open Razorpay payment OF THIS INVOICE.
  const invoice = await store.loadInvoice(db, invoiceId);
  const payment = await store.loadPayment(db, paymentId);
  if (!orders.ownedBy(invoice, userId) || invoice.status === 'draft' || orders.eligibilityProblem(invoice, now())) return { outcome: 'unavailable', invoiceId };
  if (!payment || payment.invoiceId !== invoiceId || payment.kind !== 'payment' || payment.status !== 'pending' || !payment.razorpayOrderId) return { outcome: 'unavailable', invoiceId };
  const amount = toMinorUnits(toThousandths(payment.amount), payment.currency);
  if (amount === null) return { outcome: 'unavailable', invoiceId };

  // Consume. The unique audit key is the single-use switch.
  try {
    await appendAuditLog(db, {
      caseId: payment.caseId, entityType: 'payment', entityId: String(payment.id), action: 'payment.checkout_opened', actorType: 'patient', actorId: String(userId),
      source: 'hosted_checkout', reasonCode: 'checkout_session', idempotencyKey: `checkout:${jti}`,
      afterData: { paymentId: payment.id, invoiceId, razorpayOrderId: payment.razorpayOrderId },
    });
  } catch (err) {
    if (!(err && err.code === 'P2002')) throw err;
    // Already redeemed. Everything above (signature, expiry, ownership, eligibility, the payment still pending with its order) has just been
    // re-checked, so the page may be repeated only if the first redemption was moments ago. Nothing is written here: no second audit row.
    const first = await db.auditLog.findUnique({
      where: { entityType_entityId_idempotencyKey: { entityType: 'payment', entityId: String(payment.id), idempotencyKey: `checkout:${jti}` } },
      select: { recordedAt: true },
    });
    const age = first && first.recordedAt ? now().getTime() - new Date(first.recordedAt).getTime() : null;
    if (age === null || Number.isNaN(age) || age < -CLOCK_SKEW_MS || age > REPLAY_WINDOW_MS) return { outcome: 'used', invoiceId };
  }

  const returnToken = signToken(KINDS.return, { userId, invoiceId, paymentId: payment.id }, { env, now: now() });
  if (!returnToken) return { outcome: 'unavailable', invoiceId };
  return { outcome: 'ready', config: { keyId, orderId: payment.razorpayOrderId, amount, currency: payment.currency, invoiceId, returnToken: returnToken.token } };
}

// ---- 3. the return (Razorpay's callback or the page itself -> the app) -----------------------------------------------------------------------------------

// A hint for the app's message, from what the BROWSER says. Never used for anything but the word shown to the patient.
//   POST (Razorpay's callback): a well-formed payment id means something was submitted; anything else is a failure. No other field is read.
//   GET  (the hosted page leaving): one of the allow-listed words, else "returned".
function classifyReturn(method, { body, query } = {}) {
  if (method === 'POST') {
    const id = body && typeof body === 'object' ? body.razorpay_payment_id : undefined;
    return typeof id === 'string' && PAYMENT_ID.test(id) ? 'submitted' : 'failed';
  }
  const word = query && typeof query === 'object' ? query.result : undefined;
  return typeof word === 'string' && RESULTS.includes(word) ? word : 'returned';
}

/** The app link to send the browser to. Always the fixed scheme and path; only an invoice id from a VERIFIED token and an allow-listed word are added. */
function returnLocation({ ret, result, env = process.env, now = () => new Date() }) {
  const checked = verifyToken(KINDS.return, ret, { env, now: now() });
  if (checked.ok) return `${APP_RETURN}?invoice=${checked.claims.invoiceId}&result=${RESULTS.includes(result) ? result : 'returned'}`;
  if (checked.code === 'expired') return `${APP_RETURN}?invoice=${checked.claims.invoiceId}&result=expired`;
  return `${APP_RETURN}?result=unavailable`;
}

const appLink = (invoiceId, result) => `${APP_RETURN}?${invoiceId ? `invoice=${invoiceId}&` : ''}result=${RESULTS.includes(result) ? result : 'unavailable'}`;

module.exports = { createCheckoutSession, openCheckout, REPLAY_WINDOW_MS, classifyReturn, returnLocation, appLink, APP_RETURN, RESULTS };
