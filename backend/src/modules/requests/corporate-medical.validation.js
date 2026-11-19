// Strict validation of a Corporate Medical Solutions request in its structured, patient-side format (serviceKey "corporate"). Pure: no database, no network.
// The controller calls it before anything is written and passes the returned `data` (never the raw body) on to createRequest, which stores it like any other
// request: its reference is the standard REQ-<1000 + request id>, which its Case copies (requests.service.js).
//
// Self-contained, like home-healthcare.validation.js: it imports nothing from the other service validators (own text, date and phone rules). It uses only neutral shared code
// (libphonenumber-js and the generated country list).
//
// The eleven fields of the form, and where each is stored
//   companyName         Company Name, required, at most 191 characters, one line              -> company_name
//   employeeCount       No. of Employees, required, a whole number from 1 to 10,000           -> employee_count
//   patientName         Name of Employee, required (2 to 100 characters, at least one letter) -> patient_name  (the existing name column)
//   patientGender       Gender, required: Male | Female | Other                               -> patient_gender
//   programmes          Programmes, required, one or more of the seven keys below, no repeats -> selected_programmes (JSON array of keys, canonical order)
//   anyRequirement      Any Requirement, optional free text, at most 2,000 characters         -> description (framed, see below)
//   specialRequirement  Special Requirement, optional free text, at most 2,000 characters     -> description (framed, see below)
//   patientContact      Patient Contact, required: "+<country code><number>", valid           -> patient_contact in international form ("+91 98765 43210", as Home Healthcare)
//   preferredDate       Preferred Date, required: "YYYY-MM-DD", today or later by the patient's own calendar (utcOffsetMinutes, minutes east of UTC, is required) -> preferred_date
//   officeAddress       Office Address, required: the company's complete office address, at most 2,000 characters, as typed (line breaks kept) -> origin (VARCHAR(2000))
//   officeCountry       Office Country, required: an ISO 3166-1 alpha-2 code ("IN")           -> country, as the country's NAME ("India")
//
// officeCountry is the COMPANY OFFICE's country. It is independent of the phone number's country code and of anything about the patient: nothing here derives one from the
// other, and a patient's own country is not collected at all. patient_location stays NULL (the office is not the patient's location). Not collected, so stored as NULL: age,
// urgency, mobility, equipment, care level. destination is '' (the column is NOT NULL; the same empty-string precedent as Teleconsultation and Home Healthcare). A client-sent
// `description`, `origin`, `country` or any other key is refused.
//
// The two requirement texts are stored in `description`, the only text column the request has for them. They are composed HERE, in a versioned, length-framed
// format, so patient text can never be mistaken for system text and is never searched for markers. Only the sections that were typed are written, and nothing
// is written at all (description NULL) when neither was typed:
//
//   Corporate Medical Solutions v1 (any <A>, special <S>)
//   Any Requirement:                      (only when A > 0)
//   <exactly A UTF-16 code units: the text as typed>
//   Special Requirement:                  (only when S > 0)
//   <exactly S UTF-16 code units: the text as typed>
//
// <A> and <S> are JavaScript string lengths (UTF-16 code units); the patient-facing limit (2,000) counts Unicode code points.
//
// A stored request is "new format" only when its serviceKey is corporate AND company_name, employee_count and selected_programmes are all valid AND its
// description is empty or parses completely (corporateFieldsOf). That test is NOT changed by the four office / contact fields: a request saved with only the first seven
// fields (before they existed) is still new format and is shown without them (nothing is invented for it), while a new request must carry all of them (the validator).
// Every earlier Corporate Medical request (free-text description, none of the columns) is legacy and keeps the display it always had.
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { COUNTRIES } = require('../../common/constants/countries');

const CORPORATE_SERVICE_KEY = 'corporate';
// Must equal the service title in the mobile app's data/services.json.
const CORPORATE_SERVICE_TYPE = 'Corporate Medical Solutions';

// The seven programmes, in the order shown. The keys are what is stored and sent; the labels are the English names (the mobile app holds the same list in
// lib/corporateMedical.js, and a test fails when the two differ).
const PROGRAMMES = {
  doctor: 'Doctor',
  nurse: 'Nurse',
  medical_room_management: 'Medical room management',
  first_aid_training: 'First aid training',
  acls_bls_training: 'ACLS & BLS training',
  events: 'Events',
  pre_employment_health_checkup: 'Pre-employment health checkup',
};
const PROGRAMME_KEYS = Object.keys(PROGRAMMES);

const GENDERS = { male: 'Male', female: 'Female', other: 'Other' };
const COUNTRY_NAME = new Map(COUNTRIES.map((country) => [country.code, country.name]));

