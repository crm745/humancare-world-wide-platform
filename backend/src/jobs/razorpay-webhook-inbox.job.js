// Applies stored Razorpay webhook events (integration_inbox, source "razorpay") to Payments, every 10 seconds. All the rules live in
// payments/razorpay-webhook.processor.js; this only schedules it. While PAYMENTS_ENABLED is not exactly "true", or PAYMENTS_ENVIRONMENT_ID /
// RAZORPAY_WEBHOOK_SECRET are missing or invalid, every run returns at once without touching the database; the events wait in the inbox.
// It never calls Razorpay. It is separate from, and shares nothing with, the Bitrix24 inbox job.
const { runRazorpayWebhookWorker } = require('../modules/payments/razorpay-webhook.worker');

module.exports = {
  name: 'razorpay-webhook-inbox',
  intervalMs: 10 * 1000,
  runOnStart: false,
  run: () => runRazorpayWebhookWorker(),
};
