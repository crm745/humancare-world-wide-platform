// Delivers the Private Charter "bitrix.deal.create" outbox events to Bitrix24 (creates one Deal per Case in
// Category 38). All the rules live in bitrix/deal-worker.service.js; this only schedules it. While either Bitrix
// switch (or the review workflow) is off, every run returns at once without touching the database or Bitrix.
const { runDealWorker } = require('../modules/bitrix/deal-worker.service');

module.exports = {
  name: 'bitrix-deal',
  intervalMs: 30 * 1000,
  runOnStart: false,
  run: () => runDealWorker(),
};
