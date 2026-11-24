// Delivers the Private Charter "bitrix.deal.create" outbox events to Bitrix24 (creates one Deal per Case in
// Category 38). All the rules live in bitrix/deal-worker.service.js; this only schedules it. While either Bitrix
// switch (or the review workflow) is off, every run returns at once without touching the database or Bitrix.
const { runDealWorker } = require('../modules/bitrix/deal-worker.service');
const { QUEUE_POLL_INTERVAL_MS } = require('../modules/bitrix/queue/service-registry');

module.exports = {
  name: 'bitrix-deal',
  intervalMs: QUEUE_POLL_INTERVAL_MS, // the queue is LOOKED AT once a minute; the shared rate limiter decides how fast calls go out
  runOnStart: false,
  run: () => runDealWorker(),
};
