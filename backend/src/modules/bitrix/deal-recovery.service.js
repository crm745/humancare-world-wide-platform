// Manual recovery of a Private Charter Deal event that did not complete. Decided by a person (superadmin), recorded
// in the append-only AuditLog, and designed so that it can never produce a second Deal for a Case:
//
//   mode "requeue"          the event FAILED BEFORE any Bitrix call (external_call_started_at is NULL: a mapping,
//                           eligibility or lease failure). The Case data is validated again; if the original problem
//                           is not corrected the request is refused. A NEW event (new key) is written.
//   mode "confirm_no_deal"  the event has call evidence (Bitrix refused definitively, or reconciliation ran its whole
//                           waiting period without a match). Bitrix is searched again first: a Deal that exists is a
//                           refusal (adopt it instead). The person attests, with a reason, that they also checked in
//                           Bitrix. A NEW event (new key) is written.
//   mode "adopt_deal"       an ambiguous event in manual review. The person names the Bitrix Deal ID; Bitrix must
//                           confirm that this Deal is in Category 38 and carries the exact Case reference. The event
//                           is then completed and the link set, as reconciliation would have done.
//
// Never done here: the original event is never deleted, never reset to pending, and its last_error / call evidence
// are never changed (adopt only completes it, as M6 rule R1 does). An event with call evidence is never requeued by
// "requeue". An ambiguous event still being reconciled (no manual-review marker) cannot be touched at all.
//
// Duplicate protection: the replacement's idempotency key is derived from the original event
// (dealRecoveryIdempotencyKey) and is UNIQUE, so the database allows one replacement per event whatever happens.
// The original event row and every event of the Case are locked (SELECT ... FOR UPDATE) in one transaction, so two
// concurrent requests are serialised and the second sees the first one's replacement. A Case that already has an
// event waiting or running, or a Deal ID on its link, is refused.
//
// The reason is a CODE from a fixed list, not free text: the audit writer deliberately has no free-text column,
// so a patient detail cannot end up in the audit trail.
const { appendAuditLog } = require('../../common/audit/business-audit');
const { assertDealEligible, DEAL_CREATE_EVENT, DEAL_ENTITY_TYPE, dealRecoveryIdempotencyKey } = require('./deal-outbox');
const { buildDealFields, DealMappingError, DEAL } = require('./bitrix-deal');
const { MANUAL_REVIEW_PREFIX } = require('./deal-outbox.store');

const MODES = ['requeue', 'confirm_no_deal', 'adopt_deal'];
const REASON_CODES = ['data_corrected', 'bitrix_issue_resolved', 'checked_in_bitrix', 'deal_found_in_bitrix'];
const ACTION_RECOVERY = 'bitrix.deal.recovery';
const ACTION_ADOPTED = 'bitrix.deal.adopted_manually';
const NO_MATCH_REVIEWS = [`${MANUAL_REVIEW_PREFIX}:no_match`, `${MANUAL_REVIEW_PREFIX}:lookup_uncertain`];

class RecoveryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RecoveryError';
    this.status = status;
    this.code = code;
  }
}
const refuse = (status, code, message) => new RecoveryError(status, code, message);

function validateInput({ actor, caseId, eventId, mode, reasonCode, dealId }) {
  if (!actor || actor.role !== 'superadmin') throw refuse(403, 'forbidden', 'Superadmin access required.');
  if (!Number.isInteger(actor.id) || actor.id <= 0) throw refuse(403, 'forbidden', 'A signed-in Admin is required.');
  if (!Number.isInteger(caseId) || caseId <= 0 || !Number.isInteger(eventId) || eventId <= 0) throw refuse(400, 'invalid_ids', 'caseId and eventId must be whole numbers.');
  if (!MODES.includes(mode)) throw refuse(400, 'invalid_mode', `mode must be one of: ${MODES.join(', ')}.`);
  if (typeof reasonCode !== 'string' || !REASON_CODES.includes(reasonCode)) {
    throw refuse(400, 'reason_required', `An explicit reasonCode is required: one of ${REASON_CODES.join(', ')}.`);
  }
  if (mode === 'adopt_deal' && !(typeof dealId === 'string' && /^[1-9]\d*$/.test(dealId))) {
    throw refuse(400, 'invalid_deal_id', 'dealId must be the Bitrix Deal ID as digits.');
  }
}

