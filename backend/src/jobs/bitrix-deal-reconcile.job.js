// Slow safety net for missed Bitrix24 Deal webhooks: at most 10 linked Deals are re-read every 10 minutes and a
// change is handed to the normal inbound processor. All rules live in bitrix/deal-reconcile.service.js. While either
// Bitrix switch (or the review workflow) is off, every run returns at once.
const { reconcileDeals } = require('../modules/bitrix/deal-reconcile.service');

module.exports = {
  name: 'bitrix-deal-reconcile',
  intervalMs: 10 * 60 * 1000,
  runOnStart: false,
  run: () => reconcileDeals(),
};
