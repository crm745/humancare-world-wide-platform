// Passkey-enrollment ticket: short-lived proof that a pending Admin just set their password via a
// valid activation invitation, so they may START a first-passkey registration. It is not a
// session and grants nothing else.
//
// Separate from the login tickets (admin-login-ticket.service.js), which keep their fixed
// 120-second lifetime and flows: this one has its own key label, audience and a 10-minute
// lifetime, and a login ticket can never be read as an enrollment ticket or the reverse.
//
// Bound to the Admin, the (already used) activation invitation, and the moment the password
// was set (`pca`). A later password change therefore kills the ticket. The consuming service
// must also re-read the Admin and confirm status "pending_passkey" and no passkey, then call
// enrollmentTicketMatches. The ticket holds no secret and is never stored or logged.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ADMIN_LOCK_POLICY } = require('./admin-lock.config');
const { deriveAdminKey, ADMIN_TOKEN_ISSUER } = require('./admin-token.service');

const ADMIN_ENROLLMENT_TICKET_AUDIENCE = 'humancare-admin-enrollment-ticket';
const ADMIN_ENROLLMENT_TICKET_KEY_LABEL = 'humancare/admin-lock/enrollment-ticket/v1';
const ADMIN_ENROLLMENT_TICKET_TTL_SECONDS = ADMIN_LOCK_POLICY.enrollmentTicketTtlMs / 1000; // 600
const ADMIN_ENROLLMENT_FLOW = 'passkey_enrollment';
const ALGORITHM = 'HS256';
const MISSING_SECRET = 'JWT_ACCESS_SECRET is not set';

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

// `passwordChangedAt` is the Admin's passwordChangedAt as stored (a Date, set when the
// password was chosen) - required, so a ticket cannot be minted without the binding.
function signAdminEnrollmentTicket({ adminId, invitationId, passwordChangedAt } = {}) {
  if (!isPositiveInt(adminId)) throw new Error('adminId must be a positive integer');
  if (!isPositiveInt(invitationId)) throw new Error('invitationId must be a positive integer');
  if (!(passwordChangedAt instanceof Date) || Number.isNaN(passwordChangedAt.getTime())) {
    throw new Error('passwordChangedAt must be a valid Date');
  }
  return jwt.sign(
    { flow: ADMIN_ENROLLMENT_FLOW, inv: invitationId, pca: passwordChangedAt.getTime() },
    deriveAdminKey(ADMIN_ENROLLMENT_TICKET_KEY_LABEL),
    {
      algorithm: ALGORITHM,
      subject: String(adminId),
      issuer: ADMIN_TOKEN_ISSUER,
      audience: ADMIN_ENROLLMENT_TICKET_AUDIENCE,
      jwtid: crypto.randomUUID(),
      expiresIn: ADMIN_ENROLLMENT_TICKET_TTL_SECONDS,
    },
  );
}

// Verifies signature, issuer, audience, algorithm, expiry, flow, the exact 600-second lifetime and
// the claim shapes. Returns { adminId, invitationId, passwordChangedAt, ticketId, expiresAt } or
// null. It cannot check the binding against the database - see enrollmentTicketMatches.
function readAdminEnrollmentTicket(ticket) {
  if (typeof ticket !== 'string' || !ticket) return null;
  let payload;
  try {
    payload = jwt.verify(ticket, deriveAdminKey(ADMIN_ENROLLMENT_TICKET_KEY_LABEL), {
      algorithms: [ALGORITHM],
      issuer: ADMIN_TOKEN_ISSUER,
      audience: ADMIN_ENROLLMENT_TICKET_AUDIENCE,
    });
  } catch (err) {
    if (err.message === MISSING_SECRET) throw err;
    return null;
  }

  const adminId = Number(payload.sub);
  if (!isPositiveInt(adminId) || String(adminId) !== payload.sub) return null;
  if (payload.flow !== ADMIN_ENROLLMENT_FLOW) return null;
  if (!isPositiveInt(payload.inv)) return null;
  if (!isPositiveInt(payload.pca)) return null;
  if (typeof payload.jti !== 'string' || !payload.jti) return null;
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) return null;
  if (payload.exp - payload.iat !== ADMIN_ENROLLMENT_TICKET_TTL_SECONDS) return null;

  return {
    adminId,
    invitationId: payload.inv,
    passwordChangedAt: new Date(payload.pca),
    ticketId: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  };
}

// True only if the ticket was issued for exactly this Admin, this invitation, and this password
// state. `admin` is the freshly read row ({ id, passwordChangedAt }); a missing
// passwordChangedAt never matches.
function enrollmentTicketMatches(claims, { admin, invitationId } = {}) {
  if (!claims || !admin || !(admin.passwordChangedAt instanceof Date)) return false;
  return claims.adminId === admin.id
    && claims.invitationId === invitationId
    && claims.passwordChangedAt.getTime() === admin.passwordChangedAt.getTime();
}

module.exports = {
  signAdminEnrollmentTicket,
  readAdminEnrollmentTicket,
  enrollmentTicketMatches,
  ADMIN_ENROLLMENT_FLOW,
  ADMIN_ENROLLMENT_TICKET_AUDIENCE,
  ADMIN_ENROLLMENT_TICKET_TTL_SECONDS,
};
