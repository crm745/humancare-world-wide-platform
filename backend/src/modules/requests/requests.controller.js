const fs = require('fs');
const {
  createRequest,
  findRequestByClientRequestId,
  listRequestsForUser,
  getRequestForUser,
  listDocumentsForUser,
} = require('./requests.service');
const { addDocumentToCase, findCaseDocumentByClientUploadId } = require('../documents/documents.service');
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
const { parseClientRequestId } = require('./client-request-id');
const { parseClientUploadId, isUniqueViolation } = require('./client-upload-id');
const { scanBeforeStore, sameStoredContent, withUploadLock } = require('../documents/legacy-scan');
const { hashFile } = require('../request-review/request-review.files');
const { isScanClean } = require('../documents/document-scan');
const { resolveCityRefs, getVerifiedCity } = require('../geo/geo.service');
const { isTeleStructuredRequest, isStructuredTeleRow, validateTeleRequest } = require('./tele-consultation.validation');
const { toPatientRequest, toPatientRequests } = require('./request-response');
const { isMortalKey, isMortalRequestKey, OLD_MORTAL_KEYS, validateMortalRequest } = require('./mortal-remains.validation');
const { isHomeKey, validateHomeRequest } = require('./home-healthcare.validation');
const { isMvtStructuredRequest, cityRefOf, validateMvtRequest } = require('./medical-value-travel.validation');
const { isMarineStructuredRequest, cityRefOf: marineCityRefOf, validateMarineRequest } = require('./marine-medical-safety.validation');
const { isCorporateStructuredRequest, validateCorporateRequest, isNewCorporateFormat } = require('./corporate-medical.validation');
const { validateGenericRequest, unknownFieldsLogLine } = require('./generic-request.validation');
const { legacyBypassProblem } = require('./legacy-body-guard');
const { validateTransportRequest } = require('./transport-request.validation');
const { closedRequestProblem, fileCountProblem, fileContentProblem, safeDocumentName } = require('./upload-policy');

