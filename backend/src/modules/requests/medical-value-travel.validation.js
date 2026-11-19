// Strict validation of a Medical Value Travel request in its structured format (serviceKey "medvalue"). Pure: no database, no network. The controller looks the
// picked cities up first (geo.service getVerifiedCity), calls this before anything is written, and passes the returned `data` (never the raw body) on to
// createRequest, which stores it like any other request.
//
// Self-contained, like home-healthcare.validation.js: it imports nothing from the other service validators (own text rules, own date helpers). It uses only
// neutral shared code (libphonenumber-js and the generated country list).
//
// What the app sends and what is stored
//   treatmentScope    "domestic" | "international"                  -> transfer_scope (the column Mortal Remains also uses; each service reads its own meaning)
//   patientName       at most 191 characters                        -> patient_name
//   patientAge        whole number 0-129                            -> patient_age
//   patientGender     Male | Female | Other                         -> patient_gender
//   country           ISO 3166-1 alpha-2 code ("IN")                -> country (the country's NAME, as the other structured services store it)
//   patientContact    "+<country code><number>"                     -> patient_contact in E.164 ("+919876543210")
//   currentCity       { geonameId } (picked) or { text } (typed)    -> origin (+ patient_location, the same text) and, for a picked city, the origin_* columns
//   destinationCity   { geonameId } (picked) or { text } (typed)    -> destination (+ the destination_* columns for a picked city)
//   preferredDate     optional "YYYY-MM-DD", today or later by the PATIENT's own calendar (utcOffsetMinutes, minutes east of UTC) -> preferred_date
//   specialty         one of SPECIALTIES (English label)            -> specialty
//   otherSpecialty    required when specialty is "Other", at most 191 characters -> other_specialty (NULL otherwise)
//   medicalHistory    optional free text, at most 2,000 characters  -> description, exactly as typed (the existing Condition & Diagnosis field, relabelled)
//
// The scope rules: the Current City is in the selected country, a Domestic destination too, an International destination in a different one. They are enforced
// only where the country is KNOWN: for a picked city (its country comes from the server's verified GeoNames record). A city typed by hand has no country the
// server can trust and none is invented for it: it is kept EXACTLY as typed, its GeoNames columns stay NULL (that is how an unverified city is recognised), and
// the rules are not claimed for it.
//
// Urgency is never collected for this service: it stays NULL.
//
// The description holds ONLY the Medical History, exactly as typed (a client-sent `description` is refused). The scope, specialty and other specialty live in their own
// columns and are never repeated in it. A request is "new format" when its serviceKey is medvalue, its transfer_scope is a real scope AND its specialty column holds an
// approved specialty (see mvtFieldsOf).
//
// COMPATIBILITY: requests saved before the specialty columns existed carry a versioned, length-framed description instead:
//
//   Medical Value Travel v1 (other <O>, history <H>)
//   Specialty: <one line, an approved label>
//   Other Specialty:                    (only when the specialty is "Other")
//   <exactly O UTF-16 code units: the text as typed>
//   Medical History:                    (only when entered)
//   <exactly H UTF-16 code units: the text as typed>
//
// <O> and <H> are JavaScript string lengths (UTF-16 code units). mvtFieldsOf still reads such a row through parseMvtDescription; composeMvtDescription is kept only to
// build that legacy text (tests). Anything that is neither shape is a legacy request shown the way it always was.
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { COUNTRIES } = require('../../common/constants/countries');

const MVT_SERVICE_KEY = 'medvalue';
const MVT_SERVICE_TYPE = 'Medical Value Travel';

const SCOPES = { domestic: 'Domestic', international: 'International' };
const GENDERS = { male: 'Male', female: 'Female', other: 'Other' };
const OTHER_SPECIALTY = 'Other';
// The approved initial list, in the order shown. The mobile app holds the same list (lib/medicalValueTravel.js); a test fails when the two differ.
const SPECIALTIES = [
  'Cardiology and Cardiac Surgery',
  'Oncology',
  'Orthopedics and Joint Replacement',
  'Neurology and Neurosurgery',
  'Transplant (Kidney, Liver, Bone Marrow)',
  'Gastroenterology',
  'Urology',
  'Nephrology',
  'Gynecology and IVF',
  'Pediatrics',
  'Ophthalmology',
  'ENT',
  'Dermatology',
  'Dental',
  'Bariatric and Weight Loss',
  'Spine',
  'Pulmonology',
  'Endocrinology',
  'Plastic and Cosmetic Surgery',
  'General Surgery',
  'Internal Medicine',
  'Rehabilitation and Physiotherapy',
  'Ayurveda and Wellness',
  OTHER_SPECIALTY,
];

