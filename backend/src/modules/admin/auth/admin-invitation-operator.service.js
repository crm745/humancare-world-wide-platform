// Operator-only invitation management, used by scripts/admin-invitation.js - deliberately not an
// HTTP API. Resend replaces an Admin's open activation invitations with a fresh one; revoke
// cancels them. Invitation rows are never deleted, so the history is kept. As in provisioning,
// the raw token exists only in memory for the email and is never printed, logged or audited.
const crypto = require('crypto');
const { prisma } = require('../../../db/prisma');
const { sendMail } = require('../../../lib/mailer');
const { hashToken } = require('../../../common/utils/token-hash');
const { loadAdminLockConfig, assertPortalUrlConfig } = require('./admin-lock.config');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const {
  ProvisioningError,
  normalizeAdminEmail,
  buildInvitationUrl,
  invitationMessage,
  operatorIdentity,
} = require('./admin-provisioning.service');

const ACTIVATION = 'activation';
const OPEN_ACTIVATION = { purpose: ACTIVATION, usedAt: null, revokedAt: null };
const PASSKEY_ENROLLMENT_STATUS = 'pending_passkey';
const PASSKEY_ENROLLMENT = 'passkey_enrollment';
const OPEN_ENROLLMENT = { purpose: PASSKEY_ENROLLMENT, usedAt: null, revokedAt: null };
const ENROLLMENT_PATH = '/enroll-passkey';

class InvitationOperatorError extends Error {
  // code: 'admin_not_found' | 'not_invited' | 'no_open_invitation' | 'not_pending_passkey' | 'no_password' | 'has_passkey'
  constructor(code, message) {
    super(message);
    this.name = 'InvitationOperatorError';
    this.code = code;
  }
}

async function findInvitedAdmin(tx, email) {
  const admin = await tx.adminUser.findUnique({ where: { email } });
  if (!admin) throw new InvitationOperatorError('admin_not_found', 'No admin with that email.');
  if (admin.status !== 'invited') {
    throw new InvitationOperatorError('not_invited', 'That admin is not waiting for activation, so it has no activation invitation to manage.');
  }
  return admin;
}

// Revokes the Admin's open activation invitations and issues a new one (valid 72 hours), all in
// one transaction with its audit event, then emails it. Returns
// { admin, invitation, revokedCount, emailDelivered, emailError }.
async function resendActivationInvitation({ email, now = new Date() } = {}) {
  const cleanEmail = normalizeAdminEmail(email);
  const config = loadAdminLockConfig();
  assertPortalUrlConfig(config); // fail before changing anything

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + config.invitationTtlMs);
  const operator = operatorIdentity();

  const done = await prisma.$transaction(async (tx) => {
    const admin = await findInvitedAdmin(tx, cleanEmail);

    // Touching the Admin row (only while still "invited") serialises concurrent resends and
    // re-checks the status atomically.
    const held = await tx.adminUser.updateMany({ where: { id: admin.id, status: 'invited' }, data: { updatedAt: now } });
    if (held.count !== 1) throw new InvitationOperatorError('not_invited', 'That admin is not waiting for activation.');

    const revoked = await tx.adminInvitation.updateMany({ where: { adminId: admin.id, ...OPEN_ACTIVATION }, data: { revokedAt: now } });
    const invitation = await tx.adminInvitation.create({
      data: { adminId: admin.id, purpose: ACTIVATION, tokenHash, sentToEmail: admin.email, expiresAt },
    });
    await recordAdminAuditEvent({
      actorType: 'operator',
      event: 'admin_invitation_resent',
      identifier: admin.email,
      detail: {
        adminId: admin.id,
        invitationId: invitation.id,
        revokedInvitationCount: revoked.count,
        invitationExpiresAt: expiresAt.toISOString(),
        operator,
      },
      db: tx,
    });
    return { admin, invitation, revokedCount: revoked.count };
  });

  const result = {
    admin: { id: done.admin.id, name: done.admin.name, email: done.admin.email, role: done.admin.role },
    invitation: { id: done.invitation.id, expiresAt },
    revokedCount: done.revokedCount,
    emailDelivered: false,
    emailError: null,
  };

  // Committed: a failed email keeps the new invitation (the old ones are already revoked).
  try {
    await sendMail(invitationMessage({
      to: done.admin.email,
      name: done.admin.name,
      role: done.admin.role,
      url: buildInvitationUrl(config.portalUrl, token),
      expiresAt,
    }));
    result.emailDelivered = true;
  } catch (err) {
    result.emailError = String(err?.message || 'unknown error').slice(0, 200);
  }
  return result;
}

