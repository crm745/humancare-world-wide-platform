// Confirms and publishes a Private Charter quotation by itself after a clean scan, a 120-second settle period and a check that the Bitrix Deal is in the stage
// "Quoted". All the rules live in quotations/quotation-auto-publish.service.js (which reuses the existing confirm and publish); this only schedules it. While
// QUOTATION_AUTO_PUBLISH is not exactly "true", or any part of its configuration is wrong, every run returns at once without touching the database or Bitrix.
const { sweepQuotationAutoPublish } = require('../modules/quotations/quotation-auto-publish.service');

module.exports = {
  name: 'quotation-auto-publish',
  intervalMs: 60 * 1000,
  runOnStart: false,
  run: () => sweepQuotationAutoPublish(),
};
