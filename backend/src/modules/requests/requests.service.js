const { prisma } = require('../../db/prisma');
const { createLead } = require('../bitrix/bitrix.service');
const { leadInputFromRequest } = require('../bitrix/bitrix-lead');
const { isBitrixSyncEnabled } = require('../bitrix/bitrix-config');
const { URGENCY_TO_CASE, PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const { isRequestReviewEnabled, PATIENT_DOCUMENT_SELECT } = require('../request-review/request-review.config');
const { createReviewRequest } = require('../request-review/request-review.service');
const { SAFE_DOCUMENT_SELECT } = require('../documents/document-response');

const VALID_STATUSES = ['submitted', 'in_progress', 'completed', 'cancelled'];

async function createRequest(userId, data) {
  // Request-first workflow (Private Charter only, when switched on): the request is saved with its
  // REQ- reference and no Case; the Case is created later, when an Admin approves it. Everything
  // below is the original flow, unchanged, for every other service and for Private Charter while
  // the workflow is off.
  if (data.serviceKey === PRIVATE_CHARTER_KEY && isRequestReviewEnabled()) return createReviewRequest(userId, data);

  const {
    serviceType,
    serviceKey,
    patientName,
    patientAge,
    patientGender,
    patientLocation,
    patientContact,
    origin,
    destination,
    originGeonameId,
    originCityName,
    originCountryCode,
    originTimezone,
    destinationGeonameId,
    destinationCityName,
    destinationCountryCode,
    country,
    preferredDate,
    careLevel,
    description,
    deceasedRelation,
    placeOfDeath,
    dateOfDeath,
    mobility,
    equipOxygen,
    equipCardiacMonitor,
    equipVentilator,
    urgency,
  } = data;

  // Create first so we have an id, then stamp a human-friendly reference number onto it.
  const created = await prisma.serviceRequest.create({
    data: {
      userId,
      serviceType,
      serviceKey: serviceKey || null,
      patientName,
      patientAge: patientAge != null ? Number(patientAge) : null,
      patientGender: patientGender || null,
      patientLocation: patientLocation || null,
      patientContact: patientContact || null,
      origin,
      destination,
      // Private Charter only (the verified cities); null for every other service.
      originGeonameId: originGeonameId ?? null,
      originCityName: originCityName ?? null,
      originCountryCode: originCountryCode ?? null,
      originTimezone: originTimezone ?? null,
      destinationGeonameId: destinationGeonameId ?? null,
      destinationCityName: destinationCityName ?? null,
      destinationCountryCode: destinationCountryCode ?? null,
      country: country || null,
      preferredDate: preferredDate ? new Date(preferredDate) : null,
      careLevel: careLevel || null,
      description: description || null,
      deceasedRelation: deceasedRelation || null,
      placeOfDeath: placeOfDeath || null,
      dateOfDeath: dateOfDeath ? new Date(dateOfDeath) : null,
      mobility: mobility || null,
      equipOxygen: equipOxygen ?? null,
      equipCardiacMonitor: equipCardiacMonitor ?? null,
      equipVentilator: equipVentilator ?? null,
      urgency: urgency || null,
      referenceNumber: `TEMP-${Date.now()}`,
      status: 'submitted',
    },
  });

  const referenceNumber = `REQ-${1000 + created.id}`;
  const request = await prisma.serviceRequest.update({
    where: { id: created.id },
    data: { referenceNumber },
  });

  // Every submitted request becomes a Case immediately, unassigned, so it shows up
  // in the corporate queue as soon as it lands — corporates triage from there.
  const newCase = await prisma.case.create({
    data: {
      serviceRequestId: request.id,
      referenceNumber,
      patientName: request.patientName,
      patientAge: request.patientAge,
      patientGender: request.patientGender,
      patientContact: request.patientContact,
      serviceType: request.serviceType,
      origin: request.origin,
      destination: request.destination,
      country: request.country,
      // Left out when the request has none, so the Case keeps its own 'routine' default.
      ...(request.urgency && { urgency: URGENCY_TO_CASE[request.urgency] }),
      status: 'submitted',
    },
  });
  await prisma.caseStageEvent.create({
    data: { caseId: newCase.id, stage: 'submitted', note: 'Request received from patient app.' },
  });

  // Bitrix24 is best-effort: a CRM hiccup must never fail the patient's submission,
  // which has already been saved above by this point. While the switch is off nothing
  // is sent and nothing is recorded as failed (see bitrix-config.js).
  if (!isBitrixSyncEnabled()) return request;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const leadId = await createLead(leadInputFromRequest(request, user));
    await prisma.serviceRequest.update({ where: { id: request.id }, data: { bitrixLeadId: leadId } });
  } catch (err) {
    console.error(`Bitrix24 lead creation failed for ${request.referenceNumber}:`, err.message);
    // Persisted (not just logged) so the background retry job in bitrix-retry.service.js
    // can pick it back up — a console line nobody is watching used to be the only
    // record a lead ever dropped.
    await prisma.serviceRequest.update({
      where: { id: request.id },
      data: { bitrixSyncAttempts: 1, bitrixLastError: err.message, bitrixSyncFailedAt: new Date() },
    });
  }

  return request;
}

async function listRequestsForUser(userId, { status } = {}) {
  const where = { userId };
  if (status && status !== 'all') {
    if (!VALID_STATUSES.includes(status)) {
      const err = new Error(`Invalid status filter. Use one of: ${VALID_STATUSES.join(', ')}`);
      err.statusCode = 400;
      throw err;
    }
    where.status = status;
  }
  return prisma.serviceRequest.findMany({ where, orderBy: { createdAt: 'desc' } });
}

async function getRequestForUser(userId, id) {
  const request = await prisma.serviceRequest.findFirst({
    where: { id: Number(id), userId },
    include: {
      case: { include: { stageEvents: { orderBy: { occurredAt: 'asc' } }, documents: { select: SAFE_DOCUMENT_SELECT } } },
      // Empty for every request made before the review workflow; never exposes stored file names.
      requestDocuments: { select: PATIENT_DOCUMENT_SELECT, orderBy: { id: 'asc' } },
    },
  });
  if (!request) {
    const err = new Error('Request not found');
    err.statusCode = 404;
    throw err;
  }
  return request;
}

// Every document the app collects is a medical record of some kind — there's no
// separate "identity/insurance" category to split out, so this is just one flat list
// across every case the patient's requests have opened.
async function listDocumentsForUser(userId) {
  return prisma.document.findMany({
    where: { case: { serviceRequest: { userId } } },
    select: { ...SAFE_DOCUMENT_SELECT, case: { select: { referenceNumber: true } } },
    orderBy: { uploadedAt: 'desc' },
  });
}

module.exports = {
  VALID_STATUSES,
  createRequest,
  listRequestsForUser,
  getRequestForUser,
  listDocumentsForUser,
};
