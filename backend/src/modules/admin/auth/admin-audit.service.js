// Audit trail for the Admin Lock System, written to the SecurityEvent table with the actor in
// actor_type / actor_id (see common/audit/audit-log.js for the shared, best-effort writer).
//
// Unlike that writer this one NEVER swallows errors: a critical state change passes its
// transaction client as `db` so the audit row commits or rolls back with the change itself.
// What a failed write means for a denied login is the caller's policy - this module only
// guarantees the failure is visible and that nothing here can turn a denial into a success.
//
// Never put a token, password, credential ID or public key in `detail`. Two guards, both of
// which reject (rather than silently drop) so the mistake is found in development:
//  - key names that suggest secret material are refused, except an explicit allowlist of
//    numeric counters/versions (SAFE_METADATA_KEYS) that merely contain a word like "token";
//  - string values that look like secret material (bearer/JWT strings, SHA-256-style hex
//    digests, long opaque base64/base64url strings, PEM blocks) are refused under any key.
const { prisma } = require('../../../db/prisma');
const {
  ADMIN_AUDIT_ACTOR_TYPES,
  ADMIN_SYSTEM_EVENT_PREFIX,
} = require('../../../common/constants/admin-audit.constants');

const ACTOR_TYPES = Object.freeze([...ADMIN_AUDIT_ACTOR_TYPES, 'system']);
const EVENT_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
const FORBIDDEN_DETAIL_KEY =
  /pass(word|phrase|code)|secret|token|credential|public_?key|private_?key|authorization|cookie|signature|otp|\bpin\b|hash/i;
// Exact key names that are safe because they only ever hold a non-negative whole number.
const SAFE_METADATA_KEYS = new Set([
  'tokenVersion',
  'previousTokenVersion',
  'newTokenVersion',
  'credentialCount',
  'passkeyCount',
  'sessionCount',
]);
const SECRET_VALUE_PATTERNS = [
  /^\s*(bearer|basic)\s+\S+/i, // Authorization header value
  /^eyJ[\w-]+\.[\w-]+(\.[\w-]*)?$/, // JWT
  /^[0-9a-f]{32,}$/i, // hex digest (token hash, key material)
  /^[A-Za-z0-9_\-+/=]{40,}$/, // long opaque base64 / base64url string
  /-----BEGIN [A-Z ]*(KEY|CERTIFICATE)-----/, // PEM
];
const MAX_DETAIL_DEPTH = 5;

function assertSafeDetail(value, path, depth) {
  if (depth > MAX_DETAIL_DEPTH) throw new Error('Admin audit detail is nested too deeply');
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`Admin audit detail "${path}" looks like secret material`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => assertSafeDetail(item, `${path}[${i}]`, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (SAFE_METADATA_KEYS.has(key)) {
        if (!(Number.isInteger(inner) && inner >= 0)) {
          throw new Error(`Admin audit detail "${key}" must be a non-negative whole number`);
        }
      } else if (FORBIDDEN_DETAIL_KEY.test(key)) {
        throw new Error(`Admin audit detail must not contain secret-like field "${key}"`);
      } else {
        assertSafeDetail(inner, `${path}.${key}`, depth + 1);
      }
    }
  }
}

function clip(value, max) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

// `db` is an optional Prisma transaction client; the global client is used otherwise.
// `req` is optional - ipAddress / userAgent in the options win over what it provides.
async function recordAdminAuditEvent({
  actorType,
  actorId = null,
  event,
  identifier = null,
  ipAddress = null,
  userAgent = null,
  detail = null,
  req = null,
  db = prisma,
} = {}) {
  if (!ACTOR_TYPES.includes(actorType)) {
    throw new Error(`Admin audit actorType must be one of: ${ACTOR_TYPES.join(', ')}`);
  }
  if (typeof event !== 'string' || !EVENT_PATTERN.test(event)) {
    throw new Error('Admin audit event must be a lowercase snake_case name of at most 64 characters');
  }
  if (actorId !== null && !(Number.isInteger(actorId) && actorId > 0)) {
    throw new Error('Admin audit actorId must be a positive integer or null');
  }
  if (actorType === 'system') {
    if (actorId !== null) throw new Error('Admin audit events by the system must not have an actorId');
    // The discriminator that gives system events the fixed Admin retention (see the constants).
    if (!event.startsWith(ADMIN_SYSTEM_EVENT_PREFIX)) {
      throw new Error(`Admin audit events by the system must start with "${ADMIN_SYSTEM_EVENT_PREFIX}"`);
    }
  }
  if (detail !== null) {
    if (typeof detail !== 'object' || Array.isArray(detail)) {
      throw new Error('Admin audit detail must be a plain object');
    }
    assertSafeDetail(detail, 'detail', 1);
  }

  return db.securityEvent.create({
    data: {
      event,
      actorType,
      actorId,
      identifier: clip(identifier, 191),
      ipAddress: clip(ipAddress ?? req?.ip, 64),
      userAgent: clip(userAgent ?? (req?.get ? req.get('user-agent') : null), 255),
      detail: detail || undefined,
    },
  });
}

module.exports = { recordAdminAuditEvent, ADMIN_AUDIT_ACTOR_TYPES: ACTOR_TYPES };
