// Razorpay order housekeeping, every minute: (1) a pending payment older than a minute that never got an order id is recovered by its
// receipt, (2) an order nobody has touched for 30 minutes is closed locally, but only after Razorpay confirms it was never attempted
// or paid. All rules live in payments/payment-orders.service.js. While PAYMENTS_ENABLED is not exactly "true" (or the Razorpay
// credentials are unusable) every run returns at once and calls nothing.
const { runPaymentOrderMaintenance } = require('../modules/payments/payment-orders.service');

module.exports = {
  name: 'payment-order-recovery',
  intervalMs: 60 * 1000,
  runOnStart: false,
  run: () => runPaymentOrderMaintenance(),
};
