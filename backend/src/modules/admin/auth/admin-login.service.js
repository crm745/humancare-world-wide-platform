// Admin sign-in with password AND passkey, in two steps:
//   1. beginAdminPasskeyLogin    - password; returns a 120-second login ticket + WebAuthn options;
//   2. completeAdminPasskeyLogin - the passkey assertion; returns the session and its tokens.
// No step issues anything until BOTH factors have succeeded, and an Admin who has a passkey can
// never sign in with the password alone. Every refusal is one generic error that says nothing
// about the account, its state, a lock, or whether it has a passkey. Unexpected database or audit
// failures are not turned into refusals: they propagate (fail closed) for the caller to treat as a
// server error.
//
// Failed-attempt policy: each login attempt is RESERVED, under the Admin row lock, before the
// password is looked at. A reservation raises failedLoginCount; the counter goes back to zero only
// after a full login (both factors). When a reservation finds the counter already at the
// threshold, the account is locked for 15 minutes and the attempt is refused. Because reservation
// precedes the check, parallel guesses cannot exceed the threshold.
//
// The lock starts at the fifth FAILURE, not at the sixth request:
//   - the fifth reservation raises the counter to 5 and leaves the account unlocked, so a correct
//     fifth password can still finish its passkey step (the ticket and challenge last 120 s);
//   - a wrong fifth password, or a failed assertion (after its challenge was consumed) while the
//     counter is at the threshold, locks immediately, at that moment, for exactly 15 minutes;
//   - any password attempt that finds the counter at the threshold with no lock - an unfinished
//     fifth attempt, or one that raced it - locks the account and is refused, so an unfinished
//     fifth attempt is never an open-ended window and the sixth guess is never evaluated.
// A lock is written in its own committed transaction BEFORE it is audited; if the audit write then
// fails the error propagates (fail closed) but the lock stands. Locks are never extended.
// Expired, replayed or otherwise unusable tickets and challenges are refused before any counter
// is touched.
//
// `db` is a root Prisma client (it needs $transaction).
const { generateAuthenticationOptions } = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const { prisma } = require('../../../db/prisma');
const { maskEmail } = require('../../../common/utils/phone');
const { comparePassword, DUMMY_PASSWORD_HASH } = require('../../auth/auth.service');
const { ADMIN_LOCK_POLICY, loadAdminLockConfig, assertWebAuthnConfig } = require('./admin-lock.config');
const { issueAdminWebAuthnChallenge, consumeAdminWebAuthnChallenge } = require('./admin-webauthn-challenge.service');
const { signAdminPasskeyLoginTicket, readAdminPasskeyLoginTicket } = require('./admin-login-ticket.service');
const { signAdminAccessToken } = require('./admin-token.service');
const { createAdminSession, ACCESS_TOKEN_TTL_SECONDS } = require('./admin-session.service');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const { normalizeAdminEmail } = require('./admin-provisioning.service');
const { normalizeTransports } = require('./admin-webauthn.helpers');
const {
  verifyAdminPasskeyAssertion,
  advanceAdminPasskeyCounter,
  sanitizeAdminAssertionResponse,
  PasskeyAssertionError,
} = require('./admin-passkey-assertion.service');

// The one refusal for every failed sign-in step.
class AdminLoginError extends Error {
  constructor(reason = 'refused') {
    super('Invalid credentials');
    this.name = 'AdminLoginError';
    this.code = 'invalid_credentials';
    Object.defineProperty(this, 'reason', { value: reason, enumerable: false }); // internal, for the audit trail
  }
}

function assertRoot(db) {
  if (!db || typeof db.$transaction !== 'function') throw new TypeError('db must be a root Prisma client');
}

// Best-effort trail of a refused attempt: ids and a reason code only. Nothing is enforced from
// these rows (the counters on the Admin are), so failing to write one cannot change the outcome.
async function auditRefusal(db, adminId, event, reason, ipAddress) {
  if (!adminId) return;
  try {
    await recordAdminAuditEvent({ actorType: 'admin', actorId: adminId, event, ipAddress, detail: { reason }, db });
  } catch (err) {
    console.error(`Could not record a refused Admin sign-in (${err.code || err.name}).`);
  }
}

const NOT_RESERVED = Object.freeze({ reserved: false, attempt: 0, locked: null });

