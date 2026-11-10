// Lifecycle of the single-use challenges behind Admin WebAuthn ceremonies (table
// AdminWebAuthnChallenge): issue one, and consume it exactly once. It does not build WebAuthn
// options or verify responses - those callers use the value this returns.
//
// Rules this module enforces:
//  - the challenge is 32 random bytes as canonical base64url, stored exactly as returned;
//  - it is bound to a trusted Admin, an allowlisted purpose and optional invitation / recovery
//    request / session, and lives 120 seconds;
//  - issuing one invalidates the Admin's earlier open challenges of the same purpose (kept as
//    history, marked consumed), atomically with the insert;
//  - consuming claims it with a single conditional UPDATE, so of any number of simultaneous
//    attempts at most one succeeds. Consumption is final: it is never undone, so a failed
//    verification cannot be retried with the same challenge.
// The Admin id, purpose and bindings must come from trusted server-side state (a verified ticket
// or session), never from the browser. Challenge values are never logged or audited.
const crypto = require('crypto');
const { prisma } = require('../../../db/prisma');
const { ADMIN_LOCK_POLICY } = require('./admin-lock.config');

const CHALLENGE_BYTES = 32;

// purpose -> lifetime, the bindings it may carry, and (optionally) the bindings it MUST carry.
//
// recovery_approval / recovery_rejection are the passkey step-up of a two-person-recovery
// approver. The Admin id is the approver; the challenge is tied to the exact recovery request and
// to the approver's current database-backed session, and both bindings are mandatory when it is
// issued and when it is consumed - an unbound step-up challenge cannot exist. Approving and
// rejecting are separate purposes, so a challenge issued for one can never authorise the other.
const PURPOSES = Object.freeze({
  registration: { ttlMs: ADMIN_LOCK_POLICY.registrationChallengeTtlMs, bindings: ['invitationId', 'sessionId'] },
  recovery_registration: { ttlMs: ADMIN_LOCK_POLICY.registrationChallengeTtlMs, bindings: ['recoveryRequestId'] },
  authentication: { ttlMs: ADMIN_LOCK_POLICY.loginChallengeTtlMs, bindings: [] },
  unlock: { ttlMs: ADMIN_LOCK_POLICY.unlockChallengeTtlMs, bindings: ['sessionId'] },
  recovery_approval: {
    ttlMs: ADMIN_LOCK_POLICY.recoveryStepUpChallengeTtlMs,
    bindings: ['recoveryRequestId', 'sessionId'],
    required: ['recoveryRequestId', 'sessionId'],
  },
  recovery_rejection: {
    ttlMs: ADMIN_LOCK_POLICY.recoveryStepUpChallengeTtlMs,
    bindings: ['recoveryRequestId', 'sessionId'],
    required: ['recoveryRequestId', 'sessionId'],
  },
});
const BINDING_FIELDS = ['invitationId', 'recoveryRequestId', 'sessionId'];

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

function assertAdminId(adminId) {
  if (!isPositiveInt(adminId)) throw new TypeError('adminId must be a positive integer');
}

function assertPurpose(purpose) {
  if (typeof purpose !== 'string' || !Object.hasOwn(PURPOSES, purpose)) {
    throw new TypeError(`purpose must be one of: ${Object.keys(PURPOSES).join(', ')}`);
  }
}

function assertNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
}

// A binding is a positive id, or (consume only) null meaning "must be unbound"; undefined means
// "not part of this operation". A binding the purpose does not allow is an error.
function checkBindings(purpose, bindings, { allowNull }) {
  const allowed = PURPOSES[purpose].bindings;
  for (const field of BINDING_FIELDS) {
    const value = bindings[field];
    if (value === undefined) continue;
    if (!allowed.includes(field)) throw new TypeError(`${field} is not allowed for purpose "${purpose}"`);
    if (value === null && allowNull) continue;
    if (!isPositiveInt(value)) throw new TypeError(`${field} must be a positive integer`);
  }
  // A mandatory binding must be a real id: neither missing nor null ("unbound") will do.
  for (const field of PURPOSES[purpose].required || []) {
    if (!isPositiveInt(bindings[field])) throw new TypeError(`${field} is required for purpose "${purpose}"`);
  }
}

function newChallenge() {
  return crypto.randomBytes(CHALLENGE_BYTES);
}

function clipIp(ipAddress) {
  const text = String(ipAddress ?? '').trim();
  return text ? text.slice(0, 64) : null;
}

