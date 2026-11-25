// Recovers the patient notifications of admin case stage changes whose notification step failed (see
// modules/cases/case-stage-notification-reconciler.js). Scheduled ONLY by the dedicated push worker (src/push-delivery-worker.js); it is deliberately not in
// jobs/index.js (the main worker's list). Does nothing in a test, scoped, integration or synthetic run.
const { reconcileStageNotifications } = require('../modules/cases/case-stage-notification-reconciler');

module.exports = {
  name: 'case-stage-notification-reconcile',
  intervalMs: 3 * 60 * 1000,
  runOnStart: false,
  run: () => reconcileStageNotifications(),
};
