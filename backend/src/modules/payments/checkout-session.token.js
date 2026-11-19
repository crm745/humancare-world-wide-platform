// Signed, short-lived, purpose-bound tokens for HOSTED Razorpay Checkout. Pure: no database, no network, no logging.
//
// Two kinds, never interchangeable:
//   "s"  SESSION  how the browser opens the hosted page. Created for an authenticated patient, bound to ONE invoice and ONE payment, valid for ten
//                 minutes, and consumed at most once by the page (see checkout-session.service.js: the single use is enforced by the database).
//   "r"  RETURN   how the browser gets back to the app after Razorpay. Razorpay posts to our callback URL without our authentication, so this token
//                 is what that URL carries. It can ONLY produce a redirect to the app; it changes nothing.
// A token is an opaque capability, not a login: it carries no Bearer token, no API secret, no webhook secret and no personal data (only ids and an
// expiry). Its integrity is an HMAC-SHA-256 over the exact encoded payload, compared in constant time.
//
// KEY: derived from the existing JWT access secret with a fixed purpose label, so no new environment variable is needed, a hosted-checkout token can
// never be a JWT (different format and key) and a JWT can never be a hosted-checkout token. If that secret is missing, nothing is signed or accepted.
const crypto = require('crypto');

const SESSION_TTL_SECONDS = 10 * 60;
const RETURN_TTL_SECONDS = 30 * 60;
const KINDS = Object.freeze({ session: 's', return: 'r' });
const PURPOSE = 'humancare:hosted-checkout:v1';
const MAX_TOKEN_LENGTH = 512;
const B64URL = /^[A-Za-z0-9_-]+$/;
const JTI = /^[0-9a-f]{32}$/;

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');
const isId = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 2147483647;

function signingKey(env) {
  const secret = env && env.JWT_ACCESS_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return crypto.createHmac('sha256', secret).update(PURPOSE).digest();
}

const mac = (key, encoded) => crypto.createHmac('sha256', key).update(encoded).digest();

/**
 * Creates a token. `claims` = { userId, invoiceId, paymentId }. Resolves { token, jti, expiresAt: Date } or null when no signing key is configured.
 * `now` is a Date; the lifetime is fixed per kind.
 */
function signToken(kind, { userId, invoiceId, paymentId }, { env = process.env, now = new Date() } = {}) {
  if (kind !== KINDS.session && kind !== KINDS.return) throw new RangeError('unknown token kind');
  if (!isId(userId) || !isId(invoiceId) || !isId(paymentId)) throw new RangeError('ids must be positive whole numbers');
  const key = signingKey(env);
  if (!key) return null;
  const ttl = kind === KINDS.session ? SESSION_TTL_SECONDS : RETURN_TTL_SECONDS;
  const exp = Math.floor(now.getTime() / 1000) + ttl;
  const jti = crypto.randomBytes(16).toString('hex');
  const encoded = b64u(JSON.stringify({ v: 1, k: kind, jti, uid: userId, inv: invoiceId, pay: paymentId, exp }));
  return { token: `${encoded}.${b64u(mac(key, encoded))}`, jti, expiresAt: new Date(exp * 1000) };
}

/**
 * Checks a token. Resolves { ok: true, claims } or { ok: false, code, claims? } with code one of:
 *   unconfigured | malformed | signature | wrong_kind | expired
 * `claims` is returned ONLY when the signature was valid (so an expired token still says which invoice it was for); it is never trusted otherwise.
 * { userId, invoiceId, paymentId, jti, expiresAt }.
 */
function verifyToken(kind, token, { env = process.env, now = new Date() } = {}) {
  const key = signingKey(env);
  if (!key) return { ok: false, code: 'unconfigured' };
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, code: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !B64URL.test(parts[0]) || !B64URL.test(parts[1])) return { ok: false, code: 'malformed' };
  const [encoded, signature] = parts;

  const provided = Buffer.from(signature, 'base64url');
  const expected = mac(key, encoded);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return { ok: false, code: 'signature' };

  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return { ok: false, code: 'malformed' }; }
  if (!payload || typeof payload !== 'object' || payload.v !== 1 || typeof payload.jti !== 'string' || !JTI.test(payload.jti)
    || !isId(payload.uid) || !isId(payload.inv) || !isId(payload.pay) || !Number.isSafeInteger(payload.exp) || typeof payload.k !== 'string') {
    return { ok: false, code: 'malformed' };
  }
  const claims = { userId: payload.uid, invoiceId: payload.inv, paymentId: payload.pay, jti: payload.jti, expiresAt: new Date(payload.exp * 1000) };
  if (payload.k !== kind) return { ok: false, code: 'wrong_kind', claims };
  if (Math.floor(now.getTime() / 1000) >= payload.exp) return { ok: false, code: 'expired', claims };
  return { ok: true, claims };
}

module.exports = { signToken, verifyToken, KINDS, SESSION_TTL_SECONDS, RETURN_TTL_SECONDS, MAX_TOKEN_LENGTH };