const COMPANY_MAX = 191; // company_name is VARCHAR(191)
const NAME_MIN = 2;
const NAME_MAX = 100;
const EMPLOYEES_MIN = 1;
const EMPLOYEES_MAX = 10000; // the approved maximum for a new request
// A row saved before the maximum was set to 10,000 may hold a larger count (the first version allowed up to 1,000,000): reading one still works, so no stored request is
// hidden. New requests are held to EMPLOYEES_MAX only.
const STORED_EMPLOYEES_MAX = 1000000;
const TEXT_MAX = 2000; // Unicode code points, for each requirement
const FRAME_MAX = TEXT_MAX * 2; // the largest UTF-16 framing length the parser accepts
const ADDRESS_MAX = 2000; // Unicode code points: Office Address (origin is VARCHAR(2000))
// The UTC offsets that exist: UTC-12 to UTC+14, in minutes east of UTC.
const OFFSET_MIN = -720;
const OFFSET_MAX = 840;

const ALLOWED_FIELDS = new Set([
  'serviceType', 'serviceKey', 'companyName', 'employeeCount', 'patientName', 'patientGender', 'programmes', 'anyRequirement', 'specialRequirement',
  'patientContact', 'preferredDate', 'utcOffsetMinutes', 'officeAddress', 'officeCountry',
]);
// Seeing any of these (with the key corporate) is what makes a request "structured": an older app build sends the generic body, which has none of them.
const STRUCTURED_MARKERS = ['companyName', 'employeeCount', 'programmes', 'anyRequirement', 'specialRequirement', 'patientContact', 'preferredDate', 'officeAddress', 'officeCountry'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (value) => value === undefined || value === null;
const codePoints = (text) => Array.from(text).length;
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const hasLineBreak = (text) => /[\n\r]/.test(text) || text.includes(SEPARATORS[0]) || text.includes(SEPARATORS[1]);

// ---- the character rules for patient free text (same as the other structured services) ---------------------------------------------------------------
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
// Why a free-text value cannot be accepted, or null. The text itself is never changed.
function freeTextProblem(field, value, { required, max }) {
  if (typeof value !== 'string') return required ? `${field} is required` : `${field} must be text`;
  if (required && value.trim() === '') return `${field} is required`;
  if (hasDisallowedControl(value) || hasUnpairedSurrogate(value)) return `${field} contains characters that cannot be saved`;
  if (codePoints(value) > max) return `${field} can be at most ${max} characters`;
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

// ---- the description: compose and parse -------------------------------------------------------------------------------------------------------------
const ANY_LEAD = '\nAny Requirement:\n';
const SPECIAL_LEAD = '\nSpecial Requirement:\n';
const HEADER = /^Corporate Medical Solutions v1 \(any (0|[1-9]\d{0,3}), special (0|[1-9]\d{0,3})\)$/;

// '' when neither requirement was typed (the request then has no description at all).
function composeCorporateDescription({ any = '', special = '' } = {}) {
  if (any === '' && special === '') return '';
  let text = `Corporate Medical Solutions v1 (any ${any.length}, special ${special.length})`;
  if (any !== '') text += `${ANY_LEAD}${any}`;
  if (special !== '') text += `${SPECIAL_LEAD}${special}`;
  return text;
}

const INVALID = Object.freeze({ ok: false });
// The strict parser. { ok: true, any, special } or { ok: false }. Linear; it never searches inside patient text (the lengths in the header say where each text
// ends); it never throws; any deviation at all is "invalid" and nothing is partially parsed. An empty or missing description is valid: both texts are ''.
function parseCorporateDescription(text) {
  try {
    if (text === null || text === undefined || text === '') return { ok: true, any: '', special: '' };
    if (typeof text !== 'string') return INVALID;
    let pos = text.indexOf('\n');
    if (pos < 0) return INVALID;
    const header = HEADER.exec(text.slice(0, pos));
    if (!header) return INVALID;
    const anyLength = Number(header[1]);
    const specialLength = Number(header[2]);
    if ((anyLength === 0 && specialLength === 0) || anyLength > FRAME_MAX || specialLength > FRAME_MAX) return INVALID;
    let any = '';
    let special = '';
    if (anyLength > 0) {
      if (text.slice(pos, pos + ANY_LEAD.length) !== ANY_LEAD) return INVALID;
      pos += ANY_LEAD.length;
      if (pos + anyLength > text.length) return INVALID;
      any = text.slice(pos, pos + anyLength);
      pos += anyLength;
    }
    if (specialLength > 0) {
      if (text.slice(pos, pos + SPECIAL_LEAD.length) !== SPECIAL_LEAD) return INVALID;
      pos += SPECIAL_LEAD.length;
      if (pos + specialLength !== text.length) return INVALID;
      special = text.slice(pos);
      pos += specialLength;
    }
    if (pos !== text.length) return INVALID;
    // a frame that cut a surrogate pair in two, or a corrupted text, is not valid
    if (hasUnpairedSurrogate(any) || hasUnpairedSurrogate(special)) return INVALID;
    return { ok: true, any, special };
  } catch {
    return INVALID;
  }
}

// ---- reading a stored request ------------------------------------------------------------------------------------------------------------------------
// The programmes of a stored row as an array of valid, distinct keys, or null when it is not one (a JSON string, an object, an empty list, an unknown key ...).
function storedProgrammes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROGRAMME_KEYS.length) return null;
  if (!value.every((key) => typeof key === 'string' && Object.hasOwn(PROGRAMMES, key))) return null;
  return new Set(value).size === value.length ? [...value] : null;
}

