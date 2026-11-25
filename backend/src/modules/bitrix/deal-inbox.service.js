// Processes stored Bitrix24 Deal events (integration_inbox) into Case stage changes. See bitrix-inbound.controller.js
// for how they arrive. NOTHING in a stored event is trusted: for each one the Deal is READ from Bitrix, and it is
// applied only when every check below agrees.
//
// Per event, in order:
//   1. The exact Deal ID (text) must be linked to a Case through BitrixDealLink (the only mapping; never a name,
//      phone number or anything personal). The Case must be an eligible Private Charter Case. A Deal that is not
//      linked yet is retried for a while (our own create may still be saving its link), then quarantined.
//   2. crm.deal.get: the Deal's ID, CATEGORY_ID (38) and Primary Deal Reference (UF_CRM_1794548440549) must equal
//      the link's Deal ID, 38 and the Case's exact reference, or the event is quarantined.
//   3. The Deal's STAGE_ID must be an approved Category 38 stage (bitrix-deal-stages.js). An unknown or obsolete
//      stage, or a Deal Lost whose reason is not Patient Cancelled (5914), is quarantined, never guessed.
//   4. One transaction, with the Case row locked (SELECT ... FOR UPDATE): decide (stale / already applied / no change /
//      Case already closed / apply), write the fenced inbox result FIRST (0 rows = lease lost, everything rolls back),
//      then the Case change (compare-and-swap on stage_version), the stage event, the link, the fixed-message patient
//      Notification and the AuditLog entry. A failure anywhere rolls the whole transaction back: no partial Case.
//      For a patient-visible stage the notification's PUSH DELIVERIES are queued in the same transaction (notifications/push-delivery-enqueue.js), only for a
//      newly created notification. This service sends nothing and reads no push token: the push delivery worker (off unless PUSH_DELIVERY_ENABLED=true) sends them later.
//   5. Nothing happens after commit.
//
// QUARANTINE = the inbox row ends 'ignored' with last_error "quarantined:<code>" plus an AuditLog entry
// (bitrix.deal.inbound_quarantined). The Case is not touched and the patient is not notified. A transient problem
// (Bitrix unreachable) is retried with a growing delay, then ends 'failed' with an audit entry.
// Inbound events never create a Case, Deal or Lead.
const os = require('os');
const crypto = require('crypto');
const { prisma: defaultPrisma } = require('../../db/prisma');
const { isPrivateCharterDealWorkerActive, isQuotationSyncActive } = require('./bitrix-config');
const { gatewayForPass } = require('./queue/dispatcher');
const { PRIVATE_CHARTER_QUEUE } = require('./queue/service-registry');
const { assertDealEligible } = require('./deal-outbox');
const { detectAndEnqueueQuotationSync } = require('./quotation-outbox');
const { resolveProfile, activeProfileName } = require('./bitrix-profiles');
const { linkProfileProblem, dealProblem, lookupProfileStage } = require('./bitrix-profile-runtime');
const bitrixDealApi = require('./bitrix-deal.api');
const defaultStore = require('./deal-inbox.store');
const { LOST_REASON_FIELD } = require('./bitrix-deal-stages');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { createPatientNotification } = require('../notifications/notification-core');
const { enqueuePushDeliveries } = require('../notifications/push-delivery-enqueue');
const { suppressionReason, SYNTHETIC_IDENTITY_PREFIX } = require('../notifications/push-delivery.config');

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 8;
const NOT_LINKED_RETRIES = 5; // a Deal we just created may not have its link saved yet
const BATCH_SIZE = 10;
const SAME_SECOND_DELAY_SECONDS = 30;
const CLOSED_STATUSES = new Set(['completed', 'cancelled']);
const retryDelay = (attempts) => Math.min(60 * attempts, 900);

class LeaseLostError extends Error {
  constructor() { super('The inbox lease was lost; nothing was written.'); this.name = 'LeaseLostError'; }
}
class ConcurrentChangeError extends Error {
  constructor() { super('The Case changed during processing; nothing was written.'); this.name = 'ConcurrentChangeError'; }
}

const makeWorkerId = () => `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`.slice(0, 64);

