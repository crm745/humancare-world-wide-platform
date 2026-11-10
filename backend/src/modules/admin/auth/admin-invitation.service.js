// Admin activation invitations, the invitee's side: inspect a link, then accept it by choosing a
// password. These are the two operations a future public API would expose; resend and revoke are
// operator-only (admin-invitation-operator.service.js).
//
// Accepting moves the Admin from "invited" to "pending_passkey" and returns a 10-minute
// enrollment ticket that lets them start their first-passkey registration. It issues NO access
// token and NO session: the Admin cannot use the dashboard until passkey enrollment and the later
// login work exist. The raw token is only ever hashed here, never stored, logged or audited; the
// ticket is a short-lived bearer value, never stored or logged either.
const { prisma } = require('../../../db/prisma');
const { hashToken } = require('../../../common/utils/token-hash');
const { maskEmail } = require('../../../common/utils/phone');
const { passwordProblem, hashPassword, comparePassword, DUMMY_PASSWORD_HASH } = require('../../auth/auth.service');
const { ADMIN_LOCK_POLICY } = require('./admin-lock.config');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const { signAdminEnrollmentTicket, ADMIN_ENROLLMENT_TICKET_TTL_SECONDS } = require('./admin-enrollment-ticket.service');

const ACTIVATION = 'activation';
// 32 random bytes as base64url. Checking the shape first means junk never reaches the database.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class InvitationError extends Error {
  // code: 'invalid_invitation' | 'weak_password'
  // state (invalid_invitation only): 'invalid' | 'used' | 'revoked' | 'expired'
  constructor(code, message, state = null) {
    super(message);
    this.name = 'InvitationError';
    this.code = code;
    this.state = state;
  }
}

function invalidInvitation(state) {
  return new InvitationError('invalid_invitation', 'This invitation link is not valid.', state);
}

// The invitation (with its Admin) for a raw token, or null. `db` is the client or a transaction.
async function findInvitationByToken(db, token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  return db.adminInvitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { admin: true } });
}

// 'valid' or the reason the invitation cannot be used. Anything that would hint at another
// account's details (wrong purpose, missing admin, wrong status, mismatched email) is just
// 'invalid'; used / revoked / expired are safe to tell the holder of the token.
function classifyInvitation(invitation, now) {
  if (!invitation || invitation.purpose !== ACTIVATION || !invitation.admin) return 'invalid';
  if (invitation.usedAt) return 'used';
  if (invitation.revokedAt) return 'revoked';
  if (!(invitation.expiresAt > now)) return 'expired';
  const { admin } = invitation;
  if (admin.status !== 'invited' || admin.passwordHash !== null) return 'invalid';
  if (String(invitation.sentToEmail).toLowerCase() !== String(admin.email).toLowerCase()) return 'invalid';
  return 'valid';
}

// Safe display information only. Never the token, its hash, the password hash or any other
// security field.
async function inspectActivationInvitation(token, { now = new Date() } = {}) {
  const invitation = await findInvitationByToken(prisma, token);
  const state = classifyInvitation(invitation, now);
  if (state !== 'valid') return { valid: false, state };
  return {
    valid: true,
    state,
    adminName: invitation.admin.name,
    maskedEmail: maskEmail(invitation.sentToEmail),
    purpose: invitation.purpose,
    expiresAt: invitation.expiresAt,
  };
}

// A rejected attempt is recorded only when the token matched a real invitation (so the log is
// not flooded by guesses), and a failure to record it never changes the outcome: the attempt
// stays denied. Only the reason and ids are written - never token material.
async function auditRejection(invitation, reason, context) {
  if (!invitation) return;
  try {
    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: invitation.adminId,
      event: 'admin_invitation_accept_failed',
      identifier: maskEmail(invitation.sentToEmail),
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      detail: { reason, invitationId: invitation.id },
    });
  } catch (err) {
    console.error(`Could not record rejected invitation attempt (${err.code || err.name}).`);
  }
}

