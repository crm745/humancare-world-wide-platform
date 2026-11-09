// Passkey-recovery ticket: short-lived proof that the Admin whose passkey is being recovered just
// redeemed their approved recovery invitation WITH their current password, so they may START
// registering a replacement passkey. It is not a session and grants nothing else.
//
// Deliberately separate from the enrollment ticket (admin-enrollment-ticket.service.js) and the
// login tickets: its own key label, audience and flow, so none of them can be read as a recovery
// ticket, or the reverse, and an access token can never stand in for it.
//
// Bound to
//   - the Admin being recovered (the token subject),
//   - the approved recovery request (rid),
//   - the recovery invitation that was redeemed (inv),
//   - the moment that Admin's password was set (pca), so a password change kills the ticket,
//   - a random id (jti), so the consuming code can make it single-use.
// The ticket holds no secret and is never stored or logged. Reading checks only what the token
// itself proves; whether the request, invitation and Admin are STILL in the right state can only
// be known from the database, which is what recoveryTicketMatches is for - the consuming service
// must re-read those rows (under its transaction's locks) and call it.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ADMIN_LOCK_POLICY } = require('./admin-lock.config');
const { deriveAdminKey, ADMIN_TOKEN_ISSUER } = require('./admin-token.service');

const ADMIN_RECOVERY_TICKET_AUDIENCE = 'humancare-admin-recovery-ticket';
const ADMIN_RECOVERY_TICKET_KEY_LABEL = 'humancare/admin-lock/recovery-ticket/v1';
const ADMIN_RECOVERY_TICKET_TTL_SECONDS = ADMIN_LOCK_POLICY.recoveryTicketTtlMs / 1000; // 600
const ADMIN_RECOVERY_FLOW = 'passkey_recovery';
const RECOVERY_INVITATION_PURPOSE = 'passkey_recovery';
const ALGORITHM = 'HS256';
const MISSING_SECRET = 'JWT_ACCESS_SECRET is not set';

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

// `passwordChangedAt` is the Admin's stored passwordChangedAt (a Date) - required, so a ticket
// cannot be minted without the binding.
function signAdminRecoveryTicket({ adminId, recoveryRequestId, invitationId, passwordChangedAt } = {}) {
  if (!isPositiveInt(adminId)) throw new Error('adminId must be a positive integer');
  if (!isPositiveInt(recoveryRequestId)) throw new Error('recoveryRequestId must be a positive integer');
  if (!isPositiveInt(invitationId)) throw new Error('invitationId must be a positive integer');
  if (!(passwordChangedAt instanceof Date) || Number.isNaN(passwordChangedAt.getTime())) {
    throw new Error('passwordChangedAt must be a valid Date');
  }
  return jwt.sign(
    { flow: ADMIN_RECOVERY_FLOW, rid: recoveryRequestId, inv: invitationId, pca: passwordChangedAt.getTime() },
    deriveAdminKey(ADMIN_RECOVERY_TICKET_KEY_LABEL),
    {
      algorithm: ALGORITHM,
      subject: String(adminId),
      issuer: ADMIN_TOKEN_ISSUER,
      audience: ADMIN_RECOVERY_TICKET_AUDIENCE,
      jwtid: crypto.randomUUID(),
      expiresIn: ADMIN_RECOVERY_TICKET_TTL_SECONDS,
    },
  );
}

// Verifies signature, issuer, audience, algorithm, expiry, flow, the exact 600-second lifetime and
// the shape of every claim. Returns
//   { adminId, recoveryRequestId, invitationId, passwordChangedAt, ticketId, expiresAt } or null.
// A missing signing secret is a server fault and throws; anything wrong with the ticket is null.
function readAdminRecoveryTicket(ticket) {
  if (typeof ticket !== 'string' || !ticket) return null;
  let payload;
  try {
    payload = jwt.verify(ticket, deriveAdminKey(ADMIN_RECOVERY_TICKET_KEY_LABEL), {
      algorithms: [ALGORITHM],
      issuer: ADMIN_TOKEN_ISSUER,
      audience: ADMIN_RECOVERY_TICKET_AUDIENCE,
    });
  } catch (err) {
    if (err.message === MISSING_SECRET) throw err;
    return null;
  }

  const adminId = Number(payload.sub);
  if (!isPositiveInt(adminId) || String(adminId) !== payload.sub) return null;
  if (payload.flow !== ADMIN_RECOVERY_FLOW) return null;
  if (!isPositiveInt(payload.rid)) return null;
  if (!isPositiveInt(payload.inv)) return null;
  if (!isPositiveInt(payload.pca)) return null;
  if (typeof payload.jti !== 'string' || !payload.jti) return null;
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) return null;
  if (payload.exp - payload.iat !== ADMIN_RECOVERY_TICKET_TTL_SECONDS) return null;

  return {
    adminId,
    recoveryRequestId: payload.rid,
    invitationId: payload.inv,
    passwordChangedAt: new Date(payload.pca),
    ticketId: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  };
}

// True only if the ticket was issued for exactly the rows read from the database NOW:
//   - the Admin: same id, still "active", same password state (passwordChangedAt);
//   - the recovery request: same id, for this Admin, still "approved" - a pending, rejected,
//     completed, expired or cancelled request refuses the ticket - and not past its own deadline:
//     a request whose expiresAt is at or before `now` (or has none) refuses it;
//   - the invitation: same id, a "passkey_recovery" invitation of this Admin and this request,
//     redeemed (usedAt) and not revoked.
// `admin`, `request` and `invitation` are the freshly read rows; `now` is the caller's clock
// (default: the current time). Any missing piece is false.
function recoveryTicketMatches(claims, { admin, request, invitation, now = new Date() } = {}) {
  if (!claims || !admin || !request || !invitation) return false;
  if (!(admin.passwordChangedAt instanceof Date)) return false;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  if (!(request.expiresAt instanceof Date) || !(request.expiresAt.getTime() > now.getTime())) return false;
  return claims.adminId === admin.id
    && admin.status === 'active'
    && claims.passwordChangedAt.getTime() === admin.passwordChangedAt.getTime()
    && claims.recoveryRequestId === request.id
    && request.adminId === admin.id
    && request.status === 'approved'
    && claims.invitationId === invitation.id
    && invitation.adminId === admin.id
    && invitation.purpose === RECOVERY_INVITATION_PURPOSE
    && invitation.recoveryRequestId === request.id
    && invitation.usedAt instanceof Date
    && !invitation.revokedAt;
}

module.exports = {
  signAdminRecoveryTicket,
  readAdminRecoveryTicket,
  recoveryTicketMatches,
  ADMIN_RECOVERY_FLOW,
  ADMIN_RECOVERY_TICKET_AUDIENCE,
  ADMIN_RECOVERY_TICKET_TTL_SECONDS,
};