// `enqueuePush(tx, notification)` queues the patient's push deliveries inside the stage transaction. A run that must never queue them (a scoped or synthetic
// detection, an operator script with --no-push) passes `suppressedEnqueuePush` explicitly. The old `push` option (a direct sender) is gone: a caller that still
// passes it meant "no push", and silently ignoring it would queue deliveries, so it is refused loudly instead.
function buildContext(overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, 'push')) {
    throw new Error('deal-inbox: the "push" option was replaced by "enqueuePush"; pass suppressedEnqueuePush to queue no push deliveries.');
  }
  const ctx = {
    prisma: defaultPrisma, store: defaultStore, api: bitrixDealApi, env: process.env, log: console,
    enqueuePush: enqueuePushDeliveries, lostReasonField: LOST_REASON_FIELD, workerId: makeWorkerId(), ...overrides,
  };
  if (typeof ctx.enqueuePush !== 'function') ctx.enqueuePush = enqueuePushDeliveries; // undefined = the default, never "nothing"
  return ctx;
}

// A test, scoped, integration or synthetic run, or a synthetic E2E patient identity, never gets push deliveries queued (the in-app notification is
// unaffected). The same rules the delivery worker applies when it sends (push-delivery.config.js). This is the ENVIRONMENT guard; a caller that must
// suppress for another reason (a scoped detection) passes suppressedEnqueuePush, which does not depend on the environment at all.
function pushMayBeQueued(ctx, serviceRequest) {
  if (suppressionReason(ctx.env)) return false;
  const name = serviceRequest && typeof serviceRequest.patientName === 'string' ? serviceRequest.patientName : '';
  return !name.startsWith(SYNTHETIC_IDENTITY_PREFIX);
}

const requestStatusFor = (status) => (status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'submitted' ? 'submitted' : 'in_progress');

function auditEntry(action, claim, { code, caseRecord = null, extra = {} }) {
  return {
    caseId: caseRecord ? caseRecord.id : null, entityType: 'integration_inbox', entityId: claim.id, action,
    actorType: 'bitrix', source: 'bitrix_webhook', reasonCode: code,
    afterData: {
      inboxEventId: claim.id, bitrixDealId: claim.dealId,
      ...(caseRecord ? { caseId: caseRecord.id, caseReference: caseRecord.referenceNumber } : {}), ...extra,
    },
    correlationId: `inbox:${claim.id}`, idempotencyKey: `${action}:inbox:${claim.id}`,
  };
}

// ---- results that do not change a Case ---------------------------------------------------------------------------
async function finish(ctx, claim, { status, code, delaySeconds = 0, audit = null }) {
  try {
    await ctx.prisma.$transaction(async (tx) => {
      const written = await ctx.store.writeResult(tx, claim, { status, lastError: code, delaySeconds });
      if (written !== 1) throw new LeaseLostError();
      if (audit) await appendAuditLog(tx, audit);
    });
    return true;
  } catch (err) {
    if (err instanceof LeaseLostError) { ctx.log.warn(`[deal-inbox] event ${claim.id}: lease lost, result not recorded.`); return false; }
    throw err;
  }
}

async function quarantine(ctx, claim, code, caseRecord = null) {
  ctx.log.error(`[ALERT] Bitrix24 inbound Deal event ${claim.id} (deal ${claim.dealId}) quarantined: ${code}`);
  return finish(ctx, claim, {
    status: 'ignored', code: `quarantined:${code}`,
    audit: auditEntry('bitrix.deal.inbound_quarantined', claim, { code: `quarantine:${code}`, caseRecord }),
  });
}

async function retryLater(ctx, claim, code, caseRecord = null) {
  if (claim.attempts >= MAX_ATTEMPTS) {
    ctx.log.error(`[ALERT] Bitrix24 inbound Deal event ${claim.id} (deal ${claim.dealId}) failed after ${claim.attempts} attempts: ${code}`);
    return finish(ctx, claim, { status: 'failed', code, audit: auditEntry('bitrix.deal.inbound_failed', claim, { code: `failed:${code}`, caseRecord }) });
  }
  return finish(ctx, claim, { status: 'received', code, delaySeconds: retryDelay(claim.attempts) });
}