// The fields of a stored NEW-format request: { ok: true, companyName, employeeCount, programmes (keys), anyRequirement, specialRequirement, patientContact, preferredDate,
// officeAddress, officeCountry } or { ok: false }. The last four are '' / null for a request saved before they existed (nothing is invented for it): officeAddress is the origin
// column and officeCountry the country column, both read ONLY for a new-format request, where they mean the company's office.
function corporateFieldsOf(request) {
  if (!request || request.serviceKey !== CORPORATE_SERVICE_KEY) return INVALID;
  const { companyName, employeeCount } = request;
  if (typeof companyName !== 'string' || companyName.trim() === '') return INVALID;
  if (!Number.isInteger(employeeCount) || employeeCount < EMPLOYEES_MIN || employeeCount > STORED_EMPLOYEES_MAX) return INVALID;
  const programmes = storedProgrammes(request.selectedProgrammes);
  if (!programmes) return INVALID;
  const parsed = parseCorporateDescription(request.description);
  if (!parsed.ok) return INVALID;
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    ok: true, companyName, employeeCount, programmes, anyRequirement: parsed.any, specialRequirement: parsed.special,
    patientContact: text(request.patientContact), preferredDate: request.preferredDate || null, officeAddress: text(request.origin), officeCountry: text(request.country),
  };
}
const isNewCorporateFormat = (request) => corporateFieldsOf(request).ok;

// True when the body is the structured Corporate Medical Solutions format.
const isCorporateStructuredRequest = (body) => isObject(body)
  && body.serviceKey === CORPORATE_SERVICE_KEY
  && STRUCTURED_MARKERS.some((key) => Object.hasOwn(body, key));

