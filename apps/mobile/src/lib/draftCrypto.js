// Phase 6: the envelope an encrypted draft is stored in. Pure: the AES-256-GCM primitive is INJECTED (lib/draftCryptoDevice.js on the phone, Node's crypto in the tests), so this file
// holds only the format and the rules.
//
// A draft file is JSON: { "v": 1, "d": "<base64 of nonce + ciphertext + auth tag>" }. It names no account, no service and no field. The plaintext (inside the ciphertext) is
// { savedAt, step, values }. The AES-GCM "additional authenticated data" binds the ciphertext to the ACCOUNT, the FORMAT VERSION and the SERVICE: a file copied to another account's
// slot, one whose version was changed, or one presented as another service fails authentication and is never decrypted.
import { DRAFT_VERSION } from './draftSchema';

export const MAX_DRAFT_BYTES = 64 * 1024; // the largest plaintext a draft may have

// UTF-8 without TextEncoder/TextDecoder (not guaranteed on every runtime the tests and the app share).
export function utf8Encode(text) {
  const out = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let c;
    let n;
    if (b < 0x80) { c = b; n = 1; } else if (b >> 5 === 6) { c = b & 31; n = 2; } else if (b >> 4 === 14) { c = b & 15; n = 3; } else if (b >> 3 === 30) { c = b & 7; n = 4; } else throw new Error('bad utf8');
    if (i + n > bytes.length) throw new Error('bad utf8');
    for (let k = 1; k < n; k += 1) { if ((bytes[i + k] & 0xc0) !== 0x80) throw new Error('bad utf8'); c = (c << 6) | (bytes[i + k] & 63); }
    out += String.fromCodePoint(c);
    i += n;
  }
  return out;
}

// The authenticated header for one draft. The account id is whatever lib/tokenIdentity.js names ("patient:7"); the service is the draft's service key.
export const buildAad = (accountId, service, version = DRAFT_VERSION) => utf8Encode(`humancare-draft|v${version}|${accountId}|${service}`);

// plain: { savedAt, step, values }. Returns the text to put in the file, or throws 'too_large'.
export async function sealDraft(cipher, keyB64, accountId, service, plain) {
  const bytes = utf8Encode(JSON.stringify(plain));
  if (bytes.length > MAX_DRAFT_BYTES) throw new Error('too_large');
  const combined = await cipher.encrypt(keyB64, bytes, buildAad(accountId, service));
  return JSON.stringify({ v: DRAFT_VERSION, d: combined });
}

// Returns the plaintext object, or null for anything that is not a valid, authentic draft of THIS account and service (wrong key, tampering, another account, another version).
// The reason is never reported with any content.
export async function openDraft(cipher, keyB64, accountId, service, fileText) {
  let envelope;
  try { envelope = JSON.parse(fileText); } catch { return null; }
  if (!envelope || typeof envelope !== 'object' || envelope.v !== DRAFT_VERSION || typeof envelope.d !== 'string' || envelope.d.length > 200000) return null;
  try {
    const bytes = await cipher.decrypt(keyB64, envelope.d, buildAad(accountId, service, envelope.v));
    if (!bytes || bytes.length > MAX_DRAFT_BYTES) return null;
    const plain = JSON.parse(utf8Decode(bytes));
    return plain && typeof plain === 'object' && !Array.isArray(plain) ? plain : null;
  } catch {
    return null; // authentication failed (or the plaintext was not what a draft is)
  }
}
