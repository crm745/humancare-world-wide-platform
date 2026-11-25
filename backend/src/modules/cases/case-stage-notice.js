// The patient's notice after an ADMIN case stage change: the in-app notification and its push deliveries, in ONE transaction (after the stage change itself
// has committed; see applyStageChange in cases.service.js for why the two are separate). Used by applyStageChange AND by the recovery job
// (case-stage-notification-reconciler.js), so both create the notification the same way and with the same idempotency key
// (stage_update:patient:<patient id>:cse<stage event id>): whichever runs second finds it and creates nothing.
//
// No Bitrix import is allowed here: the dedicated push worker loads this module and must not depend on the Bitrix configuration.
const { prisma } = require('../../db/prisma');
const { createPatientNotification } = require('../notifications/notification-core');
const { enqueuePushDeliveries } = require('../notifications/push-delivery-enqueue');
const { suppressionReason, SYNTHETIC_IDENTITY_PREFIX } = require('../notifications/push-delivery.config');

// The eligibility marker written on the stage event by the admin path, in the existing nullable columns case_stage_events.source and .actor_type.
// Only a patient's service-request Case gets it. Bitrix events carry 'bitrix_webhook' / 'bitrix', the review workflow 'system', everything older NULL.
const ADMIN_STAGE_SOURCE = 'admin_stage_change';
const ADMIN_STAGE_ACTOR = 'admin';

const STAGE_NOTICE_KIND = 'stage_update';

function caseDeps(deps = {}) {
  const ctx = { enqueuePush: enqueuePushDeliveries, env: process.env, log: console, ...deps };
  if (typeof ctx.enqueuePush !== 'function') ctx.enqueuePush = enqueuePushDeliveries; // undefined = the default, never "nothing"
  if (!ctx.env || typeof ctx.env !== 'object') ctx.env = process.env;
  return ctx;
}

// The environment guard, then the synthetic E2E identity: neither queues push deliveries (the in-app notification is unaffected).
function pushMayBeQueued(ctx, serviceRequest) {
  if (suppressionReason(ctx.env)) return false;
  const name = serviceRequest && typeof serviceRequest.patientName === 'string' ? serviceRequest.patientName : '';
  return !name.startsWith(SYNTHETIC_IDENTITY_PREFIX);
}

// A short, identifier-shaped description of a failure for the log: never the message (a database error can quote values), never a token.
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
function failureCode(err) {
  const pick = (v) => (typeof v === 'string' && SAFE_IDENTIFIER.test(v) ? v : null);
  return (err && (pick(err.publicCode) || pick(err.code) || pick(err.name))) || 'Error';
}

// The patient's notification and its push deliveries, in ONE transaction: the notification through the central core (the catalogue's fixed title and
// body: the staff note is never copied into it), then `enqueuePush(tx, notification)` only for a newly created one. A replay (created: false) creates and queues nothing.
async function notifyPatient(ctx, caseRecord, stageEvent) {
  const serviceRequest = caseRecord.serviceRequest;
  return prisma.$transaction(async (tx) => {
    const { notification, created } = await createPatientNotification({
      recipientId: serviceRequest.userId,
      kind: STAGE_NOTICE_KIND,
      caseId: caseRecord.id,
      serviceRequestId: serviceRequest.id,
      eventRef: `cse${stageEvent.id}`,
      data: { screen: 'request', entityType: 'service_request', entityId: serviceRequest.id },
    }, { tx });
    if (!created) return { status: 'exists' };
    // The name that decides the synthetic-identity rule is read here, not added to the Case's response (CASE_INCLUDE is what clients receive).
    const identity = await tx.serviceRequest.findUnique({ where: { id: serviceRequest.id }, select: { patientName: true } });
    const deliveries = pushMayBeQueued(ctx, identity) ? await ctx.enqueuePush(tx, notification) : { enqueued: 0, alreadyQueued: 0, skipped: 'suppressed' };
    return { status: 'created', deliveries };
  });
}

module.exports = { STAGE_NOTICE_KIND, ADMIN_STAGE_SOURCE, ADMIN_STAGE_ACTOR, caseDeps, pushMayBeQueued, failureCode, notifyPatient };
