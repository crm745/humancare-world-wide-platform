// The target's side of an approved Admin passkey recovery, in three steps:
//   1. redeemRecoveryInvitation          the emailed link + the Admin's CURRENT password -> a
//                                        10-minute recovery ticket (no session, no token);
//   2. generateRecoveryRegistrationOptions  the ticket -> WebAuthn options for a NEW passkey and a
//                                        recovery_registration challenge;
//   3. verifyRecoveryPasskeyRegistration    the authenticator's response -> the new passkey is stored,
//                                        every old one revoked, every session ended, the request
//                                        completed - in ONE transaction.
// Service layer only: no HTTP route. Nothing here signs the Admin in; they sign in afterwards with
// their password and the new passkey like anyone else.
//
// The old passkeys are untouched until step 3 stores the new one - and only inside the very
// transaction that inserts it, so a failure at any point leaves the Admin exactly as they were.
// The password, the failed-login counter and the lockout are never changed.
//
// Locking, the same order as the decision service: the recovery REQUEST row first (as the first
// statement, so later reads see everything already committed) -> the Admin row -> the invitation
// row -> the passkeys and sessions. Each lock is an UPDATE ... WHERE that also re-checks the state
// it protects (a current read), so a disable, password change, revocation or expiry that
// committed a moment ago is seen.
//
// Every refusal is one generic error. Raw invitation tokens, tickets, challenges and responses
// are never stored (the token only as a hash), logged or audited.
const { generateRegistrationOptions, verifyRegistrationResponse } = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const { prisma } = require('../../../db/prisma');
const { hashToken } = require('../../../common/utils/token-hash');
const { maskEmail } = require('../../../common/utils/phone');
const { comparePassword, DUMMY_PASSWORD_HASH } = require('../../auth/auth.service');
const { ADMIN_LOCK_POLICY, loadAdminLockConfig, assertWebAuthnConfig } = require('./admin-lock.config');
const { issueAdminWebAuthnChallenge, consumeAdminWebAuthnChallenge } = require('./admin-webauthn-challenge.service');
const {
  signAdminRecoveryTicket,
  readAdminRecoveryTicket,
  recoveryTicketMatches,
  ADMIN_RECOVERY_TICKET_TTL_SECONDS,
} = require('./admin-recovery-ticket.service');
const { sanitizeRegistrationResponse, buildCredentialRecord, PasskeyRegistrationError } = require('./admin-webauthn-registration.service');
const { revokeSessionRows } = require('./admin-session.service');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const {
  ADMIN_REGISTRATION_SETTINGS,
  ADMIN_WEBAUTHN_ALGORITHMS,
  registrationAuthenticatorSelection,
  deriveAdminWebAuthnUserHandle,
  normalizeTransports,
  normalizePasskeyLabel,
} = require('./admin-webauthn.helpers');

const RECOVERY_INVITATION_PURPOSE = 'passkey_recovery';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes as base64url, like every invitation
const PASSKEY_REVOKE_REASON = 'recovery';
const SESSION_REVOKE_REASON = 'passkey_recovery';

const EVENTS = Object.freeze({
  attempt: 'admin_recovery_redeem_attempt', // counted: one row per password attempt, written before the check
  failed: 'admin_recovery_redeem_failed', // wrong password (informational)
  refused: 'admin_recovery_redeem_refused', // unusable link / attempts exhausted (informational)
  redeemed: 'admin_recovery_invitation_redeemed',
  registrationFailed: 'admin_recovery_registration_failed',
  recovered: 'admin_passkey_recovered',
});

// The one error of this service. `reason` is a short internal code for the audit trail; it is not
// enumerable, so it is never serialised to a client.
class RecoveryRegistrationError extends Error {
  constructor(reason = 'invalid_context') {
    super('This passkey recovery session is not valid. Please start again.');
    this.name = 'RecoveryRegistrationError';
    this.code = 'invalid_recovery';
    Object.defineProperty(this, 'reason', { value: reason, enumerable: false });
  }
}

