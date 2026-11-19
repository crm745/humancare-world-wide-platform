// Scans stored quotation PDFs with ClamAV (retries with backoff; a final failure or an infection is alerted and audited). All the rules
// live in bitrix/quotation-scan.service.js. Idle while the quotation switch or either Bitrix switch is off. A quotation can only ever
// be confirmed or published after a successful clean scan (the database enforces it).
const { sweepPendingQuotationScans } = require('../modules/bitrix/quotation-scan.service');

module.exports = {
  name: 'scan-case-quotations',
  intervalMs: 60 * 1000,
  runOnStart: false,
  run: () => sweepPendingQuotationScans(),
};
