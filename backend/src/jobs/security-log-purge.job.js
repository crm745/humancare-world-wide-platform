// Deletes security log entries past their retention period — once when the worker starts,
// then daily. The deletion and the retention period live in security-events.js.
const { purgeOldSecurityEvents, retentionDays } = require('../modules/auth/security-events');

module.exports = {
  name: 'security-log-purge',
  intervalMs: 24 * 60 * 60 * 1000,
  runOnStart: true,
  run: async () => {
    const count = await purgeOldSecurityEvents();
    if (count) console.log(`Deleted ${count} security log entries older than ${retentionDays()} days.`);
  },
};
