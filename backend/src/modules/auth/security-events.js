// Audit trail of patient account security events (the SecurityEvent table).
//
// Never pass a password or an OTP here — only who (userId), what (event), the masked
// identifier that was typed, and where from (IP, user agent). Writing the log must
// never break the login it describes, so failures are reported and swallowed.
const { prisma } = require('../../db/prisma');
const { maskContact } = require('../../common/utils/phone');
const { sharedAuditEventWhere } = require('../../common/constants/admin-audit.constants');

const EVENTS = {
  REGISTER_STARTED: 'register_started',
  REGISTER_COMPLETED: 'register_completed',
  EMAIL_VERIFIED: 'email_verified', // first code sent to the email was used (email login)
  LOGIN_SUCCEEDED: 'login_succeeded',
  LOGIN_FAILED: 'login_failed', // wrong password, or no such account
  ACCOUNT_LOCKED: 'account_locked', // 5th wrong password
  LOGIN_BLOCKED_LOCKED: 'login_blocked_locked', // attempt while locked
  OTP_FAILED: 'otp_failed', // wrong/expired/locked code at any step
  PASSWORD_RESET_REQUESTED: 'password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'password_reset_completed',
  PASSWORD_SET: 'password_set', // first password for an account that had none
  CONTACT_CHANGE_FAILED: 'contact_change_failed', // wrong current password
  MOBILE_CHANGED: 'mobile_changed',
  EMAIL_CHANGED: 'email_changed',
  SOCIAL_LOGIN_SUCCEEDED: 'social_login_succeeded',
  SOCIAL_LOGIN_REFUSED: 'social_login_refused',
};

async function recordSecurityEvent(req, event, { userId = null, identifier = null, detail = null } = {}) {
  try {
    await prisma.securityEvent.create({
      data: {
        event,
        userId,
        identifier: identifier ? maskContact(String(identifier)) || null : null,
        ipAddress: req.ip || null,
        userAgent: String(req.get('user-agent') || '').slice(0, 255) || null,
        detail: detail || undefined,
      },
    });
  } catch (err) {
    console.error(`Could not record security event "${event}":`, err.message);
  }
}

// The log holds personal data (IP addresses), so it isn't kept forever. Entries older
// than SECURITY_LOG_RETENTION_DAYS (default 365) are deleted by a daily job in
// server.js. Don't set it below 180: CERT-In's 2022 directions ask for logs to be kept
// at least that long. Confirm the exact period with legal.
// Admin Lock audit events are NOT purged here: they have their own fixed retention
// (modules/admin/auth/admin-audit-retention.js) that this setting cannot change.
const DEFAULT_RETENTION_DAYS = 365;

function retentionDays() {
  const days = Number(process.env.SECURITY_LOG_RETENTION_DAYS);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
}

async function purgeOldSecurityEvents() {
  const cutoff = new Date(Date.now() - retentionDays() * 24 * 60 * 60 * 1000);
  // Everything except Admin Lock events (admin/operator actors and "admin." system events).
  const { count } = await prisma.securityEvent.deleteMany({
    where: { AND: [{ createdAt: { lt: cutoff } }, sharedAuditEventWhere()] },
  });
  return count;
}

module.exports = { EVENTS, recordSecurityEvent, purgeOldSecurityEvents, retentionDays };
