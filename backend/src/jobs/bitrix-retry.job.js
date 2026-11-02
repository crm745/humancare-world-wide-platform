// Re-sends leads that failed to reach Bitrix24 on submission. All the logic (what counts
// as pending, the retry limit, the backoff, the BITRIX_SYNC_ENABLED switch) stays in
// bitrix-retry.service.js; this only schedules it.
const { retryFailedBitrixSyncs } = require('../modules/bitrix/bitrix-retry.service');

module.exports = {
  name: 'bitrix-retry',
  intervalMs: 5 * 60 * 1000,
  runOnStart: false,
  run: () => retryFailedBitrixSyncs(),
};
