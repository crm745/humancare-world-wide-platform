// Deletes Admin Lock audit events older than their fixed retention period - once when the
// worker starts, then daily. The deletion lives in modules/admin/auth/admin-audit-retention.js.
const { purgeOldAdminAuditEvents, ADMIN_AUDIT_RETENTION_DAYS } = require('../modules/admin/auth/admin-audit-retention');

module.exports = {
  name: 'admin-audit-purge',
  intervalMs: 24 * 60 * 60 * 1000,
  runOnStart: true,
  run: async () => {
    const count = await purgeOldAdminAuditEvents();
    if (count) console.log(`Deleted ${count} Admin audit entries older than ${ADMIN_AUDIT_RETENTION_DAYS} days.`);
  },
};