function assertRoot(db) {
  if (!db || typeof db.$transaction !== 'function') throw new TypeError('db must be a root Prisma client');
}

// ---- 1. redeeming the invitation ------------------------------------------------------------

// 'valid' or the internal reason a recovery invitation cannot be redeemed (for the audit trail
// only: every refusal reaches the caller as the same generic error).
function classifyRecoveryInvitation(invitation, request, now) {
  if (!invitation || invitation.purpose !== RECOVERY_INVITATION_PURPOSE || !invitation.admin) return 'invalid';
  if (invitation.usedAt) return 'used';
  if (invitation.revokedAt) return 'revoked';
  if (!(invitation.expiresAt > now)) return 'expired';
  if (!Number.isInteger(invitation.recoveryRequestId) || !request) return 'no_request';
  if (request.id !== invitation.recoveryRequestId || request.adminId !== invitation.adminId) return 'request_mismatch';
  if (request.status !== 'approved') return 'request_status';
  if (!(request.expiresAt instanceof Date) || !(request.expiresAt > now)) return 'request_expired';
  const { admin } = invitation;
  if (admin.status !== 'active') return 'admin_status';
  if (typeof admin.passwordHash !== 'string' || !admin.passwordHash || !(admin.passwordChangedAt instanceof Date)) return 'no_password';
  if (String(invitation.sentToEmail).toLowerCase() !== String(admin.email).toLowerCase()) return 'email_mismatch';
  return 'valid';
}

// Best-effort trail entry (ids and a reason code only). Nothing is enforced from these rows
// except the attempt rows, which are written inside reserveRedemptionAttempt.
async function auditRedemption(db, invitation, event, reason, ipAddress) {
  if (!invitation) return;
  try {
    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: invitation.adminId,
      event,
      identifier: maskEmail(invitation.sentToEmail),
      ipAddress,
      detail: { reason, invitationId: invitation.id, ...(invitation.recoveryRequestId ? { recoveryRequestId: invitation.recoveryRequestId } : {}) },
      db,
    });
  } catch (err) {
    console.error(`Could not record a passkey-recovery redemption event (${err.code || err.name}).`);
  }
}

