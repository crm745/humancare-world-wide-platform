// Admin access tokens. Separate from the Patient/Corporate tokens in auth.service.js:
//  - signed with a key derived (HMAC-SHA256, domain-separated label) from JWT_ACCESS_SECRET, so
//    the raw secret is never an Admin signing key and an Admin token fails the shared
//    requireAuth verification (and vice versa);
//  - its own issuer and audience, checked on verify together with the algorithm and expiry.
// These are dashboard tokens: every one is bound to an AdminSession id (`sid`, a positive
// integer) and is neither signed nor accepted without it. A future token that is not tied to a
// session needs its own audience, key label and verify function, never this one.
// The claims are a convenience, not authority: session middleware must re-read the Admin and
// session from the database before trusting role, status or tokenVersion.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ADMIN_LOCK_POLICY } = require('./admin-lock.config');

const ADMIN_TOKEN_ISSUER = 'humancare-api';
const ADMIN_ACCESS_AUDIENCE = 'humancare-admin-access';
const ADMIN_ACCESS_KEY_LABEL = 'humancare/admin-lock/access-token/v1';
const ADMIN_ROLES = ['admin', 'superadmin'];
const ALGORITHM = 'HS256';
const MISSING_SECRET = 'JWT_ACCESS_SECRET is not set';

// Derives a purpose-specific key from the configured access secret. Exported for the other Admin
// token utilities (login tickets), each of which passes its own label.
function deriveAdminKey(label) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error(MISSING_SECRET);
  return crypto.createHmac('sha256', secret).update(label).digest();
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

// `role` is the Admin's role (admin | superadmin); `sessionId` is the AdminSession id and is
// required. `tokenVersion` is included when provided.
function signAdminAccessToken({ adminId, role, sessionId, tokenVersion } = {}) {
  if (!isPositiveInt(adminId)) throw new Error('adminId must be a positive integer');
  if (!ADMIN_ROLES.includes(role)) throw new Error(`role must be one of: ${ADMIN_ROLES.join(', ')}`);
  if (!isPositiveInt(sessionId)) throw new Error('sessionId must be a positive integer');
  const claims = { role, sid: sessionId };
  if (tokenVersion !== undefined && tokenVersion !== null) {
    if (!Number.isInteger(tokenVersion) || tokenVersion < 0) throw new Error('tokenVersion must be a non-negative integer');
    claims.tv = tokenVersion;
  }
  return jwt.sign(claims, deriveAdminKey(ADMIN_ACCESS_KEY_LABEL), {
    algorithm: ALGORITHM,
    subject: String(adminId),
    issuer: ADMIN_TOKEN_ISSUER,
    audience: ADMIN_ACCESS_AUDIENCE,
    expiresIn: Math.floor(ADMIN_LOCK_POLICY.accessTokenTtlMs / 1000),
  });
}

// { adminId, role, sessionId, tokenVersion } for a valid Admin access token, else null.
function verifyAdminAccessToken(token) {
  if (typeof token !== 'string' || !token) return null;
  let payload;
  try {
    payload = jwt.verify(token, deriveAdminKey(ADMIN_ACCESS_KEY_LABEL), {
      algorithms: [ALGORITHM],
      issuer: ADMIN_TOKEN_ISSUER,
      audience: ADMIN_ACCESS_AUDIENCE,
    });
  } catch (err) {
    // A missing secret is a deployment fault, not a bad token - don't hide it as "invalid".
    if (err.message === MISSING_SECRET) throw err;
    return null;
  }

  const adminId = Number(payload.sub);
  if (!isPositiveInt(adminId) || String(adminId) !== payload.sub) return null;
  if (!ADMIN_ROLES.includes(payload.role)) return null;
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) return null;
  if (!isPositiveInt(payload.sid)) return null;
  if (payload.tv !== undefined && !(Number.isInteger(payload.tv) && payload.tv >= 0)) return null;

  return { adminId, role: payload.role, sessionId: payload.sid, tokenVersion: payload.tv ?? null };
}

module.exports = {
  signAdminAccessToken,
  verifyAdminAccessToken,
  deriveAdminKey,
  ADMIN_TOKEN_ISSUER,
  ADMIN_ACCESS_AUDIENCE,
  ADMIN_ROLES,
};
