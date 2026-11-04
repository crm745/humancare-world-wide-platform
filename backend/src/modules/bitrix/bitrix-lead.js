// Turns a patient request or a corporate case into Bitrix24 lead fields. Kept apart
// from bitrix.service.js (the HTTP call) so it can be tested without any network.

// --- What a lead looks like ----------------------------------------------------------
// Mirrors how the Operations team fills a lead by hand (title "Origin to Destination",
// the patient fields, "Required Service", B2C/B2B), so app leads sit in the same Kanban
// the same way. Field codes and list-item ids are this Bitrix account's own, read with
// crm.lead.fields on 2026-10-27; the labels next to them are what Bitrix shows.
const FIELD = {
  REFERENCE_NO: 'UF_CRM_1768195061660', // Reference No.
  PATIENT_NAME: 'UF_CRM_1775637387862', // Patient Name
  PATIENT_AGE: 'UF_CRM_1768195253912', // Patient Age
  GENDER: 'UF_CRM_1775637565398', // Gender (list)
  DATE_OF_SERVICE: 'UF_CRM_1775637683789', // Date Of Service
  // Address fields: plain text is accepted and Bitrix files it as a location itself
  // (checked with a test lead on 2026-10-27; it reads back as "Mumbai|;|<location id>").
  PICKUP_CITY: 'UF_CRM_1768812307305', // Pickup City (on the form's Travel Details)
  DROP_CITY: 'UF_CRM_1768812329423', // Drop City (on the form's Travel Details)
  CURRENT_LOCATION: 'UF_CRM_1775637732390', // Current Location
  DESTINATION_LOCATION: 'UF_CRM_1775637753105', // Destination Location
  TRANSFER_URGENCY: 'UF_CRM_1775637825406', // Transfer Urgency (list)
  INDUSTRY: 'UF_CRM_1775717843808', // Industry (list)
  REQUIRED_SERVICE: 'UF_CRM_1781505417891', // Required Service (list, multiple)
  CURRENT_MEDICAL_CONDITIONS: 'UF_CRM_1784283904', // Current Medical Conditions (on the form's Patient details)
  MEDICAL_REPORT: 'UF_CRM_1768194664955', // Medical Report (file, on the form's Documents)
  // Mortal Remains: Operations fill "Deceased Name" on HMR leads; on conversion the deal's
  // own "Deceased Name" is fed from Patient Name, so a deceased's name goes in both.
  DECEASED_NAME: 'UF_CRM_1780912350541', // Deceased Name
  RELATION: 'UF_CRM_1775637464857', // Relation to the Patient (list)
};

// The app's service keys (mobile src/data/mock.js SERVICE_TILES, plus the Commercial
// Airlines stretcher/wheelchair choice) -> Bitrix "Required Service" item ids.
// Not listed yet, so sent without one for Operations to pick: "hospital"
// (Hospitalization Assistance, no matching Bitrix service agreed) and the old "air".
const REQUIRED_SERVICE_BY_KEY = {
  privatecharter: 2820, // Private Charter Air Ambulance
  commercialair_stretcher: 2824, // Commercial Airline Stretcher (CAS)
  commercialair_wheelchair: 2826, // Commercial Airline Wheelchair (CAW)
  ground: 2830, // Ground Ambulance (GA)
  mortal: 2828, // Human Mortal Remains (HMR); older app builds, before "Within India / International"
  mortal_domestic: 2828, // Human Mortal Remains (HMR), within India
  mortal_international: 2828, // Human Mortal Remains (HMR), international
  homecare: 2834, // Home Health Care (HHC)
  tele: 2836, // Telemedicine
  corporate: 2930, // Corporate Medical Solution
};

