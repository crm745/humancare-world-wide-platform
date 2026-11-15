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

module.exports = { enqueueDealCreation, assertDealEligible, dealCreateIdempotencyKey, dealRecoveryIdempotencyKey, DEAL_CREATE_EVENT, DEAL_ENTITY_TYPE };
