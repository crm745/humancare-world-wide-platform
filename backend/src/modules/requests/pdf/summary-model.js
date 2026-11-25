// What the request summary PDF says: a plain document model built from the patient's own request row. Pure (no PDF library, no fonts, no database, no network), so every service's content is
// tested apart from the drawing.
//
//   buildSummaryModel(request, { now })  ->  {
//     reference, serviceName, statusKey, statusLabel, generatedAt, submittedAt,
//     sections: [{ title, rows: [{ label, value }] }],        Patient Information, Service Information, Request Details (service-specific), in this order, empty ones left out
//     documents: null | [{ name, meta }],                     null = this service takes no documents; [] = none uploaded yet
//     timeline: [{ when, stage, note }]
//   }
//
// ALWAYS ENGLISH: every label, status, date and unit is written here in English whatever language the app is in. What the patient typed (names, addresses, medical text, file names) is passed
// through exactly as typed, never translated; only control characters are removed and an enormous text is cut (TEXT_LIMIT).
//
// ONLY what the patient may see: the model reads a fixed list of fields of the request (below). It never reads, so can never print, the Bitrix fields, the owner's id, file paths, storage keys,
// checksums, scan details, tokens or any other internal column.
const { mobilityText, URGENCY_LABEL, EQUIPMENT, TRAVEL_TYPE_LABEL, criticalLevelText } = require('../../../common/constants/request.constants');
const { careLevelText } = require('../../../common/utils/care-level');
const { SCOPES, MODES, userDetailsOf } = require('../mortal-remains.validation');
const { HOURS, CARETAKERS, parseHomeDescription, isNewHomeFormat } = require('../home-healthcare.validation');
const { SCOPES: MVT_SCOPES, mvtFieldsOf, isNewMvtFormat, OTHER_SPECIALTY } = require('../medical-value-travel.validation');
const { SCOPES: TELE_SCOPES, TYPES: TELE_TYPES } = require('../tele-consultation.validation');
const { PROGRAMMES: CORPORATE_PROGRAMMES, corporateFieldsOf, isNewCorporateFormat } = require('../corporate-medical.validation');
const { SCOPES: MARINE_SCOPES, parseMarineDescription, isNewMarineFormat } = require('../marine-medical-safety.validation');

