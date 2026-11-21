// Who an access token belongs to, read from its claims, so a stored record can be tied to an account (lib/submissionKey.js). Pure (no React, no native modules).
//
// THIS IS NOT AUTHENTICATION. Nothing is verified here (the signature is not checked, the expiry is not looked at) and nothing is granted by it: the server alone decides whether a
// token is valid. The claims are only read to decide whose local record something is, which is why an EXPIRED token still identifies its owner (the app's access tokens last
// 15 minutes, so an expired one is the normal thing to find while a session is being renewed or a person logs in again).
//
// The result is "<role>:<sub>", e.g. "patient:7": the role is part of it so a patient and a corporate user with the same number are never the same account.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = (() => { const table = {}; for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET[i]] = i; return table; })();

// base64url -> text, without atob/Buffer (neither is guaranteed on every runtime). Returns null for anything that is not valid base64url.
function decodeBase64Url(input) {
  if (typeof input !== 'string' || input.length === 0 || /[^A-Za-z0-9_-]/.test(input)) return null;
  const text = input.replace(/-/g, '+').replace(/_/g, '/');
  if (text.length % 4 === 1) return null;
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of text) {
    value = (value << 6) | LOOKUP[ch];
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 0xff); }
  }
  try { return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join('')); } catch { return null; }
}

export function userIdFromToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const json = decodeBase64Url(parts[1]);
  if (!json) return null;
  let claims;
  try { claims = JSON.parse(json); } catch { return null; }
  if (!claims || typeof claims !== 'object') return null;
  const sub = claims.sub;
  if (!(typeof sub === 'string' || typeof sub === 'number') || String(sub).trim() === '') return null;
  const role = typeof claims.role === 'string' && claims.role ? claims.role : 'patient';
  return `${role}:${String(sub)}`;
}
