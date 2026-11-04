// Operator-side Admin disable / re-enable (used by scripts/admin-account.js; there is deliberately
// no HTTP route). An account is never deleted: disabling is a status change plus the end of every
// live session, and enabling is the reverse of the status change only.
//
// Both operations are ONE transaction that includes the audit event, so an audit (or any other)
// failure rolls the whole change back and nothing is half done. The Admin row is locked first (a
// write of the value it already has), which serialises concurrent disable / enable / login
// attempts on the same account: a login that is committing a session when a disable starts is
// finished first, and the disable then revokes that session too.
//
// What these deliberately do NOT do:
//  - delete or revoke passkeys (they survive a disable / enable round trip untouched);
//  - restore revoked sessions or refresh tokens, or create any session or token;
//  - touch the password, activation / enrollment invitations or WebAuthn challenges.
// What a disable DOES do to passkey recovery: the Admin's open (pending or approved) recovery
// requests are cancelled and their live passkey_recovery invitations revoked, in the same
// transaction as the status change and its audit event (see cancelRecoveryForDisabledAdmin). Completed,
// rejected, expired and already-cancelled requests are history and stay as they are.
//  - print or audit any secret.
const { prisma } = require('../../../db/prisma');
const { ProvisioningError, normalizeAdminEmail, operatorIdentity } = require('./admin-provisioning.service');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const {
  OPEN_STATUSES,
  RECOVERY_REQUEST_EVENTS,
  revokeLiveRecoveryInvitations,
} = require('./admin-recovery-request.service');

const MAX_REASON_LENGTH = 255; // AdminUser.disabledReason is VARCHAR(255)
const SESSION_REVOKE_REASON = 'account_disabled';
const DISABLED_EVENT = 'admin_account_disabled';
const ENABLED_EVENT = 'admin_account_enabled';
const RECOVERY_CANCEL_REASON = 'Admin account disabled';

function assertRoot(db) {
  if (!db || typeof db.$transaction !== 'function') throw new TypeError('db must be a root Prisma client');
}

function normalizeDisableReason(value) {
  if (typeof value !== 'string') throw new ProvisioningError('invalid_reason', 'A reason is required.');
  const reason = value.trim().replace(/\s+/g, ' ');
  if (!reason) throw new ProvisioningError('invalid_reason', 'A reason is required.');
  if (reason.length > MAX_REASON_LENGTH) {
    throw new ProvisioningError('invalid_reason', `The reason must be at most ${MAX_REASON_LENGTH} characters.`);
  }
  if (/[\p{Cc}<>]/u.test(reason)) {
    throw new ProvisioningError('invalid_reason', 'The reason must not contain control characters, "<" or ">".');
  }
  return reason;
}

// Finds the Admin by exact email and takes its row lock; returns the fresh row. Throws if the
// account does not exist.
async function lockAdminByEmail(tx, email, now) {
  const found = await tx.adminUser.findUnique({ where: { email } });
  if (!found) throw new ProvisioningError('admin_not_found', 'No admin with that email.');
  const held = await tx.adminUser.updateMany({ where: { id: found.id }, data: { updatedAt: now } });
  if (held.count !== 1) throw new ProvisioningError('admin_not_found', 'No admin with that email.');
  const admin = await tx.adminUser.findUnique({ where: { id: found.id } });
  if (!admin) throw new ProvisioningError('admin_not_found', 'No admin with that email.');
  return admin;
}

// Refuses to disable the last active superadmin (nobody could then manage Admin accounts or the
// sensitive settings). Runs inside the disable transaction and does nothing for any other role.
//
// Locking the target alone is not enough: two operators disabling two DIFFERENT superadmins would
// each lock their own row, each see "one other active superadmin", and both commit. So, for a
// superadmin target:
//   1. read the candidate ids (a plain read; it only chooses what to lock);
//   2. lock every active superadmin row, one UPDATE per row, in ASCENDING id order, the target
//      included - a concurrent disable queues behind the first row it needs, so there is no
//      deadlock, and the second one only continues once the first has committed;
//   3. count the active superadmins with one more UPDATE. An UPDATE is a "current read" in InnoDB:
//      it sees rows committed after this transaction's snapshot, which a plain SELECT under
//      REPEATABLE READ would not. That count is therefore taken after, and sees, the other
//      operator's commit.
// If the target is among the active superadmins and is the only one, nothing is changed.
// The lock writes store the value the row already has (apart from updatedAt); the transaction
// is rolled back when it throws.
async function guardLastActiveSuperadmin(tx, email, now) {
  const target = await tx.adminUser.findUnique({ where: { email } });
  if (!target || target.role !== 'superadmin') return;

  const candidates = await tx.adminUser.findMany({ where: { role: 'superadmin', status: 'active' } });
  const ids = [...new Set([...candidates.map((row) => row.id), target.id])].sort((a, b) => a - b);

  let targetIsActive = false;
  for (const id of ids) {
    const held = await tx.adminUser.updateMany({
      where: { id, role: 'superadmin', status: 'active' },
      data: { updatedAt: now },
    });
    if (id === target.id) targetIsActive = held.count === 1;
  }
  if (!targetIsActive) return; // not an active superadmin any more (or never): nothing to protect

  const remaining = await tx.adminUser.updateMany({
    where: { role: 'superadmin', status: 'active' },
    data: { updatedAt: now },
  });
  if (remaining.count <= 1) {
    throw new ProvisioningError('last_active_superadmin', 'That admin is the last active superadmin and cannot be disabled.');
  }
}

