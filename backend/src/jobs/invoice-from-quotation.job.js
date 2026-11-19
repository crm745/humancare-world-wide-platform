// Recovery for Phase 4: an accepted quotation whose invoice was not created (the request that accepted it failed after the decision committed, or the
// patient never refreshed) gets its invoice here. Idempotent and safe to repeat: see quotations/quotation-invoice.service.js. No payment, no Bitrix call.
const { sweepAcceptedWithoutInvoice } = require('../modules/quotations/quotation-invoice.service');

module.exports = {
  name: 'invoice-from-quotation',
  intervalMs: 60 * 1000,
  runOnStart: false,
  run: () => sweepAcceptedWithoutInvoice(),
};