// Marks every open (unused, unrevoked) activation invitation of an invited Admin as revoked.
// The Admin and the invitation rows are kept. Returns { admin, revokedCount }.
async function revokeActivationInvitation({ email, now = new Date() } = {}) {
  const cleanEmail = normalizeAdminEmail(email);
  const operator = operatorIdentity();

  return prisma.$transaction(async (tx) => {
    const admin = await findInvitedAdmin(tx, cleanEmail);
    const open = await tx.adminInvitation.findMany({ where: { adminId: admin.id, ...OPEN_ACTIVATION }, select: { id: true } });
    if (open.length === 0) {
      throw new InvitationOperatorError('no_open_invitation', 'That admin has no outstanding activation invitation to revoke.');
    }
    const ids = open.map((row) => row.id);
    // Conditional, so an invitation accepted a moment ago is not "revoked" after the fact.
    const revoked = await tx.adminInvitation.updateMany({ where: { id: { in: ids }, ...OPEN_ACTIVATION }, data: { revokedAt: now } });
    if (revoked.count !== ids.length) {
      throw new InvitationOperatorError('no_open_invitation', 'The invitation changed while revoking; nothing was revoked. Try again.');
    }
    await recordAdminAuditEvent({
      actorType: 'operator',
      event: 'admin_invitation_revoked',
      identifier: admin.email,
      detail: { adminId: admin.id, invitationIds: ids, revokedInvitationCount: ids.length, operator },
      db: tx,
    });
    return { admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role }, revokedCount: ids.length };
  });
}

