// Two-person approval of an Admin passkey recovery: the approver's passkey step-up, the approval or
// rejection, and - on the second approval - the recovery invitation. Service layer only: there is
// no HTTP route, and redeeming the invitation / registering the new passkey are later steps.
//
// WHO may decide: an active Admin with role "superadmin" who is neither the target of the request
// nor the Admin who filed it, signed in with a live database-backed session, who proves possession
// of one of their OWN passkeys for this exact request. Approving and rejecting are separate
// step-ups (challenge purposes recovery_approval / recovery_rejection), each bound to the approver,
// the request and the session, so neither can authorise the other, and a challenge for one request
// or session is useless for any other.
//
// Order of an attempt (the same shape as the sign-in's passkey step):
//   1. read-only checks (request open, approver eligible, not decided yet, session live) - an
//      ineligible caller never burns a challenge;
//   2. CONSUME the challenge - final, committed on its own: a failed assertion burns it;
//   3. verify the assertion with the shared verifier (no session or token is created);
//   4. ONE transaction that locks, re-validates everything, advances the passkey counter, records
//      the decision, applies the outcome and writes the audit event. Any failure rolls all of it
//      back.
//
// Locking (the same order everywhere, so concurrent decisions queue instead of deadlocking; it is
// also the order of request creation, break-glass, resend, disable and redemption):
//   Admin rows in ascending id order (approver, target, earlier approvers) - the FIRST statements,
//   chosen from a read taken before the transaction
//   -> the request row (so every later read sees what earlier decisions committed)
//   -> any earlier approver who appeared meanwhile (rare; still ascending)
//   -> the approver's session row.
// Admin eligibility is checked with UPDATE ... WHERE statements (current reads), never with plain
// SELECTs, which under REPEATABLE READ could show a role or status that changed a moment ago.
//
// The target's passkeys, password, sessions and failed-login counter are never touched here: the
// old passkeys stay usable until recovery completes. The request's own seven-day deadline is never
// changed. Emails go out only AFTER a commit and can never undo it.
const crypto = require('crypto');
const { generateAuthenticationOptions } = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const { prisma } = require('../../../db/prisma');
const { sendMail } = require('../../../lib/mailer');
const { hashToken } = require('../../../common/utils/token-hash');
const { maskEmail } = require('../../../common/utils/phone');
const { ADMIN_LOCK_POLICY, loadAdminLockConfig, assertWebAuthnConfig, assertPortalUrlConfig } = require('./admin-lock.config');
const { issueAdminWebAuthnChallenge, consumeAdminWebAuthnChallenge } = require('./admin-webauthn-challenge.service');
const {
  verifyAdminPasskeyAssertion,
  advanceAdminPasskeyCounter,
  sanitizeAdminAssertionResponse,
  PasskeyAssertionError,
} = require('./admin-passkey-assertion.service');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const { buildInvitationUrl, ProvisioningError, normalizeAdminEmail, operatorIdentity } = require('./admin-provisioning.service');
const {
  normalizeRecoveryReason,
  parseRequestId,
  isPastDeadline,
  revokeLiveRecoveryInvitations,
  RECOVERY_INVITATION_PURPOSE,
  REQUESTED_VIA_BREAK_GLASS,
  OPEN_STATUSES,
  RECOVERY_REQUEST_EVENTS,
} = require('./admin-recovery-request.service');
const { normalizeTransports } = require('./admin-webauthn.helpers');

const DECISIONS = Object.freeze({
  approve: { purpose: 'recovery_approval', decision: 'approved' },
  reject: { purpose: 'recovery_rejection', decision: 'rejected' },
});
const RECOVERY_LINK_PATH = '/recover-passkey';

const EVENTS = Object.freeze({
  stepUpIssued: 'admin_recovery_stepup_issued',
  refused: 'admin_recovery_decision_refused',
  approvalRecorded: 'admin_recovery_approval_recorded',
  approved: 'admin_recovery_approved',
  rejected: 'admin_recovery_rejected',
  invitationCreated: 'admin_recovery_invitation_created',
  invitationSent: 'admin_recovery_invitation_sent',
  invitationDeliveryFailed: 'admin_recovery_invitation_delivery_failed',
});

// The one error of this service. `code` is public and deliberately coarse:
//   not_available   the request, the approver or the session is not in a state that allows this
//                   (not found, not pending, expired, wrong Admin, not an active superadmin, the
//                   target, no live session) - it says nothing about which;
//   already_decided this approver has already decided on this request;
//   step_up_failed  the challenge or the passkey assertion was refused.
// `reason` is an internal code for the audit trail; it is not enumerable, so never serialised.
class RecoveryDecisionError extends Error {
  constructor(code, reason = code) {
    super({
      not_available: 'This recovery request is not available to you.',
      already_decided: 'You have already decided on this recovery request.',
      step_up_failed: 'The passkey confirmation was not accepted.',
    }[code] || 'Refused');
    this.name = 'RecoveryDecisionError';
    this.code = code;
    Object.defineProperty(this, 'reason', { value: reason, enumerable: false });
  }
}

const notAvailable = (reason) => new RecoveryDecisionError('not_available', reason);

