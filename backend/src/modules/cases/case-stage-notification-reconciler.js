// RECOVERY of the patient notification of an admin case stage change.
//
// applyStageChange (cases.service.js) commits the stage change first and creates the patient's notification afterwards, in a transaction of its own. If that
// second step fails (or the process dies between the two), the stage change stays and the patient was never told. This job finds those events and creates the
// missing notification, through the SAME function the original path uses (case-stage-notice.js notifyPatient: the in-app notification and its push deliveries
// in one transaction, with the same idempotency key stage_update:patient:<patient id>:cse<stage event id>).
//
// Which events are eligible (all must hold; nothing else is ever touched):
//   * case_stage_events.source = 'admin_stage_change' AND actor_type = 'admin': the explicit marker the admin path writes, and only for a Case of a patient's
//     service request. Events with NULL or any other source (older events, Bitrix 'bitrix_webhook', the review workflow 'system', ...) are NOT eligible, so
//     nothing old is back-filled and Bitrix events (which notify in their own transaction) can never be notified twice;
//   * the Case has a service request (a corporate Case never does);
//   * the event is not older than MAX_AGE_HOURS (24 h) and not younger than GRACE_SECONDS: the original path gets time to finish its own notification first.
//
// Duplicates are impossible by construction: the notification's idempotency key is UNIQUE, so the second of two writers (this job, a second copy of it, or the
// original path) finds the first one's row and creates nothing. The pre-check below only saves work; correctness never depends on it. A stage change is never
// undone or touched here: this job only creates notifications. One failing event does not stop the others; it is tried again on the next run until it is older
// than 24 h.
//
// It runs regardless of the push switch (the in-app notification does not depend on it; push deliveries are queued only as the original path would, and are
// refused in a test, scoped, integration or synthetic run). In such a run the whole job does nothing.
//
// Logs: aggregate counts and short error codes only: never a patient, case, event or notification id, a name, a token or any notification text.
const { prisma: defaultPrisma } = require('../../db/prisma');
const { buildIdempotencyKey } = require('../notifications/notification-catalogue');
const { suppressionReason } = require('../notifications/push-delivery.config');
const { ADMIN_STAGE_SOURCE, ADMIN_STAGE_ACTOR, STAGE_NOTICE_KIND, failureCode, notifyPatient, caseDeps } = require('./case-stage-notice');

const POLICY = Object.freeze({
  MAX_AGE_HOURS: 24, // never look further back than this
  GRACE_SECONDS: 120, // an event younger than this is left to the original path
  BATCH: 100, // events examined per run (oldest first)
  FAILURE_ALERT_COOLDOWN_SECONDS: 30 * 60, // a failure is reported at most this often (the job runs every few minutes)
});

const defaultState = { lastFailureAlertAtMs: 0 };

/**
 * One reconciliation run. `overrides`: { prisma, env, log, nowMs, state, enqueuePush, notify }.
 * Resolves { active: false, problem } when it must not run, otherwise { active: true, checked, alreadyNotified, recovered, failed }.
 */
async function reconcileStageNotifications(overrides = {}) {
  const ctx = { prisma: defaultPrisma, env: process.env, log: console, nowMs: () => Date.now(), state: defaultState, notify: notifyPatient, ...overrides };
  const suppressed = suppressionReason(ctx.env);
  if (suppressed) return { active: false, problem: `suppressed_${suppressed}` };

  const now = ctx.nowMs();
  const events = await ctx.prisma.caseStageEvent.findMany({
    where: {
      source: ADMIN_STAGE_SOURCE,
      actorType: ADMIN_STAGE_ACTOR,
      occurredAt: { gte: new Date(now - POLICY.MAX_AGE_HOURS * 3600 * 1000), lte: new Date(now - POLICY.GRACE_SECONDS * 1000) },
      case: { serviceRequestId: { not: null } },
    },
    orderBy: { id: 'asc' },
    take: POLICY.BATCH,
    select: { id: true, stage: true, caseId: true, case: { select: { id: true, serviceRequest: { select: { id: true, userId: true } } } } },
  });
  const result = { active: true, checked: 0, alreadyNotified: 0, recovered: 0, failed: 0 };
  const eligible = events.filter((e) => e.case && e.case.serviceRequest && Number.isSafeInteger(e.case.serviceRequest.userId));
  result.checked = eligible.length;
  if (eligible.length === 0) return result;

  // Work saved, not correctness: events whose notification already exists are skipped without opening a transaction.
  const keyOf = (e) => buildIdempotencyKey({ recipientType: 'patient', recipientId: e.case.serviceRequest.userId, kind: STAGE_NOTICE_KIND, eventRef: `cse${e.id}` });
  const existing = await ctx.prisma.notification.findMany({ where: { idempotencyKey: { in: eligible.map(keyOf) } }, select: { idempotencyKey: true } });
  const have = new Set(existing.map((n) => n.idempotencyKey));

  const deps = caseDeps({ env: ctx.env, log: ctx.log, ...(ctx.enqueuePush ? { enqueuePush: ctx.enqueuePush } : {}) });
  const codes = {};
  for (const event of eligible) {
    if (have.has(keyOf(event))) { result.alreadyNotified += 1; continue; }
    try {
      const outcome = await ctx.notify(deps, { id: event.case.id, serviceRequest: event.case.serviceRequest }, { id: event.id, stage: event.stage });
      if (outcome && outcome.status === 'created') result.recovered += 1;
      else result.alreadyNotified += 1; // 'exists': another writer created it between the pre-check and now
    } catch (err) {
      result.failed += 1;
      const code = failureCode(err);
      codes[code] = (codes[code] || 0) + 1;
    }
  }

  if (result.recovered > 0) {
    ctx.log.info(`[case-stage-reconciler] recovered ${result.recovered} missed patient notification(s) (checked ${result.checked}, already notified ${result.alreadyNotified}, failed ${result.failed}).`);
  }
  if (result.failed > 0 && now - ctx.state.lastFailureAlertAtMs >= POLICY.FAILURE_ALERT_COOLDOWN_SECONDS * 1000) {
    ctx.state.lastFailureAlertAtMs = now;
    const summary = Object.entries(codes).map(([code, n]) => `${code}:${n}`).join(',');
    ctx.log.error(`[ALERT] [case-stage-reconciler] ${result.failed} patient notification(s) could not be recovered (codes ${summary}); they are tried again until they are 24 h old.`);
  }
  return result;
}

module.exports = { reconcileStageNotifications, POLICY };