// ---- the validator -----------------------------------------------------------------------------------------------------------------------------------
// Returns { error } (the first problem, as the other validators report one) or { data } for createRequest.
function validateCorporateRequest(body, { now = new Date() } = {}) {
  if (!isObject(body)) return { error: 'The request body must be a JSON object.' };

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) return { error: `${key} is not accepted for Corporate Medical Solutions requests` };
  }
  if (body.serviceKey !== CORPORATE_SERVICE_KEY) return { error: 'serviceKey must be "corporate" for Corporate Medical Solutions requests' };
  if (body.serviceType !== CORPORATE_SERVICE_TYPE) return { error: `serviceType must be "${CORPORATE_SERVICE_TYPE}" for Corporate Medical Solutions requests` };

  // 1. Company Name
  const companyProblem = freeTextProblem('companyName', body.companyName, { required: true, max: COMPANY_MAX });
  if (companyProblem) return { error: companyProblem };
  if (hasLineBreak(body.companyName) || /\t/.test(body.companyName)) return { error: 'companyName must be a single line' };
  const companyName = body.companyName.trim();

  // 2. No. of Employees: a whole number (a JSON integer, or a text of digits) from 1 to 10,000
  const countMessage = `employeeCount must be a whole number from ${EMPLOYEES_MIN} to ${EMPLOYEES_MAX}`;
  if (missing(body.employeeCount)) return { error: 'employeeCount is required' };
  let employeeCount = null;
  if (typeof body.employeeCount === 'number') {
    employeeCount = Number.isInteger(body.employeeCount) ? body.employeeCount : null;
  } else if (typeof body.employeeCount === 'string' && /^\d{1,7}$/.test(body.employeeCount.trim())) {
    employeeCount = Number(body.employeeCount.trim());
  }
  if (employeeCount === null || employeeCount < EMPLOYEES_MIN || employeeCount > EMPLOYEES_MAX) return { error: countMessage };

  // 3. Name of Employee (a separate field from the count: neither replaces the other)
  if (typeof body.patientName !== 'string') return { error: 'patientName is required' };
  const name = body.patientName.trim();
  if (hasDisallowedControl(name) || hasUnpairedSurrogate(name) || /\t/.test(name) || hasLineBreak(name)) return { error: 'patientName contains characters that are not allowed' };
  if (codePoints(name) < NAME_MIN || codePoints(name) > NAME_MAX || !/\p{L}/u.test(name)) return { error: `patientName must be ${NAME_MIN} to ${NAME_MAX} characters and include a letter` };

  // 4. Gender
  const gender = typeof body.patientGender === 'string' ? GENDERS[body.patientGender.trim().toLowerCase()] : undefined;
  if (!gender) return { error: 'patientGender must be Male, Female or Other' };

  // 5. Programmes: one or more of the seven, each at most once; stored in the canonical order whatever order they were sent in
  if (!Array.isArray(body.programmes) || body.programmes.length === 0) return { error: 'programmes must list at least one programme' };
  for (const key of body.programmes) {
    if (typeof key !== 'string' || !Object.hasOwn(PROGRAMMES, key)) return { error: `programmes must only hold: ${PROGRAMME_KEYS.join(', ')}` };
  }
  if (new Set(body.programmes).size !== body.programmes.length) return { error: 'programmes must not repeat a programme' };
  const selectedProgrammes = PROGRAMME_KEYS.filter((key) => body.programmes.includes(key));

  // 6 and 7. The two optional requirements: exact text, never altered; whitespace-only counts as not entered
  const texts = {};
  for (const field of ['anyRequirement', 'specialRequirement']) {
    texts[field] = '';
    if (missing(body[field])) continue;
    const problem = freeTextProblem(field, body[field], { required: false, max: TEXT_MAX });
    if (problem) return { error: problem };
    texts[field] = body[field].trim() === '' ? '' : body[field];
  }

  // 8. Patient Contact: an international number ("+<country code>..."), the same rule and the same stored form as Home Healthcare
  const phone = typeof body.patientContact === 'string' && body.patientContact.trim().startsWith('+') ? parsePhoneNumberFromString(body.patientContact.trim()) : null;
  if (!phone || !phone.isValid()) return { error: 'patientContact must be a valid phone number with its country code' };

  // 9. Preferred Date: a real day, today or later by the patient's own calendar (their UTC offset is required, as for Home Healthcare)
  if (!Number.isInteger(body.utcOffsetMinutes) || body.utcOffsetMinutes < OFFSET_MIN || body.utcOffsetMinutes > OFFSET_MAX) {
    return { error: `utcOffsetMinutes is required: a whole number of minutes from ${OFFSET_MIN} to ${OFFSET_MAX} (minutes east of UTC)` };
  }
  if (missing(body.preferredDate)) return { error: 'preferredDate is required' };
  if (typeof body.preferredDate !== 'string' || !calendarDate(body.preferredDate)) return { error: 'preferredDate must be a valid date (YYYY-MM-DD)' };
  if (body.preferredDate < patientToday(now, body.utcOffsetMinutes)) return { error: 'preferredDate cannot be in the past' };

  // 10. Office Address: required, as typed (line breaks kept), at most 2,000 characters; a longer one is refused, never cut
  const addressProblem = freeTextProblem('officeAddress', body.officeAddress, { required: true, max: ADDRESS_MAX });
  if (addressProblem) return { error: addressProblem };
  const officeAddress = body.officeAddress.trim();

  // 11. Office Country: an ISO code from the existing country list, stored as its name. Independent of the phone's country code.
  if (missing(body.officeCountry)) return { error: 'officeCountry is required' };
  const countryCode = typeof body.officeCountry === 'string' ? body.officeCountry.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(countryCode) || !COUNTRY_NAME.has(countryCode)) return { error: 'officeCountry must be a two-letter ISO 3166-1 country code, for example "IN"' };

  return {
    data: {
      serviceType: CORPORATE_SERVICE_TYPE,
      serviceKey: CORPORATE_SERVICE_KEY,
      patientName: name,
      patientGender: gender,
      patientContact: phone.formatInternational(),
      preferredDate: body.preferredDate,
      origin: officeAddress, // the Office Address (the column is VARCHAR(2000))
      destination: '',
      country: COUNTRY_NAME.get(countryCode), // the Office Country's name (NOT the patient's country)
      companyName,
      employeeCount,
      selectedProgrammes,
      description: composeCorporateDescription({ any: texts.anyRequirement, special: texts.specialRequirement }), // '' -> NULL in createRequest
    },
  };
}

module.exports = {
  CORPORATE_SERVICE_KEY, CORPORATE_SERVICE_TYPE, PROGRAMMES, PROGRAMME_KEYS, GENDERS,
  COMPANY_MAX, NAME_MIN, NAME_MAX, EMPLOYEES_MIN, EMPLOYEES_MAX, STORED_EMPLOYEES_MAX, TEXT_MAX, FRAME_MAX, ADDRESS_MAX,
  isCorporateStructuredRequest, validateCorporateRequest, composeCorporateDescription, parseCorporateDescription, corporateFieldsOf, isNewCorporateFormat,
  hasDisallowedControl, hasUnpairedSurrogate, calendarDate, patientToday,
};
