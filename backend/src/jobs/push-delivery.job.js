// Scheduled ONLY by the dedicated push worker (src/push-delivery-worker.js); it is deliberately not in jobs/index.js (the main worker's list).
// Delivers the patients' push notifications that are waiting in notification_deliveries (the claim, the re-checks, the Expo ticket and receipt
// handling and the retries all live in notifications/push-delivery.service.js; this only schedules it). While PUSH_DELIVERY_ENABLED is not exactly
// "true", or the Expo access token is missing or invalid, or this is a test or synthetic run, every run returns at once without touching the
// database or Expo.
const { runPushDelivery } = require('../modules/notifications/push-delivery.service');

module.exports = {
  name: 'push-delivery',
  intervalMs: 15 * 1000,
  runOnStart: false,
  run: () => runPushDelivery(),
};
