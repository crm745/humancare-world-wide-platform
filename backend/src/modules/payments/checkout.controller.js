// Hosted Checkout HTTP layer. All rules live in checkout-session.service.js; the HTML and headers in checkout-page.js.
//
//   POST /invoices/:invoiceId/checkout-sessions   authenticated patient       -> { checkoutPath, expiresAt }   (mounted with the invoices router)
//   GET  /checkout/:token                         public, the token is the key -> the hosted Checkout page, once
//   GET|POST /checkout/return/:ret                public                      -> 303 to humancare://payment-return?invoice=..&result=..
//
// Nothing here reads a Payment to change it, calls Razorpay, logs a token, a body or a header, or decides that anything was paid.
const service = require('./checkout-session.service');
const page = require('./checkout-page');

async function postCheckoutSession(req, res) {
  res.set('Cache-Control', 'no-store');
  const session = await service.createCheckoutSession({ userId: Number(req.user.id), invoiceId: req.params.invoiceId });
  return res.status(201).json(session);
}

// What the person is told for each way a session can fail. Fixed texts; never a reason that would help someone probe.
const MESSAGES = Object.freeze({
  invalid: [400, 'This payment link is not valid', 'Please return to the app and start the payment again.'],
  expired: [410, 'This payment link has expired', 'Please return to the app and start the payment again.'],
  used: [410, 'This payment link was already used', 'Please return to the app and start the payment again.'],
  unavailable: [409, 'Payment is not available right now', 'Please return to the app to check your invoice.'],
});

async function getCheckoutPage(req, res) {
  const result = await service.openCheckout({ token: req.params.token });
  const scriptNonce = page.nonce();
  if (result.outcome === 'ready') {
    res.set(page.securityHeaders(scriptNonce));
    return res.status(200).send(page.renderCheckoutPage(result.config, scriptNonce));
  }
  const [status, title, message] = MESSAGES[result.outcome] || MESSAGES.unavailable;
  res.set(page.securityHeaders(scriptNonce));
  return res.status(status).send(page.renderMessagePage({ title, message, appLink: service.appLink(result.invoiceId, result.outcome === 'expired' ? 'expired' : 'unavailable') }));
}

// Razorpay posts here after a redirect-mode payment (application/x-www-form-urlencoded), and the hosted page itself navigates here (GET) when the
// patient cancels. Only the allow-listed word is derived; the body is never stored, logged or echoed.
function handleReturn(req, res) {
  const result = service.classifyReturn(req.method, { body: req.body, query: req.query });
  const location = service.returnLocation({ ret: req.params.ret, result });
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Location: location });
  res.status(303).type('html').send(page.renderMessagePage({
    title: 'Returning to HumanCare', message: 'If the app does not open automatically, tap the button below.', appLink: location,
  }));
}

module.exports = { postCheckoutSession, getCheckoutPage, handleReturn };