const TEXT_LIMIT = 20000; // characters of one patient-typed text kept in the PDF (the form allows far less except the 64 KB description)
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A date-only value (a preferred date, a date of death) is stored as that calendar day at 00:00 UTC and is read in UTC, so it prints as the day that was chosen whatever the server's timezone is.
function formatDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${day} ${date.getUTCFullYear()}`;
}

// A moment ("23 Nov 2026, 14:05 UTC"): always English and always UTC, so the same request prints the same text on any server.
function formatMoment(value) {
  if (value === null || value === undefined || value === '') return null; // no date is no date (new Date(null) would read as 1970)
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

const STATUS_LABELS = Object.freeze({ submitted: 'Submitted', scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' });
const humanize = (key) => {
  const text = String(key || '').replace(/[_-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
};
const statusLabelOf = (status) => STATUS_LABELS[status] || humanize(status) || 'Submitted';

// Control characters (other than a line break and a tab) cannot be drawn and bidirectional controls could reorder what follows them; they are removed. Nothing else is changed.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩﻿]/g;
function clean(value) {
  if (value === null || value === undefined) return null;
  let text = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
  if (typeof text !== 'string') return null;
  text = text.replace(/\r\n?/g, '\n').replace(UNPRINTABLE, '').replace(/\t/g, ' ').trim();
  if (text === '') return null;
  const chars = Array.from(text);
  return chars.length > TEXT_LIMIT ? `${chars.slice(0, TEXT_LIMIT).join('')}… (text shortened)` : text;
}

// The service's own name, once: the variant the app appends to it ("Commercial Airlines — Stretcher (CAS)", "Mortal Remains Transportation — Within India") is not a second service name; it is shown in its own
// row (Travel type, Transfer scope, Transport mode).
function baseServiceName(request) {
  const type = request && typeof request.serviceType === 'string' ? request.serviceType : '';
  const base = type.split(' — ')[0].trim();
  const escort = /^Medical Escort \((.+)\)$/.exec(base); // the stored name of Commercial Airlines: the app calls the service "Commercial Airlines"
  return (escort ? escort[1].trim() : base) || null;
}

// A country stored as its two-letter code (Private Charter, Marine, Medical Value Travel and Corporate Medical Solutions) is written as its English name; any other text is left as typed.
const countryNames = typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
function countryText(value) {
  if (typeof value !== 'string') return value;
  const code = value.trim();
  if (!/^[A-Z]{2}$/.test(code) || !countryNames) return value;
  try { const name = countryNames.of(code); return name && name !== code ? name : value; } catch { return value; }
}
const present = (value) => value !== null && value !== undefined && value !== '';
const day = (value) => (value ? formatDateOnly(value) : null);
const ageGender = (request) => [request.patientAge, request.patientGender].filter(present).join(' / ');
const oxygenText = (request) => (request.equipOxygen === true
  ? `Yes${present(request.equipOxygenLpm) ? ` (${request.equipOxygenLpm} LPM)` : ''}`
  : request.equipOxygen === false ? 'No' : null);

const rows = (...pairs) => pairs.map(([label, value]) => ({ label, value: clean(value) })).filter((r) => r.value !== null);

// ---- one function per layout: { patient, service, details } rows ------------------------------------------------------------------------------------------------------------------
// (every label is the one the summary has always used, so nothing a patient or a test looks for has moved)

function homeLayout(request) {
  const parsed = parseHomeDescription(request.description);
  const caretakers = String(request.caretakerTypes || '').split(',').map((key) => CARETAKERS[key]).filter(Boolean).join(', ');
  return {
    patient: rows(['Patient Name:', request.patientName], ['Age / Gender:', ageGender(request)], ['Contact Number:', request.patientContact], ['Country:', countryText(request.country)]),
    service: rows(['Service:', baseServiceName(request)], ['Service Date:', day(request.preferredDate)]),
    details: rows(['Home address:', parsed.address], ['Nurse / Caretaker:', caretakers], ['Care Requirement:', HOURS[request.careRequirement]], ['Care Level:', request.careLevel],
      ['Oxygen:', oxygenText(request)], ['Medical History:', parsed.history]),
  };
}

function mvtLayout(request) {
  const parsed = mvtFieldsOf(request); // the columns, or the v1 description of a request made before them
  const specialty = parsed.specialty === OTHER_SPECIALTY ? `Other (${parsed.other})` : parsed.specialty;
  return {
    patient: rows(['Patient Name:', request.patientName], ['Age / Gender:', ageGender(request)], ['Contact Number:', request.patientContact], ['Country:', countryText(request.country)]),
    service: rows(['Service:', baseServiceName(request)], ['Treatment scope:', MVT_SCOPES[request.transferScope]], ['Preferred treatment date:', day(request.preferredDate)]),
    details: rows(['Specialty:', specialty], ['Current city:', request.origin], ['Destination city:', request.destination], ['Medical History:', parsed.history]),
  };
}

function corporateLayout(request) {
  const parsed = corporateFieldsOf(request);
  return {
    patient: rows(['Name of Employee:', request.patientName], ['Gender:', request.patientGender], ['Patient Contact:', parsed.patientContact]),
    service: rows(['Service:', baseServiceName(request)], ['Company Name:', parsed.companyName], ['No. of Employees:', parsed.employeeCount], ['Preferred Date:', day(parsed.preferredDate)]),
    details: rows(['Programmes:', parsed.programmes.map((key) => CORPORATE_PROGRAMMES[key]).join(', ')], ['Office Address:', parsed.officeAddress], ['Office Country:', countryText(parsed.officeCountry)],
      ['Any Requirement:', parsed.anyRequirement], ['Special Requirement:', parsed.specialRequirement]),
  };
}

function teleLayout(request) {
  return {
    patient: rows(['Patient Name:', request.patientName], ['Age / Gender:', ageGender(request)], ['Contact Number:', request.patientContact], ['Country:', countryText(request.country)]),
    service: rows(['Service:', baseServiceName(request)], ['Consultation type:', TELE_TYPES[request.consultationType]], ['Scope:', TELE_SCOPES[request.transferScope]], ['Visit date:', day(request.preferredDate)]),
    details: rows(['Current address:', request.origin], ['Medical details:', request.description]),
  };
}

function marineLayout(request) {
  const parsed = parseMarineDescription(request.description);
  return {
    patient: rows(['Patient Name:', request.patientName], ['Age / Gender:', ageGender(request)], ['Contact Number:', request.patientContact], ['Country:', countryText(request.country)]),
    service: rows(['Service:', baseServiceName(request)], ['Service scope:', MARINE_SCOPES[request.transferScope]], ['Date of service:', day(request.preferredDate)]),
    details: rows(['Origin:', request.origin], ['Destination:', request.destination], ['Critical level:', careLevelText(request.careLevel)], ['Oxygen:', oxygenText(request)], ['Medical History:', parsed.history]),
  };
}

// Private Charter, Commercial Air, Ground Ambulance, Hospitalization, the older Air key and Mortal Remains (the name on a Mortal Remains request is the deceased's).
function transportLayout(request) {
  const mortal = /^mortal(_|$)/.test(request.serviceKey || '');
  const travel = /^commercialair_(stretcher|wheelchair)$/.exec(request.serviceKey || '');
  const details = mortal ? userDetailsOf(request.description) : request.description;
  const onBoard = EQUIPMENT.filter(([field]) => request[field] === true)
    .map(([field, label]) => (field === 'equipOxygen' && present(request.equipOxygenLpm) ? `${label} (${request.equipOxygenLpm} LPM)` : label)).join(', ');
  return {
    patient: rows([mortal ? "Deceased Person's Name:" : 'Patient Name:', request.patientName], ['Age / Gender:', ageGender(request)], ['Contact Number:', request.patientContact],
      ['Country:', countryText(request.country)], ['Relation to the deceased:', request.deceasedRelation], ['Place of death:', request.placeOfDeath], ['Date of death:', day(request.dateOfDeath)]),
    service: rows(['Service:', baseServiceName(request)], ['Transfer scope:', SCOPES[request.transferScope]], ['Transport mode:', MODES[request.transportMode]],
      ['Travel type:', travel ? travel[1].charAt(0).toUpperCase() + travel[1].slice(1) : TRAVEL_TYPE_LABEL[request.travelType]], [mortal ? 'Preferred transfer date:' : 'Date Of Service:', day(request.preferredDate)],
      ['Urgency:', URGENCY_LABEL[request.urgency]]),
    details: rows(['From:', request.origin], ['To:', request.destination], [mortal ? 'Details:' : 'Condition & diagnosis:', details],
      ['Critical level:', criticalLevelText(request.criticalLevel)], // Private Charter's revised form: a list of keys (empty for every other service)
      ['Oxygen required:', request.oxygenRequired == null ? null : request.oxygenRequired ? (present(request.oxygenFlowLpm) ? `Yes, ${request.oxygenFlowLpm} LPM` : 'Yes') : 'No'],
      ['Care level:', careLevelText(request.careLevel, { translateLegacy: true })], ['Patient mobility:', mobilityText(request.mobility)], ['Required on board:', onBoard]),
  };
}

function layoutOf(request) {
  if (isNewHomeFormat(request)) return homeLayout(request);
  if (isNewMvtFormat(request)) return mvtLayout(request);
  if (isNewMarineFormat(request)) return marineLayout(request);
  if (isNewCorporateFormat(request)) return corporateLayout(request);
  if (request.serviceKey === 'tele' && Object.hasOwn(TELE_TYPES, request.consultationType || '')) return teleLayout(request);
  return transportLayout(request);
}

// ---- documents: names only (never a path, a link, a checksum or a scan record) ------------------------------------------------------------------------------------------------------
const formatSize = (bytes) => {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return null;
  const n = Number(bytes);
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};
function documentsOf(request) {
  if (request.serviceKey === 'tele' && Object.hasOwn(TELE_TYPES, request.consultationType || '')) return null; // Teleconsultation takes no documents
  if (isNewCorporateFormat(request)) return null; // neither does Corporate Medical Solutions
  const list = [];
  const caseDocuments = request.case && Array.isArray(request.case.documents) ? request.case.documents : [];
  for (const d of caseDocuments) list.push({ name: d.name, type: d.type, size: d.fileSizeBytes, at: d.uploadedAt });
  const reviewed = Array.isArray(request.requestDocuments) ? request.requestDocuments : [];
  for (const d of reviewed) if (!d.supersededAt) list.push({ name: d.originalName, type: null, size: d.sizeBytes, at: d.uploadedAt });
  return list
    .map((d) => ({ name: clean(d.name) || 'Document', meta: [clean(d.type), formatSize(d.size), d.at ? `Uploaded ${formatDateOnly(d.at) || ''}`.trim() : null].filter(Boolean).join('  ·  ') }))
    .slice(0, 100);
}

const STAGE_LABELS = Object.freeze({ submitted: 'Request submitted', scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' });
function timelineOf(request) {
  const events = request.case && Array.isArray(request.case.stageEvents) ? request.case.stageEvents : [];
  return events.slice(0, 200).map((ev) => ({ when: formatMoment(ev.occurredAt), stage: STAGE_LABELS[ev.stage] || humanize(ev.stage), note: clean(ev.note) })).filter((ev) => ev.when || ev.stage);
}

// The first row of every document is the person's name: when the request has none, the row says so instead of leaving the section out.
const NAME_LABELS = ['Patient Name:', "Deceased Person's Name:", 'Name of Employee:'];
function withName(layout, request) {
  if (layout.patient.some((r) => NAME_LABELS.includes(r.label))) return layout;
  const mortal = /^mortal(_|$)/.test(request.serviceKey || '');
  const corporate = layout.service.some((r) => r.label === 'Company Name:');
  const label = mortal ? "Deceased Person's Name:" : corporate ? 'Name of Employee:' : 'Patient Name:';
  return { ...layout, patient: [{ label, value: 'Not provided' }, ...layout.patient] };
}

function buildSummaryModel(request, { now = new Date() } = {}) {
  const layout = withName(layoutOf(request), request);
  const sections = [
    { title: 'Patient Information', rows: layout.patient },
    { title: 'Service Information', rows: layout.service },
    { title: 'Request Details', rows: layout.details },
  ].filter((section) => section.rows.length > 0);
  return {
    reference: clean(request.referenceNumber) || 'Request',
    serviceName: clean(baseServiceName(request)) || 'HumanCare service request',
    statusKey: request.status || 'submitted',
    statusLabel: statusLabelOf(request.status),
    generatedAt: formatMoment(now),
    submittedAt: formatMoment(request.createdAt),
    sections,
    documents: documentsOf(request),
    timeline: timelineOf(request),
  };
}

module.exports = { buildSummaryModel, formatDateOnly, formatMoment, statusLabelOf, STATUS_LABELS, TEXT_LIMIT };
