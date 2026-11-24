// Attaches Admin-authorized documents to their Bitrix24 Deals and removes revoked ones. All the rules live in
// bitrix/deal-document-worker.service.js; this only schedules it. While either Bitrix switch (or the review workflow) is off,
// every run returns at once without touching the database or Bitrix.
const { runDealDocumentWorker } = require('../modules/bitrix/deal-document-worker.service');
const { sweep: sweepAutoShare } = require('../modules/bitrix/deal-document-auto-share');

module.exports = {
  name: 'bitrix-deal-document',
  intervalMs: 30 * 1000,
  runOnStart: false,
  // The safety net of the automatic sharing runs first (silent and inert unless DOCUMENT_AUTO_SHARE is on); it never throws.
  run: async () => {
    await sweepAutoShare();
    return runDealDocumentWorker();
  },
};