const GENDER = { male: 362, female: 364, other: 366 }; // Male | Female | Others
const INDUSTRY = { patientApp: 712, corporatePortal: 710 }; // B2C | B2B
const URGENCY = { urgent: 380, critical: 380, routine: 382 }; // Urgent | Planned
// The lead's Relation list has only these; any other relation goes in the comment.
const RELATION = { father: 352, mother: 354, brother: 356, spouse: 358, friend: 360 };
const MORTAL_TRANSFER = { mortal_domestic: 'Within India', mortal_international: 'International' };
const isMortal = (serviceKey) => /^mortal(_|$)/.test(serviceKey || '');

const { MOBILITY_LABEL, URGENCY_LABEL, URGENCY_TO_CASE, EQUIPMENT } = require('../../common/constants/request.constants');

// "Other" in this account's own Source list (confirmed with crm.status.list SOURCE);
// there's no app/portal source yet, and the user chose to keep "Other".
const SOURCE_OTHER = 'UC_8HLHOF';
const STAGE_CASE_IN_PROGRESS = 'IN_PROCESS'; // the Kanban's first column

function dateOnly(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : undefined;
}

// The lead comment (shown on the Kanban card): what the requester asked for, as short as
// Operations' own notes. One detail per line, blanks skipped.
function commentLines(pairs) {
  const lines = pairs.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
  return lines.length ? lines.join('\n') : '-'; // "-" = the requester gave no details
}

// "Oxygen, Cardiac monitor" for the equipment asked for on board; nothing when none was.
function equipmentOnBoard(request) {
  return EQUIPMENT.filter(([field]) => request[field] === true).map(([, label]) => label).join(', ');
}

// The comment plus the names of every medical report uploaded so far. The single-file
// "Medical Report" field only keeps one of them, so Operations can still see all of them here.
function commentWithReports(comments, fileNames) {
  if (!fileNames || !fileNames.length) return comments;
  const line = `Medical reports (${fileNames.length}): ${fileNames.join(', ')}`;
  return comments === '-' ? line : `${comments}\n${line}`;
}

