// The Admin session cookies. Tokens travel only in these HttpOnly cookies, never in a JSON body.
//
//   access   hc_admin_token    Path /admin          15 minutes
//   refresh  hc_admin_refresh  Path /admin/refresh  until the session's absolute end
//
// Both are HttpOnly, SameSite=Strict, host-only (no Domain), and Secure in production. Strict
// matches the current localhost development topology (portal and API are same-site); the
// production topology is not established, so nothing here assumes one.
//
// A cookie can only be removed by a Set-Cookie with the same name, Path, Domain and attributes, so
// the clear options below are derived from the same constants as the set options. The legacy
// password-only login set hc_admin_token with Path "/" and SameSite=Lax; that variant is cleared
// separately and exactly as it was set.
const { ACCESS_TOKEN_TTL_SECONDS } = require('./admin-session.service');

const ACCESS_COOKIE = 'hc_admin_token';
const REFRESH_COOKIE = 'hc_admin_refresh';
const ACCESS_PATH = '/admin';
const REFRESH_PATH = '/admin/refresh';

const secure = () => process.env.NODE_ENV === 'production';

const accessOptions = () => ({ httpOnly: true, secure: secure(), sameSite: 'strict', path: ACCESS_PATH });
const refreshOptions = () => ({ httpOnly: true, secure: secure(), sameSite: 'strict', path: REFRESH_PATH });
// Exactly the attributes of the cookie written by the legacy login (admin.controller.js#login).
const legacyOptions = () => ({ httpOnly: true, secure: secure(), sameSite: 'lax', path: '/' });

function setSessionCookies(res, { accessToken, refreshToken, refreshExpiresAt }) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...accessOptions(), maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...refreshOptions(), expires: refreshExpiresAt });
}

function clearLegacyAccessCookie(res) {
  res.clearCookie(ACCESS_COOKIE, legacyOptions());
}

function clearCurrentSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE, accessOptions());
  res.clearCookie(REFRESH_COOKIE, refreshOptions());
}

// The three variants: the two current cookies and the legacy one.
function clearAllSessionCookies(res) {
  clearCurrentSessionCookies(res);
  clearLegacyAccessCookie(res);
}

// One cookie from the raw Cookie header (the app has no cookie-parser). The first occurrence wins.
function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  const match = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return null;
  }
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_PATH,
  REFRESH_PATH,
  setSessionCookies,
  clearAllSessionCookies,
  clearCurrentSessionCookies,
  clearLegacyAccessCookie,
  readCookie,
};
