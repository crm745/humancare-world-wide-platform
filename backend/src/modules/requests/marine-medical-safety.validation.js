// Strict validation of a Marine Medical Safety request in its structured format (serviceKey "marine"). Pure: no database, no network. A later phase's controller
// looks the picked cities up first (geo.service getVerifiedCity), calls this before anything is written, and passes the returned `data` (never the raw body) on
// to createRequest, which stores it like any other request.
//
// Self-contained, like home-healthcare.validation.js and medical-value-travel.validation.js: it imports nothing from another service's validator (own text rules,
// own date helpers, own description format). It uses only neutral shared code: libphonenumber-js, the generated country list and the shared Critical Level and
// Oxygen flow-rate rules in common/constants/request.constants.js (the very ones Ground Ambulance, Commercial Air and Home Healthcare use).
//
// What the app sends and what is stored
//   serviceScope      "domestic" | "international" (the patient sees it as "Service Scope")   -> transfer_scope (the column Mortal Remains and Medical Value Travel
//                     also use; each service reads its own meaning, and every reader checks the service key first)
//   patientName       2 to 191 characters with a letter                                        -> patient_name
//   patientAge        whole number 0-129                                                       -> patient_age
//   patientGender     Male | Female | Other                                                    -> patient_gender
//   country           ISO 3166-1 alpha-2 code ("IN")                                           -> country (the country's NAME, as the other structured services store it)
//   patientContact    "+<country code><number>"                                                -> patient_contact in E.164 ("+919876543210")
//   originCity        { geonameId } (picked) or { text } (typed city or port)                  -> origin (+ patient_location, the same text) and, for a picked city, the origin_* columns
//   destinationCity   { geonameId } (picked) or { text } (typed city or port)                  -> destination (+ the destination_* columns for a picked city)
//   preferredDate     optional "YYYY-MM-DD", today or later by the PATIENT's own calendar (utcOffsetMinutes, minutes east of UTC) -> preferred_date (the Date of Service)
//   utcOffsetMinutes  required with preferredDate; never stored
//   careLevel         optional Critical Level: one or more of crit_icu, crit_ventilated, crit_tracheostomy, crit_ecmo (a comma-separated text, or a list), each once,
//                     stored in the order chosen as a comma-separated text                     -> care_level
//   equipOxygen       optional three-state: absent or null = not answered (stored NULL), true = Yes, false = No   -> equip_oxygen
//   equipOxygenLpm    required when equipOxygen is true (a number, > 0 and <= 15, one decimal); refused otherwise -> equip_oxygen_lpm (NULL for No and for not answered)
//   medicalHistory    optional free text, at most 2,000 characters, kept exactly            -> inside description
//
// The scope rules: the Origin is in the selected country, a Domestic destination too, an International destination in a different one. They are enforced only where
// the country is KNOWN: for a picked city (its country comes from the server's verified GeoNames record). A city or port typed by hand has no country the server
// can trust and none is invented for it: it is kept EXACTLY as typed, every GeoNames column stays NULL (that is how an unverified location is recognised), and the
// rules are not claimed for it.
//
// Never accepted (a clear 400 each, like every field this format does not carry): urgency, mobility, cardiac monitor, ventilator equipment, emergency contact,
// vessel or ship name, GPS coordinates, and the generic description / origin / destination / patientLocation / transferScope fields (the structured format has its own:
// medicalHistory, originCity, destinationCity, serviceScope). createRequest itself needs only serviceType and serviceKey from the client besides these, and both are
// allowed. Urgency, mobility and the two equipment flags are stored NULL.
//
// The description is composed HERE, in a versioned, length-framed format, so patient text can never be mistaken for system text and is never searched for markers.
// The scope is NOT repeated in it (it is in transfer_scope). The header is ALWAYS written, with or without a Medical History:
//
//   Marine Medical Safety v1 (history <H>)
//   Medical History:                          (only when a Medical History was entered; with none the description is the header line alone)
//   <exactly H UTF-16 code units: the text as typed>
//
// <H> is a JavaScript string length (UTF-16 code units). The patient-facing limit is separate and counts Unicode code points (2,000). A request is "new format" only
// when its serviceKey is marine, its transfer_scope is a real scope AND the whole description parses (parseMarineDescription); anything else is a legacy generic
// Marine request and keeps the generic path and display.
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { COUNTRIES } = require('../../common/constants/countries');
const { oxygenLpmProblem, commercialAirCareLevelProblem, COMMERCIAL_AIR_CARE_LEVEL_KEYS } = require('../../common/constants/request.constants');

