// The PUBLIC hosted-Checkout routes, mounted at /checkout in app.js. No login: a browser opened from the app has no Bearer token, and none is ever put in
// a URL. The session token in the path is a single-use capability (see checkout-session.token.js); the return token only redirects. Rate limited per IP
// (generously: behind a tunnel or proxy many people share one address).
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getCheckoutPage, handleReturn } = require('./checkout.controller');

const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many requests. Please wait a minute.', code: 'rate_limited' },
});

const checkoutRouter = express.Router();
checkoutRouter.use(checkoutLimiter);

// Razorpay's redirect-mode callback is a form post. Small, flat and only ever inspected for one field.
const formBody = express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 100 });
// The return routes come first so that "return" is never read as a token.
checkoutRouter.get('/return/:ret', handleReturn);
checkoutRouter.post('/return/:ret', formBody, handleReturn);
checkoutRouter.get('/:token', getCheckoutPage);

module.exports = { checkoutRouter };
