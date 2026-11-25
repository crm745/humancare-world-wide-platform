// What a patient's phone is sent about a request (POST /requests, GET /requests/me, GET /requests/me/:id).
//
// An allow-list: only the fields below leave the server, so a column added to service_requests or cases later is
// private until it is added here. Never sent to a patient: the owner's id, the Bitrix sync fields (lead id, attempts,
// last error), the geoname ids and timezone of the cities, and everything internal on the Case (staff notes, billing,
// corporate id, policy reference, additional info, special requirements, referral source, the Bitrix fields).
//
// The PDF summary (request-summary.pdf.js) and the other server-side code read the full row themselves; this is only
// for what goes out in a response.

const { criticalLevelList, PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const { PROFILE_ACTUAL } = require('../bitrix/bitrix-profiles');

// How a Private Charter request is tracked on the phone.
//
//   trackingFlow   "five_stage" = the approved five-stage journey (Request Received, Quotation Ready, Payment Confirmed, Service In Progress,
//                  Completed); null = the existing tracking; absent = not a Private Charter request (or no Case information was loaded to decide).
//   trackingStage  for a five_stage request, the stage it is at now: one of FIVE_STAGE_KEYS.
//
// The flow is DISPLAY configuration, separate from the Bitrix worker: it needs no Bitrix switch, no BITRIX_DEAL_PROFILE, no worker, outbox event or
// Deal, and it never creates one. It is decided, in this order:
//   1. a Deal link that already exists wins: its profile "actual" -> five_stage; "test" (or any other value) -> the existing tracking. Links made
//      before profiles were stamped "test" in the migration, so a historical record keeps the existing tracking;
//   2. a request with no usable link (not approved yet, or its link has no profile because none was configured when it was made) follows
//      PRIVATE_CHARTER_TRACKING_FLOW: unset or "five_stage" -> five_stage, anything else (for example "standard") -> the existing tracking.
//      Only a request in the review workflow (reviewStatus set) is eligible: older requests from before it keep the existing tracking.
// A quotation, a payment or a stage event never decides it. Nothing about Bitrix is sent: only these two neutral values.
const TRACKING_FLOW_FIVE_STAGE = 'five_stage';
const TRACKING_FLOW_ENV = 'PRIVATE_CHARTER_TRACKING_FLOW';
const FIVE_STAGE_KEYS = Object.freeze(['request_received', 'quotation_ready', 'payment_confirmed', 'service_in_progress', 'completed']);
// The Case stage events that reach each of the five stages (Request Received is always reached).
const FIVE_STAGE_EVENTS = Object.freeze({ quotation_ready: 1, payment_confirmed: 2, in_progress: 3, completed: 4 });

// The flow the deployment intends for new Private Charter requests.
const intendedFlow = (env = process.env) => {
  const value = env[TRACKING_FLOW_ENV];
  return value === undefined || value === '' || value === TRACKING_FLOW_FIVE_STAGE ? TRACKING_FLOW_FIVE_STAGE : null;
};

// `caseRecord` is the request's Case as loaded (undefined = not loaded, null = none). `options.newRequest`: it was just created, so it has no
// Case or link yet.
function trackingFlowOf(request, caseRecord, options = {}) {
  if (request.serviceKey !== PRIVATE_CHARTER_KEY) return undefined;
  if (!options.newRequest) {
    if (caseRecord === undefined) return undefined; // no Case information at all: say nothing rather than guess
    if (isObject(caseRecord) && !('bitrixDealLink' in caseRecord)) return undefined; // the link was not loaded: same
    const link = isObject(caseRecord) ? caseRecord.bitrixDealLink : null;
    if (isObject(link) && link.profile != null) return link.profile === PROFILE_ACTUAL ? TRACKING_FLOW_FIVE_STAGE : null;
  }
  if (request.reviewStatus == null) return null; // a request from before the review workflow
  return intendedFlow();
}

// The stage a five_stage request is at: the furthest of the five that its Case has reached. Before approval, or with no Case, it is Request Received.
function fiveStageOf(request, caseRecord) {
  let furthest = 0;
  if (request.reviewStatus === 'approved' && isObject(caseRecord)) {
    for (const event of Array.isArray(caseRecord.stageEvents) ? caseRecord.stageEvents : []) {
      if (isObject(event) && Object.prototype.hasOwnProperty.call(FIVE_STAGE_EVENTS, event.stage)) furthest = Math.max(furthest, FIVE_STAGE_EVENTS[event.stage]);
    }
    if (caseRecord.status === 'in_progress') furthest = Math.max(furthest, 3);
    if (caseRecord.status === 'completed') furthest = 4;
  }
  return FIVE_STAGE_KEYS[furthest];
}

// Sets trackingFlow / trackingStage on the outgoing request.
function addTracking(out, request, caseRecord, options) {
  const flow = trackingFlowOf(request, caseRecord, options);
  if (flow === undefined) return;
  out.trackingFlow = flow;
  if (flow === TRACKING_FLOW_FIVE_STAGE) out.trackingStage = fiveStageOf(request, options && options.newRequest ? null : caseRecord);
}

// The fields of the request itself the app's list, details, tracking and request-tracking screens read.
const REQUEST_FIELDS = [
  'id', 'referenceNumber', 'status', 'serviceType', 'serviceKey',
  'patientName', 'patientAge', 'patientGender', 'patientLocation', 'patientContact',
  'origin', 'destination', 'country', 'preferredDate', 'careLevel', 'description',
  'deceasedRelation', 'placeOfDeath', 'dateOfDeath', 'transferScope', 'transportMode', 'careRequirement', 'caretakerTypes', 'specialty', 'otherSpecialty', 'consultationType',
  'companyName', 'employeeCount', 'selectedProgrammes',
  'mobility', 'equipOxygen', 'equipCardiacMonitor', 'equipVentilator', 'urgency',
  'travelType', 'criticalLevel', 'oxygenRequired', 'oxygenFlowLpm',
  'originCityName', 'originCountryCode', 'destinationCityName', 'destinationCountryCode',
  'reviewStatus', 'documentsRequestReason', 'submittedAt', 'reviewedAt', 'createdAt', 'updatedAt',
];
// What an Admin has asked the patient for after approval (the service already selects only these).
const DOCUMENT_REQUEST_FIELDS = ['id', 'description', 'reason', 'createdAt'];
const CASE_FIELDS = ['id', 'referenceNumber', 'status', 'urgency', 'createdAt', 'updatedAt'];
// The note is written by staff and shown to the patient on Tracking and in the PDF timeline.
const STAGE_EVENT_FIELDS = ['id', 'stage', 'note', 'occurredAt'];
const CASE_DOCUMENT_FIELDS = ['id', 'type', 'name', 'fileSizeBytes', 'uploadedAt', 'clientUploadId'];
const REQUEST_DOCUMENT_FIELDS = [
  'id', 'originalName', 'sizeBytes', 'uploadedAt', 'replacesId', 'supersededAt', 'scanStatus', 'reviewStatus', 'rejectionReason', 'clientUploadId',
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
  if ('documentRequests' in caseRecord) out.documentRequests = pickEach(caseRecord.documentRequests, DOCUMENT_REQUEST_FIELDS);
  return out;
}

// One request as the patient's phone gets it.
function toPatientRequest(request, options = {}) {
  if (!isObject(request)) return request;
  const out = pick(request, REQUEST_FIELDS);
  // Critical Level goes out as a list (a value stored before the multi-select is a list of one).
  if ('criticalLevel' in out) out.criticalLevel = out.criticalLevel == null ? null : criticalLevelList(out.criticalLevel);
  // Commercial Air oxygen flow rate: present only when one was saved, so every other service (Private Charter
  // included) returns exactly the fields it always did.
  if (request.equipOxygenLpm != null) out.equipOxygenLpm = request.equipOxygenLpm;
  if ('case' in request) out.case = toPatientCase(request.case);
  addTracking(out, request, 'case' in request ? request.case : undefined, options);
  if ('requestDocuments' in request) {
    out.requestDocuments = pickEach(request.requestDocuments, REQUEST_DOCUMENT_FIELDS);
    // Phase 5: this server remembers the app's upload ids, so a document list WITHOUT an id for a file the app sent really means the server does not have it. An older server
    // never sends this, and the app then treats the answer as incomplete (it never assumes an upload is missing).
    out.clientUploadIdSupported = true;
  }
  return out;
}

// A row of the request list: the request itself, plus how it is tracked. The list query loads only what that needs (the Case's status, its stage
// names and its Deal link's profile); that Case is NOT sent, so a list row keeps the shape it always had, with trackingFlow / trackingStage added.
function toPatientListRequest(request) {
  if (!isObject(request)) return request;
  const { case: caseRecord, ...rest } = request;
  const out = toPatientRequest(rest); // no Case key: nothing about the Case is sent and no tracking is decided here
  addTracking(out, request, 'case' in request ? caseRecord : undefined, {});
  return out;
}

const toPatientRequests = (requests) => (Array.isArray(requests) ? requests.map(toPatientListRequest) : requests);

module.exports = {
  toPatientRequest, toPatientRequests, toPatientListRequest, toPatientCase,
  TRACKING_FLOW_FIVE_STAGE, TRACKING_FLOW_ENV, FIVE_STAGE_KEYS, REQUEST_FIELDS, CASE_FIELDS, STAGE_EVENT_FIELDS, CASE_DOCUMENT_FIELDS, REQUEST_DOCUMENT_FIELDS,
};