// Creates a challenge for `adminId` and `purpose`. Returns
//   { challengeId, challenge, challengeBytes, purpose, expiresAt }
// where `challenge` is the base64url string to keep as expectedChallenge. NOTE for the options
// caller: generateRegistrationOptions UTF-8-encodes a string challenge, so pass `challengeBytes`
// (the decoded bytes) to make options.challenge equal `challenge`.
//
// Pass `db` (a transaction client) to make this part of the caller's transaction; otherwise it
// opens its own. Either way invalidation and creation are one atomic unit.
async function issueAdminWebAuthnChallenge({
  adminId, purpose, invitationId, recoveryRequestId, sessionId, ipAddress = null, now = new Date(), db = null,
} = {}) {
  assertAdminId(adminId);
  assertPurpose(purpose);
  assertNow(now);
  const bindings = { invitationId, recoveryRequestId, sessionId };
  checkBindings(purpose, bindings, { allowNull: false });

  const bytes = newChallenge();
  const challenge = bytes.toString('base64url'); // canonical, unpadded
  const expiresAt = new Date(now.getTime() + PURPOSES[purpose].ttlMs);

  const run = async (client) => {
    // Touch the Admin row first: it serialises concurrent issues for the same Admin (so exactly
    // one open challenge can remain) and proves the Admin exists.
    const locked = await client.adminUser.updateMany({ where: { id: adminId }, data: { updatedAt: now } });
    if (locked.count !== 1) throw new Error('Admin not found');

    // Retire earlier open challenges of this purpose. Rows are kept; only consumedAt is set.
    await client.adminWebAuthnChallenge.updateMany({
      where: { adminId, purpose, consumedAt: null },
      data: { consumedAt: now },
    });

    const row = await client.adminWebAuthnChallenge.create({
      data: {
        adminId,
        purpose,
        challenge,
        invitationId: invitationId ?? null,
        recoveryRequestId: recoveryRequestId ?? null,
        sessionId: sessionId ?? null,
        expiresAt,
        ipAddress: clipIp(ipAddress),
      },
    });
    return row.id;
  };

  const challengeId = db ? await run(db) : await prisma.$transaction(run);
  return { challengeId, challenge, challengeBytes: new Uint8Array(bytes), purpose, expiresAt };
}

// Claims the Admin's open challenge for `purpose` and returns it, or null if there is none
// (missing, expired, already consumed, other Admin/purpose, or wrong binding). Supplied
// bindings must match; pass null to require "unbound", leave undefined to not check one.
// `challengeId` (from a verified server-signed ticket, never from the browser) restricts the claim
// to that exact challenge, so a ticket cannot authorize a different challenge issued later.
// Returns { challengeId, adminId, purpose, challenge, invitationId, recoveryRequestId,
// sessionId, expiresAt, consumedAt }. A successful claim is final: call this BEFORE verifying
// the browser's response and never try to restore the challenge if verification fails.
async function consumeAdminWebAuthnChallenge({
  adminId, purpose, challengeId, invitationId, recoveryRequestId, sessionId, now = new Date(), db = prisma,
} = {}) {
  assertAdminId(adminId);
  assertPurpose(purpose);
  assertNow(now);
  if (challengeId !== undefined && !isPositiveInt(challengeId)) throw new TypeError('challengeId must be a positive integer');
  const bindings = { invitationId, recoveryRequestId, sessionId };
  checkBindings(purpose, bindings, { allowNull: true });

  const where = { adminId, purpose, consumedAt: null, expiresAt: { gt: now } };
  if (challengeId !== undefined) where.id = challengeId;
  for (const field of BINDING_FIELDS) if (bindings[field] !== undefined) where[field] = bindings[field];

  const candidate = await db.adminWebAuthnChallenge.findFirst({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!candidate) return null;

  // The read above only chooses a row; this conditional update is what claims it. If another
  // request got there first (or the row expired meanwhile) nothing matches and the count is 0.
  const claimed = await db.adminWebAuthnChallenge.updateMany({
    where: { id: candidate.id, ...where },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) return null;

  return {
    challengeId: candidate.id,
    adminId: candidate.adminId,
    purpose: candidate.purpose,
    challenge: candidate.challenge,
    invitationId: candidate.invitationId ?? null,
    recoveryRequestId: candidate.recoveryRequestId ?? null,
    sessionId: candidate.sessionId ?? null,
    expiresAt: candidate.expiresAt,
    consumedAt: now,
  };
}

module.exports = {
  issueAdminWebAuthnChallenge,
  consumeAdminWebAuthnChallenge,
  ADMIN_WEBAUTHN_PURPOSES: Object.freeze(Object.keys(PURPOSES)),
  CHALLENGE_BYTES,
};