// ---- applying a stage --------------------------------------------------------------------------------------------
async function applyStage(ctx, claim, caseRecord, deal, entry, modifiedAt) {
  const stageId = deal.STAGE_ID;
  const idemKey = `bitrix.deal.stage:${claim.dealId}:${stageId}:${modifiedAt.toISOString()}`;
  let outcome;

  await ctx.prisma.$transaction(async (tx) => {
    const [current] = await tx.$queryRaw`SELECT id, status, charter_stage, stage_version FROM cases WHERE id = ${caseRecord.id} FOR UPDATE`;
    if (!current) throw new ConcurrentChangeError();
    const link = await tx.bitrixDealLink.findUnique({ where: { caseId: caseRecord.id } });
    const previousStage = current.charter_stage ?? null;
    const previousStatus = current.status;
    const closeInbox = (status, code) => ctx.store.writeResult(tx, claim, { status, lastError: code });
    const requireFence = (written) => { if (written !== 1) throw new LeaseLostError(); };

    // (a) The same transition was already applied (a repeated or concurrent delivery).
    const already = await tx.caseStageEvent.findFirst({ where: { caseId: caseRecord.id, idempotencyKey: idemKey }, select: { id: true } });
    // (b) An older state than the last one applied: never move the Case backwards.
    const stale = link && link.externalModifiedAt && modifiedAt.getTime() < new Date(link.externalModifiedAt).getTime();
    const sameState = previousStage === entry.key && (entry.status === null || entry.status === previousStatus);
    const closed = CLOSED_STATUSES.has(previousStatus);

    const ignore = async (code) => {
      requireFence(await closeInbox('ignored', `ignored:${code}`));
      await appendAuditLog(tx, auditEntry('bitrix.deal.inbound_ignored', claim, { code: `ignored:${code}`, caseRecord, extra: { bitrixStageId: stageId } }));
      outcome = { result: 'ignored', code };
    };

    // (b2) Bitrix's modified time has one-second precision. A DIFFERENT stage with exactly the same modified time as
    // the last one applied cannot be ordered against it (two readers could have crossed). The first time, look again
    // after a short wait; the second read is later than any reader that was in flight, so it is applied.
    const sameSecondConflict = !already && link && link.externalModifiedAt && link.stageId && link.stageId !== stageId
      && modifiedAt.getTime() === new Date(link.externalModifiedAt).getTime() && claim.attempts < 2;

    if (already) return ignore('already_applied');
    if (stale) return ignore('stale_event');
    if (sameSecondConflict) {
      requireFence(await ctx.store.writeResult(tx, claim, { status: 'received', lastError: 'same_second_conflict', delaySeconds: SAME_SECOND_DELAY_SECONDS }));
      outcome = { result: 'deferred', code: 'same_second_conflict' };
      return undefined;
    }
    if (sameState) {
      requireFence(await closeInbox('ignored', 'ignored:no_change'));
      await tx.bitrixDealLink.update({ where: { caseId: caseRecord.id }, data: { stageId, externalModifiedAt: modifiedAt, lastSyncedAt: new Date(), syncStatus: 'synced', lastError: null } });
      await appendAuditLog(tx, auditEntry('bitrix.deal.inbound_ignored', claim, { code: 'ignored:no_change', caseRecord, extra: { bitrixStageId: stageId } }));
      outcome = { result: 'ignored', code: 'no_change' };
      return undefined;
    }
    if (closed) {
      // A completed or cancelled Case is never reopened or changed by an inbound event: a person decides.
      requireFence(await closeInbox('ignored', 'quarantined:case_already_closed'));
      await appendAuditLog(tx, auditEntry('bitrix.deal.inbound_quarantined', claim, { code: 'quarantine:case_already_closed', caseRecord, extra: { bitrixStageId: stageId } }));
      outcome = { result: 'quarantined', code: 'case_already_closed' };
      return undefined;
    }

    // (c) Apply. The inbox result is written first, so a lost lease rolls everything else back.
    requireFence(await closeInbox('processed', null));
    const nextStatus = entry.status ?? previousStatus;
    const nextVersion = Number(current.stage_version) + 1;
    const changed = await tx.case.updateMany({
      where: { id: caseRecord.id, stageVersion: Number(current.stage_version) },
      data: { charterStage: entry.key, status: nextStatus, stageVersion: { increment: 1 }, ...(CLOSED_STATUSES.has(nextStatus) ? { closedAt: new Date() } : {}) },
    });
    if (changed.count !== 1) throw new ConcurrentChangeError();
    const stageEvent = await tx.caseStageEvent.create({
      data: {
        caseId: caseRecord.id, stage: entry.key, note: null, previousStage, actorType: 'bitrix', actorId: null, source: 'bitrix_webhook',
        reasonCode: `bitrix:${stageId}`, idempotencyKey: idemKey, externalModifiedAt: modifiedAt,
      },
    });
    if (entry.status !== null) {
      await tx.serviceRequest.update({ where: { id: caseRecord.serviceRequest.id }, data: { status: requestStatusFor(nextStatus) } });
    }
    await tx.bitrixDealLink.update({ where: { caseId: caseRecord.id }, data: { stageId, externalModifiedAt: modifiedAt, lastSyncedAt: new Date(), syncStatus: 'synced', lastError: null } });
    if (entry.patientVisible && entry.message) {
      // Through the central core, inside this transaction: a failure rolls the whole stage change back. The profile's
      // `message` only decides WHETHER to notify; the title and body are the catalogue's fixed text. The stage event just
      // written is the stable event reference. The push deliveries are queued right after it, in the SAME transaction, only for a newly
      // created notification: a replay (created: false) queues nothing, and a failure to queue rolls the whole stage change back too.
      const serviceRequest = caseRecord.serviceRequest;
      const created = await createPatientNotification({
        recipientId: serviceRequest.userId,
        kind: 'stage_update',
        caseId: caseRecord.id,
        serviceRequestId: serviceRequest.id,
        eventRef: `cse${stageEvent.id}`,
        data: { screen: 'request', entityType: 'service_request', entityId: serviceRequest.id },
      }, { tx });
      if (created.created && pushMayBeQueued(ctx, serviceRequest)) await ctx.enqueuePush(tx, created.notification);
    }
    await appendAuditLog(tx, {
      caseId: caseRecord.id, entityType: 'case', entityId: caseRecord.id, action: 'bitrix.deal.stage_synced',
      actorType: 'bitrix', source: 'bitrix_webhook', reasonCode: `stage:${entry.key}`,
      beforeData: { charterStage: previousStage, status: previousStatus, stageVersion: Number(current.stage_version) },
      afterData: {
        charterStage: entry.key, status: nextStatus, stageVersion: nextVersion, bitrixStageId: stageId, bitrixDealId: claim.dealId,
        caseId: caseRecord.id, caseReference: caseRecord.referenceNumber, inboxEventId: claim.id,
      },
      correlationId: `inbox:${claim.id}`, idempotencyKey: idemKey,
    });
    outcome = { result: 'applied', stage: entry.key };
    return undefined;
  });
  return outcome;
}