// Returns { status: 'pending_passkey', nextStep: 'passkey_enrollment', enrollmentTicket,
// ticketExpiresInSeconds }. The ticket is bound to the Admin, this accepted invitation and the
// exact persisted password timestamp, and is signed as the LAST step INSIDE the accepting
// transaction: if signing (or anything before it) fails, everything rolls back and the invitation
// is still usable, so an Admin is never left accepted-but-without-a-ticket. The ticket string only
// leaves this function after the transaction has committed.
// Throws InvitationError: 'weak_password', or 'invalid_invitation' (with .state). Database,
// audit and signing failures in the accepting transaction propagate and leave everything unchanged.
async function acceptActivationInvitation({ token, password, now = new Date(), context = {} } = {}) {
  const problem = passwordProblem(password);
  if (problem) throw new InvitationError('weak_password', problem);

  // Cheap read first so a bad link never pays for a bcrypt hash.
  const preliminary = await findInvitationByToken(prisma, token);
  const preState = classifyInvitation(preliminary, now);
  if (preState !== 'valid') {
    await auditRejection(preliminary, preState, context);
    throw invalidInvitation(preState);
  }

  const passwordHash = await hashPassword(password);

  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      // Re-read and re-validate inside the transaction...
      const invitation = await findInvitationByToken(tx, token);
      const state = classifyInvitation(invitation, now);
      if (state !== 'valid') throw invalidInvitation(state);

      // ...then claim the invitation with a conditional update. If two requests race, the
      // database serialises these updates on the row and only one still matches.
      const claimed = await tx.adminInvitation.updateMany({
        where: { id: invitation.id, purpose: ACTIVATION, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw invalidInvitation('used');

      const activated = await tx.adminUser.updateMany({
        where: { id: invitation.adminId, status: 'invited', passwordHash: null },
        data: { passwordHash, passwordChangedAt: now, emailVerifiedAt: now, status: 'pending_passkey' },
      });
      if (activated.count !== 1) throw invalidInvitation('invalid');

      // Nothing else may activate this Admin later.
      await tx.adminInvitation.updateMany({
        where: { adminId: invitation.adminId, purpose: ACTIVATION, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });

      // The timestamp as the database now holds it - the ticket must carry exactly this value.
      const persisted = await tx.adminUser.findUnique({ where: { id: invitation.adminId } });
      if (!persisted || persisted.status !== 'pending_passkey' || !(persisted.passwordChangedAt instanceof Date)) {
        throw new Error('Admin activation could not be confirmed');
      }

      await recordAdminAuditEvent({
        actorType: 'admin',
        actorId: invitation.adminId,
        event: 'admin_invitation_accepted',
        identifier: maskEmail(invitation.sentToEmail),
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        detail: { invitationId: invitation.id, newStatus: 'pending_passkey' },
        db: tx,
      });

      // Last step, still inside the transaction: a signing failure rolls everything back.
      const enrollmentTicket = signAdminEnrollmentTicket({
        adminId: persisted.id,
        invitationId: invitation.id,
        passwordChangedAt: persisted.passwordChangedAt,
      });
      return { enrollmentTicket };
    });
  } catch (err) {
    if (err instanceof InvitationError) await auditRejection(preliminary, err.state, context);
    throw err;
  }

  return {
    status: 'pending_passkey',
    nextStep: 'passkey_enrollment',
    enrollmentTicket: outcome.enrollmentTicket,
    ticketExpiresInSeconds: ADMIN_ENROLLMENT_TICKET_TTL_SECONDS,
  };
}

const PASSKEY_ENROLLMENT = 'passkey_enrollment';
// The counted event: one row per password attempt, written BEFORE the password is checked.
const ATTEMPT_EVENT = 'admin_passkey_enrollment_redeem_attempt';
// Informational rows, written best-effort and never counted: why an attempt was refused or failed.
const FAILED_REDEMPTION_EVENT = 'admin_passkey_enrollment_redeem_failed'; // wrong password
const REFUSED_REDEMPTION_EVENT = 'admin_passkey_enrollment_redeem_refused'; // unusable link / exhausted
const OPEN_ENROLLMENT = { purpose: PASSKEY_ENROLLMENT, usedAt: null, revokedAt: null };

// 'valid' or the internal reason a passkey-enrollment invitation cannot be redeemed. The reason is
// for the audit trail only: every refusal reaches the caller as the same generic error.
function classifyEnrollmentInvitation(invitation, now) {
  if (!invitation || invitation.purpose !== PASSKEY_ENROLLMENT || !invitation.admin) return 'invalid';
  if (invitation.usedAt) return 'used';
  if (invitation.revokedAt) return 'revoked';
  if (!(invitation.expiresAt > now)) return 'expired';
  const { admin } = invitation;
  if (admin.status !== 'pending_passkey') return 'admin_status';
  if (typeof admin.passwordHash !== 'string' || !admin.passwordHash || !(admin.passwordChangedAt instanceof Date)) return 'no_password';
  if (String(invitation.sentToEmail).toLowerCase() !== String(admin.email).toLowerCase()) return 'email_mismatch';
  return 'valid';
}

// Best-effort trail entry (ids and a reason code only). Nothing is enforced from these rows, so a
// failure to write one can never change the outcome.
async function auditEnrollmentRedemption(db, invitation, event, reason, ipAddress) {
  if (!invitation) return;
  try {
    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: invitation.adminId,
      event,
      identifier: maskEmail(invitation.sentToEmail),
      ipAddress,
      detail: { reason, invitationId: invitation.id },
      db,
    });
  } catch (err) {
    console.error(`Could not record a passkey-enrollment redemption event (${err.code || err.name}).`);
  }
}