// Ends the Admin's open passkey recovery, inside the disable transaction (any failure here rolls the
// whole disable back):
//   - open requests already past their deadline become "expired" (that is what they are);
//   - the other open requests (pending or approved) become "cancelled", each with its own operator
//     audit event (the same event `cancel` writes, so `status` shows who and why);
//   - every live passkey_recovery invitation of the Admin is revoked (those of a cancelled request
//     first, then any left over). Used, revoked and expired invitations are history.
// Returns { cancelledRequests, expiredRequests, revokedInvitations }.
async function cancelRecoveryForDisabledAdmin(tx, admin, now, operator) {
  const expired = await tx.adminRecoveryRequest.updateMany({
    where: { adminId: admin.id, status: { in: [...OPEN_STATUSES] }, expiresAt: { lte: now } },
    data: { status: 'expired' },
  });

  // The Admin row is locked, so no request can be added or decided from here on. But this
  // transaction's snapshot may predate a request committed while it waited for that lock, and a plain
  // read would not see it. An UPDATE is a current read: it locks the open requests and makes them
  // visible to the read below.
  await tx.adminRecoveryRequest.updateMany({ where: { adminId: admin.id, status: { in: [...OPEN_STATUSES] } }, data: { updatedAt: now } });
  const open = await tx.adminRecoveryRequest.findMany({ where: { adminId: admin.id, status: { in: [...OPEN_STATUSES] } } });
  let revokedInvitations = 0;
  let cancelledRequests = 0;
  for (const request of open.sort((a, b) => a.id - b.id)) {
    const cancelled = await tx.adminRecoveryRequest.updateMany({
      where: { id: request.id, adminId: admin.id, status: { in: [...OPEN_STATUSES] } },
      data: { status: 'cancelled' },
    });
    if (cancelled.count !== 1) continue; // decided by someone else meanwhile: nothing left to cancel
    cancelledRequests += 1;
    const revoked = await revokeLiveRecoveryInvitations(tx, { recoveryRequestId: request.id }, now);
    revokedInvitations += revoked;
    await recordAdminAuditEvent({
      actorType: 'operator',
      event: RECOVERY_REQUEST_EVENTS.cancelled,
      identifier: admin.email,
      detail: {
        adminId: admin.id,
        recoveryRequestId: request.id,
        reason: RECOVERY_CANCEL_REASON,
        cause: 'admin_disabled',
        previousStatus: request.status,
        revokedInvitationCount: revoked,
        cancelledAt: now.toISOString(),
        operator,
      },
      db: tx,
    });
  }
  revokedInvitations += await revokeLiveRecoveryInvitations(tx, { adminId: admin.id }, now);
  return { cancelledRequests, expiredRequests: expired.count, revokedInvitations };
}