const COUNTRY_NAME = new Map(COUNTRIES.map((country) => [country.code, country.name]));

const NAME_MIN = 2;
const NAME_MAX = 191;
const AGE_MAX = 129;
const COLUMN_MAX = 191; // origin / destination / patient_location are VARCHAR(191)
const OTHER_MAX = 191;
const HISTORY_MAX = 2000; // Unicode code points
const OTHER_FRAME_MAX = OTHER_MAX * 2; // UTF-16 code units: the largest framing length the parser accepts
const HISTORY_FRAME_MAX = HISTORY_MAX * 2;
const OFFSET_MIN = -720;
const OFFSET_MAX = 840;

// The fields the structured format carries. Seeing any of these (with the key medvalue) is what makes a request "structured": an older app build sends none
// of them and keeps the generic rules.
const STRUCTURED_MARKERS = ['treatmentScope', 'specialty', 'otherSpecialty', 'medicalHistory', 'currentCity', 'destinationCity'];
const ALLOWED_FIELDS = new Set([
  'serviceType', 'serviceKey', 'treatmentScope', 'patientName', 'patientAge', 'patientGender', 'country', 'patientContact', 'currentCity', 'destinationCity',
  'preferredDate', 'utcOffsetMinutes', 'specialty', 'otherSpecialty', 'medicalHistory',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (value) => value === undefined || value === null;
// Unicode code points, as a person (and MySQL utf8mb4) counts characters: an emoji is one.
const codePoints = (text) => Array.from(text).length;
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const hasLineBreak = (text) => /[\n\r]/.test(text) || text.includes(SEPARATORS[0]) || text.includes(SEPARATORS[1]);

// ---- the character rules for patient free text -----------------------------------------------------------------------------------------------------
// Rejected: every control character (Unicode category Cc) EXCEPT TAB, LF and CR, and unpaired surrogates. Everything else is accepted as typed.
function hasDisallowedControl(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
    if (c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}
function hasUnpairedSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i += 1; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}
// Why a free-text value cannot be accepted, or null. The text itself is never changed. `required` means not empty or whitespace-only (judged on a trimmed COPY).
function freeTextProblem(field, value, { required, max }) {
  if (typeof value !== 'string') return required ? `${field} is required` : `${field} must be text`;
  if (required && value.trim() === '') return `${field} is required`;
  if (hasDisallowedControl(value) || hasUnpairedSurrogate(value)) return `${field} contains characters that cannot be saved`;
  if (codePoints(value) > max) return `${field} can be at most ${max} characters`;
  return null;
}
// A one-line value (a typed city, a specialty name): free text with no line break at all.
function oneLineProblem(field, value, { required, max }) {
  const problem = freeTextProblem(field, value, { required, max });
  if (problem) return problem;
  if (typeof value === 'string' && hasLineBreak(value)) return `${field} must be a single line`;
  return null;
}

// ---- dates (the patient's own calendar) ---------------------------------------------------------------------------------------------------------------------
// "YYYY-MM-DD" that is a real calendar day ("2026-02-30" is refused), or null.
function calendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  const real = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  return real ? value : null;
}
// The patient's own today: the moment `now` seen on a clock `utcOffsetMinutes` minutes east of UTC (what the app's date picker uses).
const patientToday = (now, utcOffsetMinutes) => new Date(now.getTime() + utcOffsetMinutes * 60000).toISOString().slice(0, 10);

// ---- the description: compose and parse ----------------------------------------------------------------------------------------------------------------
const SPECIALTY_LABEL = 'Specialty: ';
const OTHER_LEAD = '\nOther Specialty:\n';
const HISTORY_LEAD = '\nMedical History:\n';
const HEADER = /^Medical Value Travel v1 \(other (0|[1-9]\d{0,3}), history (0|[1-9]\d{0,3})\)$/;

function composeMvtDescription({ specialty, other = '', history = '' }) {
  const parts = [`Medical Value Travel v1 (other ${other.length}, history ${history.length})`, `${SPECIALTY_LABEL}${specialty}`];
  if (specialty === OTHER_SPECIALTY) parts.push(`Other Specialty:\n${other}`);
  if (history !== '') parts.push(`Medical History:\n${history}`);
  return parts.join('\n');
}

const INVALID = Object.freeze({ ok: false });
// The strict parser. { ok: true, specialty, other, history } or { ok: false }. Linear; it never searches inside patient text (the lengths in the header say where
// the two texts end); it never throws; any deviation at all is "invalid" and nothing is partially parsed.
function parseMvtDescription(text) {
  try {
    if (typeof text !== 'string') return INVALID;
    const headerEnd = text.indexOf('\n');
    if (headerEnd < 0) return INVALID;
    const header = HEADER.exec(text.slice(0, headerEnd));
    if (!header) return INVALID;
    const otherLength = Number(header[1]);
    const historyLength = Number(header[2]);
    if (otherLength > OTHER_FRAME_MAX || historyLength > HISTORY_FRAME_MAX) return INVALID;
    let pos = headerEnd + 1;
    const lineEnd = text.indexOf('\n', pos);
    const line = text.slice(pos, lineEnd < 0 ? text.length : lineEnd);
    if (!line.startsWith(SPECIALTY_LABEL)) return INVALID;
    const specialty = line.slice(SPECIALTY_LABEL.length);
    if (specialty === '' || /\r/.test(specialty) || codePoints(specialty) > COLUMN_MAX) return INVALID;
    pos += line.length; // at the end of the Specialty line (the next section starts with its own line break)
    let other = '';
    if (specialty === OTHER_SPECIALTY) {
      if (otherLength < 1 || text.slice(pos, pos + OTHER_LEAD.length) !== OTHER_LEAD) return INVALID;
      pos += OTHER_LEAD.length;
      if (pos + otherLength > text.length) return INVALID;
      other = text.slice(pos, pos + otherLength);
      pos += otherLength;
    } else if (otherLength !== 0) {
      return INVALID;
    }
    let history = '';
    if (historyLength > 0) {
      if (text.slice(pos, pos + HISTORY_LEAD.length) !== HISTORY_LEAD) return INVALID;
      pos += HISTORY_LEAD.length;
      if (pos + historyLength !== text.length) return INVALID;
      history = text.slice(pos);
      pos += historyLength;
    }
    if (pos !== text.length) return INVALID;
    // a frame that cut a surrogate pair in two, or a corrupted text, is not valid
    if (hasUnpairedSurrogate(other) || hasUnpairedSurrogate(history)) return INVALID;
    return { ok: true, specialty, other, history };
  } catch {
    return INVALID;
  }
}

// The specialty fields of a stored request: { ok: true, specialty, other, history } or { ok: false }.
//   current rows: the specialty column holds an approved specialty; `other` comes from other_specialty ("Other" only) and the description is the Medical History.
//   v1 rows (saved before the columns): the specialty column is empty and the whole description parses as the v1 format.
function mvtFieldsOf(request) {
  if (!request || request.serviceKey !== MVT_SERVICE_KEY || !Object.hasOwn(SCOPES, request.transferScope || '')) return INVALID;
  const description = typeof request.description === 'string' ? request.description : '';
  if (request.specialty !== undefined && request.specialty !== null && request.specialty !== '') {
    if (typeof request.specialty !== 'string' || !SPECIALTIES.includes(request.specialty)) return INVALID;
    const isOther = request.specialty === OTHER_SPECIALTY;
    const other = typeof request.otherSpecialty === 'string' ? request.otherSpecialty : '';
    if (isOther && other === '') return INVALID;
    if (!isOther && other !== '') return INVALID;
    return { ok: true, specialty: request.specialty, other, history: description };
  }
  return parseMvtDescription(request.description);
}

// True for a stored NEW-format Medical Value Travel request (current or v1, see mvtFieldsOf). Anything else (every older request) is legacy.
const isNewMvtFormat = (request) => mvtFieldsOf(request).ok;

// ---- structured detection ---------------------------------------------------------------------------------------------------------------------------------------
const isMvtStructuredRequest = (body) => isObject(body)
  && body.serviceKey === MVT_SERVICE_KEY
  && STRUCTURED_MARKERS.some((key) => Object.hasOwn(body, key));

// The city a field names: { id } for a picked one ({ geonameId }), { text } for a typed one ({ text }), or { problem }. Nothing else is accepted inside it.
function cityRefOf(raw) {
  if (!isObject(raw)) return { problem: 'must be a city: { "geonameId": <number> } or { "text": "<city>" }' };
  const keys = Object.keys(raw);
  if (keys.length !== 1) return { problem: 'must hold exactly one of geonameId or text' };
  if (keys[0] === 'geonameId') {
    const id = raw.geonameId;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 2147483647) return { problem: 'geonameId must be a positive whole number' };
    return { id };
  }
  if (keys[0] === 'text') return { text: raw.text };
  return { problem: 'must hold exactly one of geonameId or text' };
}