function assertRoot(db) {
  if (!db || typeof db.$transaction !== 'function') throw new TypeError('db must be a root Prisma client');
}

function parseId(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

const isOpen = (request, now) => Boolean(
  request && request.status === 'pending' && request.expiresAt instanceof Date && request.expiresAt.getTime() > now.getTime(),
);

// An active superadmin, not the target and not the filing Admin (read-only; locked checks follow).
const isEligibleApprover = (approver, request) => Boolean(
  approver && approver.status === 'active' && approver.role === 'superadmin'
  && approver.id !== request.adminId && approver.id !== request.requestedByAdminId,
);

// Locks Admin rows in ascending id order, each with a current read (an UPDATE that writes the value
// the row already has). `targetId` must be an active Admin; every other id an active superadmin.
// Returns Map id -> whether the row still qualified. Nothing is thrown here: callers throw AFTER the
// request lock, in their own order, so the refusal that is reported does not change.
async function lockAdminsAscending(tx, ids, targetId, now) {
  const standing = new Map();
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const where = id === targetId ? { id, status: 'active' } : { id, role: 'superadmin', status: 'active' };
    const result = await tx.adminUser.updateMany({ where, data: { updatedAt: now } });
    standing.set(id, result.count === 1);
  }
  return standing;
}

// Which Admin rows to lock before the request: its target and the approvers who approved so far.
// A plain read OUTSIDE the transaction, used only to choose what to lock; everything that decides
// is re-read under the locks.
async function planAdminLocks(db, requestId) {
  const request = await db.adminRecoveryRequest.findUnique({ where: { id: requestId } });
  if (!request) return { targetId: null, earlierApprovers: [] };
  const rows = await db.adminRecoveryApproval.findMany({ where: { requestId, decision: 'approved' } });
  return { targetId: request.adminId, earlierApprovers: rows.map((row) => row.approverId) };
}

async function sessionIsLive(client, sessionId, adminId, now) {
  const session = await client.adminSession.findUnique({ where: { id: sessionId } });
  return Boolean(
    session && session.adminId === adminId && !session.revokedAt
    && session.absoluteExpiresAt > now && session.idleExpiresAt > now,
  );
}

// Everything that can be checked without locking. Throws RecoveryDecisionError.
async function precheck(db, { requestId, approverId, sessionId, now }) {
  const request = await db.adminRecoveryRequest.findUnique({ where: { id: requestId } });
  if (!isOpen(request, now)) throw notAvailable('request_unavailable');
  const approver = await db.adminUser.findUnique({ where: { id: approverId } });
  if (!isEligibleApprover(approver, request)) throw notAvailable('approver_ineligible');
  if (!(await sessionIsLive(db, sessionId, approverId, now))) throw notAvailable('session_invalid');
  const target = await db.adminUser.findUnique({ where: { id: request.adminId } });
  if (!target || target.status !== 'active') throw notAvailable('target_unavailable');
  const earlier = await db.adminRecoveryApproval.count({ where: { requestId, approverId } });
  if (earlier > 0) throw new RecoveryDecisionError('already_decided');
  return { request, approver, target };
}

// Best-effort trail of a refused attempt: ids and a reason code only.
async function auditRefusal(db, approverId, requestId, kind, reason, ipAddress) {
  try {
    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: approverId,
      event: EVENTS.refused,
      ipAddress,
      detail: { recoveryRequestId: requestId, decision: kind, reason },
      db,
    });
  } catch (err) {
    console.error(`Could not record a refused recovery decision (${err.code || err.name}).`);
  }
}

// ---- 1. step-up challenge ------------------------------------------------------------------