// Burning an exhausted link is hardening only: the attempt count is what stops further guesses.
async function burnInvitation(db, invitation, now) {
  try {
    await db.adminInvitation.updateMany({
      where: { id: invitation.id, purpose: RECOVERY_INVITATION_PURPOSE, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
  } catch (err) {
    console.error(`Could not revoke an exhausted passkey-recovery invitation (${err.code || err.name}).`);
  }
}

// Reserves one password attempt BEFORE the password is looked at: lock the invitation row (the
// first statement, only while it is still open), count the attempts already recorded for it, refuse
// at the limit, otherwise write this attempt's row. The row is part of the transaction, so an
// attempt that cannot be recorded is not allowed (fail closed), and parallel guesses cannot get
// more than `failedLoginThreshold` attempts through. Returns { allowed, attempt }.
async function reserveRedemptionAttempt(db, invitation, ipAddress) {
  return db.$transaction(async (tx) => {
    const held = await tx.adminInvitation.updateMany({
      where: { id: invitation.id, purpose: RECOVERY_INVITATION_PURPOSE, adminId: invitation.adminId, usedAt: null, revokedAt: null },
      data: { revokedAt: null },
    });
    if (held.count !== 1) return { allowed: false, attempt: 0 };
    const used = await tx.securityEvent.count({
      where: { event: EVENTS.attempt, actorType: 'admin', actorId: invitation.adminId, createdAt: { gt: invitation.createdAt } },
    });
    if (used >= ADMIN_LOCK_POLICY.failedLoginThreshold) return { allowed: false, attempt: used };
    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: invitation.adminId,
      event: EVENTS.attempt,
      identifier: maskEmail(invitation.sentToEmail),
      ipAddress,
      detail: { invitationId: invitation.id, recoveryRequestId: invitation.recoveryRequestId, attempt: used + 1 },
      db: tx,
    });
    return { allowed: true, attempt: used + 1 };
  });
}

// Redeems an approved recovery invitation - the link plus the Admin's current password - for a
// 10-minute recovery ticket. Returns { status: 'approved', nextStep: 'passkey_registration',
// recoveryTicket, ticketExpiresInSeconds } or throws the generic RecoveryRegistrationError;
// nothing reveals whether the link, the Admin, the password or the request was the problem. Issues
// no session, token or cookie. Guessing is bounded to `failedLoginThreshold` attempts per
// invitation; the last wrong one also revokes the link. If an attempt cannot be recorded the call
// fails (with the underlying error) without checking the password.
async function redeemRecoveryInvitation({ token, password, ipAddress = null, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const generic = (reason = 'invalid') => new RecoveryRegistrationError(reason);

  const wellFormed = typeof token === 'string' && TOKEN_PATTERN.test(token);
  const invitation = wellFormed
    ? await db.adminInvitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { admin: true } })
    : null;
  const request = invitation && Number.isInteger(invitation.recoveryRequestId)
    ? await db.adminRecoveryRequest.findUnique({ where: { id: invitation.recoveryRequestId } })
    : null;
  const reason = classifyRecoveryInvitation(invitation, request, now);

  // A usable link costs one reserved attempt up front; anything else is refused with no attempt.
  const reservation = reason === 'valid' ? await reserveRedemptionAttempt(db, invitation, ipAddress) : { allowed: false, attempt: 0 };
  const checkable = reason === 'valid' && reservation.allowed;

  // One bcrypt comparison on every path, so timing does not separate "no such link" from "wrong password".
  const passwordUsable = typeof password === 'string' && password.length > 0 && Buffer.byteLength(password, 'utf8') <= 72;
  const matches = await comparePassword(passwordUsable ? password : '', checkable ? invitation.admin.passwordHash : DUMMY_PASSWORD_HASH);

  if (reason !== 'valid') {
    await auditRedemption(db, invitation, EVENTS.refused, reason, ipAddress);
    throw generic(reason);
  }
  if (!reservation.allowed) {
    await auditRedemption(db, invitation, EVENTS.refused, 'attempts_exhausted', ipAddress);
    await burnInvitation(db, invitation, now);
    throw generic('attempts_exhausted');
  }
  if (!passwordUsable || !matches) {
    await auditRedemption(db, invitation, EVENTS.failed, 'wrong_password', ipAddress);
    if (reservation.attempt >= ADMIN_LOCK_POLICY.failedLoginThreshold) await burnInvitation(db, invitation, now);
    throw generic('wrong_password');
  }

  const checkedHash = invitation.admin.passwordHash;
  const checkedChangedAt = invitation.admin.passwordChangedAt;

  const recoveryTicket = await db.$transaction(async (tx) => {
    // First statement: the Admin (the order of every recovery transaction), only while active with the
    // very password that was just checked.
    const heldAdmin = await tx.adminUser.updateMany({
      where: { id: invitation.adminId, status: 'active', passwordHash: checkedHash, passwordChangedAt: checkedChangedAt },
      data: { updatedAt: now },
    });
    // Then the request, only while approved and unexpired.
    const heldRequest = await tx.adminRecoveryRequest.updateMany({
      where: { id: invitation.recoveryRequestId, adminId: invitation.adminId, status: 'approved', expiresAt: { gt: now } },
      data: { updatedAt: now },
    });
    if (heldRequest.count !== 1) throw generic('request_changed');
    if (heldAdmin.count !== 1) throw generic('admin_changed');
    // Claim the invitation exactly once. Simultaneous redemptions: only one sees count 1.
    const claimed = await tx.adminInvitation.updateMany({
      where: {
        id: invitation.id, purpose: RECOVERY_INVITATION_PURPOSE, adminId: invitation.adminId,
        recoveryRequestId: invitation.recoveryRequestId, usedAt: null, revokedAt: null, expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw generic('invitation_changed');

    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: invitation.adminId,
      event: EVENTS.redeemed,
      identifier: maskEmail(invitation.sentToEmail),
      ipAddress,
      detail: { invitationId: invitation.id, recoveryRequestId: invitation.recoveryRequestId },
      db: tx,
    });

    // Last step, inside the transaction: if signing fails everything above rolls back and the link
    // is still usable. The ticket leaves this function only after the commit.
    return signAdminRecoveryTicket({
      adminId: invitation.adminId,
      recoveryRequestId: invitation.recoveryRequestId,
      invitationId: invitation.id,
      passwordChangedAt: checkedChangedAt,
    });
  });

  return {
    status: 'approved',
    nextStep: 'passkey_registration',
    recoveryTicket,
    ticketExpiresInSeconds: ADMIN_RECOVERY_TICKET_TTL_SECONDS,
  };
}

// ---- shared: the ticket's database bindings ------------------------------------------------

// Locks, in the fixed order, everything a recovery ticket rests on - each lock re-checking the
// state it protects - then reads the rows and applies recoveryTicketMatches. No plain read happens
// before the locks. Returns the fresh { admin, request, invitation }; throws the generic error.
async function lockRecoveryContext(tx, claims, now) {
  const admin = await tx.adminUser.updateMany({
    where: { id: claims.adminId, status: 'active', passwordChangedAt: claims.passwordChangedAt },
    data: { updatedAt: now },
  });
  const request = await tx.adminRecoveryRequest.updateMany({
    where: { id: claims.recoveryRequestId, adminId: claims.adminId, status: 'approved', expiresAt: { gt: now } },
    data: { updatedAt: now },
  });
  if (request.count !== 1 || admin.count !== 1) throw new RecoveryRegistrationError('state_changed');
  const invitation = await tx.adminInvitation.updateMany({
    where: {
      id: claims.invitationId, adminId: claims.adminId, purpose: RECOVERY_INVITATION_PURPOSE,
      recoveryRequestId: claims.recoveryRequestId, usedAt: { not: null }, revokedAt: null,
    },
    data: { revokedAt: null },
  });
  if (invitation.count !== 1) throw new RecoveryRegistrationError('state_changed');
  return readRecoveryContext(tx, claims, now);
}

async function readRecoveryContext(client, claims, now) {
  const [admin, request, invitation] = await Promise.all([
    client.adminUser.findUnique({ where: { id: claims.adminId } }),
    client.adminRecoveryRequest.findUnique({ where: { id: claims.recoveryRequestId } }),
    client.adminInvitation.findUnique({ where: { id: claims.invitationId } }),
  ]);
  const redeemedInTime = invitation && invitation.usedAt instanceof Date && invitation.usedAt <= invitation.expiresAt;
  if (!redeemedInTime || !(request && request.expiresAt > now) || !recoveryTicketMatches(claims, { admin, request, invitation, now })) {
    throw new RecoveryRegistrationError('state_changed');
  }
  return { admin, request, invitation };
}

async function auditRegistrationRefusal(db, claims, reason, ipAddress) {
  try {
    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: claims.adminId,
      event: EVENTS.registrationFailed,
      ipAddress,
      detail: { reason, recoveryRequestId: claims.recoveryRequestId },
      db,
    });
  } catch (err) {
    console.error(`Could not record refused passkey-recovery registration (${err.code || err.name}).`);
  }
}