// Starts the lockout on a row the caller holds (inside its transaction), unless the account is
// already locked - an existing lock is never extended. An expired lock means the stored count is
// stale (a reservation resets it), so nothing is locked on it. Returns { adminId, email,
// lockedUntil } if this call locked the account, else null.
async function lockIfExhausted(tx, admin, now) {
  if (admin.lockedUntil) return null; // already locked, or an expired lock whose count is stale
  if ((admin.failedLoginCount || 0) < ADMIN_LOCK_POLICY.failedLoginThreshold) return null;
  const lockedUntil = new Date(now.getTime() + ADMIN_LOCK_POLICY.accountLockoutMs);
  await tx.adminUser.updateMany({ where: { id: admin.id }, data: { lockedUntil } });
  return { adminId: admin.id, email: admin.email, lockedUntil };
}

// Audits a lock that has already been committed. Not swallowed: an audit failure surfaces as a
// server error, but the lock it describes is already in force.
async function auditAccountLocked(db, { adminId, email, lockedUntil }, reason) {
  await recordAdminAuditEvent({
    actorType: 'system',
    event: 'admin.account_locked',
    identifier: maskEmail(email),
    detail: { adminId, lockedUntil: lockedUntil.toISOString(), reason },
    db,
  });
}

// Locks the Admin now if the failure just seen was the one that exhausted the attempts.
async function lockAfterFailure(db, adminId, now, reason) {
  const locked = await db.$transaction(async (tx) => {
    const held = await tx.adminUser.updateMany({ where: { id: adminId, status: 'active' }, data: { updatedAt: now } });
    if (held.count !== 1) return null;
    const admin = await tx.adminUser.findUnique({ where: { id: adminId } });
    return admin ? lockIfExhausted(tx, admin, now) : null;
  });
  if (locked) await auditAccountLocked(db, locked, reason);
}

// Reserves one sign-in attempt for an active Admin, atomically. `reserved` is true if the attempt
// may go on (and has been counted; `attempt` is its number), false if the account is locked or no
// longer active. A request that finds the counter already at the threshold with no lock in force
// starts the lock (reported in `locked`, to be audited by the caller) and is refused.
async function reserveLoginAttempt(db, adminId, now) {
  const outcome = await db.$transaction(async (tx) => {
    const held = await tx.adminUser.updateMany({ where: { id: adminId, status: 'active' }, data: { updatedAt: now } });
    if (held.count !== 1) return NOT_RESERVED;
    const admin = await tx.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) return NOT_RESERVED;

    if (admin.lockedUntil && admin.lockedUntil > now) return NOT_RESERVED; // locked
    const count = admin.lockedUntil ? 0 : (admin.failedLoginCount || 0); // a spent lock: count afresh

    if (count >= ADMIN_LOCK_POLICY.failedLoginThreshold) {
      return { reserved: false, attempt: 0, locked: await lockIfExhausted(tx, { ...admin, lockedUntil: null }, now) };
    }
    await tx.adminUser.updateMany({ where: { id: adminId }, data: { failedLoginCount: count + 1, lockedUntil: null } });
    return { reserved: true, attempt: count + 1, locked: null };
  });
  if (outcome.locked) await auditAccountLocked(db, outcome.locked, 'attempts_exhausted');
  return outcome;
}