// Issues the passkey step-up for `kind` ("approve" or "reject") on one request and returns the
// browser's authentication options. Needs the approver's live session; binds the challenge to the
// approver, the request and that session, for 120 seconds, single use. A newer step-up of the same
// kind replaces an older one. Returns { decision, requestId, options, expiresAt }.
// Throws RecoveryDecisionError (not_available / already_decided); configuration and database
// failures propagate.
async function issueRecoveryStepUp({ kind, requestId, approverId, sessionId, ipAddress = null, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  if (!Object.hasOwn(DECISIONS, kind)) throw new TypeError('kind must be "approve" or "reject"');
  parseId(requestId, 'requestId');
  parseId(approverId, 'approverId');
  parseId(sessionId, 'sessionId');
  const { rpId } = assertWebAuthnConfig(loadAdminLockConfig());
  const { purpose } = DECISIONS[kind];

  try {
    await precheck(db, { requestId, approverId, sessionId, now });
  } catch (err) {
    if (err instanceof RecoveryDecisionError) await auditRefusal(db, approverId, requestId, kind, `stepup_${err.reason}`, ipAddress);
    throw err;
  }

  const plan = await planAdminLocks(db, requestId);
  return db.$transaction(async (tx) => {
    // First: the approver's and the target's Admin rows, ascending, each checked with a current read.
    const standing = await lockAdminsAscending(tx, [approverId, ...(plan.targetId ? [plan.targetId] : [])], plan.targetId, now);

    // Then the request lock, only while it is open.
    const held = await tx.adminRecoveryRequest.updateMany({
      where: { id: requestId, status: 'pending', expiresAt: { gt: now } },
      data: { updatedAt: now },
    });
    if (held.count !== 1) throw notAvailable('request_unavailable');
    const request = await tx.adminRecoveryRequest.findUnique({ where: { id: requestId } });

    if (approverId === request.adminId) throw notAvailable('approver_is_target');

    for (const id of [approverId, request.adminId].sort((a, b) => a - b)) {
      if (id === request.adminId) {
        if (!standing.get(id)) throw notAvailable('target_unavailable');
      } else if (!standing.get(id) || id === request.requestedByAdminId) {
        throw notAvailable('approver_ineligible');
      }
    }
    const live = await tx.adminSession.updateMany({
      where: { id: sessionId, adminId: approverId, revokedAt: null, absoluteExpiresAt: { gt: now }, idleExpiresAt: { gt: now } },
      data: { revokedAt: null },
    });
    if (live.count !== 1) throw notAvailable('session_invalid');
    if ((await tx.adminRecoveryApproval.count({ where: { requestId, approverId } })) > 0) throw new RecoveryDecisionError('already_decided');

    const passkeys = await tx.adminPasskey.findMany({ where: { adminId: approverId, revokedAt: null } });
    if (passkeys.length === 0) throw notAvailable('no_passkey');

    const issued = await issueAdminWebAuthnChallenge({
      adminId: approverId, purpose, recoveryRequestId: requestId, sessionId, ipAddress, now, db: tx,
    });
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: passkeys.map((p) => ({ id: isoBase64URL.fromBuffer(p.credentialId), transports: normalizeTransports(p.transports) })),
      challenge: issued.challengeBytes, // bytes, not the string: the library would UTF-8-encode a string
      timeout: ADMIN_LOCK_POLICY.recoveryStepUpChallengeTtlMs,
      userVerification: 'required',
    });
    if (options.challenge !== issued.challenge) throw new Error('Authentication options do not match the stored challenge');

    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: approverId,
      event: EVENTS.stepUpIssued,
      ipAddress,
      detail: { recoveryRequestId: requestId, decision: kind, sessionId },
      db: tx,
    });
    return { decision: kind, requestId, options, expiresAt: issued.expiresAt };
  });
}

// ---- 2. emails (after the commit only) -----------------------------------------------------

const escapeHtml = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function recoveryInvitationMessage({ to, name, url, expiresAt, breakGlass = false }) {
  const expires = expiresAt.toUTCString();
  const approval = breakGlass ? 'an operator under the emergency (break-glass) procedure' : 'two administrators';
  const text = [
    `Hello ${name},`,
    '',
    `Your passkey recovery has been approved by ${approval}.`,
    'Open this link and enter your current password when asked, to register a new passkey:',
    url,
    '',
    `The link can be used once and expires on ${expires}.`,
    'If you were not expecting this email, do not use the link and tell your administrator straight away.',
  ].join('\n');
  const html = `<p>Hello ${escapeHtml(name)},</p>`
    + `<p>Your passkey recovery has been approved by ${approval}.</p>`
    + `<p><a href="${escapeHtml(url)}">Register a new passkey</a> (you will be asked for your current password).</p>`
    + `<p>The link can be used once and expires on ${escapeHtml(expires)}.<br>If you were not expecting this email, do not use the link and tell your administrator straight away.</p>`;
  return { to, subject: 'Your HumanCare Admin passkey recovery link', text, html, sensitive: true };
}

function recoveryRejectedMessage({ to, name, requestId }) {
  const text = [
    `Hello ${name},`,
    '',
    `The passkey recovery requested for your HumanCare World Wide Admin account (reference ${requestId}) was rejected.`,
    'Nothing about your account has changed. If you still need to recover your passkey, contact your administrator.',
  ].join('\n');
  const html = `<p>Hello ${escapeHtml(name)},</p>`
    + `<p>The passkey recovery requested for your HumanCare World Wide Admin account (reference ${escapeHtml(requestId)}) was rejected.</p>`
    + '<p>Nothing about your account has changed. If you still need to recover your passkey, contact your administrator.</p>';
  return { to, subject: 'Your passkey recovery request was rejected', text, html };
}

// Sends one message; reports { delivered, error } and records the outcome best-effort (ids only,
// never the error text, the link or the token). Never throws.
async function deliver(message, { event, failedEvent, actorType = 'admin', actorId = null, target, requestId, invitationId = null, kind, operator = null }) {
  const outcome = { delivered: false, error: null };
  const note = async (name) => {
    try {
      await recordAdminAuditEvent({
        actorType,
        actorId,
        event: name,
        identifier: maskEmail(target.email),
        detail: { adminId: target.id, recoveryRequestId: requestId, kind, ...(invitationId ? { invitationId } : {}), ...(operator ? { operator } : {}) },
      });
    } catch (auditErr) {
      console.error(`Could not record a recovery notification outcome (${auditErr.code || auditErr.name}).`);
    }
  };
  try {
    await sendMail(message);
    outcome.delivered = true;
    if (event) await note(event);
  } catch (err) {
    outcome.error = String(err?.message || 'unknown error').slice(0, 200);
    await note(failedEvent);
  }
  return outcome;
}