// ---- 2. registration options ---------------------------------------------------------------

// Validates the recovery ticket against the database and returns the browser options for the NEW
// passkey (user verification required), storing a recovery_registration challenge bound to this
// Admin and request. A newer call replaces an older challenge. Old passkeys are not touched; they
// are listed in excludeCredentials so the same authenticator cannot be registered again.
// Throws RecoveryRegistrationError; a configuration problem throws its own, specific error.
async function generateRecoveryRegistrationOptions({ ticket, ipAddress = null, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const { rpId, rpName } = assertWebAuthnConfig(loadAdminLockConfig());
  const claims = readAdminRecoveryTicket(ticket);
  if (!claims) throw new RecoveryRegistrationError('invalid_ticket');

  try {
    return await db.$transaction(async (tx) => {
      const { admin } = await lockRecoveryContext(tx, claims, now);
      const known = await tx.adminPasskey.findMany({ where: { adminId: admin.id } });

      const issued = await issueAdminWebAuthnChallenge({
        adminId: admin.id, purpose: 'recovery_registration', recoveryRequestId: claims.recoveryRequestId, ipAddress, now, db: tx,
      });
      const options = await generateRegistrationOptions({
        rpName,
        rpID: rpId,
        userName: admin.email,
        userDisplayName: admin.name,
        userID: deriveAdminWebAuthnUserHandle(admin.id),
        challenge: issued.challengeBytes, // bytes, not the string: the library would UTF-8-encode a string
        timeout: ADMIN_REGISTRATION_SETTINGS.timeoutMs,
        attestationType: ADMIN_REGISTRATION_SETTINGS.attestationType,
        authenticatorSelection: registrationAuthenticatorSelection(),
        supportedAlgorithmIDs: [...ADMIN_WEBAUTHN_ALGORITHMS],
        excludeCredentials: known.map((p) => ({ id: isoBase64URL.fromBuffer(p.credentialId), transports: normalizeTransports(p.transports) })),
      });
      if (options.challenge !== issued.challenge) throw new Error('Registration options do not match the stored challenge');
      return options;
    });
  } catch (err) {
    if (err instanceof RecoveryRegistrationError) await auditRegistrationRefusal(db, claims, err.reason, ipAddress);
    throw err;
  }
}

// ---- 3. verifying the replacement passkey and completing the recovery ----------------------

// Order matters:
//   1. configuration, ticket and the SHAPE of the response and label (no database yet);
//   2. the ticket's bindings, read-only;
//   3. CONSUME the recovery_registration challenge - final, committed on its own, never restored:
//      a failed registration burns it and the Admin asks for fresh options;
//   4. cryptographic verification (outside any transaction) and the checks on the stored record;
//   5. ONE transaction that locks and re-validates, inserts the new passkey, THEN revokes every
//      other live passkey, ends all sessions and refresh tokens, completes the request and audits.
// Returns { status: 'recovered', nextStep: 'sign_in' }: no token, cookie or session.
async function verifyRecoveryPasskeyRegistration({ ticket, response, label, ipAddress = null, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const { rpId, origin } = assertWebAuthnConfig(loadAdminLockConfig());
  const claims = readAdminRecoveryTicket(ticket);
  if (!claims) throw new RecoveryRegistrationError('invalid_ticket');

  let safeResponse;
  let safeLabel;
  try {
    safeResponse = sanitizeRegistrationResponse(response);
    safeLabel = normalizePasskeyLabel(label);
  } catch {
    throw new RecoveryRegistrationError('invalid_response');
  }

  try {
    await readRecoveryContext(db, claims, now);
  } catch (err) {
    if (err instanceof RecoveryRegistrationError) await auditRegistrationRefusal(db, claims, err.reason, ipAddress);
    throw err;
  }

  const consumed = await consumeAdminWebAuthnChallenge({
    adminId: claims.adminId, purpose: 'recovery_registration', recoveryRequestId: claims.recoveryRequestId, now, db,
  });
  if (!consumed) {
    await auditRegistrationRefusal(db, claims, 'challenge_unavailable', ipAddress);
    throw new RecoveryRegistrationError('challenge_unavailable');
  }

  let record;
  try {
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: safeResponse,
        expectedChallenge: consumed.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        expectedType: ADMIN_REGISTRATION_SETTINGS.expectedType,
        requireUserPresence: ADMIN_REGISTRATION_SETTINGS.requireUserPresence,
        requireUserVerification: ADMIN_REGISTRATION_SETTINGS.requireUserVerification,
        supportedAlgorithmIDs: [...ADMIN_WEBAUTHN_ALGORITHMS],
      });
    } catch {
      throw new RecoveryRegistrationError('verification_failed');
    }
    try {
      record = buildCredentialRecord(verification, safeResponse);
    } catch (err) {
      throw err instanceof PasskeyRegistrationError ? new RecoveryRegistrationError(err.reason) : err;
    }
  } catch (err) {
    if (err instanceof RecoveryRegistrationError) await auditRegistrationRefusal(db, claims, err.reason, ipAddress);
    throw err;
  }

  try {
    await db.$transaction(async (tx) => {
      const { admin, invitation } = await lockRecoveryContext(tx, claims, now);

      // 1. The new passkey. A credential already registered (to anyone, live or revoked) is a
      // duplicate: the transaction ends here and nothing has changed.
      const passkey = await tx.adminPasskey.create({
        data: {
          adminId: admin.id,
          credentialIdHash: record.credentialIdHash,
          credentialId: record.credentialId,
          publicKey: record.publicKey,
          signCount: record.signCount,
          transports: record.transports,
          aaguid: record.aaguid,
          deviceType: record.deviceType,
          backedUp: record.backedUp,
          label: safeLabel,
        },
      });

      // 2. Only now, every OTHER live passkey of this Admin is revoked.
      const revokedPasskeys = await tx.adminPasskey.updateMany({
        where: { adminId: admin.id, revokedAt: null, id: { not: passkey.id } },
        data: { revokedAt: now, revokedReason: PASSKEY_REVOKE_REASON, revokedBy: null },
      });

      // 3. Every session and every still-valid refresh token of this Admin. (The Admin row has
      // been locked since before any plain read, so no sign-in can add a session meanwhile.)
      const sessions = await tx.adminSession.findMany({ where: { adminId: admin.id } });
      const sessionIds = sessions.map((s) => s.id);
      const liveSessionIds = sessions.filter((s) => !s.revokedAt).map((s) => s.id);
      let revokedTokens = 0;
      if (sessionIds.length > 0) {
        revokedTokens = (await tx.adminRefreshToken.findMany({ where: { sessionId: { in: sessionIds }, revokedAt: null } })).length;
        await revokeSessionRows(tx, liveSessionIds, SESSION_REVOKE_REASON, now);
        await tx.adminRefreshToken.updateMany({ where: { sessionId: { in: sessionIds }, revokedAt: null }, data: { revokedAt: now } });
      }

      // 4. The request is completed exactly once.
      const completed = await tx.adminRecoveryRequest.updateMany({
        where: { id: claims.recoveryRequestId, status: 'approved' },
        data: { status: 'completed', completedAt: now },
      });
      if (completed.count !== 1) throw new RecoveryRegistrationError('state_changed');

      await recordAdminAuditEvent({
        actorType: 'admin',
        actorId: admin.id,
        event: EVENTS.recovered,
        identifier: maskEmail(admin.email),
        ipAddress,
        detail: {
          recoveryRequestId: claims.recoveryRequestId,
          invitationId: invitation.id,
          newPasskeyId: passkey.id,
          revokedPasskeyCount: revokedPasskeys.count,
          sessionCount: liveSessionIds.length,
          revokedRefreshCount: revokedTokens,
          deviceType: record.deviceType,
          backedUp: record.backedUp,
        },
        db: tx,
      });
    });
  } catch (err) {
    // A credential that already exists is one more generic refusal.
    if (err && err.code === 'P2002') {
      await auditRegistrationRefusal(db, claims, 'duplicate_credential', ipAddress);
      throw new RecoveryRegistrationError('duplicate_credential');
    }
    if (err instanceof RecoveryRegistrationError) await auditRegistrationRefusal(db, claims, err.reason, ipAddress);
    throw err; // database or audit failures surface as they are; nothing was committed
  }

  return { status: 'recovered', nextStep: 'sign_in' };
}

module.exports = {
  redeemRecoveryInvitation,
  generateRecoveryRegistrationOptions,
  verifyRecoveryPasskeyRegistration,
  classifyRecoveryInvitation,
  RecoveryRegistrationError,
  RECOVERY_REGISTRATION_EVENTS: EVENTS,
};
