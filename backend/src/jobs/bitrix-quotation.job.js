// Delivers the "bitrix.quotation.sync" outbox events: downloads the Deal's Quotation PDF from Bitrix24 (READ only) and records it as an
// unpublished draft quotation. All the rules live in bitrix/quotation-sync.service.js; this only schedules it. While the quotation
// switch (BITRIX_QUOTATION_SYNC_ENABLED), either Bitrix switch or the review workflow is off, every run returns at once without touching
// the database or Bitrix.
const { runQuotationSync } = require('../modules/bitrix/quotation-sync.service');

module.exports = {
  name: 'bitrix-quotation',
  intervalMs: 30 * 1000,
  runOnStart: false,
  run: () => runQuotationSync(),
};
