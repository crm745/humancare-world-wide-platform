const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../../db/prisma');
const { createLead, sendMedicalReportToBitrix } = require('../bitrix/bitrix.service');
const { leadInputFromRequest, commentWithReports } = require('../bitrix/bitrix-lead');
const { isScanClean } = require('../documents/document-scan');
const { isBitrixSyncEnabled, isPrivateCharterDealRequested } = require('../bitrix/bitrix-config');
const { URGENCY_TO_CASE, PRIVATE_CHARTER_KEY, isCommercialAirKey, isGroundKey, usesCriticalLevelPage } = require('../../common/constants/request.constants');
const { isRequestReviewEnabled, PATIENT_DOCUMENT_SELECT } = require('../request-review/request-review.config');
const { createReviewRequest } = require('../request-review/request-review.service');
const { SAFE_DOCUMENT_SELECT } = require('../documents/document-response');
const { findOwnedByClientRequestId, isUniqueViolation } = require('./client-request-id');

const VALID_STATUSES = ['submitted', 'in_progress', 'completed', 'cancelled'];

// `clientRequestId` (optional, a validated lower-case UUID) makes the submission idempotent: the request, its reference, its Case and its first stage event are saved in ONE
// transaction, and the database's unique index on (user_id, client_request_id) is the final guard, so the same submission arriving again (a retry after a lost answer) or
// at the same moment twice returns the request that was saved first: no second request, no second Case, no second Bitrix call. Without a key (an older app build)
// the request is saved as it always was, and every call makes a new request.
async function createRequest(userId, data, { clientRequestId } = {}) {
  // Request-first workflow (Private Charter only, when switched on): the request is saved with its
  // REQ- reference and no Case; the Case is created later, when an Admin approves it. Everything
  // below is the original flow, unchanged, for every other service and for Private Charter while
  // the workflow is off.
  if (data.serviceKey === PRIVATE_CHARTER_KEY && isRequestReviewEnabled()) return createReviewRequest(userId, data, { clientRequestId });

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
    transferScope,
    transportMode,
    careRequirement,
    caretakerTypes,
    specialty,
    otherSpecialty,
    consultationType,
    companyName,
    employeeCount,
    selectedProgrammes,
    mobility,
    equipOxygen,
    equipOxygenLpm,
    equipCardiacMonitor,
    equipVentilator,
    urgency,
  } = data;

  // Request, reference number, Case and first stage event are saved TOGETHER or not at all: a failure part-way leaves no request without its Case (and, with a key, no
  // half-saved submission that a retry would then be handed back). Nothing outside the database happens inside the transaction.
  let request;
  try {
    request = await prisma.$transaction(async (tx) => {
      // Create first so we have an id, then stamp a human-friendly reference number onto it.
      const created = await tx.serviceRequest.create({
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
          // Mortal Remains only (validated in mortal-remains.validation.js); the keys are left out for every other service so its write is unchanged.
          ...(transferScope !== undefined && { transferScope: transferScope || null }),
          ...(transportMode !== undefined && { transportMode: transportMode || null }),
          // Home Healthcare only (validated in home-healthcare.validation.js); the keys are left out for every other service so its write is unchanged.
          ...(serviceKey === 'homecare' && { careRequirement: careRequirement || null, caretakerTypes: caretakerTypes || null }),
          // Medical Value Travel and Teleconsultation only (validated in their own validators); the keys are left out for every other service so its write is unchanged.
          ...(specialty !== undefined && { specialty: specialty || null }),
          ...(otherSpecialty !== undefined && { otherSpecialty: otherSpecialty || null }),
          ...(consultationType !== undefined && { consultationType: consultationType || null }),
          // Corporate Medical Solutions, employee-submitted (validated in corporate-medical.validation.js); the keys are left out for every other service.
          ...(companyName !== undefined && { companyName: companyName || null }),
          ...(employeeCount !== undefined && { employeeCount: employeeCount ?? null }),
          ...(selectedProgrammes !== undefined && { selectedProgrammes: selectedProgrammes ?? Prisma.DbNull }),
          // Ground Ambulance no longer asks Patient mobility: an older app build may still send it (accepted, so it is not broken), but it is never stored for a
          // new Ground request. Requests already saved keep their value.
          mobility: isGroundKey(serviceKey) ? null : mobility || null,
          equipOxygen: equipOxygen ?? null,
          // Commercial Air, Ground Ambulance, Home Healthcare and structured Marine Medical Safety (validated in the controller / its own validator); the key is left out for
          // every other service. Marine's validator always returns the field (a number only for Oxygen Yes), so only a structured Marine request has it defined: an older
          // generic Marine request has none, and its write stays exactly as it was.
          ...((usesCriticalLevelPage(serviceKey) || serviceKey === 'homecare' || (serviceKey === 'marine' && equipOxygenLpm !== undefined)) && { equipOxygenLpm: equipOxygen === true && equipOxygenLpm != null ? equipOxygenLpm : null }),
          equipCardiacMonitor: equipCardiacMonitor ?? null,
          equipVentilator: equipVentilator ?? null,
          // Commercial Air has no Ventilator under Required on board (it is the care level "Ventilated"): never stored for it.
          ...(isCommercialAirKey(serviceKey) && { equipVentilator: null }),
          // Ground Ambulance: Required on board is Oxygen only, so neither Cardiac monitor nor Ventilator is ever stored for it.
          ...(isGroundKey(serviceKey) && { equipCardiacMonitor: null, equipVentilator: null }),
          urgency: urgency || null,
          referenceNumber: `TEMP-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          // Only when the app sent a key: an older build's write is exactly what it was.
          ...(clientRequestId && { clientRequestId }),
          status: 'submitted',
        },
      });

      // Every service, Corporate Medical Solutions included: REQ-<1000 + request id>, which the request's Case copies. (An earlier version of Corporate Medical Solutions
      // used CASE-<1000 + case id>; those requests keep the reference they were saved with and are never renumbered.)
      const referenceNumber = `REQ-${1000 + created.id}`;
      const request = await tx.serviceRequest.update({
        where: { id: created.id },
        data: { referenceNumber },
      });

      // Every submitted request becomes a Case immediately, unassigned, so it shows up
      // in the corporate queue as soon as it lands — corporates triage from there.
      const newCase = await tx.case.create({
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
      await tx.caseStageEvent.create({
        data: { caseId: newCase.id, stage: 'submitted', note: 'Request received from patient app.' },
      });
      return request;
    });
  } catch (err) {
    // The same submission was saved first (this one lost the race, or this is a retry that got here): hand back THAT request. Nothing more is created or sent.
    if (clientRequestId && isUniqueViolation(err)) {
      const existing = await findOwnedByClientRequestId(prisma, userId, clientRequestId);
      if (existing) return existing;
    }
    throw err;
  }

  // Bitrix24 is best-effort: a CRM hiccup must never fail the patient's submission,
  // which has already been saved above by this point. While the switch is off nothing
  // is sent and nothing is recorded as failed (see bitrix-config.js).
  if (!isBitrixSyncEnabled()) return request;
  // Once Private Charter Deal integration is switched on, Private Charter uses the Deal workflow and never a Lead.
  // (The startup check also requires the review workflow then, which never reaches this line; this is the second guard.)
  if (serviceKey === PRIVATE_CHARTER_KEY && isPrivateCharterDealRequested()) return request;
  // ONE lead is made per saved request (syncLead: exactly what was done here before). The patient waits for it only for a short budget (BITRIX_SUBMIT_WAIT_MS, 2.5 s by default; Bitrix
  // normally answers in well under a second): when the CRM is slower, the answer goes back now, the SAME call carries on in the background (it is never abandoned and never started twice,
  // so no second lead can come from it) and records its outcome when it ends. A lead that fails is recorded for the retry sweep exactly as before.
  const pending = syncLead(request, userId);
  const outcome = await settleWithin(pending, bitrixSubmitWaitMs());
  if (!outcome.settled) {
    console.warn(`Bitrix24 is slow: request ${request.referenceNumber} was answered before its lead was made; the lead call continues in the background.`);
    pending.then((made) => (made ? forwardEarlyReports(request, made.leadId, made.user) : undefined)).catch((err) => console.error(`Bitrix24 late follow-up failed for ${request.referenceNumber}: ${err.message}`));
  }

  return request;
}

// How long a submission waits for the CRM before it answers the patient: BITRIX_SUBMIT_WAIT_MS milliseconds, 0 to 15000 (0 = never wait), 2500 when unset or not a whole number in range.
const DEFAULT_BITRIX_SUBMIT_WAIT_MS = 2500;
const MAX_BITRIX_SUBMIT_WAIT_MS = 15000;
function bitrixSubmitWaitMs(env = process.env) {
  const raw = env.BITRIX_SUBMIT_WAIT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '' || !/^\d+$/.test(String(raw).trim())) return DEFAULT_BITRIX_SUBMIT_WAIT_MS;
  const value = Number(String(raw).trim());
  return value <= MAX_BITRIX_SUBMIT_WAIT_MS ? value : DEFAULT_BITRIX_SUBMIT_WAIT_MS;
}

// Waits for `promise` for at most `ms`: { settled: true } when it finished first, { settled: false } when the time ran out (the promise is NOT cancelled). The timer never keeps the process alive
// and is always cleared.
function settleWithin(promise, ms) {
  if (!(ms > 0)) return Promise.resolve({ settled: false });
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: false }), ms); if (timer.unref) timer.unref(); });
  return Promise.race([promise.then(() => ({ settled: true })), timeout]).finally(() => clearTimeout(timer));
}

// Makes the Bitrix24 lead for a saved request and stores its id; on failure records it (attempts, error, time) for the retry sweep in bitrix-retry.service.js. Exactly the lead creation this
// file always did, moved here so it can run beyond the patient's wait. NEVER rejects: a failure to even record a failure is logged (the saved request must not turn into an error, and a
// background run must not become an unhandled rejection). Resolves { leadId, user } on success, null on failure.
async function syncLead(request, userId) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const leadId = await createLead(leadInputFromRequest(request, user));
    await prisma.serviceRequest.update({ where: { id: request.id }, data: { bitrixLeadId: leadId } });
    return { leadId, user };
  } catch (err) {
    console.error(`Bitrix24 lead creation failed for ${request.referenceNumber}:`, err.message);
    // Persisted (not just logged) so the background retry job in bitrix-retry.service.js
    // can pick it back up — a console line nobody is watching used to be the only
    // record a lead ever dropped.
    try {
      await prisma.serviceRequest.update({
        where: { id: request.id },
        data: { bitrixSyncAttempts: 1, bitrixLastError: err.message, bitrixSyncFailedAt: new Date() },
      });
    } catch (recordError) {
      console.error(`Bitrix24 failure for ${request.referenceNumber} could not be recorded for the retry sweep: ${recordError.message}`);
    }
    return null;
  }
}

// A lead that was made AFTER the patient had its answer: reports uploaded in the meantime found no lead to go to (the upload sends a report only to an existing lead), so they are forwarded now,
// the way the retry sweep does for a late lead: every clean Medical Report of the request's Case, with the comment that names them all. Best effort; an older, never-scanned one is skipped.
async function forwardEarlyReports(request, leadId, user) {
  const reports = await prisma.document.findMany({
    where: { type: 'Medical Report', case: { serviceRequestId: request.id } },
    orderBy: { uploadedAt: 'asc' },
  });
  const clean = reports.filter(isScanClean);
  if (!clean.length) return;
  const comments = commentWithReports(leadInputFromRequest(request, user).comments, clean.map((report) => report.name));
  for (const report of clean) await sendMedicalReportToBitrix(leadId, report, { comments });
}

// The patient's own request saved for a client request ID (the app's "Check status" after an answer was lost), or null.
async function findRequestByClientRequestId(userId, clientRequestId) {
  return findOwnedByClientRequestId(prisma, userId, clientRequestId);
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
      case: { include: { stageEvents: { orderBy: { occurredAt: 'asc' } }, documents: { select: { ...SAFE_DOCUMENT_SELECT, clientUploadId: true } } } },
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
  bitrixSubmitWaitMs,
  createRequest,
  findRequestByClientRequestId,
  listRequestsForUser,
  getRequestForUser,
  listDocumentsForUser,
};
