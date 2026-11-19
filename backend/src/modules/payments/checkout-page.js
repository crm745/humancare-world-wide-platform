// The HumanCare-hosted Checkout page and its HTTP security headers. Pure: strings in, strings out.
//
// The page receives ONLY public payment information, as a JSON data block (never executed): the public Razorpay Key ID, the server-created order id,
// the amount in the smallest unit, the currency, the invoice id and the signed RETURN token. No secret, no signature, no personal data, no payment row
// id. The script is static (no value is ever interpolated into code); it reads the data block, strips the session token from the address bar, opens
// Razorpay Standard Checkout for the existing order and sends the browser on with an allow-listed result word. Razorpay's own redirect callback goes
// to /checkout/return/<return token>. NOTHING the page or Razorpay's browser callback reports completes a payment: only the verified webhook does.
//
// Headers: the page is never cached and never sent as a Referer (the session token is in the address), cannot be framed, and runs only the one nonce'd
// script plus Razorpay's checkout script. The Razorpay hosts below are the ones Razorpay documents for Standard Checkout.
const crypto = require('crypto');

const nonce = () => crypto.randomBytes(16).toString('base64');

function securityHeaders(scriptNonce) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'nonce-${scriptNonce}' https://checkout.razorpay.com`,
      "frame-src https://api.razorpay.com https://checkout.razorpay.com",
      "connect-src https://api.razorpay.com https://checkout.razorpay.com https://lumberjack.razorpay.com https://lumberjack-metrics.razorpay.com",
      "style-src 'unsafe-inline' https://checkout.razorpay.com",
      'img-src data: https:',
      'font-src https: data:',
      "form-action 'self' https://api.razorpay.com",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  };
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// JSON for a <script type="application/json"> block: no character that could close the element or start markup.
const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const STYLE = 'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;color:#0b2545;background:#fff;text-align:center}'
  + 'main{max-width:420px;margin:48px auto}h1{font-size:20px}p{color:#44556b;line-height:1.5}'
  + 'button,a.btn{display:inline-block;margin:6px;padding:12px 22px;border-radius:10px;border:0;font-size:16px;text-decoration:none;cursor:pointer}'
  + 'button.pay{background:#1a73e8;color:#fff}button.cancel,a.btn{background:#eef2f8;color:#0b2545}';

/** The Checkout page. `config` is exactly { keyId, orderId, amount, currency, invoiceId, returnToken }. */
function renderCheckoutPage(config, scriptNonce) {
  const data = { keyId: config.keyId, orderId: config.orderId, amount: config.amount, currency: config.currency, invoiceId: config.invoiceId, returnToken: config.returnToken };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>HumanCare payment</title><style>${STYLE}</style></head>
<body><main>
<h1>HumanCare World Wide</h1>
<p id="hc-status">Opening secure payment…</p>
<button id="hc-pay" class="pay" type="button">Pay now</button>
<button id="hc-cancel" class="cancel" type="button">Cancel and return to the app</button>
<noscript><p>Payment needs JavaScript. Please return to the app and try again.</p></noscript>
</main>
<script type="application/json" id="hc-config">${safeJson(data)}</script>
<script nonce="${scriptNonce}" src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script nonce="${scriptNonce}">${PAGE_SCRIPT}</script>
</body></html>`;
}

// Static: no value is ever interpolated here. The data comes from the JSON block above.
const PAGE_SCRIPT = `(function () {
  var cfg = JSON.parse(document.getElementById('hc-config').textContent);
  var status = document.getElementById('hc-status');
  function say(text) { status.textContent = text; }
  function leave(result) { window.location.replace('/checkout/return/' + encodeURIComponent(cfg.returnToken) + '?result=' + result); }
  try { window.history.replaceState(null, '', '/checkout/closed'); } catch (e) { /* the token is single-use anyway */ }
  document.getElementById('hc-cancel').onclick = function () { leave('cancelled'); };
  if (typeof window.Razorpay === 'undefined') { say('The secure payment form could not be loaded. Please return to the app and try again.'); document.getElementById('hc-pay').style.display = 'none'; return; }
  var rzp = new window.Razorpay({
    key: cfg.keyId,
    order_id: cfg.orderId,
    amount: cfg.amount,
    currency: cfg.currency,
    name: 'HumanCare World Wide',
    description: 'Invoice payment',
    callback_url: window.location.origin + '/checkout/return/' + encodeURIComponent(cfg.returnToken),
    redirect: true,
    theme: { color: '#1A73E8' },
    modal: { confirm_close: true, ondismiss: function () { leave('cancelled'); } }
  });
  rzp.on('payment.failed', function () { say('The payment did not go through. You can try again.'); });
  document.getElementById('hc-pay').onclick = function () { rzp.open(); };
  rzp.open();
})();`;

/** A plain message page (expired, used, not available ...) with a link back to the app. `appLink` is one of our own fixed links. */
function renderMessagePage({ title, message, appLink }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="btn" href="${escapeHtml(appLink)}">Return to HumanCare</a></main></body></html>`;
}

module.exports = { renderCheckoutPage, renderMessagePage, securityHeaders, nonce, escapeHtml, safeJson, PAGE_SCRIPT };
