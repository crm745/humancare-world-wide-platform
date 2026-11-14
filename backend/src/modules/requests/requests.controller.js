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
} = require('../../common/constants/request.constants');
const { validatePrivateCharterRequest, isObject } = require('./private-charter.validation');
const { resolveCityRefs } = require('../geo/geo.service');
const { toPatientRequest, toPatientRequests } = require('./request-response');

const REQUIRED_FIELDS = ['serviceType', 'patientName', 'origin', 'destination'];
const { REQUIRED_SERVICE_BY_KEY } = require('../bitrix/bitrix-lead');
// Service keys the app may send (see mobile src/data/mock.js SERVICE_TILES). Optional,
// since older app builds don't send one; "hospital", "marine" (Marine Medical Safety) and
// "medvalue" (Medical Value Travel) have no Bitrix service mapped yet.
const SERVICE_KEYS = new Set([...Object.keys(REQUIRED_SERVICE_BY_KEY), 'hospital', 'marine', 'medvalue', 'air']);
// Mortal Remains as the app asks it now ("Within India / International"); older builds
// sent plain "mortal" with the ordinary patient form.
const MORTAL_KEYS = ['mortal_domestic', 'mortal_international'];
const MORTAL_FIELDS = ['deceasedRelation', 'placeOfDeath', 'dateOfDeath'];

// The deceased's details: all three given, and a date of death that isn't in the future.
function mortalFieldsError(body) {
  if (!MORTAL_KEYS.includes(body.serviceKey)) return null;
  const missing = MORTAL_FIELDS.filter((field) => !body[field]);
  if (missing.length) return `Missing required field(s): ${missing.join(', ')}`;
  // A day's slack: "today" in the family's time zone (up to UTC+14) can be tomorrow in UTC.
  const date = new Date(body.dateOfDeath);
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 24 * 60 * 60 * 1000) return 'Invalid dateOfDeath';
  return null;
}

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
  return null;
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
    const missing = REQUIRED_FIELDS.filter((field) => !req.body[field]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    }
    if (req.body.serviceKey !== undefined && !SERVICE_KEYS.has(req.body.serviceKey)) {
      return res.status(400).json({ error: 'Unknown serviceKey' });
    }
    const mortalError = mortalFieldsError(req.body);
    if (mortalError) return res.status(400).json({ error: mortalError });
    const medicalError = medicalFieldsError(req.body);
    if (medicalError) return res.status(400).json({ error: medicalError });
    const request = await createRequest(req.user.id, req.body);
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
    // This is the request form's one upload: "Upload Medical Report", or for Mortal
    // Remains "Upload Death Certificate". The lead has no death-certificate field, so
    // that one stays with us (Bitrix has it on the deal; sent once deals are synced).
    const mortal = MORTAL_KEYS.includes(request.serviceKey);
    const document = await addDocumentToCase(request.case.id, {
      type: mortal ? 'Death Certificate' : 'Medical Report',
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
