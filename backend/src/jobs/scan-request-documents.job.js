// Scans request documents that are due: never scanned, or failed for now and past their retry delay (exponential
// backoff, at most SCAN_RETRY.maxAttempts attempts; see request-review.config.js). A document stays unusable until a scan
// says "clean". Documents whose file is gone or altered, or whose attempts ran out, fail for good and leave the sweep.
// While ClamAV is down nothing is scanned and no attempt is used up (see sweepPendingScans).
const { sweepPendingScans } = require('../modules/request-review/request-review.service');

// The last summary line printed. While nothing changes (for example ClamAV stays down and the same documents keep
// waiting) the same line is not printed again every minute; any scan result or change prints at once.
let lastLine = '';

module.exports = {
  name: 'scan-request-documents',
  intervalMs: 60 * 1000,
  runOnStart: true,
  run: async () => {
    const { checked, scanned, failed, waiting, due, scannerUnavailable } = await sweepPendingScans();
    if (!checked && !scannerUnavailable) {
      lastLine = '';
      return;
    }
    const line = scannerUnavailable && !checked
      ? `[scan] ClamAV is unavailable: ${due} document(s) are due and wait. No retry attempt is used up.`
      : `[scan] ${checked} checked: ${scanned} scanned, ${failed} failed for good, ${waiting} still waiting and will be retried.${scannerUnavailable ? ' ClamAV stopped answering, so the rest of the sweep was skipped.' : ''}`;
    if (scanned || failed || line !== lastLine) console.log(line);
    lastLine = line;
  },
};