// Step 1. Verifies the password and, for an eligible Admin, returns { loginTicket, options }:
// the ticket is bound to the Admin, their password state and the exact challenge in `options`.
// Issues no cookie, token or session and does not reset the failure counter.
async function beginAdminPasskeyLogin({ email, password, ipAddress = null, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const { rpId } = assertWebAuthnConfig(loadAdminLockConfig()); // a server fault, not a refusal

  let cleanEmail = null;
  try { cleanEmail = normalizeAdminEmail(email); } catch { /* unusable email: refused below */ }
  const passwordUsable = typeof password === 'string' && password.length > 0 && Buffer.byteLength(password, 'utf8') <= 72;

  const admin = cleanEmail ? await db.adminUser.findUnique({ where: { email: cleanEmail } }) : null;
  // Eligible = active, has a password, and has at least one live passkey. Anyone else is refused
  // exactly like a wrong password, and (having nothing to count against) touches no counter.
  let eligible = Boolean(
    admin && admin.status === 'active' && typeof admin.passwordHash === 'string' && admin.passwordHash
    && admin.passwordChangedAt instanceof Date,
  );
  if (eligible) eligible = (await db.adminPasskey.count({ where: { adminId: admin.id, revokedAt: null } })) > 0;
  const { reserved, attempt } = eligible ? await reserveLoginAttempt(db, admin.id, now) : NOT_RESERVED;

  // One bcrypt comparison on every path.
  const matches = await comparePassword(passwordUsable ? password : '', eligible && reserved ? admin.passwordHash : DUMMY_PASSWORD_HASH);
  if (!eligible || !reserved || !matches || !passwordUsable) {
    // The failed attempt that used up the last allowed one starts the lockout right now.
    if (eligible && reserved && attempt >= ADMIN_LOCK_POLICY.failedLoginThreshold) {
      await lockAfterFailure(db, admin.id, now, 'attempts_exhausted');
    }
    await auditRefusal(db, admin && admin.id, 'admin_login_failed', !eligible ? 'ineligible' : !reserved ? 'locked' : 'wrong_password', ipAddress);
    throw new AdminLoginError();
  }

  return db.$transaction(async (tx) => {
    // Lock the Admin, but only if still active with the very password that was just checked.
    const held = await tx.adminUser.updateMany({
      where: { id: admin.id, status: 'active', passwordHash: admin.passwordHash, passwordChangedAt: admin.passwordChangedAt },
      data: { updatedAt: now },
    });
    if (held.count !== 1) throw new AdminLoginError('state_changed');
    const fresh = await tx.adminUser.findUnique({ where: { id: admin.id } });
    if (!fresh || fresh.status !== 'active' || (fresh.lockedUntil && fresh.lockedUntil > now)) throw new AdminLoginError('state_changed');

    const passkeys = await tx.adminPasskey.findMany({ where: { adminId: admin.id, revokedAt: null } });
    if (passkeys.length === 0) throw new AdminLoginError('state_changed');

    // Retires this Admin's earlier open sign-in challenge: only the newest can be used.
    const issued = await issueAdminWebAuthnChallenge({ adminId: admin.id, purpose: 'authentication', ipAddress, now, db: tx });
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: passkeys.map((p) => ({ id: isoBase64URL.fromBuffer(p.credentialId), transports: normalizeTransports(p.transports) })),
      challenge: issued.challengeBytes, // bytes, not the string: the library would UTF-8-encode a string
      timeout: ADMIN_LOCK_POLICY.loginChallengeTtlMs,
      userVerification: 'required',
    });
    if (options.challenge !== issued.challenge) throw new Error('Authentication options do not match the stored challenge');

    const loginTicket = signAdminPasskeyLoginTicket({
      adminId: admin.id,
      passwordChangedAt: fresh.passwordChangedAt,
      challengeId: issued.challengeId,
    });
    return { loginTicket, options };
  });
}

// The shape check of the shared assertion verifier, with its refusal expressed as this flow's one error.
function sanitizeAssertion(response) {
  try {
    return sanitizeAdminAssertionResponse(response);
  } catch (err) {
    if (err instanceof PasskeyAssertionError) throw new AdminLoginError(err.reason);
    throw err;
  }
}

