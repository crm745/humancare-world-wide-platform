// What a patient's phone is sent about a request (POST /requests, GET /requests/me, GET /requests/me/:id).
//
// An allow-list: only the fields below leave the server, so a column added to service_requests or cases later is
// private until it is added here. Never sent to a patient: the owner's id, the Bitrix sync fields (lead id, attempts,
// last error), the geoname ids and timezone of the cities, and everything internal on the Case (staff notes, billing,
// corporate id, policy reference, additional info, special requirements, referral source, the Bitrix fields).
//
// The PDF summary (request-summary.pdf.js) and the other server-side code read the full row themselves; this is only
// for what goes out in a response.

// The fields of the request itself the app's list, details, tracking and request-tracking screens read.
const REQUEST_FIELDS = [
  'id', 'referenceNumber', 'status', 'serviceType', 'serviceKey',
  'patientName', 'patientAge', 'patientGender', 'patientLocation', 'patientContact',
  'origin', 'destination', 'country', 'preferredDate', 'careLevel', 'description',
  'deceasedRelation', 'placeOfDeath', 'dateOfDeath',
  'mobility', 'equipOxygen', 'equipCardiacMonitor', 'equipVentilator', 'urgency',
  'originCityName', 'originCountryCode', 'destinationCityName', 'destinationCountryCode',
  'reviewStatus', 'documentsRequestReason', 'submittedAt', 'reviewedAt', 'createdAt', 'updatedAt',
];
const CASE_FIELDS = ['id', 'referenceNumber', 'status', 'urgency', 'createdAt', 'updatedAt'];
// The note is written by staff and shown to the patient on Tracking and in the PDF timeline.
const STAGE_EVENT_FIELDS = ['id', 'stage', 'note', 'occurredAt'];
const CASE_DOCUMENT_FIELDS = ['id', 'type', 'name', 'fileSizeBytes', 'uploadedAt'];
const REQUEST_DOCUMENT_FIELDS = [
  'id', 'originalName', 'sizeBytes', 'uploadedAt', 'replacesId', 'supersededAt', 'scanStatus', 'reviewStatus', 'rejectionReason',
];

const isObject = (value) => value !== null && typeof value === 'object';

// The listed fields of `source` that it has, nothing else (a field it does not have stays absent).
function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
  }
  return out;
}

const pickEach = (list, fields) => (Array.isArray(list) ? list.map((item) => pick(item, fields)) : list);

function toPatientCase(caseRecord) {
  if (!isObject(caseRecord)) return caseRecord; // null: no Case yet
  const out = pick(caseRecord, CASE_FIELDS);
  if ('stageEvents' in caseRecord) out.stageEvents = pickEach(caseRecord.stageEvents, STAGE_EVENT_FIELDS);
  if ('documents' in caseRecord) out.documents = pickEach(caseRecord.documents, CASE_DOCUMENT_FIELDS);
  return out;
}

// One request as the patient's phone gets it.
function toPatientRequest(request) {
  if (!isObject(request)) return request;
  const out = pick(request, REQUEST_FIELDS);
  if ('case' in request) out.case = toPatientCase(request.case);
  if ('requestDocuments' in request) out.requestDocuments = pickEach(request.requestDocuments, REQUEST_DOCUMENT_FIELDS);
  return out;
}

const toPatientRequests = (requests) => (Array.isArray(requests) ? requests.map(toPatientRequest) : requests);

module.exports = {
  toPatientRequest, toPatientRequests, toPatientCase,
  REQUEST_FIELDS, CASE_FIELDS, STAGE_EVENT_FIELDS, CASE_DOCUMENT_FIELDS, REQUEST_DOCUMENT_FIELDS,
};