// Burning an exhausted link is hardening only: the attempt count, not this revoke, is what stops
// further guesses, so a failure here is logged and nothing depends on it.
async function burnInvitation(db, invitation, now) {
  try {
    await db.adminInvitation.updateMany({ where: { id: invitation.id, ...OPEN_ENROLLMENT }, data: { revokedAt: now } });
  } catch (err) {
    console.error(`Could not revoke an exhausted passkey-enrollment invitation (${err.code || err.name}).`);
  }
}

// Reserves one password attempt, atomically, BEFORE the password is looked at:
//   1. lock the invitation row (a conditional write of the value it already has, only while it is
//      still open) - every concurrent attempt on this link queues here, one at a time;
//   2. count the attempts already recorded for it, now that all earlier ones have committed;
//   3. if the limit is reached, refuse; otherwise write this attempt's row and commit.
// Because the row is part of the reservation transaction, an attempt that cannot be recorded is
// not allowed: the audit/database error propagates (fail closed) and the password is never
// checked. And because reservation is serialised, no burst of parallel guesses can get more than
// `failedLoginThreshold` attempts through. Returns { allowed, attempt }.
async function reserveRedemptionAttempt(db, invitation, ipAddress) {
  return db.$transaction(async (tx) => {
    const held = await tx.adminInvitation.updateMany({
      where: { id: invitation.id, ...OPEN_ENROLLMENT, adminId: invitation.adminId },
      data: { revokedAt: null },
    });
    if (held.count !== 1) return { allowed: false, attempt: 0 }; // used or revoked meanwhile

    // Attempts for this invitation: this Admin's rows since the invitation was issued (a new
    // invitation, issued by an operator, starts a fresh count).
    const used = await tx.securityEvent.count({
      where: { event: ATTEMPT_EVENT, actorType: 'admin', actorId: invitation.adminId, createdAt: { gt: invitation.createdAt } },
    });
    if (used >= ADMIN_LOCK_POLICY.failedLoginThreshold) return { allowed: false, attempt: used };

    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: invitation.adminId,
      event: ATTEMPT_EVENT,
      identifier: maskEmail(invitation.sentToEmail),
      ipAddress,
      detail: { invitationId: invitation.id, attempt: used + 1 },
      db: tx,
    });
    return { allowed: true, attempt: used + 1 };
  });
}

