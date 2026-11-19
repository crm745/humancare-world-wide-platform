const fs = require('fs');
const {
  createRequest,
  listRequestsForUser,
  getRequestForUser,
  listDocumentsForUser,
} = require('./requests.service');
const { addDocumentToCase } = require('../documents/documents.service');
const { toSafeDocument } = require('../documents/document-response');
const { addPatientDocument, scanRequestDocument, toUploadResponse } = require('../request-review/request-review.service');
const { sendMedicalReportToBitrix } = require('../bitrix/bitrix.service');
const { leadInputFromRequest, commentWithReports } = require('../bitrix/bitrix-lead');
const { prisma } = require('../../db/prisma');
const { streamRequestSummaryPdf } = require('./request-summary.pdf');
const {
  MOBILITY, URGENCY, EQUIPMENT, isTransportKey, PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE,
  isCommercialAirKey, isGroundKey, usesCriticalLevelPage, oxygenLpmProblem, commercialAirCareLevelProblem,
} = require('../../common/constants/request.constants');
const { validatePrivateCharterRequest, isObject } = require('./private-charter.validation');
const { resolveCityRefs, getVerifiedCity } = require('../geo/geo.service');
const { isTeleStructuredRequest, isStructuredTeleRow, validateTeleRequest } = require('./tele-consultation.validation');
const { toPatientRequest, toPatientRequests } = require('./request-response');
const { isMortalKey, isMortalRequestKey, OLD_MORTAL_KEYS, validateMortalRequest } = require('./mortal-remains.validation');
const { isHomeKey, validateHomeRequest } = require('./home-healthcare.validation');
const { isMvtStructuredRequest, cityRefOf, validateMvtRequest } = require('./medical-value-travel.validation');
const { isMarineStructuredRequest, cityRefOf: marineCityRefOf, validateMarineRequest } = require('./marine-medical-safety.validation');
const { isCorporateStructuredRequest, validateCorporateRequest, isNewCorporateFormat } = require('./corporate-medical.validation');
const { validateGenericRequest, unknownFieldsLogLine } = require('./generic-request.validation');
const { SIGNATURE_BYTES, contentMatchesDeclared } = require('../../common/utils/file-signature');

const REQUIRED_FIELDS = ['serviceType', 'patientName', 'origin', 'destination'];
const { REQUIRED_SERVICE_BY_KEY } = require('../bitrix/bitrix-lead');
// Service keys the app may send (see mobile src/data/mock.js SERVICE_TILES). Optional,
// since older app builds don't send one; "hospital", "marine" (Marine Medical Safety) and
// "medvalue" (Medical Value Travel) have no Bitrix service mapped yet.
const SERVICE_KEYS = new Set([...Object.keys(REQUIRED_SERVICE_BY_KEY), 'hospital', 'marine', 'medvalue', 'air']);
// Mortal Remains: the app sends the single key "mortal"; the two older keys (mortal_domestic / mortal_international) are no longer accepted for new
// requests. Its rules live in mortal-remains.validation.js. Rows already stored with an older key are untouched and still recognised (isMortalRequestKey).
// Uploads for a Mortal Remains request: at most this many files per request.
const MORTAL_MAX_FILES = 10;

const FIELD_ERRORS_MESSAGE = 'Please correct the highlighted fields.';

const present = (value) => value !== undefined && value !== null;

// The medical page: only allowed values. Mobility and the equipment flags belong to patient
// transport, so any other service refuses them. A missing value is fine (older app versions
// don't send these), so nothing here makes them required.
function medicalFieldsError(body) {
  const transport = isTransportKey(body.serviceKey);
  if (present(body.mobility)) {
    if (!MOBILITY.includes(body.mobility)) return `Invalid mobility. Use one of: ${MOBILITY.join(', ')}`;
    if (!transport) return 'mobility is only accepted for air and ground ambulance requests';
  }
  for (const [field] of EQUIPMENT) {
    if (!present(body[field])) continue;
    if (typeof body[field] !== 'boolean') return `${field} must be true or false`;
    if (!transport) return `${field} is only accepted for air and ground ambulance requests`;
  }
  if (present(body.urgency) && !URGENCY.includes(body.urgency)) {
    return `Invalid urgency. Use one of: ${URGENCY.join(', ')}`;
  }
  return groundIssueError(body) || criticalLevelCareError(body) || onBoardEquipmentError(body) || oxygenLpmError(body);
}

