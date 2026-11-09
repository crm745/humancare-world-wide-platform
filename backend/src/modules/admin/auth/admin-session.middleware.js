// Express middleware for Admin routes, backed by the database.
//
//  requireAdminSession(...)  - accepts ONLY the new session access tokens. Every request re-reads
//                              the session and the Admin: role and status come from the database,
//                              never from the token.
//  requireAdminAuth(...)     - the transition middleware for the existing Admin router: accepts new
//                              session tokens, and legacy password-only tokens only while passkey
//                              enforcement is off AND the Admin (re-read each request) is active
//                              and has no live passkey. An Admin who has a passkey therefore never
//                              regains password-only access through an old token, and with
//                              enforcement on no legacy token is accepted at all.
//
// Both set req.user in the shape the existing Admin controllers already read:
//   { id, role: 'admin', corporateId: null, adminRole: 'admin' | 'superadmin' }
// (plus sessionId for session tokens). They are not mounted anywhere yet; wiring them into the
// router is a later step. Failures are generic: 401 for anything wrong with the credential.
const jwt = require('jsonwebtoken');
const { prisma } = require('../../../db/prisma');
const { loadAdminLockConfig } = require('./admin-lock.config');
const { verifyAdminAccessToken } = require('./admin-token.service');
const { validateAdminSession } = require('./admin-session.service');

const COOKIE_NAME = 'hc_admin_token';

// Authorization: Bearer first, then the cookie - the same order the shared middleware uses.
function readToken(req) {
  const header = req.headers && req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  const match = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
  } catch {
    return null;
  }
}

const unauthorized = (res, message = 'Invalid token') => res.status(401).json({ error: message });

function userFrom(admin, sessionId = null) {
  return { id: admin.id, role: 'admin', corporateId: null, adminRole: admin.role, ...(sessionId ? { sessionId } : {}) };
}

// Resolves a token to a user, or null. `allowLegacy` additionally accepts a legacy token.
async function authenticate(token, { allowLegacy, now, db }) {
  const claims = verifyAdminAccessToken(token);
  if (claims) {
    const live = await validateAdminSession({ sessionId: claims.sessionId, adminId: claims.adminId, now, db });
    return live ? userFrom(live.admin, live.session.id) : null;
  }
  if (!allowLegacy) return null;

  // Legacy path: only while enforcement is off, and only for an Admin who is (still) allowed to
  // use a password alone.
  if (loadAdminLockConfig().passkeyEnforcement) return null;
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
  } catch {
    return null;
  }
  if (!payload || payload.role !== 'admin') return null;
  const adminId = Number(payload.sub);
  if (!Number.isInteger(adminId) || adminId <= 0) return null;
  const admin = await db.adminUser.findUnique({ where: { id: adminId } });
  if (!admin || admin.status !== 'active') return null;
  if ((await db.adminPasskey.count({ where: { adminId, revokedAt: null } })) > 0) return null;
  return userFrom(admin);
}

function build({ allowLegacy }) {
  // `allowedRoles` matches the shared middleware's argument: the role CLAIM class ('admin'), while
  // admin/superadmin is decided later from req.user.adminRole as before.
  return function adminAuthMiddleware(allowedRoles = ['admin'], options = {}) {
    const { now = () => new Date(), db = prisma } = options;
    return async function handler(req, res, next) {
      try {
        const token = readToken(req);
        if (!token) return unauthorized(res, 'Missing or malformed Authorization header');
        const user = await authenticate(token, { allowLegacy, now: now(), db });
        if (!user) return unauthorized(res);
        if (allowedRoles && !allowedRoles.includes(user.role)) return res.status(403).json({ error: 'Not authorized for this action' });
        req.user = user;
        return next();
      } catch (err) {
        return next(err);
      }
    };
  };
}

const requireAdminSession = build({ allowLegacy: false });
const requireAdminAuth = build({ allowLegacy: true });

module.exports = { requireAdminSession, requireAdminAuth, readToken };
