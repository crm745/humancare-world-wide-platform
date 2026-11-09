// Retention for Admin Lock audit events (admin/operator actors and "admin." system events): a fixed period that SECURITY_LOG_RETENTION_DAYS
// does not affect. The shared purge (modules/auth/security-events.js) skips these rows.
const { prisma } = require('../../../db/prisma');
const {
  ADMIN_AUDIT_RETENTION_DAYS,
  adminAuditEventWhere,
} = require('../../../common/constants/admin-audit.constants');

async function purgeOldAdminAuditEvents(now = Date.now()) {
  const cutoff = new Date(now - ADMIN_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.securityEvent.deleteMany({
    where: { AND: [{ createdAt: { lt: cutoff } }, adminAuditEventWhere()] },
  });
  return count;
}

module.exports = { purgeOldAdminAuditEvents, ADMIN_AUDIT_RETENTION_DAYS };