const MARINE_SERVICE_KEY = 'marine';
const MARINE_SERVICE_TYPE = 'Marine Medical Safety';
// The patient-facing label of the scope choice.
const SERVICE_SCOPE_LABEL = 'Service Scope';

const SCOPES = { domestic: 'Domestic', international: 'International' };
const GENDERS = { male: 'Male', female: 'Female', other: 'Other' };
// The Critical Level options, in the order shown (the same four keys as Ground Ambulance and Commercial Air).
const CRITICAL_LEVELS = COMMERCIAL_AIR_CARE_LEVEL_KEYS;

const COUNTRY_NAME = new Map(COUNTRIES.map((country) => [country.code, country.name]));

const NAME_MIN = 2;
const NAME_MAX = 191;
const AGE_MAX = 129;
const COLUMN_MAX = 191; // origin / destination / patient_location are VARCHAR(191)
const HISTORY_MAX = 2000; // Unicode code points
const HISTORY_FRAME_MAX = HISTORY_MAX * 2; // UTF-16 code units: the largest framing length the parser accepts
const OFFSET_MIN = -720;
const OFFSET_MAX = 840;

// The fields only the structured format carries. Seeing any of these (with the key marine) is what makes a request BODY "structured": an older app build sends none
// of them and keeps the generic rules. (careLevel and equipOxygen are deliberately not markers: nothing says an older body could not carry them.)
const STRUCTURED_MARKERS = ['serviceScope', 'originCity', 'destinationCity', 'medicalHistory'];
const ALLOWED_FIELDS = new Set([
  'serviceType', 'serviceKey', 'serviceScope', 'patientName', 'patientAge', 'patientGender', 'country', 'patientContact', 'originCity', 'destinationCity',
  'preferredDate', 'utcOffsetMinutes', 'careLevel', 'equipOxygen', 'equipOxygenLpm', 'medicalHistory',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (value) => value === undefined || value === null;
// Unicode code points, as a person (and MySQL utf8mb4) counts characters: an emoji is one.
const codePoints = (text) => Array.from(text).length;
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const hasLineBreak = (text) => /[\n\r]/.test(text) || text.includes(SEPARATORS[0]) || text.includes(SEPARATORS[1]);

// ---- the character rules for patient free text -----------------------------------------------------------------------------------------------------
// Rejected: every control character (Unicode category Cc) EXCEPT TAB, LF and CR (U+0000-0008, U+000B, U+000C, U+000E-001F, DEL, U+0080-009F) and unpaired
// surrogates. Everything else (Unicode separators, zero-width and bidirectional format characters, emoji and ZWJ sequences, combining marks, every script) is
// accepted as typed. An explicit code-unit loop, so the result is identical on every JavaScript engine.
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
// A one-line value (a typed city or port): free text with no line break at all.
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
const HISTORY_LEAD = '\nMedical History:\n';
const HEADER = /^Marine Medical Safety v1 \(history (0|[1-9]\d{0,3})\)$/;

// `history` is the Medical History exactly as it is to be stored ('' for none). The header is always written.
function composeMarineDescription({ history = '' } = {}) {
  const header = `Marine Medical Safety v1 (history ${history.length})`;
  return history === '' ? header : `${header}${HISTORY_LEAD}${history}`;
}

const INVALID = Object.freeze({ ok: false });
// The strict parser. { ok: true, history } or { ok: false }. Linear; it never searches inside patient text (the length in the header says where the history ends);
// it never throws; any deviation at all is "invalid" and nothing is partially parsed.
function parseMarineDescription(text) {
  try {
    if (typeof text !== 'string') return INVALID;
    const headerEnd = text.indexOf('\n');
    const headerText = headerEnd < 0 ? text : text.slice(0, headerEnd);
    const header = HEADER.exec(headerText);
    if (!header) return INVALID;
    const historyLength = Number(header[1]);
    if (historyLength > HISTORY_FRAME_MAX) return INVALID;
    if (historyLength === 0) return headerEnd < 0 ? { ok: true, history: '' } : INVALID; // no history: the header line alone, nothing after it
    if (headerEnd < 0) return INVALID;
    if (text.slice(headerEnd, headerEnd + HISTORY_LEAD.length) !== HISTORY_LEAD) return INVALID;
    const start = headerEnd + HISTORY_LEAD.length;
    if (start + historyLength !== text.length) return INVALID;
    const history = text.slice(start);
    // a frame that cut a surrogate pair in two, or a corrupted text, is not valid
    if (hasUnpairedSurrogate(history)) return INVALID;
    return { ok: true, history };
  } catch {
    return INVALID;
  }
}

// True for a stored request that is a NEW-format Marine Medical Safety request: its key is marine, its transfer_scope is a real scope and its whole description
// parses. Anything else (every request made before this format, which has no scope and a free-text description) is a legacy generic request. A description that
// merely looks like the header does not make a request structured without the scope, and a scope alone does not either.
const isNewMarineFormat = (request) => !!request
  && request.serviceKey === MARINE_SERVICE_KEY
  && typeof request.transferScope === 'string'
  && Object.hasOwn(SCOPES, request.transferScope)
  && parseMarineDescription(request.description).ok;

// ---- structured detection of a request BODY ---------------------------------------------------------------------------------------------------------------
const isMarineStructuredRequest = (body) => isObject(body)
  && body.serviceKey === MARINE_SERVICE_KEY
  && STRUCTURED_MARKERS.some((key) => Object.hasOwn(body, key));

// The city a field names: { id } for a picked one ({ geonameId }), { text } for a typed one ({ text }), or { problem }. Nothing else is accepted inside it.
function cityRefOf(raw) {
  if (!isObject(raw)) return { problem: 'must be a city: { "geonameId": <number> } or { "text": "<city or port>" }' };
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

// The Critical Level the body names, as the canonical stored text, or { error }, or { value: null } for no selection. Absent, null, an empty text and an empty list
// are all "no selection" (valid). A text is comma-separated ("crit_icu,crit_ecmo"); a list holds the keys. The shared rule decides what is acceptable: only the four
// keys, each at most once. The order chosen is kept.
function criticalLevelOf(raw) {
  if (missing(raw)) return { value: null };
  let text;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { value: null };
    if (raw.some((item) => typeof item !== 'string')) return { error: `Invalid careLevel. Use one or more of: ${CRITICAL_LEVELS.join(', ')} (comma-separated).` };
    text = raw.join(',');
  } else if (typeof raw === 'string') {
    if (raw.trim() === '') return { value: null };
    text = raw;
  } else {
    return { error: `Invalid careLevel. Use one or more of: ${CRITICAL_LEVELS.join(', ')} (comma-separated).` };
  }
  const problem = commercialAirCareLevelProblem(text);
  if (problem) return { error: problem };
  return { value: text.split(',').map((piece) => piece.trim()).join(',') };
}

// ---- the validator ------------------------------------------------------------------------------------------------------------------------------------------------
// `cities`: { originCity, destinationCity }, each the verified city (from getVerifiedCity) for that field's { geonameId }, or null/undefined.
// Returns { error } (the first problem, as the other validators report one) or { data } for createRequest.
function validateMarineRequest(body, { now = new Date(), cities = {} } = {}) {
  if (!isObject(body)) return { error: 'The request body must be a JSON object.' };

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) return { error: `${key} is not accepted for Marine Medical Safety requests` };
  }
  if (body.serviceKey !== MARINE_SERVICE_KEY) return { error: 'serviceKey must be "marine" for Marine Medical Safety requests' };
  if (body.serviceType !== MARINE_SERVICE_TYPE) return { error: `serviceType must be "${MARINE_SERVICE_TYPE}" for Marine Medical Safety requests` };

  if (typeof body.serviceScope !== 'string' || !Object.hasOwn(SCOPES, body.serviceScope)) {
    return { error: `serviceScope (${SERVICE_SCOPE_LABEL}) must be one of: ${Object.keys(SCOPES).join(', ')}` };
  }
  const scope = body.serviceScope;

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

  // The two places: picked (verified by the server) or typed (kept exactly as typed, unverified).
  const places = {};
  for (const field of ['originCity', 'destinationCity']) {
    const ref = cityRefOf(body[field]);
    if (ref.problem) return { error: `${field} ${ref.problem}` };
    if (ref.id) {
      const city = cities[field];
      if (!city || city.geonameId !== ref.id) return { error: `${field} is not a valid city: select one from the list or type it` };
      const inCountry = city.countryCode === countryCode;
      if (field === 'originCity' && !inCountry) return { error: 'originCity must be in the selected country' };
      if (field === 'destinationCity' && scope === 'domestic' && !inCountry) return { error: 'destinationCity must be in the selected country for a Domestic request' };
      if (field === 'destinationCity' && scope === 'international' && inCountry) return { error: 'destinationCity must be in a different country for an International request' };
      places[field] = { text: city.label, verified: city };
    } else {
      const problem = oneLineProblem(field, ref.text, { required: true, max: COLUMN_MAX });
      if (problem) return { error: problem };
      places[field] = { text: ref.text, verified: null };
    }
  }

  // Medical History: optional, exact text, never altered.
  let history = '';
  if (!missing(body.medicalHistory)) {
    const problem = freeTextProblem('medicalHistory', body.medicalHistory, { required: false, max: HISTORY_MAX });
    if (problem) return { error: problem };
    // Whitespace-only is "not provided" (as in the other structured services): nothing is stored and no Medical History section is written.
    history = body.medicalHistory.trim() === '' ? '' : body.medicalHistory;
  }

  // The Date of Service: optional; today or later by the patient's own calendar.
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

  // The Critical Level: optional, one or more of the four keys.
  const level = criticalLevelOf(body.careLevel);
  if (level.error) return { error: level.error };

  // Oxygen, three states: not answered (NULL), Yes (the flow rate is required) or No (no flow rate; it is stored NULL).
  let oxygen = null;
  if (!missing(body.equipOxygen)) {
    if (typeof body.equipOxygen !== 'boolean') return { error: 'equipOxygen must be true or false' };
    oxygen = body.equipOxygen;
  }
  let oxygenLpm = null;
  if (oxygen === true) {
    if (missing(body.equipOxygenLpm)) return { error: 'equipOxygenLpm is required when Oxygen is Yes' };
    const problem = oxygenLpmProblem(body.equipOxygenLpm);
    if (problem) return { error: problem };
    oxygenLpm = Number(body.equipOxygenLpm.toFixed(1)); // one decimal at most, as the other services store it
  } else if (!missing(body.equipOxygenLpm)) {
    return { error: 'equipOxygenLpm is only accepted when Oxygen is Yes' };
  }

  const { originCity, destinationCity } = places;
  const data = {
    serviceType: MARINE_SERVICE_TYPE,
    serviceKey: MARINE_SERVICE_KEY,
    transferScope: scope,
    patientName: name,
    patientAge: age,
    patientGender: gender,
    country: COUNTRY_NAME.get(countryCode),
    patientContact: phone.number,
    origin: originCity.text,
    patientLocation: originCity.text,
    destination: destinationCity.text,
    preferredDate,
    careLevel: level.value, // null when none was chosen
    equipOxygen: oxygen, // null when not answered
    equipOxygenLpm: oxygenLpm, // a number only for Yes; NULL for No and for not answered
    description: composeMarineDescription({ history }),
  };
  // A picked city carries its verified record; a typed one leaves every one of these columns absent (createRequest stores NULL for an absent key).
  if (originCity.verified) {
    data.originGeonameId = originCity.verified.geonameId;
    data.originCityName = originCity.verified.name;
    data.originCountryCode = originCity.verified.countryCode;
    data.originTimezone = originCity.verified.timezone || null;
  }
  if (destinationCity.verified) {
    data.destinationGeonameId = destinationCity.verified.geonameId;
    data.destinationCityName = destinationCity.verified.name;
    data.destinationCountryCode = destinationCity.verified.countryCode;
  }
  return { data };
}

module.exports = {
  MARINE_SERVICE_KEY, MARINE_SERVICE_TYPE, SERVICE_SCOPE_LABEL, SCOPES, CRITICAL_LEVELS, NAME_MAX, HISTORY_MAX, AGE_MAX,
  isMarineStructuredRequest, isNewMarineFormat, cityRefOf, validateMarineRequest, composeMarineDescription, parseMarineDescription,
  hasDisallowedControl, hasUnpairedSurrogate, calendarDate, patientToday,
};