// Step 2. Verifies the passkey assertion for the ticket's Admin and, if valid, creates the session.
// Returns { accessToken, refreshToken, accessTokenExpiresInSeconds, refreshExpiresAt, admin } for
// the controller to turn into cookies; throws AdminLoginError otherwise.
//
// Order: ticket -> response shape -> Admin state -> CONSUME the exact challenge (final, committed on
// its own, never restored: a failed assertion burns it and the user starts again from the password)
// -> credential lookup scoped to this Admin -> counter check -> cryptographic verification (outside
// any transaction) -> one transaction that re-validates, updates the counter, creates the session
// and tokens, resets the failure counter and audits.
async function completeAdminPasskeyLogin({ loginTicket, response, ipAddress = null, userAgent = null, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const { rpId, origin } = assertWebAuthnConfig(loadAdminLockConfig());

  const ticket = readAdminPasskeyLoginTicket(loginTicket);
  if (!ticket) throw new AdminLoginError('invalid_ticket');
  const safeResponse = sanitizeAssertion(response);

  const admin = await db.adminUser.findUnique({ where: { id: ticket.adminId } });
  const stateOk = admin && admin.status === 'active' && admin.passwordChangedAt instanceof Date
    && admin.passwordChangedAt.getTime() === ticket.passwordChangedAt.getTime()
    && !(admin.lockedUntil && admin.lockedUntil > now);
  if (!stateOk) {
    await auditRefusal(db, admin && admin.id, 'admin_login_failed', 'state_changed', ipAddress);
    throw new AdminLoginError('state_changed');
  }

  // Final, committed on its own. The ticket names the exact challenge; any other is not accepted.
  const challenge = await consumeAdminWebAuthnChallenge({
    adminId: admin.id, purpose: 'authentication', challengeId: ticket.challengeId, now, db,
  });
  if (!challenge) {
    await auditRefusal(db, admin.id, 'admin_login_failed', 'challenge_unavailable', ipAddress);
    throw new AdminLoginError('challenge_unavailable');
  }

  // The cryptographic checks are the shared verifier's (credential ownership, userHandle, counter,
  // origin / RP ID / user verification, result invariants). It creates nothing; the session below
  // is created only by this flow.
  let passkey;
  let newCounter;
  try {
    ({ passkey, newCounter } = await verifyAdminPasskeyAssertion({
      adminId: admin.id,
      response: safeResponse,
      expectedChallenge: challenge.challenge,
      rpId,
      origin,
      ipAddress,
      db,
    }));
  } catch (err) {
    // The challenge is already burned, so this is a genuine failed assertion: it was counted when
    // its password step reserved it, and if that was the last allowed attempt the lock starts now.
    await lockAfterFailure(db, admin.id, now, 'attempts_exhausted');
    // Anything that is not a refused assertion (e.g. a database error during the lookup) is treated
    // as a failed verification, as before.
    const reason = err instanceof PasskeyAssertionError ? err.reason : 'verification_failed';
    if (reason !== 'counter_regression') await auditRefusal(db, admin.id, 'admin_login_failed', reason, ipAddress);
    throw new AdminLoginError(reason);
  }

  try {
    return await db.$transaction(async (tx) => {
      // Lock the Admin only while still active with the same password state, then re-validate.
      const held = await tx.adminUser.updateMany({
        where: { id: admin.id, status: 'active', passwordChangedAt: admin.passwordChangedAt },
        data: { updatedAt: now },
      });
      if (held.count !== 1) throw new AdminLoginError('state_changed');
      const fresh = await tx.adminUser.findUnique({ where: { id: admin.id } });
      if (!fresh || fresh.status !== 'active' || (fresh.lockedUntil && fresh.lockedUntil > now)) throw new AdminLoginError('state_changed');

      // The credential must still be live and unchanged; the counter moves only if the stored
      // value is still the one verified against (so two assertions racing on one credential cannot
      // both advance it).
      const advanced = await advanceAdminPasskeyCounter(tx, { adminId: admin.id, passkey, newCounter, now });
      if (!advanced) throw new AdminLoginError('credential_changed');

      const session = await createAdminSession(tx, { admin: fresh, now, ipAddress, userAgent });

      // Only now - both factors done - is the failure counter cleared.
      await tx.adminUser.updateMany({ where: { id: admin.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });

      await recordAdminAuditEvent({
        actorType: 'admin',
        actorId: admin.id,
        event: 'admin_login_succeeded',
        identifier: maskEmail(fresh.email),
        ipAddress,
        userAgent,
        detail: { sessionId: session.sessionId },
        db: tx,
      });

      // Role from the database; signed last, so a signing failure rolls everything back.
      const accessToken = signAdminAccessToken({ adminId: fresh.id, role: fresh.role, sessionId: session.sessionId });
      return {
        accessToken,
        refreshToken: session.refreshToken,
        accessTokenExpiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
        refreshExpiresAt: session.refreshExpiresAt,
        admin: { id: fresh.id, name: fresh.name, email: fresh.email, role: fresh.role },
      };
    });
  } catch (err) {
    if (err instanceof AdminLoginError) await auditRefusal(db, admin.id, 'admin_login_failed', err.reason, ipAddress);
    throw err;
  }
}

module.exports = { beginAdminPasskeyLogin, completeAdminPasskeyLogin, AdminLoginError };