// Ground Ambulance: the Present Medical Issue (the request's description) is mandatory. Enforced here whatever the app did; the text is stored as typed.
// Every other service keeps description optional. (An older Ground app build that sends no description is refused: it is the approved rule.)
function groundIssueError(body) {
  if (!isGroundKey(body.serviceKey)) return null;
  if (typeof body.description === 'string' && body.description.trim() !== '') return null;
  return 'description (the Present Medical Issue) is required for Ground Ambulance requests';
}

// Commercial Air's Required on board is Oxygen and Cardiac monitor. The Ventilator is the care level "Ventilated", so a new Commercial Air
// request cannot ask for it as equipment. (false is tolerated, as older app builds always sent it; it is not stored.)
function onBoardEquipmentError(body) {
  if (isGroundKey(body.serviceKey)) {
    // Ground Ambulance: Required on board is Oxygen only. Cardiac monitor and Ventilator (a care level) are refused when asked for; false is tolerated
    // (older builds always sent it) and is not stored.
    if (body.equipCardiacMonitor === true) return 'equipCardiacMonitor is not accepted for Ground Ambulance requests (Required on board is Oxygen only)';
    if (body.equipVentilator === true) return 'equipVentilator is not accepted for Ground Ambulance requests (Ventilated is a care level)';
    return null;
  }
  if (!isCommercialAirKey(body.serviceKey)) return null;
  return body.equipVentilator === true || (present(body.equipVentilator) && typeof body.equipVentilator !== 'boolean')
    ? 'equipVentilator is not accepted for Commercial Air requests (Ventilated is a care level)'
    : null;
}

// Commercial Air and Ground Ambulance have their own care levels (ICU, Ventilated, Tracheostomy, ECMO), checked on the server. Every other
// service keeps its careLevel exactly as before; Private Charter never gets here (its own validator, above, is untouched).
function criticalLevelCareError(body) {
  if (!usesCriticalLevelPage(body.serviceKey) || !present(body.careLevel)) return null;
  return commercialAirCareLevelProblem(body.careLevel);
}

// Oxygen flow rate (LPM), Commercial Air and Ground Ambulance. Checked on the server whatever the app did: required when
// Oxygen is chosen, refused when it is not, refused for every other service, and a sensible number.
// (Private Charter never gets here: it has its own validator above, which does not accept the field.)
function oxygenLpmError(body) {
  const given = present(body.equipOxygenLpm);
  if (!usesCriticalLevelPage(body.serviceKey)) {
    return given ? 'equipOxygenLpm is only accepted for Commercial Air and Ground Ambulance requests' : null;
  }
  if (body.equipOxygen === true) {
    if (!given) return 'equipOxygenLpm is required when Oxygen is selected';
    return oxygenLpmProblem(body.equipOxygenLpm);
  }
  return given ? 'equipOxygenLpm is only accepted when Oxygen is selected (equipOxygen true)' : null;
}