// ---- one event ---------------------------------------------------------------------------------------------------
async function processInboxEvent(ctx, claim) {
  // The profile this processor works for (BITRIX_DEAL_PROFILE, no default). It decides the category, the reference field and the stage table.
  const active = resolveProfile(ctx.env);
  if (!active) {
    ctx.log.error(`[deal-inbox] event ${claim.id}: not processed (profile_not_configured).`);
    return false;
  }
  const link = await ctx.prisma.bitrixDealLink.findUnique({
    where: { bitrixDealId: claim.dealId },
    include: { case: { include: { serviceRequest: true } } },
  });
  if (!link) {
    return claim.attempts < NOT_LINKED_RETRIES ? retryLater(ctx, claim, 'deal_not_linked_yet') : quarantine(ctx, claim, 'deal_not_linked');
  }
  // A Deal of the other profile is never touched: the event is left as it is (nothing is written, nothing is consumed).
  const linkIssue = linkProfileProblem(link, active);
  if (linkIssue) {
    ctx.log.error(`[deal-inbox] event ${claim.id}: not processed (${linkIssue}).`);
    return false;
  }
  const caseRecord = link.case;
  try {
    assertDealEligible(caseRecord, caseRecord && caseRecord.serviceRequest);
  } catch {
    return quarantine(ctx, claim, 'case_not_eligible', caseRecord);
  }

  const read = await ctx.api.getDeal(claim.dealId, { env: ctx.env });
  if (read.status === 'not_found') return quarantine(ctx, claim, 'deal_not_found', caseRecord);
  if (read.status !== 'ok') return retryLater(ctx, claim, 'bitrix_read_failed', caseRecord);

  const deal = read.deal;
  const dealIssue = dealProblem(active, deal, claim.dealId, caseRecord.referenceNumber);
  if (dealIssue) return quarantine(ctx, claim, dealIssue, caseRecord);

  // Quotation synchronization (off unless BITRIX_QUOTATION_SYNC_ENABLED=true): the Deal was just verified as this Case's Deal, so
  // the Quotation PDF / amount / currency it carries are compared with the stored head version and, if they differ, ONE idempotent
  // "bitrix.quotation.sync" event is queued. Independent of the stage (an unknown stage is quarantined below, the quotation is
  // still noticed). If recording the event fails the whole inbox event is retried: a lost trigger would not come back by itself.
  if (isQuotationSyncActive(ctx.env)) {
    try {
      await detectAndEnqueueQuotationSync(ctx.prisma, caseRecord, deal, active);
    } catch (err) {
      ctx.log.warn(`[deal-inbox] event ${claim.id}: quotation event not recorded (${err && err.name ? err.name : 'error'}).`);
      return retryLater(ctx, claim, 'quotation_enqueue_failed', caseRecord);
    }
  }

  const stage = lookupProfileStage(active, deal.STAGE_ID, deal, { lostReasonField: ctx.lostReasonField });
  if (!stage.ok) return quarantine(ctx, claim, stage.code, caseRecord);

  const modifiedAt = new Date(deal.DATE_MODIFY);
  if (typeof deal.DATE_MODIFY !== 'string' || Number.isNaN(modifiedAt.getTime())) return quarantine(ctx, claim, 'modified_time_missing', caseRecord);

  return applyStage(ctx, claim, caseRecord, deal, stage.entry, modifiedAt);
}

