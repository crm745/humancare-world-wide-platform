const { prisma } = require('../../db/prisma');
const { SAFE_DOCUMENT_SELECT } = require('../documents/document-response');
// The patient's notice after a stage change lives in case-stage-notice.js (no Bitrix imports), so the push worker's reconciler can reuse it unchanged.
const { ADMIN_STAGE_SOURCE, ADMIN_STAGE_ACTOR, caseDeps, failureCode, notifyPatient } = require('./case-stage-notice');
const { createLead } = require('../bitrix/bitrix.service');
const { leadInputFromCase } = require('../bitrix/bitrix-lead');
const { isBitrixSyncEnabled } = require('../bitrix/bitrix-config');

const VALID_CASE_STATUSES = ['submitted', 'scheduled', 'in_progress', 'completed', 'cancelled'];
const CASE_INCLUDE = {
  stageEvents: { orderBy: { occurredAt: 'asc' } },
  // Never `documents: true`: that would send each row's stored path (fileUrl) to the client.
  documents: { select: SAFE_DOCUMENT_SELECT },
  serviceRequest: { select: { id: true, userId: true, referenceNumber: true } },
};

// corporateId here means "which institution requested this," not "who is working it" —
// corporates (insurance/government/corporate) submit and track, they don't claim or
// fulfill cases themselves. Actual case work happens in Bitrix24 by HumanCare's own
// Operations team; see updateCaseStage below for how that flows back in.
async function listCasesForCorporate(corporateId, { status } = {}) {
  const where = { corporateId };
  if (status && status !== 'all') {
    if (!VALID_CASE_STATUSES.includes(status)) {
      const err = new Error(`Invalid status filter. Use one of: ${VALID_CASE_STATUSES.join(', ')}`);
      err.statusCode = 400;
      throw err;
    }
    where.status = status;
  }
  return prisma.case.findMany({ where, orderBy: { updatedAt: 'desc' } });
}

// Accepts either the numeric database id (what the mobile app has always used) or the
// human-readable referenceNumber like "CASE-1042" (what the corporate-portal web app
// links to, since that's the id it displays) — whichever one `id` looks like.
async function getCaseById(id) {
  const numericId = Number(id);
  const caseRecord = Number.isInteger(numericId)
    ? await prisma.case.findUnique({ where: { id: numericId }, include: CASE_INCLUDE })
    : await prisma.case.findUnique({ where: { referenceNumber: String(id) }, include: CASE_INCLUDE });
  if (!caseRecord) {
    const err = new Error('Case not found');
    err.statusCode = 404;
    throw err;
  }
  return caseRecord;
}

async function createCaseByCorporate(corporateId, data) {
  const {
    patientName,
    patientAge,
    patientGender,
    patientContact,
    serviceType,
    origin,
    destination,
    country,
    urgency,
    policyReference,
    careLevel,
    description,
    additionalInfo,
    specialRequirements,
    referralSource,
    notes,
  } = data;

  const created = await prisma.case.create({
    data: {
      corporateId,
      referenceNumber: `TEMP-${Date.now()}`,
      patientName,
      patientAge: patientAge ? Number(patientAge) : null,
      patientGender: patientGender || null,
      patientContact: patientContact || null,
      serviceType,
      origin,
      destination,
      country: country || null,
      urgency: urgency || 'routine',
      policyReference: policyReference || null,
      careLevel: careLevel || null,
      description: description || null,
      additionalInfo: additionalInfo || null,
      specialRequirements: specialRequirements || null,
      referralSource: referralSource || null,
      notes: notes || null,
      status: 'submitted',
    },
  });

  // Prefixed CASE- (not REQ-) so this can never collide with a patient-submitted
  // ServiceRequest's reference number — those use a separate id sequence.
  const caseRecord = await prisma.case.update({
    where: { id: created.id },
    data: { referenceNumber: `CASE-${1000 + created.id}` },
  });

  await prisma.caseStageEvent.create({
    data: { caseId: caseRecord.id, stage: 'submitted', note: 'Case opened by corporate.' },
  });

  // Bitrix24 is best-effort: a CRM hiccup must never fail the corporate's submission,
  // which has already been saved above by this point. Same pattern as the patient
  // app's own request flow (requests.service.js#createRequest) — on failure this is
  // persisted (not just logged) so the background retry sweep in
  // bitrix-retry.service.js can pick it back up. While the switch is off nothing is
  // sent and nothing is recorded as failed (see bitrix-config.js).
  if (!isBitrixSyncEnabled()) return caseRecord;
  try {
    const leadId = await createLead(leadInputFromCase(caseRecord));
    await prisma.case.update({ where: { id: caseRecord.id }, data: { bitrixLeadId: leadId } });
  } catch (err) {
    console.error(`Bitrix24 lead creation failed for ${caseRecord.referenceNumber}:`, err.message);
    await prisma.case.update({
      where: { id: caseRecord.id },
      data: { bitrixSyncAttempts: 1, bitrixLastError: err.message, bitrixSyncFailedAt: new Date() },
    });
  }

  return caseRecord;
}