// The email for a passkey-enrollment invitation. The link alone is not enough: the Admin must also
// enter their current password, and the message says so. Marked sensitive so the console mail
// provider never prints it.
function enrollmentInvitationMessage({ to, name, url, expiresAt }) {
  const expires = expiresAt.toUTCString();
  const text = [
    `Hello ${name},`,
    '',
    'Your HumanCare World Wide Admin account is ready except for one step: registering your passkey.',
    'Open this link and enter your current password when asked:',
    url,
    '',
    `The link can be used once and expires on ${expires}.`,
    'If you were not expecting this email, ignore it and tell your administrator.',
  ].join('\n');
  const escape = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<p>Hello ${escape(name)},</p>`
    + '<p>Your HumanCare World Wide Admin account is ready except for one step: registering your passkey.</p>'
    + `<p><a href="${escape(url)}">Finish setting up your passkey</a> (you will be asked for your current password).</p>`
    + `<p>The link can be used once and expires on ${escape(expires)}.<br>If you were not expecting this email, ignore it and tell your administrator.</p>`;
  return { to, subject: 'Finish setting up your HumanCare Admin passkey', text, html, sensitive: true };
}

// For an Admin who accepted their invitation (status "pending_passkey") but never registered a
// passkey - typically a lost or expired enrollment ticket. Revokes the Admin's open
// passkey-enrollment invitations and issues one new one (the approved 24-hour recovery lifetime),
// with its audit event, in one transaction; then emails it. It does not touch the password, the
// Admin's other invitations, or any passkey, and it is not passkey-loss recovery.
// Returns { admin, invitation, revokedCount, emailDelivered, emailError }.
async function resendPasskeyEnrollmentInvitation({ email, now = new Date() } = {}) {
  const cleanEmail = normalizeAdminEmail(email);
  const config = loadAdminLockConfig();
  assertPortalUrlConfig(config); // fail before changing anything

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + config.recoveryInvitationTtlMs);
  const operator = operatorIdentity();

  const done = await prisma.$transaction(async (tx) => {
    const found = await tx.adminUser.findUnique({ where: { email: cleanEmail } });
    if (!found) throw new InvitationOperatorError('admin_not_found', 'No admin with that email.');
    if (found.status !== PASSKEY_ENROLLMENT_STATUS) {
      throw new InvitationOperatorError('not_pending_passkey', 'That admin is not waiting to register a passkey, so a passkey-enrollment invitation does not apply.');
    }

    // Lock the Admin row (only while still pending): serialises concurrent resends and any
    // disable, password change or registration, then re-read what the decision depends on.
    const held = await tx.adminUser.updateMany({ where: { id: found.id, status: PASSKEY_ENROLLMENT_STATUS }, data: { updatedAt: now } });
    if (held.count !== 1) throw new InvitationOperatorError('not_pending_passkey', 'That admin is not waiting to register a passkey.');
    const admin = await tx.adminUser.findUnique({ where: { id: found.id } });
    if (!admin || admin.status !== PASSKEY_ENROLLMENT_STATUS) {
      throw new InvitationOperatorError('not_pending_passkey', 'That admin is not waiting to register a passkey.');
    }
    if (!admin.passwordHash) {
      throw new InvitationOperatorError('no_password', 'That admin has not set a password yet; use "resend" for the activation invitation instead.');
    }
    const livePasskeys = await tx.adminPasskey.count({ where: { adminId: admin.id, revokedAt: null } });
    if (livePasskeys > 0) {
      throw new InvitationOperatorError('has_passkey', 'That admin already has a passkey; lost-passkey recovery is a separate process.');
    }

    // Only this purpose: activation and passkey-recovery invitations are left alone.
    const revoked = await tx.adminInvitation.updateMany({ where: { adminId: admin.id, ...OPEN_ENROLLMENT }, data: { revokedAt: now } });
    const invitation = await tx.adminInvitation.create({
      data: { adminId: admin.id, purpose: PASSKEY_ENROLLMENT, tokenHash, sentToEmail: admin.email, expiresAt },
    });
    await recordAdminAuditEvent({
      actorType: 'operator',
      event: 'admin_passkey_enrollment_invitation_created',
      identifier: admin.email,
      detail: {
        adminId: admin.id,
        invitationId: invitation.id,
        revokedInvitationCount: revoked.count,
        invitationExpiresAt: expiresAt.toISOString(),
        operator,
      },
      db: tx,
    });
    return { admin, invitation, revokedCount: revoked.count };
  });

  const result = {
    admin: { id: done.admin.id, name: done.admin.name, email: done.admin.email, role: done.admin.role },
    invitation: { id: done.invitation.id, expiresAt },
    revokedCount: done.revokedCount,
    emailDelivered: false,
    emailError: null,
  };

  // Committed: a failed email keeps the new invitation (the earlier ones are already revoked).
  Object.assign(result, await deliverEnrollmentInvitation({ admin: done.admin, invitation: done.invitation, token, expiresAt, config, operator }));
  return result;
}

// Emails a passkey-enrollment link AFTER the transaction that created it has committed, so a mail
// failure can never undo or corrupt the stored state. Returns { emailDelivered, emailError }. The
// link and token exist only in memory here; on failure only ids are audited, never the error
// text, the link or the token.
async function deliverEnrollmentInvitation({ admin, invitation, token, expiresAt, config, operator }) {
  try {
    await sendMail(enrollmentInvitationMessage({
      to: admin.email,
      name: admin.name,
      url: buildInvitationUrl(config.portalUrl, token, ENROLLMENT_PATH),
      expiresAt,
    }));
    return { emailDelivered: true, emailError: null };
  } catch (err) {
    const emailError = String(err?.message || 'unknown error').slice(0, 200);
    try {
      await recordAdminAuditEvent({
        actorType: 'operator',
        event: 'admin_passkey_enrollment_invitation_delivery_failed',
        identifier: admin.email,
        detail: { adminId: admin.id, invitationId: invitation.id, operator },
      });
    } catch (auditErr) {
      console.error(`Could not record the delivery failure (${auditErr.code || auditErr.name}).`);
    }
    return { emailDelivered: false, emailError };
  }
}

const BEGIN_ENROLLMENT_SESSION_REVOKE_REASON = 'passkey_enrollment_required';
const OPEN_RECOVERY_STATUSES = ['pending', 'approved'];

// For an EXISTING Admin or Superadmin who is "active" with a password but no passkey (for example an
// account created before passkeys existed): moves them to "pending_passkey" and issues a
// passkey-enrollment invitation, in one transaction with its audit event; then emails the link.
// Operator-only (scripts/admin-invitation.js begin-enrollment) - there is no HTTP route, and no
// authenticated Admin is needed or possible: this Admin cannot hold a dashboard session.
//
//   - Requires status "active", a non-empty password hash and ZERO live passkeys; anything else is
//     refused (an Admin who already has a passkey must use passkey sign-in or recovery; an Admin
//     already "pending_passkey" uses "resend-enrollment").
//   - Changes only status, and passwordChangedAt when it is NULL (the enrollment and sign-in steps
//     need it; it is set to now and never overwritten). The password hash, id, name, email and
//     role are untouched.
//   - Ends every live session and refresh token of the Admin, so no earlier credential outlives the
//     status change.
//   - Refuses while a passkey-recovery request is open (it needs an active Admin and would be
//     orphaned): cancel it first with scripts/admin-recovery.js.
//   - Concurrency: the Admin row is locked FIRST, by a conditional UPDATE on "active" that is the
//     transaction's first statement; the preconditions (password, passkeys, recovery requests) are
//     read only afterwards, and the status change is conditional on "active" and the same password
//     hash. Two simultaneous runs cannot both succeed - the loser finds a "pending_passkey" Admin
//     and is refused - and only one invitation exists.
//   - The redemption still requires the link PLUS the current password, and the Admin is "active"
//     again only when a passkey is registered.
// Returns { admin, invitation, revokedSessions, revokedRefreshTokens, passwordChangedAtInitialized,
// emailDelivered, emailError }.
async function beginPasskeyEnrollment({ email, now = new Date() } = {}) {
  const cleanEmail = normalizeAdminEmail(email);
  const config = loadAdminLockConfig();
  assertPortalUrlConfig(config); // fail before changing anything

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + config.recoveryInvitationTtlMs);
  const operator = operatorIdentity();

  // Resolving the id is a plain read OUTSIDE the transaction: it only chooses which row to lock (an
  // Admin's id never changes). Nothing decided here is trusted - every fact is re-read under the lock.
  const target = await prisma.adminUser.findUnique({ where: { email: cleanEmail }, select: { id: true } });
  if (!target) throw new InvitationOperatorError('admin_not_found', 'No admin with that email.');

  const done = await prisma.$transaction(async (tx) => {
    // LOCK FIRST. The very first statement is the conditional UPDATE: a current read that takes the
    // Admin row lock only while the Admin is still "active" (the same order recovery request
    // creation and recovery registration use: Admin row first, no plain read before it). InnoDB
    // starts this transaction's read snapshot at its first plain read, so every read below happens
    // AFTER the lock and sees everything any other transaction committed before it. Anything that
    // could change what is read - a recovery request being created, a recovery passkey being
    // registered, a disable, a password change - needs this same Admin lock, so none can interleave.
    const held = await tx.adminUser.updateMany({ where: { id: target.id, status: 'active' }, data: { updatedAt: now } });
    if (held.count !== 1) {
      const current = await tx.adminUser.findUnique({ where: { id: target.id } });
      if (!current) throw new InvitationOperatorError('admin_not_found', 'No admin with that email.');
      throw new InvitationOperatorError(
        'not_active',
        current.status === PASSKEY_ENROLLMENT_STATUS
          ? 'That admin is already waiting to register a passkey; use "resend-enrollment" to send a new link.'
          : 'Only an active admin can begin passkey enrollment.',
      );
    }
    const notActive = () => new InvitationOperatorError('not_active', 'Only an active admin can begin passkey enrollment.');
    const admin = await tx.adminUser.findUnique({ where: { id: target.id } });
    if (!admin || admin.status !== 'active') throw notActive();
    if (typeof admin.passwordHash !== 'string' || !admin.passwordHash) {
      throw new InvitationOperatorError('no_password', 'That admin has no password; it cannot begin passkey enrollment.');
    }

    if ((await tx.adminPasskey.count({ where: { adminId: admin.id, revokedAt: null } })) > 0) {
      throw new InvitationOperatorError('has_passkey', 'That admin already has a passkey; they sign in with it, and lost-passkey recovery is a separate process.');
    }
    if ((await tx.adminRecoveryRequest.count({ where: { adminId: admin.id, status: { in: OPEN_RECOVERY_STATUSES } } })) > 0) {
      throw new InvitationOperatorError('recovery_open', 'That admin has an open passkey-recovery request; cancel it first.');
    }

    const initializePasswordChangedAt = !(admin.passwordChangedAt instanceof Date);
    const changed = await tx.adminUser.updateMany({
      where: { id: admin.id, status: 'active', passwordHash: admin.passwordHash },
      data: { status: PASSKEY_ENROLLMENT_STATUS, ...(initializePasswordChangedAt ? { passwordChangedAt: now } : {}) },
    });
    if (changed.count !== 1) throw notActive();

    // Updated first (a current read), then listed, so a sign-in that committed while this waited
    // for the Admin lock is not missed.
    const revokedSessions = await tx.adminSession.updateMany({
      where: { adminId: admin.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: BEGIN_ENROLLMENT_SESSION_REVOKE_REASON, revokedBy: null },
    });
    const sessionIds = (await tx.adminSession.findMany({ where: { adminId: admin.id } })).map((s) => s.id);
    let revokedRefreshTokens = 0;
    if (sessionIds.length > 0) {
      revokedRefreshTokens = (await tx.adminRefreshToken.updateMany({ where: { sessionId: { in: sessionIds }, revokedAt: null }, data: { revokedAt: now } })).count;
    }

    const revokedInvitations = await tx.adminInvitation.updateMany({ where: { adminId: admin.id, ...OPEN_ENROLLMENT }, data: { revokedAt: now } });
    const invitation = await tx.adminInvitation.create({
      data: { adminId: admin.id, purpose: PASSKEY_ENROLLMENT, tokenHash, sentToEmail: admin.email, expiresAt },
    });
    await recordAdminAuditEvent({
      actorType: 'operator',
      event: 'admin_passkey_enrollment_begun',
      identifier: admin.email,
      detail: {
        adminId: admin.id,
        invitationId: invitation.id,
        previousStatus: 'active',
        newStatus: PASSKEY_ENROLLMENT_STATUS,
        timestampInitialized: initializePasswordChangedAt,
        revokedSessionCount: revokedSessions.count,
        revokedRefreshCount: revokedRefreshTokens,
        revokedInvitationCount: revokedInvitations.count,
        invitationExpiresAt: expiresAt.toISOString(),
        operator,
      },
      db: tx,
    });
    return {
      admin, invitation, initializePasswordChangedAt, revokedSessions: revokedSessions.count, revokedRefreshTokens,
    };
  });

  const result = {
    admin: { id: done.admin.id, name: done.admin.name, email: done.admin.email, role: done.admin.role, status: PASSKEY_ENROLLMENT_STATUS },
    invitation: { id: done.invitation.id, expiresAt },
    revokedSessions: done.revokedSessions,
    revokedRefreshTokens: done.revokedRefreshTokens,
    passwordChangedAtInitialized: done.initializePasswordChangedAt,
    emailDelivered: false,
    emailError: null,
  };
  // Committed: a failed email keeps the new state and invitation; "resend-enrollment" can resend.
  Object.assign(result, await deliverEnrollmentInvitation({ admin: done.admin, invitation: done.invitation, token, expiresAt, config, operator }));
  return result;
}

module.exports = {
  beginPasskeyEnrollment,
  resendActivationInvitation,
  resendPasskeyEnrollmentInvitation,
  revokeActivationInvitation,
  InvitationOperatorError,
  ProvisioningError,
};
