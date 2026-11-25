// Which browser origins may call this API with credentials. Pure (reads only the environment it is given), so it can be unit-tested.
//
// A request with NO Origin header (the native mobile app, server-to-server calls, curl) is not a browser cross-origin request: CORS does not apply to it and it is allowed as before.
// A browser request is allowed only when its Origin is on the list:
//   CORS_ALLOWED_ORIGINS   comma-separated origins, e.g. "https://admin.example.com,https://corporate.example.com"   (scheme + host [+ port], no path, no "*")
//   ADMIN_WEBAUTHN_ORIGIN, ADMIN_PORTAL_URL, CORPORATE_PORTAL_URL   the portals' own addresses (their origin is taken), so a portal that is configured is also allowed
// Outside production (NODE_ENV !== 'production') the local development origins are allowed too: localhost / 127.0.0.1 / ::1 and private LAN addresses on any port (Expo web, Vite, a phone on the same Wi-Fi).
// An origin that is not allowed simply gets no CORS headers (the browser blocks the call); the request is not otherwise rejected here.
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

// "https://Admin.Example.com:443/path" -> "https://admin.example.com"; null for anything that is not an http(s) origin.
function normalizeOrigin(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text === '*' || text === 'null') return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// The set of explicitly allowed origins from an environment. A malformed entry is a configuration mistake: it is returned in `invalid` (the caller reports it) and never allowed.
function allowedOriginsFrom(env = process.env) {
  const allowed = new Set();
  const invalid = [];
  const list = String(env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of list) {
    const origin = normalizeOrigin(entry);
    if (origin) allowed.add(origin); else invalid.push(entry);
  }
  for (const key of ['ADMIN_WEBAUTHN_ORIGIN', 'ADMIN_PORTAL_URL', 'CORPORATE_PORTAL_URL']) {
    const origin = normalizeOrigin(env[key]);
    if (origin) allowed.add(origin);
  }
  return { allowed, invalid };
}

const isProduction = (env) => String(env.NODE_ENV || '').toLowerCase() === 'production';

function isLocalDevelopmentOrigin(origin) {
  try {
    return PRIVATE_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// Whether a browser Origin is allowed. `undefined` / '' (no Origin header) is always allowed.
function isOriginAllowed(origin, { allowed, production }) {
  if (origin === undefined || origin === null || origin === '') return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (allowed.has(normalized)) return true;
  return !production && isLocalDevelopmentOrigin(normalized);
}

// The options for the `cors` package. Credentials are only ever sent to an allowed origin.
function createCorsOptions(env = process.env) {
  const { allowed, invalid } = allowedOriginsFrom(env);
  const production = isProduction(env);
  if (invalid.length) console.warn(`CORS_ALLOWED_ORIGINS has ${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} that are not an http(s) origin and were ignored.`);
  if (production && allowed.size === 0) console.warn('CORS: no portal origin is configured (CORS_ALLOWED_ORIGINS, ADMIN_WEBAUTHN_ORIGIN ...): browsers on other origins are blocked; the mobile app is not affected.');
  return {
    credentials: true,
    origin(origin, callback) {
      callback(null, isOriginAllowed(origin, { allowed, production }));
    },
  };
}

module.exports = { normalizeOrigin, allowedOriginsFrom, isOriginAllowed, isLocalDevelopmentOrigin, createCorsOptions };
