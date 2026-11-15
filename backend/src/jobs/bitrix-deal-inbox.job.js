// Applies stored Bitrix24 Deal-stage events (integration_inbox) to Cases. All the rules live in
// bitrix/deal-inbox.service.js; this only schedules it. While either Bitrix switch (or the review workflow) is
// off, every run returns at once without touching the database or Bitrix.
const { runInboxWorker } = require('../modules/bitrix/deal-inbox.service');

module.exports = {
  name: 'bitrix-deal-inbox',
  intervalMs: 30 * 1000,
  runOnStart: false,
  run: () => runInboxWorker(),
};