// ---- the stage change ---------------------------------------------------------------------------------------------------------------------------
// Not exposed to corporates directly. Reachable today via PATCH /admin/cases/:id/stage
// as a manual stand-in for Operations; once the Bitrix24 webhook exists, that will
// call this too whenever a lead's stage moves in Bitrix24.
//
// TWO transactions, on purpose (the boundaries are the point of this function):
//   1. THE STAGE CHANGE: the Case status, the stage event and the patient-facing request status, together. All or nothing: any failure here rolls
//      all three back and is thrown to the caller, exactly as a failed stage change always was.
//   2. THE PATIENT NOTIFICATION (only for a Case that belongs to a patient's service request; a corporate Case has none and is never notified): the in-app
//      notification and its push deliveries, together, in one transaction of their own, AFTER the stage change has committed. Both commit or both roll
//      back, and the notification is created once per stage event (its key is the stage event's id, so a replay creates nothing twice).
//      A failure here must NOT turn a stage change that has already committed into an error response: it is reported (an [ALERT] line with a short code
//      and the `patientNotification` field of applyStageChange's result), never swallowed silently, and never retried by this function.
//
// Why not one transaction for everything (as the Bitrix and quotation senders do)? There, the notification is part of the very event being recorded. Here the
// stage change is an Operations decision that is already final for the people who made it; the patient's notice is a consequence, not a condition.
//
// `deps` (all optional): { enqueuePush(tx, notification), env, log }. `enqueuePush` queues the push deliveries; a run that must queue none passes
// suppressedEnqueuePush. `env` decides whether this run may queue them at all (a test, scoped, integration or synthetic run never does).
/**
 * The stage change and the patient's notice. Resolves { case, patientNotification } where patientNotification is
 *   { status: 'not_applicable' }                         a corporate Case: nobody is notified
 *   { status: 'created', deliveries: { enqueued, ... } } the notification was created (and its push deliveries queued, or skipped with a reason)
 *   { status: 'exists' }                                 the notification for this stage event already existed: nothing was created again
 *   { status: 'failed', code }                           the stage change IS committed; the notice could not be written (see above)
 * Throws (nothing was changed) for an invalid stage, an unknown Case or a failed stage change.
 */
async function applyStageChange(caseId, stage, note, deps) {
  if (!VALID_CASE_STATUSES.includes(stage)) {
    const err = new Error(`Invalid stage. Use one of: ${VALID_CASE_STATUSES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  const ctx = caseDeps(deps);
  const caseRecord = await getCaseById(caseId);

  // 1. The stage change: one transaction, thrown on any failure.
  const { updated, stageEvent } = await prisma.$transaction(async (tx) => {
    const updatedCase = await tx.case.update({ where: { id: caseRecord.id }, data: { status: stage } });
    // The persisted stage event is the stable reference for the patient's notification.
    // A Case of a patient's service request is marked as an admin stage change: the explicit eligibility marker of the recovery job
    // (case-stage-notification-reconciler.js). A corporate Case (no service request) is never marked: nobody is notified for it.
    const marker = caseRecord.serviceRequest ? { source: ADMIN_STAGE_SOURCE, actorType: ADMIN_STAGE_ACTOR } : {};
    const event = await tx.caseStageEvent.create({ data: { caseId: caseRecord.id, stage, note: note || null, ...marker } });
    if (caseRecord.serviceRequest) {
      // Keep the patient-facing ServiceRequest.status in the same simplified vocabulary
      // the My Requests screen filters on.
      const requestStatus = stage === 'completed' ? 'completed' : stage === 'cancelled' ? 'cancelled' : stage === 'submitted' ? 'submitted' : 'in_progress';
      await tx.serviceRequest.update({ where: { id: caseRecord.serviceRequest.id }, data: { status: requestStatus } });
    }
    return { updated: updatedCase, stageEvent: event };
  });

  // 2. The patient's notice, after the commit. A corporate Case (no service request) has none.
  if (!caseRecord.serviceRequest) return { case: updated, patientNotification: { status: 'not_applicable' } };
  try {
    return { case: updated, patientNotification: await notifyPatient(ctx, caseRecord, stageEvent) };
  } catch (err) {
    const code = failureCode(err);
    ctx.log.error(`[ALERT] Case ${caseRecord.id}: the stage change to "${stage}" is committed (stage event ${stageEvent.id}) but the patient's notification could not be created (${code}).`);
    return { case: updated, patientNotification: { status: 'failed', code } };
  }
}

// What the admin endpoint calls: the same signature and the same result (the updated Case) as always. The outcome of the patient's notice is in
// applyStageChange's result and, when it failed, in the [ALERT] log line; it is not part of the HTTP response.
async function updateCaseStage(caseId, stage, note, deps) {
  return (await applyStageChange(caseId, stage, note, deps)).case;
}

module.exports = {
  VALID_CASE_STATUSES,
  listCasesForCorporate,
  getCaseById,
  createCaseByCorporate,
  updateCaseStage,
  applyStageChange,
};