const REQUIRED_FIELDS = ['serviceType', 'patientName', 'origin', 'destination'];
const { REQUIRED_SERVICE_BY_KEY } = require('../bitrix/bitrix-lead');
// Service keys the app may send (see mobile src/data/mock.js SERVICE_TILES). Optional,
// since older app builds don't send one; "hospital", "marine" (Marine Medical Safety) and
// "medvalue" (Medical Value Travel) have no Bitrix service mapped yet.
const SERVICE_KEYS = new Set([...Object.keys(REQUIRED_SERVICE_BY_KEY), 'hospital', 'marine', 'medvalue', 'air']);
// Mortal Remains: the app sends the single key "mortal"; the two older keys (mortal_domestic / mortal_international) are no longer accepted for new
// requests. Its rules live in mortal-remains.validation.js. Rows already stored with an older key are untouched and still recognised (isMortalRequestKey).

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
    // Idempotent submission: the app sends one UUID (`clientRequestId`) per logical submission and reuses it for every retry. It is OPTIONAL (an older app build sends none and is
    // handled exactly as before). It is taken out of the body here, so no service validator ever sees it, and it is looked up BEFORE anything else: a retry of a submission that
    // was already saved gets the ORIGINAL request back (HTTP 200) without being validated, resolved or saved again, so a rule that changed in between (a date that has since
    // passed, a city lookup that is down) can never turn a saved request into an error. The database's unique index (user, key) is the final guard for the race this lookup cannot see.
    const idKey = parseClientRequestId(req.body.clientRequestId);
    if (idKey.present && !idKey.valid) {
      return res.status(400).json({ error: FIELD_ERRORS_MESSAGE, fields: { clientRequestId: 'clientRequestId must be a UUID.' } });
    }
    let clientRequestId;
    if (idKey.present) {
      clientRequestId = idKey.id;
      const { clientRequestId: _key, ...bodyWithoutKey } = req.body;
      req.body = bodyWithoutKey;
      const existing = await findRequestByClientRequestId(req.user.id, clientRequestId);
      if (existing) {
        // A key belongs to ONE submission of ONE service: reusing it for another service is a bug in the caller, never a replay.
        if (typeof req.body.serviceKey === 'string' && existing.serviceKey && req.body.serviceKey !== existing.serviceKey) {
          return res.status(409).json({ error: 'This request ID was already used for a different service.', code: 'client_request_id_reused' });
        }
        return res.status(200).json({ request: toPatientRequest(existing) });
      }
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
      const request = await createRequest(req.user.id, data, { clientRequestId });
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    // Teleconsultation in its structured format has its own validator (isolated in tele-consultation.validation.js): it derives the address
    // fields and the description itself, and the stored request is saved like any other. A Teleconsultation request WITHOUT the structured
    // fields (an older app build) is not caught here and keeps the original rules below.
    if (isTeleStructuredRequest(req.body)) {
      const { error, data } = validateTeleRequest(req.body);
      if (error) return res.status(400).json({ error });
      const request = await createRequest(req.user.id, data, { clientRequestId });
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
      const request = await createRequest(req.user.id, data, { clientRequestId });
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    // Home Healthcare has its own validator (isolated in home-healthcare.validation.js): it enforces the new format only (the older generic body, with
    // Current Location, Destination and Urgency, is refused) and composes the description and the one-line address copy itself.
    if (isHomeKey(req.body.serviceKey)) {
      const { error, data } = validateHomeRequest(req.body);
      if (error) return res.status(400).json({ error });
      const request = await createRequest(req.user.id, data, { clientRequestId });
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
      const request = await createRequest(req.user.id, data, { clientRequestId });
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
      const request = await createRequest(req.user.id, data, { clientRequestId });
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    // Corporate Medical Solutions in its structured, patient-side format has its own validator (isolated in corporate-medical.validation.js), chosen by the fields it
    // carries (companyName, employeeCount, programmes, ...). An older app build sends the generic body for "corporate", which has none of them and keeps the generic
    // rules below. The request is saved through the same flow as every other one; createRequest gives it the standard REQ- reference, which its Case copies (corporateId stays NULL).
    if (isCorporateStructuredRequest(req.body)) {
      const { error, data } = validateCorporateRequest(req.body);
      if (error) return res.status(400).json({ error });
      const request = await createRequest(req.user.id, data, { clientRequestId });
      return res.status(201).json({ request: toPatientRequest(request) });
    }
    // Every structured branch above has declined this body. For Teleconsultation, Medical Value Travel, Marine and Corporate Medical Solutions that means the old generic format (or a body that
    // only names the service in serviceType): refused, never saved as an incomplete request (legacy-body-guard.js).
    const bypass = legacyBypassProblem(req.body);
    if (bypass) return res.status(bypass.status).json(bypass.body);
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
    // Ground Ambulance and Commercial Air have no validator of their own: their contact number, date, origin, destination and name are checked here (transport-request.validation.js).
    const transportProblem = validateTransportRequest(req.body);
    if (transportProblem) return res.status(400).json(transportProblem);
    // The generic path's own check (generic-request.validation.js): the type and size of every key it keeps, another service's own columns refused, and ONLY the kept keys passed on
    // to createRequest (never the raw body). A problem is a 400 here, not a database error. Stage 1 of unknown keys: they are ignored as before and their NAMES (never values) are
    // logged once, so a later stage can refuse them with the facts in hand.
    const { error: genericError, data: genericData, unknownFields } = validateGenericRequest(req.body);
    if (genericError) return res.status(400).json({ error: genericError });
    if (unknownFields.length) console.info(unknownFieldsLogLine(req.body.serviceKey, unknownFields, SERVICE_KEYS));
    const request = await createRequest(req.user.id, genericData, { clientRequestId });
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
// "Check status" after a submission's answer was lost: the patient's own request for a client request ID, or 404 (not saved, YET: an answer can arrive late). Owner only.
async function getMyRequestByClientRequestId(req, res, next) {
  try {
    const idKey = parseClientRequestId(req.params.clientRequestId);
    if (!idKey.present || !idKey.valid) return res.status(400).json({ error: 'clientRequestId must be a UUID.' });
    const request = await findRequestByClientRequestId(req.user.id, idKey.id);
    if (!request) return res.status(404).json({ error: 'Request not found', code: 'not_found' });
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

// Why an upload to a request on the original (Case) path must be refused, or null: the request already holds the most documents it may (30; Mortal Remains 10), or the file is empty, too big,
// unreadable or not what its type and name claim (upload-policy.js: one policy for every service). Two uploads arriving at the same instant could pass the count together; the count is
// taken again, under a per-Case lock, right before the row is written (see accept below).
async function legacyUploadProblem(request, file) {
  return fileCountProblem(await prisma.document.count({ where: { caseId: request.case.id } }), request.serviceKey) || fileContentProblem(file);
}

//
async function uploadRequestDocument(req, res, next) {
  // The file is already on disk (multer). Until a database row refers to it, it belongs to nobody: on every way out that is not "stored" (a refusal, a database failure, any unexpected error)
  // it is deleted. `fileOwned` flips when a row exists; `rowAttempted` marks that a row was being written, so a failure there is first checked against the database (a write that
  // actually succeeded must never lose its file).
  let fileOwned = false;
  let rowAttempted = false;
  const discardFile = () => (req.file ? fs.promises.rm(req.file.path, { force: true }).catch(() => {}) : Promise.resolve());
  const releaseUnlessStored = async () => {
    if (fileOwned || !req.file) return;
    if (rowAttempted) {
      const row = await prisma.document.findFirst({ where: { fileUrl: `/uploads/${req.file.filename}` }, select: { id: true } }).catch(() => null);
      if (row) return;
    }
    await discardFile();
  };
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    // Phase 5: the app's id for this logical upload (optional; an older app sends none). A malformed one is refused, never guessed at.
    const uploadId = parseClientUploadId(req.body && req.body.clientUploadId);
    if (uploadId.present && !uploadId.valid) {
      await discardFile();
      return res.status(400).json({ error: 'clientUploadId must be a UUID.' });
    }
    const clientUploadId = uploadId.present ? uploadId.id : undefined;
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
      // A repeat of an upload the server already holds is answered with the original whatever the request's state is (upload recovery); anything new must be allowed: the request is
      // still open and the file is what it claims to be. (The review workflow's own cap of 30 and its checks run inside addPatientDocument.)
      const replay = clientUploadId ? (request.requestDocuments || []).find((d) => d.clientUploadId === clientUploadId) : null; // from the request already loaded above (it carries each document's clientUploadId)
      if (!replay) {
        const problem = closedRequestProblem(request) || (await fileContentProblem(req.file));
        if (problem) {
          await discardFile();
          return res.status(problem.status).json(problem.body);
        }
      }
      const stored = await addPatientDocument({
        userId: req.user.id, requestId: request.id, file: req.file, replacesDocumentId: req.body && req.body.replacesDocumentId, clientUploadId,
      });
      fileOwned = !stored.replayed; // a replay deleted its own copy; a new document owns the file
      // A repeat of an upload the server already has: the original is the answer. No second scan, replacement or count (and its new file was deleted).
      if (stored.replayed) return res.status(200).json({ document: toUploadResponse(stored) });
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
    // The file's SHA-256, taken now: it is the identity of the CONTENT (a repeat is the same upload only if its digest equals the stored original's) and the scan below is bound to it, so
    // "clean" describes exactly the bytes that are kept. Never the name or the size.
    let sha256;
    try {
      sha256 = await hashFile(req.file.path);
    } catch {
      await discardFile();
      return res.status(400).json({ error: 'The uploaded file could not be read.' });
    }
    // A repeat of an upload this case already has returns the original BEFORE anything else (after the owner check above): no limit check, no scan, no second document, no Bitrix message.
    // Its new file is deleted. Same id with different content is refused, never answered with a document that does not match.
    const replayLegacy = async (prior) => {
      await discardFile();
      if (!(await sameStoredContent(prior, sha256))) return res.status(409).json({ error: 'That upload id was already used for a different file.', code: 'client_upload_id_reused' });
      return res.status(200).json({ document: { ...toSafeDocument(prior), clientUploadId: prior.clientUploadId } });
    };
    const mortal = isMortalRequestKey(request.serviceKey);
    const accept = async () => {
      if (clientUploadId) {
        const prior = await findCaseDocumentByClientUploadId(request.case.id, clientUploadId);
        if (prior) return replayLegacy(prior);
      }
      // The same rules for every service: not on a cancelled or completed request, at most 30 documents (Mortal Remains 10), and the file's content must be what its type and name claim.
      const problem = closedRequestProblem(request) || (await legacyUploadProblem(request, req.file));
      if (problem) {
        await discardFile();
        return res.status(problem.status).json(problem.body);
      }
      // SCAN BEFORE STORE (documents/legacy-scan.js): the row below is created only after a confirmed clean verdict, so nothing (the patient's download, the corporate portal, the Bitrix24
      // message and its retry sweep) can ever see a document that was not scanned. Infected: 422 and quarantined. Scanner down, timeout or any other non-verdict: 503, deleted, FAIL CLOSED.
      const scan = await scanBeforeStore(req.file, { expectedSha256: sha256 }); // { sha256, engine, scannedAt }: stored with the row as its clean scan record
      let document;
      try {
        // The count is taken again here, one upload at a time per Case (per process), so parallel uploads cannot both pass the check above and exceed the cap.
        const written = await withUploadLock(`cap:${request.case.id}`, async () => {
          const full = fileCountProblem(await prisma.document.count({ where: { caseId: request.case.id } }), request.serviceKey);
          if (full) return { full };
          rowAttempted = true;
          return {
            document: await addDocumentToCase(request.case.id, {
              type: mortal ? MORTAL_DOCUMENT_TYPE : 'Medical Report',
              name: safeDocumentName(req.file.originalname), // never the raw client text: no control or path characters, at most 191 characters (upload-policy.js)
              fileUrl: `/uploads/${req.file.filename}`,
              fileSizeBytes: req.file.size,
              clientUploadId,
              scan,
            }),
          };
        });
        if (written.full) {
          await discardFile();
          return res.status(written.full.status).json(written.full.body);
        }
        document = written.document;
        fileOwned = true; // a row now refers to the file: from here on it is kept whatever happens next (CRM message, response)
      } catch (err) {
        // The same upload arrived at the same instant in another process and won: the unique index is the final protection. Return the original; nothing else happens for this copy.
        if (clientUploadId && isUniqueViolation(err)) {
          const prior = await findCaseDocumentByClientUploadId(request.case.id, clientUploadId).catch(() => null);
          if (prior) return replayLegacy(prior);
        }
        throw err;
      }
      if (!mortal && request.bitrixLeadId) {
        // The request form takes several reports, and the lead's Medical Report field may only
        // keep one of them: the lead comment lists the names of all of them.
        const reports = await prisma.document.findMany({
          where: { caseId: request.case.id, type: 'Medical Report' },
          orderBy: { uploadedAt: 'asc' },
        });
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        // Only documents with a confirmed clean scan are named (and, by the shared sender, only those are ever forwarded).
        const comments = commentWithReports(leadInputFromRequest(request, user).comments, reports.filter(isScanClean).map((r) => r.name));
        await sendMedicalReportToBitrix(request.bitrixLeadId, document, { comments });
      }
      return res.status(201).json({ document: { ...toSafeDocument(document), ...(document.clientUploadId ? { clientUploadId: document.clientUploadId } : {}) } });
    };
    // One copy of the same upload at a time (per process): a second copy waits, then finds the document and is answered from it: no second scan and no second Bitrix message.
    return clientUploadId ? await withUploadLock(`${request.case.id}:${clientUploadId}`, accept) : await accept();
  } catch (err) {
    await releaseUnlessStored().catch(() => {}); // a failed upload never leaves its file behind
    next(err);
  }
}
//
async function downloadRequestSummary(req, res, next) {
  try {
    const request = await getRequestForUser(req.user.id, req.params.id);
    await streamRequestSummaryPdf(res, request);
  } catch (err) {
    next(err);
  }
}
//
module.exports = {
  submitRequest,
  listMyRequests,
  getMyRequestById,
  getMyRequestByClientRequestId,
  listMyDocuments,
  uploadRequestDocument,
  downloadRequestSummary,
};
