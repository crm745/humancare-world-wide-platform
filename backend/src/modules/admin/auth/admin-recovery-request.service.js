// Operator-side lifecycle of an Admin passkey-recovery REQUEST (used by scripts/admin-recovery.js;
// there is deliberately no HTTP route): open one, look at one, cancel one. Approval, rejection,
// invitations and the new passkey are later steps - nothing here lets anyone regain access.
//
// A request names the Admin who lost their passkey (the target). It is created pending, for seven
// days, needing two approvals, and is never deleted: it is security history.
//
// Every change is ONE transaction that includes its audit event, so an audit failure rolls the
// change back. The target Admin's row is locked first when a request is created, and the request's
// own row when one is cancelled; counts that decide something are taken with UPDATE statements
// (InnoDB "current reads"), not plain SELECTs, because under REPEATABLE READ a plain SELECT could
// miss a request another operator committed a moment ago.
//
// The target is told by email AFTER the commit. The message carries no link, token or secret. A
// failed delivery never undoes the request; it is recorded in the audit trail (and shown by
// `status`) so it can be resent by a later step.
const { prisma } = require('../../../db/prisma');
const { sendMail } = require('../../../lib/mailer');
const { ADMIN_LOCK_POLICY } = require('./admin-lock.config');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const { ProvisioningError, normalizeAdminEmail, operatorIdentity } = require('./admin-provisioning.service');

const MAX_REASON_LENGTH = 500; // AdminRecoveryRequest.reason is VARCHAR(500)
const REQUESTED_VIA_OPERATOR = 'operator';
const APPROVALS_REQUIRED = 2;
// A request that has not reached a final state. (An "approved" one is waiting for its invitation
// to be used.)
const OPEN_STATUSES = Object.freeze(['pending', 'approved']);
const RECOVERY_INVITATION_PURPOSE = 'passkey_recovery';
const REQUESTED_VIA_BREAK_GLASS = 'break_glass';

const EVENTS = Object.freeze({
  requested: 'admin_recovery_requested',
  expired: 'admin_recovery_expired',
  cancelled: 'admin_recovery_cancelled',
  notificationSent: 'admin_recovery_notification_sent',
  notificationFailed: 'admin_recovery_notification_failed',
  breakGlass: 'admin_recovery_break_glass',
  invitationResent: 'admin_recovery_invitation_resent',
  invitationSent: 'admin_recovery_invitation_sent',
  invitationDeliveryFailed: 'admin_recovery_invitation_delivery_failed',
});

function assertRoot(db) {
  if (!db || typeof db.$transaction !== 'function') throw new TypeError('db must be a root Prisma client');
}

function normalizeRecoveryReason(value) {
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

// A request id as typed on the command line: a plain positive whole number.
function parseRequestId(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d{0,9}$/.test(text)) {
    throw new ProvisioningError('invalid_request_id', 'The request id must be a positive whole number.');
  }
  return Number(text);
}

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
};

const isPastDeadline = (request, now) => !(request.expiresAt instanceof Date) || request.expiresAt.getTime() <= now.getTime();

// An eligible recovery approver: an ACTIVE Admin with role "superadmin" and at least one live
// (non-revoked) passkey - the approver must be able to pass the passkey step-up - who is not the
// target. This is the one definition; `createRecoveryRequest` (a warning) and `breakGlassRecovery`
// (a transactional gate) both use it. Plain reads: callers that must be exact re-check under locks.
async function countEligibleApprovers(client, targetId) {
  const superadmins = await client.adminUser.findMany({ where: { role: 'superadmin', status: 'active', id: { not: targetId } } });
  let eligible = 0;
  for (const row of superadmins) {
    if ((await client.adminPasskey.count({ where: { adminId: row.id, revokedAt: null } })) > 0) eligible += 1;
  }
  return eligible;
}