function buildLeadFields(input) {
  const fields = {
    TITLE: `${input.origin} to ${input.destination}`,
    NAME: input.contactName,
    PHONE: input.mobile ? [{ VALUE: input.mobile, VALUE_TYPE: 'WORK' }] : undefined,
    EMAIL: input.email ? [{ VALUE: input.email, VALUE_TYPE: 'WORK' }] : undefined,
    SOURCE_ID: SOURCE_OTHER,
    STATUS_ID: STAGE_CASE_IN_PROGRESS,
    COMMENTS: input.comments,
    [FIELD.REFERENCE_NO]: input.referenceNumber,
    [FIELD.PATIENT_NAME]: input.patientName,
    [FIELD.PATIENT_AGE]: input.patientAge ?? undefined,
    [FIELD.GENDER]: GENDER[String(input.patientGender || '').toLowerCase()],
    [FIELD.DATE_OF_SERVICE]: dateOnly(input.dateOfService),
    [FIELD.PICKUP_CITY]: input.origin,
    [FIELD.DROP_CITY]: input.destination,
    [FIELD.CURRENT_LOCATION]: input.origin,
    [FIELD.DESTINATION_LOCATION]: input.destination,
    [FIELD.TRANSFER_URGENCY]: URGENCY[input.urgency],
    [FIELD.INDUSTRY]: input.industry,
    [FIELD.CURRENT_MEDICAL_CONDITIONS]: input.specialRequirements,
    [FIELD.DECEASED_NAME]: input.deceasedName,
    [FIELD.RELATION]: RELATION[String(input.relation || '').toLowerCase()],
    [FIELD.REQUIRED_SERVICE]: REQUIRED_SERVICE_BY_KEY[input.serviceKey] ? [REQUIRED_SERVICE_BY_KEY[input.serviceKey]] : undefined,
  };
  // Bitrix would store an explicit null as "cleared"; leave unknown fields out instead.
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

// A patient's request from the mobile app. `user` is the account that submitted it
// (the contact Operations call back); the patient may be someone else.
function leadInputFromRequest(request, user) {
  if (isMortal(request.serviceKey)) return mortalLeadInput(request, user);
  return {
    contactName: user?.name || request.patientName,
    mobile: request.patientContact || user?.mobile,
    email: user?.email,
    referenceNumber: request.referenceNumber,
    patientName: request.patientName,
    patientAge: request.patientAge,
    patientGender: request.patientGender,
    origin: request.origin,
    destination: request.destination,
    dateOfService: request.preferredDate,
    serviceKey: request.serviceKey,
    specialRequirements: request.specialRequirements,
    urgency: URGENCY_TO_CASE[request.urgency],
    industry: INDUSTRY.patientApp,
    comments: commentLines([
      ['Requirement', request.description],
      ['Care level', request.careLevel],
      ['Mobility', MOBILITY_LABEL[request.mobility]],
      ['On board', equipmentOnBoard(request)],
      ['Urgency', URGENCY_LABEL[request.urgency]],
      // Only when "Required Service" can't say it (no Bitrix service mapped yet).
      ['Service', REQUIRED_SERVICE_BY_KEY[request.serviceKey] ? null : request.serviceType],
    ]),
  };
}

// A Mortal Remains request: patientName is the deceased, and the lead has no fields for
// the transfer type or the place and date of death, so those go in the comment.
function mortalLeadInput(request, user) {
  const relation = request.deceasedRelation;
  return {
    contactName: user?.name,
    mobile: request.patientContact || user?.mobile,
    email: user?.email,
    referenceNumber: request.referenceNumber,
    patientName: request.patientName,
    deceasedName: request.patientName,
    patientAge: request.patientAge,
    patientGender: request.patientGender,
    relation,
    origin: request.origin,
    destination: request.destination,
    dateOfService: request.preferredDate,
    serviceKey: request.serviceKey,
    specialRequirements: request.specialRequirements,
    urgency: URGENCY_TO_CASE[request.urgency],
    industry: INDUSTRY.patientApp,
    comments: commentLines([
      ['Requirement', request.description],
      ['Urgency', URGENCY_LABEL[request.urgency]],
      ['Transfer', MORTAL_TRANSFER[request.serviceKey]],
      ['Relation to the deceased', RELATION[String(relation || '').toLowerCase()] ? null : relation],
      ['Place of death', request.placeOfDeath],
      ['Date of death', dateOnly(request.dateOfDeath)],
    ]),
  };
}

// A case a corporate opened in the corporate portal.
function leadInputFromCase(caseRecord) {
  return {
    contactName: caseRecord.patientName,
    mobile: caseRecord.patientContact,
    referenceNumber: caseRecord.referenceNumber,
    patientName: caseRecord.patientName,
    patientAge: caseRecord.patientAge,
    patientGender: caseRecord.patientGender,
    origin: caseRecord.origin,
    destination: caseRecord.destination,
    urgency: caseRecord.urgency,
    specialRequirements: caseRecord.specialRequirements,
    industry: INDUSTRY.corporatePortal,
    comments: commentLines([
      ['Requirement', caseRecord.description],
      ['Care level', caseRecord.careLevel],
      // Portal cases carry no service key yet, so the service is spelled out here.
      ['Service', caseRecord.serviceType],
    ]),
  };
}

// The lead fields that put one uploaded file into "Medical Report" (a single-file field,
// so a newer report replaces the older one). Bitrix takes the file inline as base64.
const MEDICAL_REPORT_FIELD = FIELD.MEDICAL_REPORT;

function medicalReportFields(fileName, content) {
  return { [MEDICAL_REPORT_FIELD]: { fileData: [fileName, content.toString('base64')] } };
}

module.exports = { buildLeadFields, leadInputFromRequest, leadInputFromCase, medicalReportFields, commentWithReports, MEDICAL_REPORT_FIELD, isMortal, REQUIRED_SERVICE_BY_KEY };