//the function for submitting the request
async function submitRequest(req, res, next) {
  try {
    // Express 5 leaves req.body undefined for a missing or non-JSON body, and JSON can also be
    // an array or a bare value: refuse all of those here instead of failing further down.
    if (!isObject(req.body)) {
      return res.status(400).json({ error: 'The request body must be a JSON object.', fields: {} });
    }
    // The Private Charter name belongs to that service key alone: a request that uses it with
    // another (or no) key, such as the app's old "air" default, is refused, never relabelled.
    if (req.body.serviceType === PRIVATE_CHARTER_SERVICE_TYPE && req.body.serviceKey !== PRIVATE_CHARTER_KEY) {
      return res.status(400).json({
        error: FIELD_ERRORS_MESSAGE,
        fields: { serviceKey: 'serviceKey must be "privatecharter" for the Private Charter service.' },
      });
    }
    // Private Charter has its own strict rules; every other service continues below unchanged.
    if (req.body.serviceKey === PRIVATE_CHARTER_KEY) {
      // The cities are looked up (verified) first: unavailable city data throws a 503 here, before
      // anything about the request is judged or saved.
      const cities = await resolveCityRefs(req.body);
      const { fields, data, legacy } = validatePrivateCharterRequest(req.body, { cities });
      if (Object.keys(fields).length) return res.status(400).json({ error: FIELD_ERRORS_MESSAGE, fields });
      // Which legacy formats are still arriving, by field name only: never the values.
      if (legacy.length) console.info('[legacy-format] privatecharter:', legacy.join(', '));
      const request = await createRequest(req.user.id, data);
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    // Teleconsultation in its structured format has its own validator (isolated in tele-consultation.validation.js): it derives the address
    // fields and the description itself, and the stored request is saved like any other. A Teleconsultation request WITHOUT the structured
    // fields (an older app build) is not caught here and keeps the original rules below.
    if (isTeleStructuredRequest(req.body)) {
      const { error, data } = validateTeleRequest(req.body);
      if (error) return res.status(400).json({ error });
      const request = await createRequest(req.user.id, data);
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    // Mortal Remains has its own validator (isolated in mortal-remains.validation.js); it derives the description, the address copy and the stored
    // formats itself. The two older keys are refused for new requests.
    if (OLD_MORTAL_KEYS.includes(req.body.serviceKey)) {
      return res.status(400).json({ error: 'serviceKey must be "mortal" for Mortal Remains requests' });
    }
    if (isMortalKey(req.body.serviceKey)) {
      const { error, data } = validateMortalRequest(req.body);
      if (error) return res.status(400).json({ error });
      const request = await createRequest(req.user.id, data);
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    // Home Healthcare has its own validator (isolated in home-healthcare.validation.js): it enforces the new format only (the older generic body, with
    // Current Location, Destination and Urgency, is refused) and composes the description and the one-line address copy itself.
    if (isHomeKey(req.body.serviceKey)) {
      const { error, data } = validateHomeRequest(req.body);
      if (error) return res.status(400).json({ error });
      const request = await createRequest(req.user.id, data);
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    // Medical Value Travel in its structured format has its own validator (isolated in medical-value-travel.validation.js). It is chosen by the fields it
    // carries (treatmentScope, specialty, ...): an older app build sends the generic body for "medvalue", which has none of them and keeps the generic rules
    // below. A picked city is looked up here (the server decides its country); a typed city is kept as typed and never verified.
    if (isMvtStructuredRequest(req.body)) {
      const cities = {};
      for (const field of ['currentCity', 'destinationCity']) {
        const ref = cityRefOf(req.body[field]);
        if (ref.id) cities[field] = await getVerifiedCity(ref.id);
      }
      const { error, data } = validateMvtRequest(req.body, { cities });
      if (error) return res.status(400).json({ error });
      const request = await createRequest(req.user.id, data);
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    // Marine Medical Safety in its structured format has its own validator (isolated in marine-medical-safety.validation.js), chosen by the fields it carries
    // (serviceScope, originCity, destinationCity, medicalHistory). An older app build sends the generic body for "marine", which has none of them and keeps the
    // generic rules below. A picked city is looked up here by the real GeoNames lookup (the server decides its country); a typed city or port is kept exactly as
    // typed and never verified.
    if (isMarineStructuredRequest(req.body)) {
      const cities = {};
      for (const field of ['originCity', 'destinationCity']) {
        const ref = marineCityRefOf(req.body[field]);
        if (ref.id) cities[field] = await getVerifiedCity(ref.id);
      }
      const { error, data } = validateMarineRequest(req.body, { cities });
      if (error) return res.status(400).json({ error });
      const request = await createRequest(req.user.id, data);
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    // Corporate Medical Solutions in its structured, patient-side format has its own validator (isolated in corporate-medical.validation.js), chosen by the fields it
    // carries (companyName, employeeCount, programmes, ...). An older app build sends the generic body for "corporate", which has none of them and keeps the generic
    // rules below. The request is saved through the same flow as every other one; createRequest gives it the standard REQ- reference, which its Case copies (corporateId stays NULL).
    if (isCorporateStructuredRequest(req.body)) {
      const { error, data } = validateCorporateRequest(req.body);
      if (error) return res.status(400).json({ error });
      const request = await createRequest(req.user.id, data);
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    const missing = REQUIRED_FIELDS.filter((field) => !req.body[field]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    }
    // Commercial Air is one of two travel types: the service key says which (Stretcher or Wheelchair). Without it the request is not complete.
    if (req.body.serviceKey === 'commercialair') {
      return res.status(400).json({ error: 'Travel type is required: serviceKey must be commercialair_stretcher or commercialair_wheelchair' });
    }
    if (req.body.serviceKey !== undefined && !SERVICE_KEYS.has(req.body.serviceKey)) {
      return res.status(400).json({ error: 'Unknown serviceKey' });
    }
    const medicalError = medicalFieldsError(req.body);
    if (medicalError) return res.status(400).json({ error: medicalError });
    // The generic path's own check (generic-request.validation.js): the type and size of every key it keeps, another service's own columns refused, and ONLY the kept keys passed on
    // to createRequest (never the raw body). A problem is a 400 here, not a database error. Stage 1 of unknown keys: they are ignored as before and their NAMES (never values) are
    // logged once, so a later stage can refuse them with the facts in hand.
    const { error: genericError, data: genericData, unknownFields } = validateGenericRequest(req.body);
    if (genericError) return res.status(400).json({ error: genericError });
    if (unknownFields.length) console.info(unknownFieldsLogLine(req.body.serviceKey, unknownFields, SERVICE_KEYS));
    const request = await createRequest(req.user.id, genericData);
    res.status(201).json({ request: toPatientRequest(request) });
  } catch (err) {
    next(err);
  }
}
// tell me what features and functionalities are there in the admin portal and super admin..and are they in the same webapp or what..explain me how to access them differently
async function listMyRequests(req, res, next) {
  try {
    const requests = await listRequestsForUser(req.user.id, { status: req.query.status });
    res.json({ requests: toPatientRequests(requests) });
  } catch (err) {
    next(err);
  }
}
//5 stages of case in app 
// submitted — 
// scheduled — 
// in_progress — 
// completed — 
// cancelled — 
async function getMyRequestById(req, res, next) {
  try {
    const request = await getRequestForUser(req.user.id, req.params.id);
    res.json({ request: toPatientRequest(request) });
  } catch (err) {
    next(err);
  }
}
//
async function listMyDocuments(req, res, next) {
  try {
    const documents = await listDocumentsForUser(req.user.id);
    res.json({ documents });
  } catch (err) {
    next(err);
  }
}
// The type every Mortal Remains upload is stored as.
const MORTAL_DOCUMENT_TYPE = 'Supporting Document';

// Why a Mortal Remains upload must be refused, or null. (Two uploads arriving at the same instant could pass the count together and exceed the
// cap by one: the app uploads one file at a time.)
async function mortalUploadProblem(request, file) {
  const stored = await prisma.document.count({ where: { caseId: request.case.id } });
  if (stored >= MORTAL_MAX_FILES) return `A Mortal Remains request can have at most ${MORTAL_MAX_FILES} documents.`;
  let head = Buffer.alloc(0);
  try {
    const handle = await fs.promises.open(file.path, 'r');
    try {
      const buffer = Buffer.alloc(SIGNATURE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SIGNATURE_BYTES, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return 'The uploaded file could not be read.';
  }
  if (!contentMatchesDeclared(head, file.mimetype, file.originalname)) {
    return 'The file content does not match its type. Allowed: PDF, JPG, PNG, WEBP, DOC, DOCX.';
  }
  return null;
}

//
async function uploadRequestDocument(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    // The file is already on disk (multer). If the request is not found or is not the patient's, or
    // has nothing to attach it to, it must not be left behind unreferenced.
    const discardFile = () => fs.promises.rm(req.file.path, { force: true }).catch(() => {});
    let request;
    try {
      request = await getRequestForUser(req.user.id, req.params.id);
    } catch (err) {
      await discardFile();
      throw err;
    }
    // Teleconsultation (structured format) takes no documents. Requests made before it keep what they have and still take uploads.
    if (isStructuredTeleRow(request)) {
      await discardFile();
      return res.status(400).json({ error: 'Document uploads are not available for Teleconsultation requests.' });
    }
    // Corporate Medical Solutions (employee-submitted, structured format) takes no documents. Requests made before it keep what they have and still take uploads.
    if (isNewCorporateFormat(request)) {
      await discardFile();
      return res.status(400).json({ error: 'Document uploads are not available for Corporate Medical Solutions requests.' });
    }
    // A request in the review workflow has no Case yet: its files are kept with the request, scanned
    // by ClamAV, and reviewed by an Admin. The same URL and form field as before; an optional
    // "replacesDocumentId" field marks an earlier document as replaced.
    if (request.reviewStatus != null) {
      const stored = await addPatientDocument({
        userId: req.user.id, requestId: request.id, file: req.file, replacesDocumentId: req.body && req.body.replacesDocumentId,
      });
      // Fail closed: if the scanner is down the document is saved but stays "error" (unusable)
      // until the worker's next sweep scans it.
      const scanned = await scanRequestDocument(stored.id).catch(() => null);
      return res.status(201).json({ document: toUploadResponse(scanned || stored) });
    }
    if (!request.case) {
      await discardFile();
      return res.status(409).json({ error: 'This request has no case yet.' });
    }
    // Mortal Remains has one combined upload ("Death Certificate / Additional Supporting Documents"): the server cannot tell which file is the
    // certificate, so every file is stored as a neutral "Supporting Document" (never "Death Certificate", never "Medical Report") and none is ever
    // sent to Bitrix (only "Medical Report" documents are, by this upload and by the retry sweep). Checked first: at most 10 files, and the file's
    // content must be what its type and name claim.
    const mortal = isMortalRequestKey(request.serviceKey);
    if (mortal) {
      const problem = await mortalUploadProblem(request, req.file);
      if (problem) {
        await discardFile();
        return res.status(400).json({ error: problem });
      }
    }
    const document = await addDocumentToCase(request.case.id, {
      type: mortal ? MORTAL_DOCUMENT_TYPE : 'Medical Report',
      name: req.file.originalname,
      fileUrl: `/uploads/${req.file.filename}`,
      fileSizeBytes: req.file.size,
    });
    if (!mortal && request.bitrixLeadId) {
      // The request form takes several reports, and the lead's Medical Report field may only
      // keep one of them: the lead comment lists the names of all of them.
      const reports = await prisma.document.findMany({
        where: { caseId: request.case.id, type: 'Medical Report' },
        orderBy: { uploadedAt: 'asc' },
      });
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      const comments = commentWithReports(leadInputFromRequest(request, user).comments, reports.map((r) => r.name));
      await sendMedicalReportToBitrix(request.bitrixLeadId, document, { comments });
    }
    res.status(201).json({ document: toSafeDocument(document) });
  } catch (err) {
    next(err);
  }
}
//
async function downloadRequestSummary(req, res, next) {
  try {
    const request = await getRequestForUser(req.user.id, req.params.id);
    streamRequestSummaryPdf(res, request);
  } catch (err) {
    next(err);
  }
}
//
module.exports = {
  submitRequest,
  listMyRequests,
  getMyRequestById,
  listMyDocuments,
  uploadRequestDocument,
  downloadRequestSummary,
};
