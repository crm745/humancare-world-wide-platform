const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { requireAuth } = require('../../common/middleware/auth.middleware');
const { postPaymentOrder, getInvoice } = require('./payment-orders.controller');
const { postCheckoutSession } = require('./checkout.controller');

// Keyed by the signed-in patient, not the IP: `trust proxy` is not configured, so behind a reverse proxy every caller would share
// one address. Runs after requireAuth. Skipped in tests, like the other limiters.
const paymentOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => `patient:${req.user && req.user.id}`,
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many payment attempts. Please wait a minute.', code: 'rate_limited' },
});

// Polling after Checkout is one request every few seconds, so the read limit is far higher than the order limit.
const invoiceReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => `patient:${req.user && req.user.id}`,
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many requests. Please wait a minute.', code: 'rate_limited' },
});

const invoicesRouter = Router();

// Patient only. The invoice must belong to a Case the patient owns (404 otherwise); see payment-orders.service.js.
invoicesRouter.post('/:invoiceId/payment-orders', requireAuth(['patient']), paymentOrderLimiter, postPaymentOrder);

// Patient only. A short-lived, single-use session for the hosted Razorpay Checkout page of the payment the patient already started. It creates no
// order and no payment; same ownership rules and limit as the order endpoint. See checkout-session.service.js.
invoicesRouter.post('/:invoiceId/checkout-sessions', requireAuth(['patient']), paymentOrderLimiter, postCheckoutSession);

// Patient only; the invoice must belong to a Case the patient owns (404 otherwise, the same answer as for a missing invoice).
invoicesRouter.get('/:invoiceId', requireAuth(['patient']), invoiceReadLimiter, getInvoice);

module.exports = { invoicesRouter };
