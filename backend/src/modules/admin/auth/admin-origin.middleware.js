// Origin and CSRF protection for the Admin router. The global CORS configuration is unchanged (it
// still reflects any Origin); these guards are what actually refuse cross-origin use.
//
// The one allowed origin is ADMIN_WEBAUTHN_ORIGIN, read through the validated Admin Lock
// configuration - there is no second allowlist.
//
//   adminOriginGuard()               strict - for the new authentication endpoints. The Origin
//                                    header must be present, not "null", and equal the configured
//                                    origin. If the configuration is unusable the request fails
//                                    with a generic 500 (closed), never open.
//   adminOriginGuard({ strict:false }) lenient - for the pre-existing authenticated routes, which
//                                    non-browser clients call with a Bearer token and no Origin. A
//                                    present Origin must still match; a request with no Origin is
//                                    refused only if it is state-changing and relies on a cookie
//                                    rather than a Bearer token. With no usable configuration that
//                                    same cookie-authenticated, state-changing request is refused
//                                    (fail closed); everything else passes as before.
//   requireAdminCsrfHeader           `X-HC-Admin: 1`, a custom header that browsers only send
//                                    cross-origin after a CORS preflight, required on refresh and
//                                    logout.
const { loadAdminLockConfig, assertWebAuthnConfig } = require('./admin-lock.config');
const { ACCESS_COOKIE, REFRESH_COOKIE, readCookie } = require('./admin-auth.cookies');

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_HEADER = 'x-hc-admin';

const forbidden = (res, code) => res.status(403).json({ error: 'Forbidden', code });

// The configured origin, or null if the WebAuthn configuration is missing or invalid.
function configuredOrigin() {
  try {
    return assertWebAuthnConfig(loadAdminLockConfig()).origin;
  } catch {
    return null;
  }
}

function adminOriginGuard({ strict = true } = {}) {
  return function originGuard(req, res, next) {
    const allowed = configuredOrigin();
    const origin = req.get('origin');

    if (strict) {
      if (!allowed) return next(new Error('Admin origin is not configured'));
      if (typeof origin !== 'string' || origin === 'null' || origin !== allowed) return forbidden(res, 'origin_not_allowed');
      return next();
    }

    // The one dangerous combination: a state-changing request that would be authenticated by a
    // cookie (no Bearer token), which a foreign page could trigger.
    const bearer = (req.headers.authorization || '').startsWith('Bearer ');
    const usesCookie = Boolean(readCookie(req, ACCESS_COOKIE) || readCookie(req, REFRESH_COOKIE));
    const cookieStateChange = STATE_CHANGING.has(req.method) && !bearer && usesCookie;

    // No usable expected origin: nothing to compare against, so the combination above is refused
    // (fail closed). Bearer clients, reads and cookie-less requests are unaffected.
    if (!allowed) return cookieStateChange ? forbidden(res, 'origin_not_allowed') : next();
    if (origin !== undefined) return origin === allowed ? next() : forbidden(res, 'origin_not_allowed');
    return cookieStateChange ? forbidden(res, 'origin_not_allowed') : next();
  };
}

function requireAdminCsrfHeader(req, res, next) {
  if (req.get(CSRF_HEADER) !== '1') return forbidden(res, 'csrf_required');
  return next();
}

module.exports = { adminOriginGuard, requireAdminCsrfHeader, configuredOrigin };