// ---- 3. the decision -----------------------------------------------------------------------

// The invitation, created inside the approving transaction. Returns { invitation, token } - the raw
// token exists only in this value, for the email, and is never stored, returned to a caller,
// logged or audited. Expires at the EARLIER of 24 hours from now and the request's own deadline.
async function createRecoveryInvitation(tx, { request, target, now }) {
  // At most one live (unused, unrevoked, unexpired) recovery invitation per request. An approval
  // happens once under the request lock, and a resend or break-glass revokes the old one first, so
  // this can only fire on a broken invariant - and then nothing is committed.
  const live = await tx.adminInvitation.updateMany({
    where: { recoveryRequestId: request.id, purpose: RECOVERY_INVITATION_PURPOSE, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: null },
  });
  if (live.count > 0) throw new Error('A live recovery invitation already exists for this request');

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Math.min(now.getTime() + ADMIN_LOCK_POLICY.recoveryInvitationTtlMs, request.expiresAt.getTime()));
  const invitation = await tx.adminInvitation.create({
    data: {
      adminId: target.id,
      purpose: RECOVERY_INVITATION_PURPOSE,
      recoveryRequestId: request.id,
      tokenHash: hashToken(token),
      sentToEmail: target.email,
      expiresAt,
    },
  });
  return { invitation, expiresAt, token };
}

