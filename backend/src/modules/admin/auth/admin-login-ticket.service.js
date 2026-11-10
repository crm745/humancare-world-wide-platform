// Short-lived proof that an Admin passed an earlier login step, for the next step of the same
// flow. Distinct from the shared signTicket/readTicket (auth.service.js): its own derived key,
// issuer, audience and a fixed 120-second lifetime. A ticket is bound to one Admin and one flow
// and carries a unique id (jti) so the consuming code can make it single-use. This module only
// signs and reads tickets; it does not consume them.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ADMIN_LOCK_POLICY } = require('./admin-lock.config');
const { deriveAdminKey, ADMIN_TOKEN_ISSUER } = require('./admin-token.service');

const ADMIN_LOGIN_TICKET_AUDIENCE = 'humancare-admin-login-ticket';
const ADMIN_LOGIN_TICKET_KEY_LABEL = 'humancare/admin-lock/login-ticket/v1';
const ADMIN_LOGIN_TICKET_TTL_SECONDS = ADMIN_LOCK_POLICY.loginChallengeTtlMs / 1000; // 120
const ALGORITHM = 'HS256';
const MISSING_SECRET = 'JWT_ACCESS_SECRET is not set';

// The flow a ticket unlocks. Add values here, not ad hoc strings at call sites.
const ADMIN_LOGIN_FLOWS = Object.freeze({
  PASSKEY_LOGIN: 'passkey_login', // password accepted; the passkey assertion is next
  PASSKEY_UNLOCK: 'passkey_unlock', // unlock step that proves a passkey
});
const FLOW_VALUES = Object.values(ADMIN_LOGIN_FLOWS);

function signAdminLoginTicket({ adminId, flow } = {}) {
  if (!Number.isInteger(adminId) || adminId <= 0) throw new Error('adminId must be a positive integer');
  if (!FLOW_VALUES.includes(flow)) throw new Error(`flow must be one of: ${FLOW_VALUES.join(', ')}`);
  return jwt.sign({ flow }, deriveAdminKey(ADMIN_LOGIN_TICKET_KEY_LABEL), {
    algorithm: ALGORITHM,
    subject: String(adminId),
    issuer: ADMIN_TOKEN_ISSUER,
    audience: ADMIN_LOGIN_TICKET_AUDIENCE,
    jwtid: crypto.randomUUID(),
    expiresIn: ADMIN_LOGIN_TICKET_TTL_SECONDS,
  });
}

// { adminId, flow, ticketId, expiresAt } if the ticket is valid AND for `expectedFlow`, else
// null. `expectedFlow` is required so a ticket can never be accepted for another purpose.
function readAdminLoginTicket(ticket, expectedFlow) {
  if (!FLOW_VALUES.includes(expectedFlow)) throw new Error('readAdminLoginTicket needs a known expectedFlow');
  if (typeof ticket !== 'string' || !ticket) return null;
  let payload;
  try {
    payload = jwt.verify(ticket, deriveAdminKey(ADMIN_LOGIN_TICKET_KEY_LABEL), {
      algorithms: [ALGORITHM],
      issuer: ADMIN_TOKEN_ISSUER,
      audience: ADMIN_LOGIN_TICKET_AUDIENCE,
    });
  } catch (err) {
    if (err.message === MISSING_SECRET) throw err;
    return null;
  }

  const adminId = Number(payload.sub);
  if (!Number.isInteger(adminId) || adminId <= 0 || String(adminId) !== payload.sub) return null;
  if (payload.flow !== expectedFlow) return null;
  if (typeof payload.jti !== 'string' || !payload.jti) return null;
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) return null;
  if (payload.exp - payload.iat !== ADMIN_LOGIN_TICKET_TTL_SECONDS) return null;

  return { adminId, flow: payload.flow, ticketId: payload.jti, expiresAt: new Date(payload.exp * 1000) };
}

// The ticket for the passkey step of login. A plain login ticket proves only "this Admin passed an
// earlier step"; this one is additionally bound to
//   pca  - the Admin's persisted passwordChangedAt (a password change kills it), and
//   chal - the exact authentication challenge issued with it, so it can never authorize a
//          different challenge issued later for the same Admin.
// Same key, issuer, audience, flow and exact 120-second lifetime as every login ticket.
// readAdminLoginTicket(ticket, 'passkey_login') still reads it (it ignores the extra claims), but
// code that completes a login must use readAdminPasskeyLoginTicket, which REQUIRES the bindings
// and so rejects any unbound passkey_login ticket.
function signAdminPasskeyLoginTicket({ adminId, passwordChangedAt, challengeId } = {}) {
  if (!Number.isInteger(adminId) || adminId <= 0) throw new Error('adminId must be a positive integer');
  if (!(passwordChangedAt instanceof Date) || Number.isNaN(passwordChangedAt.getTime())) {
    throw new Error('passwordChangedAt must be a valid Date');
  }
  if (!Number.isInteger(challengeId) || challengeId <= 0) throw new Error('challengeId must be a positive integer');
  return jwt.sign(
    { flow: ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN, pca: passwordChangedAt.getTime(), chal: challengeId },
    deriveAdminKey(ADMIN_LOGIN_TICKET_KEY_LABEL),
    {
      algorithm: ALGORITHM,
      subject: String(adminId),
      issuer: ADMIN_TOKEN_ISSUER,
      audience: ADMIN_LOGIN_TICKET_AUDIENCE,
      jwtid: crypto.randomUUID(),
      expiresIn: ADMIN_LOGIN_TICKET_TTL_SECONDS,
    },
  );
}

// { adminId, passwordChangedAt, challengeId, ticketId, expiresAt } or null.
function readAdminPasskeyLoginTicket(ticket) {
  const base = readAdminLoginTicket(ticket, ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN);
  if (!base) return null;
  const payload = jwt.decode(ticket); // already verified by readAdminLoginTicket above
  if (!Number.isInteger(payload.pca) || payload.pca <= 0) return null;
  if (!Number.isInteger(payload.chal) || payload.chal <= 0) return null;
  return {
    adminId: base.adminId,
    passwordChangedAt: new Date(payload.pca),
    challengeId: payload.chal,
    ticketId: base.ticketId,
    expiresAt: base.expiresAt,
  };
}

module.exports = {
  signAdminLoginTicket,
  readAdminLoginTicket,
  signAdminPasskeyLoginTicket,
  readAdminPasskeyLoginTicket,
  ADMIN_LOGIN_FLOWS,
  ADMIN_LOGIN_TICKET_AUDIENCE,
  ADMIN_LOGIN_TICKET_TTL_SECONDS,
};
