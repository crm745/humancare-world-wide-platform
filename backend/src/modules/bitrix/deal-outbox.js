// The database half of the Private Charter Bitrix24 Deal integration: the records written, in the SAME
// transaction as the Case, so that a saved request can never be left without its Case or its integration
// event. Nothing here calls Bitrix24 and nothing here needs the Bitrix switches: the event is recorded
// whether or not the Deal worker is enabled, and the (future) worker stays idle until it is switched on.
//
// Per Case (M5/M6 design):
//   * one BitrixDealLink row (unique per Case): syncStatus "pending", no Deal ID yet;
//   * one IntegrationOutbox event "bitrix.deal.create" with the PERMANENT idempotency key
//     "bitrix.deal.create:case:<caseId>" (unique across the table, so a second event for the same Case is
//     refused by the database instead of doubled).
// The payload holds ids only, never patient details, medical content or a secret.
//
// Who may use it: Private Charter Cases only. The database cannot tell kinds of Case apart, so this refuses
// (throwing, which rolls the caller's transaction back) unless the Case belongs to a Private Charter
// ServiceRequest that is in the review workflow (reviewStatus not NULL, so the historical NULL requests are
// never enqueued) and that has no Bitrix Lead. Corporate Cases (serviceRequestId NULL) are always refused.
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');

const DEAL_CREATE_EVENT = 'bitrix.deal.create';
const DEAL_ENTITY_TYPE = 'case';

const dealCreateIdempotencyKey = (caseId) => `bitrix.deal.create:case:${caseId}`;
// The key of the ONE replacement event a person may authorise for a failed event (manual recovery). It is derived
// from the original event, and the key is unique, so the database itself allows at most one replacement per event.
const dealRecoveryIdempotencyKey = (caseId, originalEventId) => `bitrix.deal.create:case:${caseId}:recovery:${originalEventId}`;

function assertDealEligible(caseRecord, request) {
  const problem = (() => {
    if (!caseRecord || !request) return 'a Case and its ServiceRequest are required';
    if (caseRecord.serviceRequestId == null || caseRecord.serviceRequestId !== request.id) return 'the Case does not belong to this request (Corporate Cases never get a Deal)';
    if (request.serviceKey !== PRIVATE_CHARTER_KEY) return 'only Private Charter requests get a Deal';
    if (request.reviewStatus == null) return 'requests created before the review workflow are excluded until individually reviewed';
    if (request.bitrixLeadId != null) return 'the request already has a Bitrix Lead';
    return null;
  })();
  if (problem) throw new Error(`Bitrix Deal creation not recorded: ${problem}.`);
}

// Creating a Deal is allowed only for an APPROVED request (the Admin approval is what opens the Case and the Deal).
// assertDealEligible stays the looser check (it is also used for Deals that already exist: inbound stage sync,
// reconciliation, recovery), so a linked Deal of an older, unapproved request keeps working.
function assertDealCreationAllowed(caseRecord, request) {
  assertDealEligible(caseRecord, request);
  if (request.reviewStatus !== 'approved') {
    throw new Error('Bitrix Deal creation not recorded: only approved requests get a Deal.');
  }
}

// `tx` is the caller's transaction. Returns the two rows it wrote.
async function enqueueDealCreation(tx, caseRecord, request) {
  assertDealEligible(caseRecord, request);
  const link = await tx.bitrixDealLink.create({ data: { caseId: caseRecord.id, syncStatus: 'pending' } });
  const event = await tx.integrationOutbox.create({
    data: {
      eventType: DEAL_CREATE_EVENT,
      entityType: DEAL_ENTITY_TYPE,
      entityId: String(caseRecord.id),
      caseId: caseRecord.id,
      idempotencyKey: dealCreateIdempotencyKey(caseRecord.id),
      payload: { caseId: caseRecord.id, serviceRequestId: request.id },
      status: 'pending',
      nextAttemptAt: new Date(),
    },
  });
  return { link, event };
}

// Idempotent version used by the Admin approval, inside the approval's transaction. It writes only what is MISSING:
// the Deal link (unique per Case) and the "bitrix.deal.create" event (unique key per Case). A Case that already has
// its link and event (an older one, or a repeated call) gets nothing new, and a Case whose link already holds a Deal
// ID never gets another event. An existing event is never reset or recreated, whatever its status (a failed or
// ambiguous one is a person's decision, see deal-recovery.service.js).
async function ensureDealCreation(tx, caseRecord, request) {
  assertDealCreationAllowed(caseRecord, request);
  let link = await tx.bitrixDealLink.findUnique({ where: { caseId: caseRecord.id } });
  let linkCreated = false;
  if (!link) {
    link = await tx.bitrixDealLink.create({ data: { caseId: caseRecord.id, syncStatus: 'pending' } });
    linkCreated = true;
  }
  let event = await tx.integrationOutbox.findUnique({ where: { idempotencyKey: dealCreateIdempotencyKey(caseRecord.id) } });
  let eventCreated = false;
  if (!event && !link.bitrixDealId) {
    event = await tx.integrationOutbox.create({
      data: {
        eventType: DEAL_CREATE_EVENT,
        entityType: DEAL_ENTITY_TYPE,
        entityId: String(caseRecord.id),
        caseId: caseRecord.id,
        idempotencyKey: dealCreateIdempotencyKey(caseRecord.id),
        payload: { caseId: caseRecord.id, serviceRequestId: request.id },
        status: 'pending',
        nextAttemptAt: new Date(),
      },
    });
    eventCreated = true;
  }
  return { link, event, linkCreated, eventCreated };
}

module.exports = { enqueueDealCreation, ensureDealCreation, assertDealCreationAllowed, assertDealEligible, dealCreateIdempotencyKey, dealRecoveryIdempotencyKey, DEAL_CREATE_EVENT, DEAL_ENTITY_TYPE };