// ---- the validator ------------------------------------------------------------------------------------------------------------------------------------------------
// `cities`: { currentCity, destinationCity }, each the verified city (from getVerifiedCity) for that field's { geonameId }, or null/undefined.
// Returns { error } (the first problem, as the other validators report one) or { data } for createRequest.
function validateMvtRequest(body, { now = new Date(), cities = {} } = {}) {
  if (!isObject(body)) return { error: 'The request body must be a JSON object.' };

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) return { error: `${key} is not accepted for Medical Value Travel requests` };
  }
  if (body.serviceKey !== MVT_SERVICE_KEY) return { error: 'serviceKey must be "medvalue" for Medical Value Travel requests' };
  if (body.serviceType !== MVT_SERVICE_TYPE) return { error: `serviceType must be "${MVT_SERVICE_TYPE}" for Medical Value Travel requests` };

  if (typeof body.treatmentScope !== 'string' || !Object.hasOwn(SCOPES, body.treatmentScope)) {
    return { error: `treatmentScope must be one of: ${Object.keys(SCOPES).join(', ')}` };
  }
  const scope = body.treatmentScope;

  // Patient
  if (typeof body.patientName !== 'string') return { error: 'patientName is required' };
  const name = body.patientName.trim();
  if (hasDisallowedControl(name) || hasUnpairedSurrogate(name) || /[\t]/.test(name) || hasLineBreak(name)) return { error: 'patientName contains characters that are not allowed' };
  if (codePoints(name) < NAME_MIN || codePoints(name) > NAME_MAX || !/\p{L}/u.test(name)) return { error: `patientName must be ${NAME_MIN} to ${NAME_MAX} characters and include a letter` };

  const ageText = typeof body.patientAge === 'number' ? String(body.patientAge) : body.patientAge;
  if (typeof ageText !== 'string' || !/^(0|[1-9]\d{0,2})$/.test(ageText.trim()) || Number(ageText) > AGE_MAX) {
    return { error: `patientAge must be a whole number from 0 to ${AGE_MAX}` };
  }
  const age = Number(ageText);

  const gender = typeof body.patientGender === 'string' ? GENDERS[body.patientGender.trim().toLowerCase()] : undefined;
  if (!gender) return { error: 'patientGender must be Male, Female or Other' };

  // The country arrives as its ISO code and is stored as its name.
  const countryCode = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(countryCode) || !COUNTRY_NAME.has(countryCode)) return { error: 'country must be a two-letter ISO 3166-1 country code, for example "IN"' };

  const phone = typeof body.patientContact === 'string' && body.patientContact.trim().startsWith('+') ? parsePhoneNumberFromString(body.patientContact.trim()) : null;
  if (!phone || !phone.isValid()) return { error: 'patientContact must be a valid phone number with its country code' };

  // The two cities: picked (verified by the server) or typed (kept exactly as typed, unverified).
  const places = {};
  for (const field of ['currentCity', 'destinationCity']) {
    const ref = cityRefOf(body[field]);
    if (ref.problem) return { error: `${field} ${ref.problem}` };
    if (ref.id) {
      const city = cities[field];
      if (!city || city.geonameId !== ref.id) return { error: `${field} is not a valid city: select one from the list or type it` };
      const inCountry = city.countryCode === countryCode;
      if (field === 'currentCity' && !inCountry) return { error: 'currentCity must be in the selected country' };
      if (field === 'destinationCity' && scope === 'domestic' && !inCountry) return { error: 'destinationCity must be in the selected country for a Domestic request' };
      if (field === 'destinationCity' && scope === 'international' && inCountry) return { error: 'destinationCity must be in a different country for an International request' };
      places[field] = { text: city.label, verified: city };
    } else {
      const problem = oneLineProblem(field, ref.text, { required: true, max: COLUMN_MAX });
      if (problem) return { error: problem };
      places[field] = { text: ref.text, verified: null };
    }
  }

  // Specialty, and the Other text when it is "Other".
  if (typeof body.specialty !== 'string' || !SPECIALTIES.includes(body.specialty)) return { error: 'specialty must be one of the listed specialties' };
  const specialty = body.specialty;
  let other = '';
  if (specialty === OTHER_SPECIALTY) {
    const problem = oneLineProblem('otherSpecialty', body.otherSpecialty, { required: true, max: OTHER_MAX });
    if (problem) return { error: problem };
    other = body.otherSpecialty;
  } else if (!missing(body.otherSpecialty)) {
    return { error: 'otherSpecialty is only accepted when the specialty is Other' };
  }

  // Medical History: optional, exact text, never altered.
  let history = '';
  if (!missing(body.medicalHistory)) {
    const problem = freeTextProblem('medicalHistory', body.medicalHistory, { required: false, max: HISTORY_MAX });
    if (problem) return { error: problem };
    // Whitespace-only is "not provided": nothing is stored (and no Medical History section is written).
    history = body.medicalHistory.trim() === '' ? '' : body.medicalHistory;
  }

  // The Preferred Treatment Date: optional; today or later by the patient's own calendar.
  let preferredDate = null;
  const hasOffset = !missing(body.utcOffsetMinutes);
  if (hasOffset && (!Number.isInteger(body.utcOffsetMinutes) || body.utcOffsetMinutes < OFFSET_MIN || body.utcOffsetMinutes > OFFSET_MAX)) {
    return { error: `utcOffsetMinutes must be a whole number of minutes from ${OFFSET_MIN} to ${OFFSET_MAX} (minutes east of UTC)` };
  }
  if (!missing(body.preferredDate) && body.preferredDate !== '') {
    if (!hasOffset) return { error: 'utcOffsetMinutes is required with preferredDate (minutes east of UTC)' };
    if (typeof body.preferredDate !== 'string' || !calendarDate(body.preferredDate)) return { error: 'preferredDate must be a valid date (YYYY-MM-DD)' };
    if (body.preferredDate < patientToday(now, body.utcOffsetMinutes)) return { error: 'preferredDate cannot be in the past' };
    preferredDate = body.preferredDate;
  }

  const { currentCity, destinationCity } = places;
  const data = {
    serviceType: MVT_SERVICE_TYPE,
    serviceKey: MVT_SERVICE_KEY,
    transferScope: scope,
    patientName: name,
    patientAge: age,
    patientGender: gender,
    country: COUNTRY_NAME.get(countryCode),
    patientContact: phone.number,
    origin: currentCity.text,
    patientLocation: currentCity.text,
    destination: destinationCity.text,
    preferredDate,
    specialty,
    otherSpecialty: specialty === OTHER_SPECIALTY ? other : null,
    description: history, // the Medical History only (an empty one is stored as NULL by createRequest)
  };
  // A picked city carries its verified record; a typed one leaves every one of these columns NULL (createRequest stores null for an absent key).
  if (currentCity.verified) {
    data.originGeonameId = currentCity.verified.geonameId;
    data.originCityName = currentCity.verified.name;
    data.originCountryCode = currentCity.verified.countryCode;
    data.originTimezone = currentCity.verified.timezone || null;
  }
  if (destinationCity.verified) {
    data.destinationGeonameId = destinationCity.verified.geonameId;
    data.destinationCityName = destinationCity.verified.name;
    data.destinationCountryCode = destinationCity.verified.countryCode;
  }
  return { data };
}

module.exports = {
  MVT_SERVICE_KEY, MVT_SERVICE_TYPE, SCOPES, SPECIALTIES, OTHER_SPECIALTY, NAME_MAX, OTHER_MAX, HISTORY_MAX, AGE_MAX,
  isMvtStructuredRequest, isNewMvtFormat, mvtFieldsOf, cityRefOf, validateMvtRequest, composeMvtDescription, parseMvtDescription,
  hasDisallowedControl, hasUnpairedSurrogate, calendarDate, patientToday,
};
