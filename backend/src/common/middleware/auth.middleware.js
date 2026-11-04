const jwt = require('jsonwebtoken');
const { PASSWORD_CHANGE_REQUIRED } = require('../constants/auth.constants');

// No cookie-parser dependency for the sake of one cookie — this reads it straight
// off the raw Cookie header. Only the admin portal sets this cookie (see
// admin.controller.js#login); every other client still authenticates via the
// Authorization header, which is checked first and wins if both are present.
function getCookieToken(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

// `options.allowPasswordChangePending` lets a route be used while the token is restricted
// by the `pwc` claim (corporate first-login password change). Every other route refuses
// such a token, so a restricted session can do nothing but change its password — new
// routes included, with no per-route work. Patient and admin tokens never carry `pwc`.
function requireAuth(allowedRoles, options = {}) {
  return function (req, res, next) {
    const header = req.headers.authorization;
    const token = header && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : getCookieToken(req, 'hc_admin_token');
    if (!token) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) throw new Error('JWT_ACCESS_SECRET is not set');

    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (err) {
      const message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
      return res.status(401).json({ error: message });
    }

    // Admin sessions are authenticated by requireAdminSession / requireAdminAuth, never here. A
    // legacy password-only Admin token (role 'admin', signed with the shared secret) is refused
    // even when no role list is given, so routes open to any role (/auth/me, /notifications)
    // cannot be reached with one.
    if (payload.role === 'admin') {
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (allowedRoles && !allowedRoles.includes(payload.role)) {
      return res.status(403).json({ error: 'Not authorized for this action' });
    }

    if (payload.pwc === true && !options.allowPasswordChangePending) {
      return res.status(403).json(PASSWORD_CHANGE_REQUIRED);
    }

    req.user = { id: payload.sub, role: payload.role, corporateId: payload.corporateId ?? null, adminRole: payload.adminRole ?? null };
    next();
  };
}

// Chain after requireAuth(['admin']): admin-account management and sensitive settings
// (the services catalog today) are superadmin-only — a regular admin's day-to-day
// access (cases, patients, corporates, tickets) is untouched by this.
function requireSuperAdmin(req, res, next) {
  if (req.user?.adminRole !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  next();
}

module.exports = { requireAuth, requireSuperAdmin };