function writeAudit(tx, action, ctx) {
  return appendAuditLog(tx, {
    caseId: ctx.caseId, entityType: 'integration_outbox', entityId: ctx.eventId, action,
    actorType: 'admin', actorId: ctx.actor.id, actorRole: ctx.actor.role, source: 'admin_portal',
    isOverride: ctx.mode !== 'requeue', reasonCode: ctx.reasonCode,
    beforeData: ctx.before,
    afterData: {
      eventId: ctx.eventId, newEventId: ctx.newEventId, caseId: ctx.caseId, caseReference: ctx.caseRecord.referenceNumber,
      status: ctx.status, ...(ctx.dealId ? { bitrixDealId: ctx.dealId } : {}),
    },
    correlationId: `recovery:${ctx.eventId}`, idempotencyKey: `${action}:event:${ctx.eventId}`,
  });
}

async function recoverDealEvent({ prisma, api, env = process.env, actor, caseId, eventId, mode, reasonCode, dealId }) {
  validateInput({ actor, caseId, eventId, mode, reasonCode, dealId });

  // Read-only look first (no lock); everything is checked again under lock below.
  const first = await prisma.integrationOutbox.findUnique({ where: { id: eventId } });
  if (!first || first.eventType !== DEAL_CREATE_EVENT || first.caseId !== caseId) throw refuse(404, 'event_not_found', 'No such Deal event for this Case.');
  const caseForReference = await prisma.case.findUnique({ where: { id: caseId }, select: { referenceNumber: true } });
  if (!caseForReference) throw refuse(404, 'case_not_found', 'No such Case.');

  // Bitrix is read BEFORE the transaction (never inside one).
  let found = null;
  if (mode !== 'requeue') {
    found = await api.findDealsByReference(caseForReference.referenceNumber, { env });
    const exists = found.status === 'single' || found.status === 'multiple';
    if (mode === 'confirm_no_deal' && exists) {
      throw refuse(409, 'deal_exists_in_bitrix', 'Bitrix already has a Deal with this reference. Adopt it instead of creating another.');
    }
    if (mode === 'adopt_deal' && !(exists && found.dealIds.includes(dealId))) {
      throw refuse(409, 'deal_not_confirmed', 'Bitrix did not confirm this Deal for the Case reference.');
    }
  }

  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw`
      SELECT id, status, case_id, last_error, external_call_started_at, locked_by FROM integration_outbox WHERE id = ${eventId} FOR UPDATE`;
    if (!row || Number(row.case_id) !== caseId) throw refuse(404, 'event_not_found', 'No such Deal event for this Case.');
    const all = await tx.$queryRaw`
      SELECT id, status, event_type, idempotency_key FROM integration_outbox
      WHERE entity_type = ${DEAL_ENTITY_TYPE} AND entity_id = ${String(caseId)} ORDER BY id FOR UPDATE`;

    const replacementKey = dealRecoveryIdempotencyKey(caseId, eventId);
    const existing = all.find((event) => event.idempotency_key === replacementKey);
    if (existing) throw refuse(409, 'already_recovered', `This event already has a replacement (event ${existing.id}).`);
    if (all.some((event) => event.event_type === DEAL_CREATE_EVENT && ['pending', 'processing'].includes(event.status))) {
      throw refuse(409, 'event_in_flight', 'A Deal event for this Case is already waiting or running.');
    }

    const caseRecord = await tx.case.findUnique({ where: { id: caseId }, include: { serviceRequest: true, bitrixDealLink: true } });
    try {
      assertDealEligible(caseRecord, caseRecord && caseRecord.serviceRequest);
    } catch {
      throw refuse(409, 'not_eligible', 'The Case is not eligible for a Bitrix Deal.');
    }
    const link = caseRecord.bitrixDealLink;
    if (!link) throw refuse(409, 'deal_link_missing', 'The Case has no Deal link.');
    if (link.bitrixDealId) throw refuse(409, 'deal_already_linked', 'The Case already has a Bitrix Deal.');

    const evidence = row.external_call_started_at != null;
    const lastError = String(row.last_error || '');
    const inManualReview = row.status === 'ambiguous' && lastError.startsWith(MANUAL_REVIEW_PREFIX);
    const base = { actor, caseId, eventId, mode, reasonCode, caseRecord, before: { eventId, status: row.status } };

    if (mode === 'adopt_deal') {
      if (!inManualReview) {
        throw refuse(409, 'reconciliation_required', 'Only an ambiguous event that reconciliation could not settle (manual review) can be resolved by adopting a Deal.');
      }
      if (lastError.startsWith(`${MANUAL_REVIEW_PREFIX}:deal_id_already_linked`)) throw refuse(409, 'deal_id_already_linked', 'That Deal is linked to another Case.');
      const changed = await tx.$executeRaw`
        UPDATE integration_outbox
        SET status = 'completed', completed_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
        WHERE id = ${eventId} AND status = 'ambiguous' AND locked_by IS NULL`;
      if (Number(changed) !== 1) throw refuse(409, 'event_changed', 'The event changed; nothing was done.');
      try {
        await tx.bitrixDealLink.update({
          where: { caseId },
          data: {
            bitrixDealId: dealId, categoryId: String(DEAL.CATEGORY_ID), stageId: found.stageId ?? null, syncStatus: 'synced',
            lastSyncedAt: new Date(), lastAttemptAt: new Date(), lastError: null,
          },
        });
      } catch (err) {
        if (err && err.code === 'P2002') throw refuse(409, 'deal_id_already_linked', 'That Deal is linked to another Case.');
        throw err;
      }
      await writeAudit(tx, ACTION_ADOPTED, { ...base, newEventId: null, status: 'completed', dealId });
      return { mode, eventId, newEventId: null, status: 'completed', bitrixDealId: dealId };
    }

    if (mode === 'requeue') {
      if (evidence) throw refuse(409, 'external_call_evidence', 'A Bitrix call was started for this event. It cannot be requeued; use reconciliation or confirm_no_deal.');
      if (row.status !== 'failed') throw refuse(409, 'not_failed', 'Only a failed event can be requeued.');
    } else {
      const bitrixRefusal = row.status === 'failed' && lastError.startsWith('Bitrix24 Deal call:');
      const noMatchReview = inManualReview && NO_MATCH_REVIEWS.some((prefix) => lastError.startsWith(prefix));
      if (!evidence) throw refuse(409, 'use_requeue', 'No Bitrix call was made for this event; use requeue.');
      if (!bitrixRefusal && !noMatchReview) {
        throw refuse(409, 'not_recoverable', 'This event cannot be replaced: reconciliation has not finished, or a Deal may exist.');
      }
    }

    // The original problem must be gone: the CURRENT Case data must now map to a valid Deal.
    try {
      buildDealFields(caseRecord, caseRecord.serviceRequest);
    } catch (err) {
      if (err instanceof DealMappingError) throw refuse(422, 'not_corrected', `The Case data still cannot be sent (${err.code}). Correct it first.`);
      throw err;
    }

    let created;
    try {
      created = await tx.integrationOutbox.create({
        data: {
          eventType: DEAL_CREATE_EVENT, entityType: DEAL_ENTITY_TYPE, entityId: String(caseId), caseId, idempotencyKey: replacementKey,
          payload: { caseId, serviceRequestId: caseRecord.serviceRequestId, recoveryOf: eventId },
          status: 'pending', nextAttemptAt: new Date(0), // the epoch: due at once, with no application clock involved
          correlationId: `recovery:${eventId}`,
        },
      });
    } catch (err) {
      if (err && err.code === 'P2002') throw refuse(409, 'already_recovered', 'This event already has a replacement.');
      throw err;
    }
    await tx.bitrixDealLink.update({ where: { caseId }, data: { syncStatus: 'pending', lastError: null } });
    await writeAudit(tx, ACTION_RECOVERY, { ...base, newEventId: created.id, status: 'pending' });
    return { mode, eventId, newEventId: created.id, status: 'pending' };
  });
}

module.exports = { recoverDealEvent, RecoveryError, MODES, REASON_CODES, ACTION_RECOVERY, ACTION_ADOPTED };