// Redeems a passkey-enrollment invitation - the link PLUS the Admin's current password - for a
// fresh 10-minute enrollment ticket, so an Admin left in "pending_passkey" can register a passkey.
// The password and passwordChangedAt are not changed. Returns
//   { status: 'pending_passkey', nextStep: 'passkey_enrollment', enrollmentTicket, ticketExpiresInSeconds }
// or throws the generic InvitationError('invalid_invitation'); nothing reveals whether the link,
// the Admin, the password or the Admin's state was the problem. Issues no token, cookie or session.
//
// Guessing is bounded to `failedLoginThreshold` (5) attempts per invitation, enforced by
// reserveRedemptionAttempt before any password is checked; the 5th wrong password also revokes the
// link, and an operator must issue a new one. If the attempt cannot be recorded the call fails
// (with the underlying database/audit error) without checking the password.
// `db` must be a root Prisma client (it needs $transaction).
async function redeemAdminPasskeyEnrollmentInvitation({ token, password, ipAddress = null, now = new Date(), db = prisma } = {}) {
  if (!db || typeof db.$transaction !== 'function') throw new TypeError('db must be a root Prisma client');
  const generic = () => invalidInvitation('invalid');

  const invitation = await findInvitationByToken(db, token);
  const reason = classifyEnrollmentInvitation(invitation, now);

  // A usable link costs one reserved attempt up front; anything else is refused with no attempt.
  const reservation = reason === 'valid' ? await reserveRedemptionAttempt(db, invitation, ipAddress) : { allowed: false, attempt: 0 };
  const checkable = reason === 'valid' && reservation.allowed;

  // One bcrypt comparison on every path - against a dummy hash when there is nothing to check -
  // so timing does not separate "no such link" from "wrong password".
  const passwordUsable = typeof password === 'string' && password.length > 0 && Buffer.byteLength(password, 'utf8') <= 72;
  const matches = await comparePassword(passwordUsable ? password : '', checkable ? invitation.admin.passwordHash : DUMMY_PASSWORD_HASH);

  if (reason !== 'valid') {
    await auditEnrollmentRedemption(db, invitation, REFUSED_REDEMPTION_EVENT, reason, ipAddress);
    throw generic();
  }
  if (!reservation.allowed) {
    await auditEnrollmentRedemption(db, invitation, REFUSED_REDEMPTION_EVENT, 'attempts_exhausted', ipAddress);
    await burnInvitation(db, invitation, now);
    throw generic();
  }
  if (!passwordUsable || !matches) {
    await auditEnrollmentRedemption(db, invitation, FAILED_REDEMPTION_EVENT, 'wrong_password', ipAddress);
    if (reservation.attempt >= ADMIN_LOCK_POLICY.failedLoginThreshold) await burnInvitation(db, invitation, now);
    throw generic();
  }

  const checkedHash = invitation.admin.passwordHash;
  const checkedChangedAt = invitation.admin.passwordChangedAt;

  const enrollmentTicket = await db.$transaction(async (tx) => {
    // Lock the Admin, but only if it is still pending with the very password that was just checked.
    // A concurrent disable, password change or registration makes this match nothing.
    const held = await tx.adminUser.updateMany({
      where: { id: invitation.adminId, status: 'pending_passkey', passwordHash: checkedHash },
      data: { updatedAt: now },
    });
    if (held.count !== 1) throw generic();

    // Claim the invitation exactly once. Two simultaneous redemptions: only one sees count 1.
    const claimed = await tx.adminInvitation.updateMany({
      where: { id: invitation.id, ...OPEN_ENROLLMENT, adminId: invitation.adminId, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw generic();

    // Re-validate everything the decision rests on, under the locks.
    const admin = await tx.adminUser.findUnique({ where: { id: invitation.adminId } });
    if (
      !admin
      || admin.status !== 'pending_passkey'
      || admin.passwordHash !== checkedHash
      || !(admin.passwordChangedAt instanceof Date)
      || admin.passwordChangedAt.getTime() !== checkedChangedAt.getTime()
      || String(invitation.sentToEmail).toLowerCase() !== String(admin.email).toLowerCase()
    ) {
      throw generic();
    }
    const livePasskeys = await tx.adminPasskey.count({ where: { adminId: admin.id, revokedAt: null } });
    if (livePasskeys > 0) throw generic();

    // No other passkey-enrollment link may stay open next to the one just used.
    await tx.adminInvitation.updateMany({
      where: { adminId: admin.id, ...OPEN_ENROLLMENT },
      data: { revokedAt: now },
    });

    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: admin.id,
      event: 'admin_passkey_enrollment_invitation_redeemed',
      identifier: maskEmail(admin.email),
      ipAddress,
      detail: { invitationId: invitation.id },
      db: tx,
    });

    // Last step, inside the transaction: if signing fails everything above rolls back and the link
    // is still usable. The ticket leaves this function only after the commit.
    return signAdminEnrollmentTicket({
      adminId: admin.id,
      invitationId: invitation.id,
      passwordChangedAt: admin.passwordChangedAt,
    });
  });

  return {
    status: 'pending_passkey',
    nextStep: 'passkey_enrollment',
    enrollmentTicket,
    ticketExpiresInSeconds: ADMIN_ENROLLMENT_TICKET_TTL_SECONDS,
  };
}

module.exports = {
  inspectActivationInvitation,
  acceptActivationInvitation,
  redeemAdminPasskeyEnrollmentInvitation,
  classifyInvitation,
  InvitationError,
};
