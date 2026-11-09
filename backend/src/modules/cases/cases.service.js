const { prisma } = require('../../db/prisma');
const { SAFE_DOCUMENT_SELECT } = require('../documents/document-response');
const { sendExpoPush } = require('../../integrations/push/expo-push.service');
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

// Not exposed to corporates directly. Reachable today via PATCH /admin/cases/:id/stage
// as a manual stand-in for Operations; once the Bitrix24 webhook exists, that will
// call this too whenever a lead's stage moves in Bitrix24.
async function updateCaseStage(caseId, stage, note) {
  if (!VALID_CASE_STATUSES.includes(stage)) {
    const err = new Error(`Invalid stage. Use one of: ${VALID_CASE_STATUSES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  const caseRecord = await getCaseById(caseId);

  const updated = await prisma.case.update({ where: { id: caseRecord.id }, data: { status: stage } });
  await prisma.caseStageEvent.create({ data: { caseId: caseRecord.id, stage, note: note || null } });

  if (caseRecord.serviceRequest) {
    // Keep the patient-facing ServiceRequest.status in the same simplified vocabulary
    // the My Requests screen filters on.
    const requestStatus = stage === 'completed' ? 'completed' : stage === 'cancelled' ? 'cancelled' : stage === 'submitted' ? 'submitted' : 'in_progress';
    await prisma.serviceRequest.update({ where: { id: caseRecord.serviceRequest.id }, data: { status: requestStatus } });
    await notifyPatient(caseRecord.serviceRequest.userId, {
      kind: 'stage_update',
      title: `${caseRecord.referenceNumber} update`,
      body: note || `Your case moved to "${stage.replace('_', ' ')}".`,
    });
  }

  return updated;
}

async function notifyPatient(userId, { kind, title, body }) {
  const notification = await prisma.notification.create({
    data: { recipientType: 'patient', recipientId: userId, kind, title, body },
  });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { pushToken: true } });
  await sendExpoPush(user?.pushToken, { title, body });
  return notification;
}

module.exports = {
  VALID_CASE_STATUSES,
  listCasesForCorporate,
  getCaseById,
  createCaseByCorporate,
  updateCaseStage,
};