// Disables the account, ends all of its sessions and ends its open passkey recovery. Returns
// { admin: { id, email, status }, revokedSessions, revokedRefreshTokens, cancelledRecoveryRequests,
//   revokedRecoveryInvitations }.
// Throws ProvisioningError: invalid_email, invalid_reason, admin_not_found, already_disabled,
// last_active_superadmin.
async function disableAdminAccount({ email, reason, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const cleanEmail = normalizeAdminEmail(email);
  const cleanReason = normalizeDisableReason(reason);
  const operator = operatorIdentity();

  return db.$transaction(async (tx) => {
    // Lock order (the same as every recovery transaction): Admin rows first, ascending - when the
    // target is a superadmin, all active superadmins including it; then the target - and only then
    // the target's recovery requests (cancelRecoveryForDisabledAdmin below). Two disables can never
    // deadlock or both slip past the last-superadmin check.
    await guardLastActiveSuperadmin(tx, cleanEmail, now);

    const admin = await lockAdminByEmail(tx, cleanEmail, now);
    if (admin.status === 'disabled') throw new ProvisioningError('already_disabled', 'That admin is already disabled.');

    // `disabledBy` is a plain Admin id. The operator running a script is not an Admin account, so
    // it stays null; who did it is in the audit event (operator identity).
    const changed = await tx.adminUser.updateMany({
      where: { id: admin.id, status: { not: 'disabled' } },
      data: { status: 'disabled', disabledAt: now, disabledReason: cleanReason, disabledBy: null },
    });
    if (changed.count !== 1) throw new ProvisioningError('already_disabled', 'That admin is already disabled.');

    // Every live session of this Admin, then every still-valid refresh token of all its sessions
    // (including tokens left on a session that was already revoked).
    // The sessions are revoked with an UPDATE FIRST, not found with a plain read: this transaction's
    // snapshot may predate a sign-in that committed while it waited for the Admin lock, and a plain
    // read would miss that session (it would then survive the disable and work again after a
    // re-enable). An UPDATE is a current read, and the rows it changes are visible to the reads below.
    const revokedSessions = await tx.adminSession.updateMany({
      where: { adminId: admin.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: SESSION_REVOKE_REASON, revokedBy: null },
    });
    const liveSessionCount = revokedSessions.count;
    const sessions = await tx.adminSession.findMany({ where: { adminId: admin.id } });
    const sessionIds = sessions.map((s) => s.id);
    let revokedRefreshTokens = 0;
    if (sessionIds.length > 0) {
      const tokens = await tx.adminRefreshToken.updateMany({ where: { sessionId: { in: sessionIds }, revokedAt: null }, data: { revokedAt: now } });
      revokedRefreshTokens = tokens.count;
    }

    // The Admin is disabled and locked: no new request can start, none can be approved or redeemed.
    const recovery = await cancelRecoveryForDisabledAdmin(tx, admin, now, operator);

    await recordAdminAuditEvent({
      actorType: 'operator',
      event: DISABLED_EVENT,
      identifier: admin.email,
      detail: {
        adminId: admin.id,
        reason: cleanReason,
        previousStatus: admin.status,
        disabledAt: now.toISOString(),
        sessionCount: liveSessionCount,
        cancelledRecoveryRequests: recovery.cancelledRequests,
        expiredRecoveryRequests: recovery.expiredRequests,
        revokedRecoveryInvitations: recovery.revokedInvitations,
        operator,
      },
      db: tx,
    });

    return {
      admin: { id: admin.id, email: admin.email, status: 'disabled' },
      revokedSessions: liveSessionCount,
      revokedRefreshTokens,
      cancelledRecoveryRequests: recovery.cancelledRequests,
      revokedRecoveryInvitations: recovery.revokedInvitations,
    };
  });
}

// The status the account had when the CLI disabled it, from the audit trail, or null (an account
// disabled some other way, or whose event has been purged).
async function statusBeforeDisable(tx, admin) {
  const event = await tx.securityEvent.findFirst({
    where: { event: DISABLED_EVENT, actorType: 'operator', identifier: admin.email },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const detail = event && event.detail;
  if (!detail || detail.adminId !== admin.id) return null;
  return typeof detail.previousStatus === 'string' ? detail.previousStatus : null;
}

// Re-enables a disabled account. The status goes back to "active" - except where "active" would
// be untrue or would open a password-only door:
//   - no password yet                      -> "invited"        (it must still be activated);
//   - a live passkey                       -> "active";
//   - password, no passkey, and the audit trail says it was "pending_passkey" when disabled
//                                          -> "pending_passkey" (it never finished enrollment);
//   - anything else (a pre-existing Admin with a password and no passkey) -> "active".
// The password, the passkeys and all history are kept; the disabled-metadata columns are cleared
// (the disable event stays in the audit trail); no session or token is created. Returns
// { admin: { id, email, status }, previousStatus, statusSource }.
// Throws ProvisioningError: invalid_email, admin_not_found, not_disabled.
async function enableAdminAccount({ email, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const cleanEmail = normalizeAdminEmail(email);
  const operator = operatorIdentity();

  return db.$transaction(async (tx) => {
    const admin = await lockAdminByEmail(tx, cleanEmail, now);
    if (admin.status !== 'disabled') throw new ProvisioningError('not_disabled', 'That admin is not disabled.');

    let status = 'active';
    let statusSource = 'default';
    if (typeof admin.passwordHash !== 'string' || !admin.passwordHash) {
      status = 'invited';
      statusSource = 'no_password';
    } else if ((await tx.adminPasskey.count({ where: { adminId: admin.id, revokedAt: null } })) > 0) {
      statusSource = 'live_passkey';
    } else if ((await statusBeforeDisable(tx, admin)) === 'pending_passkey') {
      status = 'pending_passkey';
      statusSource = 'audit_trail';
    }

    const changed = await tx.adminUser.updateMany({
      where: { id: admin.id, status: 'disabled' },
      data: { status, disabledAt: null, disabledReason: null, disabledBy: null },
    });
    if (changed.count !== 1) throw new ProvisioningError('not_disabled', 'That admin is not disabled.');

    await recordAdminAuditEvent({
      actorType: 'operator',
      event: ENABLED_EVENT,
      identifier: admin.email,
      detail: { adminId: admin.id, newStatus: status, statusSource, enabledAt: now.toISOString(), operator },
      db: tx,
    });

    return { admin: { id: admin.id, email: admin.email, status }, previousStatus: 'disabled', statusSource };
  });
}

module.exports = { disableAdminAccount, enableAdminAccount, normalizeDisableReason, DISABLED_EVENT, ENABLED_EVENT };