async function decide(kind, { requestId, approverId, sessionId, response, reason, ipAddress = null, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  parseId(requestId, 'requestId');
  parseId(approverId, 'approverId');
  parseId(sessionId, 'sessionId');
  const { purpose, decision } = DECISIONS[kind];
  const { rpId, origin } = assertWebAuthnConfig(loadAdminLockConfig());
  // An approval might be the final one: the link must be buildable BEFORE anything is committed.
  const portalUrl = kind === 'approve' ? assertPortalUrlConfig(loadAdminLockConfig()) : null;
  const cleanReason = reason === undefined || reason === null || reason === '' ? null : normalizeRecoveryReason(reason);

  let safeResponse;
  try {
    safeResponse = sanitizeAdminAssertionResponse(response);
  } catch (err) {
    if (err instanceof PasskeyAssertionError) throw new RecoveryDecisionError('step_up_failed', err.reason);
    throw err;
  }

  // 1. Read-only checks: an ineligible caller never burns a challenge.
  try {
    await precheck(db, { requestId, approverId, sessionId, now });
  } catch (err) {
    if (err instanceof RecoveryDecisionError) await auditRefusal(db, approverId, requestId, kind, err.reason, ipAddress);
    throw err;
  }

  // 2. Final, committed on its own. Bound to this approver, this request and this session.
  const challenge = await consumeAdminWebAuthnChallenge({
    adminId: approverId, purpose, recoveryRequestId: requestId, sessionId, now, db,
  });
  if (!challenge) {
    await auditRefusal(db, approverId, requestId, kind, 'challenge_unavailable', ipAddress);
    throw new RecoveryDecisionError('step_up_failed', 'challenge_unavailable');
  }

  // 3. The passkey. A database failure here is not a refusal: it propagates (fail closed).
  let verified;
  try {
    verified = await verifyAdminPasskeyAssertion({
      adminId: approverId, response: safeResponse, expectedChallenge: challenge.challenge, rpId, origin, ipAddress, db,
    });
  } catch (err) {
    if (err instanceof PasskeyAssertionError) {
      await auditRefusal(db, approverId, requestId, kind, err.reason, ipAddress);
      throw new RecoveryDecisionError('step_up_failed', err.reason);
    }
    throw err;
  }

  // 4. The decision.
  let committed;
  try {
    const plan = await planAdminLocks(db, requestId);
    committed = await db.$transaction(async (tx) => {
      // First: every Admin whose standing matters, ascending, each with a current read: this approver,
      // the target, and (for an approval) the earlier approvers seen a moment ago.
      const standing = await lockAdminsAscending(
        tx,
        [approverId, ...(plan.targetId ? [plan.targetId] : []), ...(decision === 'approved' ? plan.earlierApprovers : [])],
        plan.targetId,
        now,
      );

      // Then the request lock, only while it is still open. Nothing was read in this transaction
      // before the locks, so what is read from here on includes every decision committed before them.
      const held = await tx.adminRecoveryRequest.updateMany({
        where: { id: requestId, status: 'pending', expiresAt: { gt: now } },
        data: { updatedAt: now },
      });
      if (held.count !== 1) throw notAvailable('request_unavailable');
      const request = await tx.adminRecoveryRequest.findUnique({ where: { id: requestId } });
      const earlier = await tx.adminRecoveryApproval.findMany({ where: { requestId } });
      if (earlier.some((row) => row.approverId === approverId)) throw new RecoveryDecisionError('already_decided');

      // An approver who committed between the plan and the locks was not locked yet: lock them now
      // (ascending among themselves) so their standing is still judged by a current read.
      const earlierApprovers = decision === 'approved'
        ? earlier.filter((row) => row.decision === 'approved').map((row) => row.approverId)
        : [];
      const late = [request.adminId, ...earlierApprovers].filter((id) => !standing.has(id));
      if (late.length > 0) {
        for (const [id, ok] of await lockAdminsAscending(tx, late, request.adminId, now)) standing.set(id, ok);
      }
      if (!standing.get(request.adminId)) throw notAvailable('target_unavailable');
      if (!standing.get(approverId) || approverId === request.adminId || approverId === request.requestedByAdminId) {
        throw notAvailable('approver_ineligible');
      }
      const target = await tx.adminUser.findUnique({ where: { id: request.adminId } });

      const live = await tx.adminSession.updateMany({
        where: { id: sessionId, adminId: approverId, revokedAt: null, absoluteExpiresAt: { gt: now }, idleExpiresAt: { gt: now } },
        data: { revokedAt: null },
      });
      if (live.count !== 1) throw notAvailable('session_invalid');

      // The passkey counter moves only if the credential is still live and unchanged.
      if (!(await advanceAdminPasskeyCounter(tx, { adminId: approverId, passkey: verified.passkey, newCounter: verified.newCounter, now }))) {
        throw new RecoveryDecisionError('step_up_failed', 'credential_changed');
      }

      try {
        await tx.adminRecoveryApproval.create({
          data: { requestId, approverId, approverRole: 'superadmin', decision, reason: cleanReason, ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null },
        });
      } catch (err) {
        if (err && err.code === 'P2002') throw new RecoveryDecisionError('already_decided');
        throw err;
      }

      const common = { adminId: target.id, recoveryRequestId: requestId, decision, decidedAt: now.toISOString() };

      if (decision === 'rejected') {
        const rejected = await tx.adminRecoveryRequest.updateMany({ where: { id: requestId, status: 'pending' }, data: { status: 'rejected' } });
        if (rejected.count !== 1) throw notAvailable('request_unavailable');
        await recordAdminAuditEvent({
          actorType: 'admin', actorId: approverId, event: EVENTS.rejected, identifier: maskEmail(target.email), ipAddress, detail: common, db: tx,
        });
        return { status: 'rejected', target, validApprovals: 0 };
      }

      // Only approvers who are STILL active superadmins (and not the target) count.
      const validApprovals = 1 + earlierApprovers.filter((id) => id !== request.adminId && standing.get(id)).length;
      await recordAdminAuditEvent({
        actorType: 'admin',
        actorId: approverId,
        event: EVENTS.approvalRecorded,
        identifier: maskEmail(target.email),
        ipAddress,
        detail: { ...common, validApprovals, approvalsRequired: request.approvalsRequired },
        db: tx,
      });
      if (validApprovals < request.approvalsRequired) return { status: 'pending', target, validApprovals };

      // The final approval: the request becomes approved and the invitation exists, together.
      const approved = await tx.adminRecoveryRequest.updateMany({
        where: { id: requestId, status: 'pending' },
        data: { status: 'approved', approvedAt: now },
      });
      if (approved.count !== 1) throw notAvailable('request_unavailable');
      const created = await createRecoveryInvitation(tx, { request, target, now });
      await recordAdminAuditEvent({
        actorType: 'admin', actorId: approverId, event: EVENTS.approved, identifier: maskEmail(target.email), ipAddress,
        detail: { ...common, validApprovals }, db: tx,
      });
      await recordAdminAuditEvent({
        actorType: 'admin',
        actorId: approverId,
        event: EVENTS.invitationCreated,
        identifier: maskEmail(target.email),
        detail: { adminId: target.id, recoveryRequestId: requestId, invitationId: created.invitation.id, invitationExpiresAt: created.expiresAt.toISOString() },
        db: tx,
      });
      return { status: 'approved', target, validApprovals, ...created };
    });
  } catch (err) {
    if (err instanceof RecoveryDecisionError) await auditRefusal(db, approverId, requestId, kind, err.reason, ipAddress);
    throw err;
  }

  // Committed. Nothing below can undo it.
  const result = { decision: kind, requestId, status: committed.status, validApprovals: committed.validApprovals, invitation: null, emailDelivered: null, emailError: null };
  if (committed.status === 'approved') {
    result.invitation = { id: committed.invitation.id, expiresAt: committed.expiresAt };
    const url = buildInvitationUrl(portalUrl, committed.token, RECOVERY_LINK_PATH);
    const outcome = await deliver(
      recoveryInvitationMessage({ to: committed.target.email, name: committed.target.name, url, expiresAt: committed.expiresAt }),
      {
        event: EVENTS.invitationSent,
        failedEvent: EVENTS.invitationDeliveryFailed,
        actorId: approverId,
        target: committed.target,
        requestId,
        invitationId: committed.invitation.id,
        kind: 'invitation',
      },
    );
    result.emailDelivered = outcome.delivered;
    result.emailError = outcome.error;
  } else if (committed.status === 'rejected') {
    const outcome = await deliver(
      recoveryRejectedMessage({ to: committed.target.email, name: committed.target.name, requestId }),
      { event: null, failedEvent: RECOVERY_REQUEST_EVENTS.notificationFailed, actorId: approverId, target: committed.target, requestId, kind: 'rejection' },
    );
    result.emailDelivered = outcome.delivered;
    result.emailError = outcome.error;
  }
  return result;
}

// Approves a recovery request. `response` is the browser's assertion for the challenge issued by
// issueRecoveryStepUp({ kind: 'approve', ... }). Returns { decision: 'approve', requestId, status:
// 'pending' | 'approved', validApprovals, invitation: null | { id, expiresAt }, emailDelivered,
// emailError }; `status: 'approved'` means THIS call was the second valid approval.
function approveRecoveryRequest(input) {
  return decide('approve', input);
}

// Rejects a recovery request: one eligible rejection ends it. `reason` is optional.
// Returns { decision: 'reject', requestId, status: 'rejected', emailDelivered, emailError, ... }.
function rejectRecoveryRequest(input) {
  return decide('reject', input);
}

// ---- 4. operator workflows: resend and break-glass ------------------------------------------
// Both are operator-only (scripts/admin-recovery.js; no HTTP route), both create the invitation
// with createRecoveryInvitation and send it with deliver() AFTER the commit, so they share the
// token generation, hashing, expiry cap and delivery recording of an ordinary approval.

const BREAK_GLASS_EVENT = RECOVERY_REQUEST_EVENTS.breakGlass;
const RESEND_EVENT = RECOVERY_REQUEST_EVENTS.invitationResent;
const APPROVERS_REQUIRED = 2;
const MIN_BREAK_GLASS_REASON_LENGTH = 15;
const MIN_BREAK_GLASS_REASON_WORDS = 3;

const breakGlassConfirmation = (email) => `BREAK-GLASS ${email}`;

// A break-glass reason must say something: well-formed (as any recovery reason) and at least
// fifteen characters in at least three words. Returns the normalised reason.
function normalizeBreakGlassReason(value) {
  const reason = normalizeRecoveryReason(value);
  if (reason.length < MIN_BREAK_GLASS_REASON_LENGTH || reason.split(' ').length < MIN_BREAK_GLASS_REASON_WORDS) {
    throw new ProvisioningError('invalid_reason', `A break-glass reason must explain the emergency (at least ${MIN_BREAK_GLASS_REASON_LENGTH} characters in ${MIN_BREAK_GLASS_REASON_WORDS} words or more).`);
  }
  return reason;
}

const notResendable = (message) => new ProvisioningError('request_not_resendable', message);

// Issues a replacement invitation for an APPROVED, unexpired recovery request whose target is still
// active. The request row is locked first (only while approved and unexpired), then the target; the
// request's live invitation, if any, is revoked and the new one created and audited in the same
// transaction, so there is never more than one live invitation and a failure keeps the old state.
// Used, revoked and expired invitations (and a failed earlier email) are all recoverable this way;
// a used one is history and is left as it is. The request's own deadline is never extended: the new
// invitation expires at the earlier of 24 hours from now and that deadline. The email goes out only
// after the commit; a delivery failure is recorded and never undoes the invitation.
// Returns { request, admin, invitation: { id, expiresAt }, revokedCount, emailDelivered, emailError }.
// Throws ProvisioningError: invalid_request_id, request_not_found, request_not_resendable,
// target_not_active (and configuration errors before anything is changed).
async function resendRecoveryInvitation({ id, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const requestId = parseRequestId(id);
  const portalUrl = assertPortalUrlConfig(loadAdminLockConfig()); // fail before changing anything
  const operator = operatorIdentity();

  const planned = await db.adminRecoveryRequest.findUnique({ where: { id: requestId } });
  const done = await db.$transaction(async (tx) => {
    // First: the target's Admin row (only while active), then the request - the order of every
    // recovery transaction. Their refusals are raised afterwards, in the original order.
    const lockedTarget = planned
      ? await tx.adminUser.updateMany({ where: { id: planned.adminId, status: 'active' }, data: { updatedAt: now } })
      : { count: 0 };
    // The request lock, only while it is approved and unexpired.
    const held = await tx.adminRecoveryRequest.updateMany({
      where: { id: requestId, status: 'approved', expiresAt: { gt: now } },
      data: { updatedAt: now },
    });
    const request = await tx.adminRecoveryRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new ProvisioningError('request_not_found', 'No recovery request with that id.');
    if (held.count !== 1) {
      if (request.status === 'approved' && isPastDeadline(request, now)) {
        throw notResendable(`Request ${requestId} has passed its deadline and can no longer receive an invitation.`);
      }
      throw notResendable(`Only an approved request can receive a replacement invitation; request ${requestId} is "${request.status}".`);
    }

    if (lockedTarget.count !== 1) throw new ProvisioningError('target_not_active', 'The admin of this request is not active, so no invitation can be sent.');
    const target = await tx.adminUser.findUnique({ where: { id: request.adminId } });

    const revokedCount = await revokeLiveRecoveryInvitations(tx, { recoveryRequestId: requestId }, now);
    const created = await createRecoveryInvitation(tx, { request, target, now });
    await recordAdminAuditEvent({
      actorType: 'operator',
      event: RESEND_EVENT,
      identifier: maskEmail(target.email),
      detail: {
        adminId: target.id,
        recoveryRequestId: requestId,
        invitationId: created.invitation.id,
        revokedInvitationCount: revokedCount,
        invitationExpiresAt: created.expiresAt.toISOString(),
        requestedVia: request.requestedVia,
        operator,
      },
      db: tx,
    });
    return { request, target, revokedCount, ...created };
  });

  // Committed. Nothing below can undo it.
  const outcome = await deliver(
    recoveryInvitationMessage({
      to: done.target.email,
      name: done.target.name,
      url: buildInvitationUrl(portalUrl, done.token, RECOVERY_LINK_PATH),
      expiresAt: done.expiresAt,
      breakGlass: done.request.requestedVia === REQUESTED_VIA_BREAK_GLASS,
    }),
    {
      event: EVENTS.invitationSent,
      failedEvent: EVENTS.invitationDeliveryFailed,
      actorType: 'operator',
      target: done.target,
      requestId,
      invitationId: done.invitation.id,
      kind: 'invitation',
      operator,
    },
  );
  return {
    request: { id: requestId, status: 'approved', expiresAt: done.request.expiresAt },
    admin: { id: done.target.id, name: done.target.name, email: done.target.email },
    invitation: { id: done.invitation.id, expiresAt: done.expiresAt },
    revokedCount: done.revokedCount,
    emailDelivered: outcome.delivered,
    emailError: outcome.error,
  };
}

// Emergency recovery for an active Admin when fewer than two eligible approvers exist. Eligible =
// an active Admin with role "superadmin", other than the target, holding at least one live passkey
// (see countEligibleApprovers); an ordinary Admin, or a superadmin who cannot pass the passkey
// step-up, never counts.
// Refused unless `confirmation` is exactly "BREAK-GLASS <the target's email>" and the reason is
// meaningful. Everything is ONE transaction, with the Admin rows locked in ascending id order (the
// order the disable guard uses) and the approver count taken by a current read (UPDATE), never a
// preliminary plain read:
//   lock target + candidate superadmins -> expire stale requests -> refuse an open request
//   -> count eligible approvers (>= 2: refused) -> create the APPROVED request
//   (requestedByAdminId null, requestedVia "break_glass", approvalsRequired 0, seven days)
//   -> create its invitation (same helper, hash and 24h/deadline cap as an approval) -> audit.
// A failed audit rolls back the request and the invitation. The email follows the commit.
// It bypasses only the approvals: the target still needs the emailed link AND their current
// password, and the new passkey is still verified, exactly as in an ordinary recovery.
// Returns { request, admin, invitation, eligibleApprovers, emailDelivered, emailError }.
// Throws ProvisioningError: invalid_email, invalid_reason, confirmation_required, admin_not_found,
// target_not_active, open_request_exists, approvers_available, admin_set_changed.
async function breakGlassRecovery({ email, reason, confirmation, now = new Date(), db = prisma } = {}) {
  assertRoot(db);
  const cleanEmail = normalizeAdminEmail(email);
  const cleanReason = normalizeBreakGlassReason(reason);
  if (confirmation !== breakGlassConfirmation(cleanEmail)) {
    throw new ProvisioningError('confirmation_required', `Break-glass needs the exact typed confirmation "${breakGlassConfirmation(cleanEmail)}".`);
  }
  const portalUrl = assertPortalUrlConfig(loadAdminLockConfig()); // fail before changing anything
  const operator = operatorIdentity();
  const expiresAt = new Date(now.getTime() + ADMIN_LOCK_POLICY.recoveryRequestTtlMs);

  const done = await db.$transaction(async (tx) => {
    const found = await tx.adminUser.findUnique({ where: { email: cleanEmail } });
    if (!found) throw new ProvisioningError('admin_not_found', 'No admin with that email.');

    // Lock the target and every active superadmin in ONE ascending pass. The target only while it
    // is active; the others only while they are active superadmins.
    const candidates = await tx.adminUser.findMany({ where: { role: 'superadmin', status: 'active' } });
    const ids = [...new Set([...candidates.map((row) => row.id), found.id])].sort((a, b) => a - b);
    let targetHeld = false;
    const lockedApprovers = [];
    for (const adminId of ids) {
      const where = adminId === found.id ? { id: adminId, status: 'active' } : { id: adminId, role: 'superadmin', status: 'active' };
      const held = await tx.adminUser.updateMany({ where, data: { updatedAt: now } });
      if (adminId === found.id) targetHeld = held.count === 1;
      else if (held.count === 1) lockedApprovers.push(adminId);
    }
    if (!targetHeld) {
      const current = await tx.adminUser.findUnique({ where: { id: found.id } });
      throw new ProvisioningError('target_not_active', `Only an active admin can be recovered; that admin is "${current ? current.status : 'unknown'}".`);
    }
    const target = await tx.adminUser.findUnique({ where: { id: found.id } });

    // Requests whose deadline has passed are over, whatever their stored status says.
    const expired = await tx.adminRecoveryRequest.updateMany({
      where: { adminId: target.id, status: { in: [...OPEN_STATUSES] }, expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    if (expired.count > 0) {
      await recordAdminAuditEvent({
        actorType: 'operator',
        event: RECOVERY_REQUEST_EVENTS.expired,
        identifier: target.email,
        detail: { adminId: target.id, count: expired.count, expiredAt: now.toISOString(), trigger: 'break_glass', operator },
        db: tx,
      });
    }
    const open = await tx.adminRecoveryRequest.updateMany({ where: { adminId: target.id, status: { in: [...OPEN_STATUSES] } }, data: { updatedAt: now } });
    if (open.count > 0) {
      throw new ProvisioningError('open_request_exists', 'That admin already has an open recovery request. Cancel it first, or wait for it to finish.');
    }

    // The decisive count, taken after every lock above with CURRENT reads (UPDATE statements), so
    // it sees what other operators committed a moment ago. Eligible = still an active superadmin
    // (the locked rows above) AND holding a live passkey (re-checked now, per approver, in
    // ascending id order; the write stores the value the row already has). A superadmin who
    // appeared after the candidate list was read cannot be judged here, so the attempt is refused
    // rather than guessed at - the safe direction for an emergency bypass.
    const withoutPasskey = [];
    let eligibleCount = 0;
    for (const approverId of lockedApprovers) {
      const live = await tx.adminPasskey.updateMany({ where: { adminId: approverId, revokedAt: null }, data: { revokedAt: null } });
      if (live.count > 0) eligibleCount += 1;
      else withoutPasskey.push(approverId);
    }
    const allSuperadmins = await tx.adminUser.updateMany({
      where: { role: 'superadmin', status: 'active', id: { not: target.id } },
      data: { updatedAt: now },
    });
    if (allSuperadmins.count !== lockedApprovers.length) {
      throw new ProvisioningError('admin_set_changed', 'The set of superadmins changed while this ran. Nothing was changed; run the command again.');
    }
    const eligible = { count: eligibleCount };
    if (eligible.count >= APPROVERS_REQUIRED) {
      throw new ProvisioningError('approvers_available', `${eligible.count} eligible superadmin approvers exist, so the ordinary two-person recovery must be used instead of break-glass.`);
    }

    const request = await tx.adminRecoveryRequest.create({
      data: {
        adminId: target.id,
        requestedByAdminId: null,
        requestedVia: REQUESTED_VIA_BREAK_GLASS,
        requestIp: null,
        reason: cleanReason,
        status: 'approved',
        approvalsRequired: 0,
        approvedAt: now,
        expiresAt,
        createdAt: now,
      },
    });
    const created = await createRecoveryInvitation(tx, { request, target, now });

    const justification = `Only ${eligible.count} eligible superadmin approver(s) besides the target; ${APPROVERS_REQUIRED} are required for an ordinary recovery.`;
    await recordAdminAuditEvent({
      actorType: 'operator',
      event: BREAK_GLASS_EVENT,
      identifier: target.email,
      detail: {
        adminId: target.id,
        recoveryRequestId: request.id,
        reason: cleanReason,
        justification,
        eligibleApprovers: eligible.count,
        superadminsWithoutPasskey: withoutPasskey.length,
        approversRequired: APPROVERS_REQUIRED,
        requestedVia: REQUESTED_VIA_BREAK_GLASS,
        expiresAt: expiresAt.toISOString(),
        invitationId: created.invitation.id,
        invitationExpiresAt: created.expiresAt.toISOString(),
        operator,
      },
      db: tx,
    });
    await recordAdminAuditEvent({
      actorType: 'operator',
      event: EVENTS.invitationCreated,
      identifier: maskEmail(target.email),
      detail: { adminId: target.id, recoveryRequestId: request.id, invitationId: created.invitation.id, invitationExpiresAt: created.expiresAt.toISOString(), operator },
      db: tx,
    });
    return { request, target, eligibleApprovers: eligible.count, ...created };
  });

  // Committed. Nothing below can undo it.
  const outcome = await deliver(
    recoveryInvitationMessage({
      to: done.target.email,
      name: done.target.name,
      url: buildInvitationUrl(portalUrl, done.token, RECOVERY_LINK_PATH),
      expiresAt: done.expiresAt,
      breakGlass: true,
    }),
    {
      event: EVENTS.invitationSent,
      failedEvent: EVENTS.invitationDeliveryFailed,
      actorType: 'operator',
      target: done.target,
      requestId: done.request.id,
      invitationId: done.invitation.id,
      kind: 'invitation',
      operator,
    },
  );
  return {
    request: { id: done.request.id, status: 'approved', expiresAt },
    admin: { id: done.target.id, name: done.target.name, email: done.target.email },
    invitation: { id: done.invitation.id, expiresAt: done.expiresAt },
    eligibleApprovers: done.eligibleApprovers,
    emailDelivered: outcome.delivered,
    emailError: outcome.error,
  };
}

module.exports = {
  issueRecoveryStepUp,
  approveRecoveryRequest,
  rejectRecoveryRequest,
  resendRecoveryInvitation,
  breakGlassRecovery,
  breakGlassConfirmation,
  normalizeBreakGlassReason,
  RecoveryDecisionError,
  RECOVERY_DECISION_EVENTS: EVENTS,
  RECOVERY_LINK_PATH,
};
