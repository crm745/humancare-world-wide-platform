// Pure helpers for Admin passkey registration: fixed WebAuthn settings and the validation /
// encoding of the values that are stored. No database, no options generation and no ceremony
// verification here - those are separate, later pieces that use these.
const crypto = require('crypto');
const { isoBase64URL, COSEALG } = require('@simplewebauthn/server/helpers');
const { ADMIN_LOCK_POLICY } = require('./admin-lock.config');
const { deriveAdminKey } = require('./admin-token.service');

const ADMIN_WEBAUTHN_USER_HANDLE_KEY_LABEL = 'humancare/admin-lock/webauthn-user-handle/v1';
const USER_HANDLE_BYTES = 32; // 1..64 allowed by WebAuthn; never contains personal data

// ES256 and RS256 only. Pass the same list to option generation and to verification, so a
// change in the library's defaults (it may add post-quantum algorithms) cannot alter behavior.
const ADMIN_WEBAUTHN_ALGORITHMS = Object.freeze([COSEALG.ES256, COSEALG.RS256]); // [-7, -257]

const ADMIN_REGISTRATION_SETTINGS = Object.freeze({
  attestationType: 'none',
  authenticatorSelection: Object.freeze({ residentKey: 'preferred', userVerification: 'required' }),
  requireUserPresence: true,
  requireUserVerification: true,
  supportedAlgorithmIDs: ADMIN_WEBAUTHN_ALGORITHMS,
  timeoutMs: ADMIN_LOCK_POLICY.registrationChallengeTtlMs, // the browser prompt lasts as long as the challenge
  expectedType: 'webauthn.create',
});

// A fresh authenticatorSelection object for each ceremony. The library adds fields to the object
// it is given (and throws on a frozen one), so pass this copy rather than the constant above.
function registrationAuthenticatorSelection() {
  return { ...ADMIN_REGISTRATION_SETTINGS.authenticatorSelection };
}

// Stable, opaque per-Admin user handle (WebAuthn `user.id`), as the Uint8Array the installed
// library requires. Derived, not stored: HMAC-SHA256 under a key with its own domain-separation
// label, so it reveals neither the Admin id nor anything usable elsewhere.
function deriveAdminWebAuthnUserHandle(adminId) {
  if (!Number.isInteger(adminId) || adminId <= 0) throw new Error('adminId must be a positive integer');
  const mac = crypto
    .createHmac('sha256', deriveAdminKey(ADMIN_WEBAUTHN_USER_HANDLE_KEY_LABEL))
    .update(`admin:${adminId}`)
    .digest();
  return new Uint8Array(mac); // a plain Uint8Array copy, not a Buffer
}

const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CREDENTIAL_ID_MIN_BYTES = 16; // WebAuthn: at least 16 bytes
const CREDENTIAL_ID_MAX_BYTES = 1023; // WebAuthn: at most 1023 bytes

// Raw credential-ID bytes from the base64url string a browser sends. Rejects anything that is not
// canonical base64url (so one id has exactly one text form) or has an out-of-range length.
function decodeCredentialId(credentialId) {
  if (typeof credentialId !== 'string' || !CREDENTIAL_ID_PATTERN.test(credentialId)) {
    throw new TypeError('Credential ID must be a base64url string');
  }
  if (credentialId.length > Math.ceil((CREDENTIAL_ID_MAX_BYTES * 4) / 3)) {
    throw new TypeError('Credential ID is too long');
  }
  const bytes = isoBase64URL.toBuffer(credentialId);
  if (bytes.length < CREDENTIAL_ID_MIN_BYTES || bytes.length > CREDENTIAL_ID_MAX_BYTES) {
    throw new TypeError('Credential ID has an invalid length');
  }
  if (isoBase64URL.fromBuffer(bytes) !== credentialId) {
    throw new TypeError('Credential ID is not canonical base64url');
  }
  return Buffer.from(bytes);
}

// SHA-256 (lowercase hex, 64 chars) of the DECODED credential-ID bytes - the AdminPasskey lookup
// key. Hashing the decoded bytes (not the text) means every encoding of one id gives one hash.
// Accepts the base64url string or the raw bytes.
function hashCredentialId(credentialId) {
  const bytes = typeof credentialId === 'string' ? decodeCredentialId(credentialId) : credentialId;
  if (!(bytes instanceof Uint8Array) || bytes.length < CREDENTIAL_ID_MIN_BYTES || bytes.length > CREDENTIAL_ID_MAX_BYTES) {
    throw new TypeError('Credential ID must be a base64url string or 16-1023 bytes');
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const ALLOWED_TRANSPORTS = Object.freeze(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);
const MAX_TRANSPORTS = ALLOWED_TRANSPORTS.length;

// Transports from the browser, reduced to the known values (deduplicated, in the order given).
// Unknown strings are dropped, since browsers add new transport names over time; the wrong
// shape (not an array, non-string entries) is an error.
function normalizeTransports(transports) {
  if (transports === undefined || transports === null) return [];
  if (!Array.isArray(transports) || transports.length > 32) throw new TypeError('Transports must be a short array');
  const result = [];
  for (const transport of transports) {
    if (typeof transport !== 'string') throw new TypeError('Each transport must be a string');
    if (ALLOWED_TRANSPORTS.includes(transport) && !result.includes(transport)) result.push(transport);
  }
  return result.slice(0, MAX_TRANSPORTS);
}

const DEFAULT_PASSKEY_LABEL = 'Passkey';
const MAX_LABEL_LENGTH = 100;

// A display name for the passkey: control characters removed, whitespace collapsed, trimmed,
// cut to 100 characters; blank or missing becomes the default.
function normalizePasskeyLabel(label) {
  if (label === undefined || label === null) return DEFAULT_PASSKEY_LABEL;
  if (typeof label !== 'string') throw new TypeError('Label must be a string');
  const cleaned = label.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return DEFAULT_PASSKEY_LABEL;
  return [...cleaned].slice(0, MAX_LABEL_LENGTH).join('').trim() || DEFAULT_PASSKEY_LABEL;
}

module.exports = {
  ADMIN_WEBAUTHN_ALGORITHMS,
  ADMIN_REGISTRATION_SETTINGS,
  ADMIN_WEBAUTHN_USER_HANDLE_KEY_LABEL,
  USER_HANDLE_BYTES,
  ALLOWED_TRANSPORTS,
  DEFAULT_PASSKEY_LABEL,
  MAX_LABEL_LENGTH,
  registrationAuthenticatorSelection,
  deriveAdminWebAuthnUserHandle,
  decodeCredentialId,
  hashCredentialId,
  normalizeTransports,
  normalizePasskeyLabel,
};