// One pass. Does nothing at all unless both Bitrix switches and the review workflow are on.
async function runInboxWorker(overrides = {}) {
  const ctx = buildContext(overrides);
  if (!isPrivateCharterDealWorkerActive(ctx.env)) return { active: false, claimed: 0 };
  // Every Bitrix call of this worker passes the shared gateway at the API layer; here it is only asked BEFORE anything is claimed, so an open circuit
  // pauses the pass without using up a single delivery attempt.
  ctx.gateway = ctx.gateway || gatewayForPass(overrides);
  const start = ctx.gateway.canStart(PRIVATE_CHARTER_QUEUE);
  if (!start.ok) return { active: true, claimed: 0, paused: start.reason };

  await ctx.store.recoverExpiredLeases(ctx.prisma, { maxAttempts: MAX_ATTEMPTS });
  let claimed = 0;
  for (const id of await ctx.store.findDueIds(ctx.prisma, BATCH_SIZE, activeProfileName(ctx.env))) {
    const claim = await ctx.store.claim(ctx.prisma, { id, workerId: ctx.workerId, leaseSeconds: LEASE_SECONDS });
    if (!claim) continue;
    claimed += 1;
    try {
      await processInboxEvent(ctx, claim);
    } catch (err) {
      // Rolled back or unknown: nothing partial exists. The lease expires and recovery retries the event.
      ctx.log.error(`[deal-inbox] event ${claim.id}: ${err && err.name ? err.name : 'error'}; left for lease recovery.`);
    }
  }
  return { active: true, claimed };
}

module.exports = { runInboxWorker, processInboxEvent, LeaseLostError, ConcurrentChangeError, LEASE_SECONDS, MAX_ATTEMPTS, NOT_LINKED_RETRIES, BATCH_SIZE };