// Revokes the live (unused, unrevoked, unexpired) recovery invitations matching `where` and returns
// how many there were. Used and already-revoked ones are history and stay as they are; an expired
// one stays "expired". Runs in the caller's transaction.
async function revokeLiveRecoveryInvitations(tx, where, now) {
  const revoked = await tx.adminInvitation.updateMany({
    where: { ...where, purpose: RECOVERY_INVITATION_PURPOSE, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
  });
  return revoked.count;
}

function requestedMessage({ to, name, requestId, expiresAt }) {
  const expires = expiresAt.toUTCString();
  const text = [
    `Hello ${name},`,
    '',
    'A passkey recovery was requested for your HumanCare World Wide Admin account.',
    `Reference: ${requestId}`,
    'Two other administrators must approve it before you receive any further instructions by email.',
    `The request expires on ${expires} if it is not approved by then.`,
    '',
    'You do not need to do anything now. If you did not expect this, tell your administrator straight away.',
  ].join('\n');
  const escape = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<p>Hello ${escape(name)},</p>`
    + '<p>A passkey recovery was requested for your HumanCare World Wide Admin account.<br>'
    + `Reference: ${escape(requestId)}</p>`
    + '<p>Two other administrators must approve it before you receive any further instructions by email.<br>'
    + `The request expires on ${escape(expires)} if it is not approved by then.</p>`
    + '<p>You do not need to do anything now. If you did not expect this, tell your administrator straight away.</p>';
  return { to, subject: 'A passkey recovery was requested for your HumanCare Admin account', text, html };
}

// Opens a recovery request for the Admin with this exact (normalised) email.
//
//  - The target must be "active" (invited, pending_passkey and disabled accounts are refused). It
//    may or may not have a passkey registered.
//  - At most one open (pending or approved) request per target, enforced under the target's row
//    lock, so two operators racing cannot both create one. Requests already past their deadline
//    are first marked "expired" so they cannot block a new one.
//  - Created with requestedByAdminId null, requestedVia "operator", status "pending", two approvals
//    required, expiring seven days after `now`. `ipAddress` is stored only if given (a command-line
//    operator has none).
//
// Returns { request: { id, status, expiresAt }, admin: { id, name, email }, eligibleApprovers,
// emailDelivered, emailError }. `eligibleApprovers` is how many OTHER active superadmins with a live passkey exist now
// (information only: fewer than two means this request cannot be approved and break-glass is
// needed). Throws ProvisioningError: invalid_email, invalid_reason, admin_not_found,
// target_not_active, open_request_exists. Database and audit failures propagate; nothing is kept.
async function createRecoveryRequest({ email, reason, ipAddress = null, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const cleanEmail = normalizeAdminEmail(email);
  const cleanReason = normalizeRecoveryReason(reason);
  const operator = operatorIdentity();
  const expiresAt = new Date(now.getTime() + ADMIN_LOCK_POLICY.recoveryRequestTtlMs);

  const done = await db.$transaction(async (tx) => {
    const found = await tx.adminUser.findUnique({ where: { email: cleanEmail } });
    if (!found) throw new ProvisioningError('admin_not_found', 'No admin with that email.');

    // Lock the target - only while it is active. Everything below happens under this lock, and a
    // concurrent disable, password change or competing request waits for it.
    const held = await tx.adminUser.updateMany({ where: { id: found.id, status: 'active' }, data: { updatedAt: now } });
    if (held.count !== 1) {
      const current = await tx.adminUser.findUnique({ where: { id: found.id } });
      const state = current ? current.status : 'unknown';
      throw new ProvisioningError('target_not_active', `Only an active admin can start a recovery; that admin is "${state}".`);
    }
    const admin = await tx.adminUser.findUnique({ where: { id: found.id } });

    // Requests whose deadline has passed are over, whatever their stored status says.
    const expired = await tx.adminRecoveryRequest.updateMany({
      where: { adminId: admin.id, status: { in: [...OPEN_STATUSES] }, expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    if (expired.count > 0) {
      await recordAdminAuditEvent({
        actorType: 'operator',
        event: EVENTS.expired,
        identifier: admin.email,
        detail: { adminId: admin.id, count: expired.count, expiredAt: now.toISOString(), trigger: 'new_request', operator },
        db: tx,
      });
    }

    // Any request still open, counted with an UPDATE (a current read that also locks them).
    const open = await tx.adminRecoveryRequest.updateMany({
      where: { adminId: admin.id, status: { in: [...OPEN_STATUSES] } },
      data: { updatedAt: now },
    });
    if (open.count > 0) {
      throw new ProvisioningError('open_request_exists', 'That admin already has an open recovery request. Cancel it first, or wait for it to finish.');
    }

    const livePasskeys = await tx.adminPasskey.count({ where: { adminId: admin.id, revokedAt: null } });
    const eligibleApprovers = await countEligibleApprovers(tx, admin.id);

    const request = await tx.adminRecoveryRequest.create({
      data: {
        adminId: admin.id,
        requestedByAdminId: null,
        requestedVia: REQUESTED_VIA_OPERATOR,
        requestIp: clip(ipAddress, 64),
        reason: cleanReason,
        status: 'pending',
        approvalsRequired: APPROVALS_REQUIRED,
        expiresAt,
        createdAt: now,
      },
    });

    await recordAdminAuditEvent({
      actorType: 'operator',
      event: EVENTS.requested,
      identifier: admin.email,
      ipAddress,
      detail: {
        adminId: admin.id,
        recoveryRequestId: request.id,
        reason: cleanReason,
        requestedVia: REQUESTED_VIA_OPERATOR,
        approvalsRequired: APPROVALS_REQUIRED,
        expiresAt: expiresAt.toISOString(),
        hasLivePasskey: livePasskeys > 0,
        operator,
      },
      db: tx,
    });
    return { admin, request, eligibleApprovers };
  });

  const result = {
    request: { id: done.request.id, status: 'pending', expiresAt },
    admin: { id: done.admin.id, name: done.admin.name, email: done.admin.email },
    eligibleApprovers: done.eligibleApprovers,
    emailDelivered: false,
    emailError: null,
  };

  // Committed. A failed notification must not undo or hide the request.
  const outcomeEvent = async (event) => {
    try {
      await recordAdminAuditEvent({
        actorType: 'operator',
        event,
        identifier: done.admin.email,
        detail: { adminId: done.admin.id, recoveryRequestId: done.request.id, operator },
      });
    } catch (auditErr) {
      // Ids only, never the error text.
      console.error(`Could not record the recovery notification outcome (${auditErr.code || auditErr.name}).`);
    }
  };
  try {
    await sendMail(requestedMessage({ to: done.admin.email, name: done.admin.name, requestId: done.request.id, expiresAt }));
    result.emailDelivered = true;
    await outcomeEvent(EVENTS.notificationSent);
  } catch (err) {
    result.emailError = String(err?.message || 'unknown error').slice(0, 200);
    await outcomeEvent(EVENTS.notificationFailed);
  }
  return result;
}

// Cancels a request that has not reached a final state: pending, or approved with its invitation
// not yet used. Any live invitation of the request is revoked in the same transaction, so a
// cancelled request leaves no usable link behind. Completed, rejected, expired and already
// cancelled requests (and an open one past its deadline) are refused. The request row is locked
// first - only while still open - so two cancellations, or a cancellation racing a decision or a
// redemption, cannot both act; the status is then checked again in the update itself.
// Returns { request: { id, status: 'cancelled' }, admin: { id, email }, revokedInvitations }.
// Throws ProvisioningError: invalid_request_id, invalid_reason, request_not_found, not_pending.
async function cancelRecoveryRequest({ id, reason, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const requestId = parseRequestId(id);
  const cleanReason = normalizeRecoveryReason(reason);
  const operator = operatorIdentity();

  return db.$transaction(async (tx) => {
    // First statement of the transaction: the lock, before anything is read.
    const held = await tx.adminRecoveryRequest.updateMany({ where: { id: requestId, status: { in: [...OPEN_STATUSES] } }, data: { updatedAt: now } });
    const request = await tx.adminRecoveryRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new ProvisioningError('request_not_found', 'No recovery request with that id.');
    if (held.count !== 1) {
      throw new ProvisioningError('not_pending', `Only a pending or approved request can be cancelled; request ${requestId} is "${request.status}".`);
    }
    if (isPastDeadline(request, now)) {
      throw new ProvisioningError('not_pending', `Only a pending or approved request can be cancelled; request ${requestId} has expired.`);
    }

    const cancelled = await tx.adminRecoveryRequest.updateMany({ where: { id: requestId, status: { in: [...OPEN_STATUSES] } }, data: { status: 'cancelled' } });
    if (cancelled.count !== 1) throw new ProvisioningError('not_pending', `Only a pending or approved request can be cancelled; request ${requestId} is no longer open.`);
    const revokedInvitations = await revokeLiveRecoveryInvitations(tx, { recoveryRequestId: requestId }, now);

    const admin = await tx.adminUser.findUnique({ where: { id: request.adminId } });
    await recordAdminAuditEvent({
      actorType: 'operator',
      event: EVENTS.cancelled,
      identifier: admin ? admin.email : null,
      detail: {
        adminId: request.adminId,
        recoveryRequestId: requestId,
        reason: cleanReason,
        previousStatus: request.status,
        revokedInvitationCount: revokedInvitations,
        cancelledAt: now.toISOString(),
        operator,
      },
      db: tx,
    });
    return { request: { id: requestId, status: 'cancelled' }, admin: { id: request.adminId, email: admin ? admin.email : null }, revokedInvitations };
  });
}

// The recovery invitations of one request, newest last, reduced to their state - never a token, a
// hash or the address. `state` of the newest is "live", "used", "revoked" or "expired" (revoked
// wins over expired, used over both); `replacements` counts the invitations after the first;
// `delivery` is the newest recorded outcome for that invitation, or "unknown".
async function describeInvitation(db, request, now) {
  const rows = (await db.adminInvitation.findMany({ where: { recoveryRequestId: request.id, purpose: RECOVERY_INVITATION_PURPOSE } }))
    .sort((a, b) => a.id - b.id);
  if (rows.length === 0) return null;
  const latest = rows.at(-1);
  const state = latest.usedAt ? 'used'
    : latest.revokedAt ? 'revoked'
      : latest.expiresAt instanceof Date && latest.expiresAt.getTime() > now.getTime() ? 'live' : 'expired';
  const outcomes = (await db.securityEvent.findMany({ where: { event: { in: [EVENTS.invitationSent, EVENTS.invitationDeliveryFailed] } } }))
    .filter((e) => e.detail && e.detail.invitationId === latest.id && e.detail.recoveryRequestId === request.id);
  const outcome = outcomes.at(-1);
  return {
    id: latest.id,
    state,
    expiresAt: latest.expiresAt,
    total: rows.length,
    replacements: rows.length - 1,
    liveCount: rows.filter((r) => !r.usedAt && !r.revokedAt && r.expiresAt instanceof Date && r.expiresAt.getTime() > now.getTime()).length,
    delivery: !outcome ? 'unknown' : outcome.event === EVENTS.invitationSent ? 'delivered' : 'failed',
  };
}

// What the operator needs to know about one request, and nothing sensitive: no token or hash (there
// are none on a request), no IP address, no passkey or credential data, no password data.
async function describeRequest(db, request, now) {
  const admin = await db.adminUser.findUnique({ where: { id: request.adminId } });
  const [approved, rejected] = await Promise.all([
    db.adminRecoveryApproval.count({ where: { requestId: request.id, decision: 'approved' } }),
    db.adminRecoveryApproval.count({ where: { requestId: request.id, decision: 'rejected' } }),
  ]);

  // Who filed / cancelled it, and whether the target was told, come from the operator audit trail.
  const events = admin
    ? await db.securityEvent.findMany({
      where: { actorType: 'operator', identifier: admin.email, event: { in: Object.values(EVENTS) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    : [];
  const mine = events.filter((e) => e.detail && e.detail.recoveryRequestId === request.id);
  const last = (event) => mine.filter((e) => e.event === event).at(-1);
  const filed = last(EVENTS.requested) || last(EVENTS.breakGlass);
  const cancelledEvent = last(EVENTS.cancelled);
  const notice = mine.filter((e) => e.event === EVENTS.notificationSent || e.event === EVENTS.notificationFailed).at(-1);

  const safeOperator = (event) => {
    const op = event && event.detail && event.detail.operator;
    return op ? { username: op.username ?? null, hostname: op.hostname ?? null } : null;
  };

  return {
    id: request.id,
    status: request.status,
    pastDeadline: OPEN_STATUSES.includes(request.status) && isPastDeadline(request, now),
    reason: request.reason ?? null,
    admin: admin ? { id: admin.id, name: admin.name, email: admin.email, status: admin.status } : { id: request.adminId },
    requestedVia: request.requestedVia,
    requestedByAdminId: request.requestedByAdminId ?? null,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    approvedAt: request.approvedAt ?? null,
    completedAt: request.completedAt ?? null,
    approvalsRequired: request.approvalsRequired,
    approvals: { approved, rejected },
    filedBy: safeOperator(filed),
    cancelledBy: safeOperator(cancelledEvent),
    notification: !notice ? 'unknown' : notice.event === EVENTS.notificationSent ? 'delivered' : 'failed',
    invitation: await describeInvitation(db, request, now),
  };
}

// One request by id, or the most recent requests of the Admin with an exact email (newest first,
// at most `limit`). Read-only. Throws ProvisioningError: invalid_request_id, invalid_email,
// request_not_found, admin_not_found.
async function getRecoveryRequestStatus({ id, email, limit = 5, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  if ((id === undefined) === (email === undefined)) {
    throw new ProvisioningError('bad_arguments', 'Give either a request id or an email.');
  }

  if (id !== undefined) {
    const request = await db.adminRecoveryRequest.findUnique({ where: { id: parseRequestId(id) } });
    if (!request) throw new ProvisioningError('request_not_found', 'No recovery request with that id.');
    return [await describeRequest(db, request, now)];
  }

  const admin = await db.adminUser.findUnique({ where: { email: normalizeAdminEmail(email) } });
  if (!admin) throw new ProvisioningError('admin_not_found', 'No admin with that email.');
  const requests = (await db.adminRecoveryRequest.findMany({ where: { adminId: admin.id } }))
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
  return Promise.all(requests.map((request) => describeRequest(db, request, now)));
}

// The open recovery requests a superadmin can still act on, for the approval screen. Read-only.
// A request is listed only while it is "pending" and unexpired, its target is still an active Admin,
// and the caller is neither the target, nor the Admin who filed it, nor someone who has already
// decided on it - the same conditions the decision service enforces, so everything listed is
// something the caller can actually approve or reject (the service still re-checks on every call).
// Oldest deadline first, at most `limit`. Only these fields leave: the reference, status, reason,
// dates, approval counts and the target's id, name and email. No invitation, token, hash,
// password, passkey, challenge, session, IP address or audit data is read, let alone returned.
// Callers have already established that `approverId` is an active superadmin.
async function listDecidableRequests({ approverId, limit = 50, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  if (!Number.isInteger(approverId) || approverId <= 0) throw new TypeError('approverId must be a positive integer');

  const open = (await db.adminRecoveryRequest.findMany({
    where: { status: 'pending', expiresAt: { gt: now } },
    orderBy: { expiresAt: 'asc' },
    take: 200,
  })).filter((r) => r.adminId !== approverId && r.requestedByAdminId !== approverId);

  const listed = [];
  for (const request of open.sort((a, b) => a.expiresAt - b.expiresAt || a.id - b.id)) {
    const target = await db.adminUser.findUnique({ where: { id: request.adminId } });
    if (!target || target.status !== 'active') continue;
    const decisions = await db.adminRecoveryApproval.findMany({ where: { requestId: request.id } });
    if (decisions.some((d) => d.approverId === approverId)) continue;
    listed.push({
      id: request.id,
      status: request.status,
      reason: request.reason ?? null,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      approvalsReceived: decisions.filter((d) => d.decision === 'approved').length,
      approvalsRequired: request.approvalsRequired,
      target: { id: target.id, name: target.name, email: target.email },
    });
    if (listed.length >= limit) break;
  }
  return listed;
}

module.exports = {
  listDecidableRequests,
  RECOVERY_INVITATION_PURPOSE,
  REQUESTED_VIA_BREAK_GLASS,
  OPEN_STATUSES,
  revokeLiveRecoveryInvitations,
  countEligibleApprovers,
  createRecoveryRequest,
  cancelRecoveryRequest,
  getRecoveryRequestStatus,
  normalizeRecoveryReason,
  parseRequestId,
  isPastDeadline,
  RECOVERY_REQUEST_EVENTS: EVENTS,
};
