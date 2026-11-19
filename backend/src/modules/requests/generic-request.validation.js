// Validation of a request on the GENERIC create path of POST /requests: the services that have no validator of their own (Commercial Airlines, Ground Ambulance, the older "air"
// key, Hospitalization, Corporate Medical Solutions, an older Marine or Medical Value Travel body, an older Teleconsultation body, and a body with no serviceKey at all).
// Private Charter, Mortal Remains, Home Healthcare, structured Teleconsultation, structured Medical Value Travel and structured Marine are decided by their own validators
// before a request ever gets here.
//
// Pure: no database, no network. The controller calls it after its existing generic checks (required fields, serviceKey, the medical page rules) and passes the returned `data`,
// never the raw body, to createRequest. So only the keys listed here can reach Prisma, and every type and length problem becomes a 400 here instead of a Prisma error (a 500).
//
// What it does
//   1. Refuses, for every generic service, the keys that belong to another service's own validator and that no generic client has ever sent: the seven GeoNames city columns,
//      the deceased details, transferScope, transportMode, careRequirement and caretakerTypes. (A null or absent value is ignored; any other value is a 400.)
//   2. Checks the type and size of every key it keeps, so nothing reaches a column it does not fit: text at most 191 characters (the VARCHAR(191) columns), the age a whole
//      number from 0 to 129, the date a real date, the description at most 65,535 UTF-8 bytes (the TEXT column's capacity), the care level text at most 191 characters.
//   3. STAGE 1 of unknown keys: a key it does not know is ignored exactly as before and its NAME (never its value) is reported back so the controller can log it. Keys of the
//      retired legacy list (columns removed from the table) are ignored without a word. Stage 2 (refusing unknown keys) is not implemented.
//
// It never changes a stored value: text goes through exactly as received (createRequest turns an empty text into NULL, as it always did); the age keeps its existing
// string-to-number conversion; the date string goes through as received.

// The keys the generic path keeps. Everything the mobile app's generic body sends (apps/mobile/src/app/request/review.js) is here.
const KEPT_FIELDS = [
  'serviceType', 'serviceKey', 'patientName', 'patientAge', 'patientGender', 'patientLocation', 'patientContact', 'origin', 'destination', 'country', 'preferredDate',
  'careLevel', 'description', 'mobility', 'equipOxygen', 'equipOxygenLpm', 'equipCardiacMonitor', 'equipVentilator', 'urgency',
];
const KEPT = new Set(KEPT_FIELDS);

// Another service's own columns: refused on the generic path (a 400), whatever the service key.
const REFUSED_FIELDS = [
  'originGeonameId', 'originCityName', 'originCountryCode', 'originTimezone',
  'destinationGeonameId', 'destinationCityName', 'destinationCountryCode',
  'deceasedRelation', 'placeOfDeath', 'dateOfDeath',
  'transferScope', 'transportMode',
  'careRequirement', 'caretakerTypes',
];

// Keys of columns that were removed from the table (migrations 20261105100000 and 20261105140000): an older app build may still send them. Ignored silently, never logged.
const RETIRED_LEGACY_FIELDS = ['medicalSummary', 'documentUrl', 'additionalInfo', 'specialRequirements', 'referralSource'];
const RETIRED = new Set(RETIRED_LEGACY_FIELDS);

const TEXT_MAX = 191; // the VARCHAR(191) columns
const AGE_MAX = 129;
const DESCRIPTION_MAX_BYTES = 65535; // the TEXT column's capacity, in UTF-8 bytes

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAbsent = (value) => value === undefined || value === null;
const codePoints = (text) => Array.from(text).length;

// An optional text value: absent or null is fine; otherwise it must be text of at most 191 characters. (An empty text is allowed and becomes NULL in createRequest, as before.)
function optionalText(body, field) {
  const value = body[field];
  if (isAbsent(value)) return { ok: true };
  if (typeof value !== 'string') return { error: `${field} must be text` };
  if (codePoints(value) > TEXT_MAX) return { error: `${field} can be at most ${TEXT_MAX} characters` };
  return { ok: true, value };
}

// "YYYY-MM-DD" that is a real calendar day, or null.
function realDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  const real = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  return real ? value : null;
}

// The date the generic form has always sent ("YYYY-MM-DD") or a full ISO date-time that parses (what an older client could send). Anything else was an Invalid Date.
function dateProblem(value) {
  if (typeof value !== 'string') return 'preferredDate must be a valid date (YYYY-MM-DD)';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return realDay(value) ? null : 'preferredDate must be a valid date (YYYY-MM-DD)';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(new Date(value).getTime())) return null;
  return 'preferredDate must be a valid date (YYYY-MM-DD)';
}

// The age as the number to store, or { error }. Absent, null, an empty text and a blank text are "no age" (NULL). Otherwise a whole number 0 to 129, as a JSON number or a text of up to
// three digits (what the form has always sent).
function ageOf(value) {
  const message = `patientAge must be a whole number from 0 to ${AGE_MAX}`;
  if (isAbsent(value)) return { value: null };
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > AGE_MAX) return { error: message };
    return { value: value === 0 ? 0 : value }; // (-0 is stored as 0)
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return { value: null };
    if (!/^\d{1,3}$/.test(text) || Number(text) > AGE_MAX) return { error: message };
    return { value: Number(text) };
  }
  return { error: message };
}

// A key name that is safe to write in a log: a short plain identifier. Anything else (a key that is long, or holds spaces or characters that could carry personal data) is logged as
// "[other]".
const safeName = (name) => (/^[A-Za-z0-9_.$-]{1,40}$/.test(name) ? name : '[other]');

// Returns { error } (the first problem, as the generic path has always reported one) or { data, unknownFields } where `data` holds only the kept keys the body had, and
// `unknownFields` the NAMES of the keys that were ignored (the retired legacy keys are not among them).
function validateGenericRequest(body) {
  if (!isObject(body)) return { error: 'The request body must be a JSON object.' };

  // 1. another service's own columns
  for (const field of REFUSED_FIELDS) {
    if (Object.hasOwn(body, field) && !isAbsent(body[field])) return { error: `${field} is not accepted for this service` };
  }

  // 2. type and size of what is kept
  for (const field of ['serviceType', 'patientName', 'origin', 'destination']) {
    const value = body[field];
    if (typeof value !== 'string') return { error: `${field} must be text` };
    if (codePoints(value) > TEXT_MAX) return { error: `${field} can be at most ${TEXT_MAX} characters` };
  }
  const data = {
    serviceType: body.serviceType, patientName: body.patientName, origin: body.origin, destination: body.destination,
  };

  if (!isAbsent(body.serviceKey)) {
    if (typeof body.serviceKey !== 'string') return { error: 'serviceKey must be text' };
    data.serviceKey = body.serviceKey;
  }
  for (const field of ['patientGender', 'patientLocation', 'patientContact', 'country']) {
    const checked = optionalText(body, field);
    if (checked.error) return { error: checked.error };
    if (Object.hasOwn(checked, 'value')) data[field] = checked.value;
  }

  const age = ageOf(body.patientAge);
  if (age.error) return { error: age.error };
  data.patientAge = age.value;

  if (!isAbsent(body.preferredDate) && body.preferredDate !== '') {
    const problem = dateProblem(body.preferredDate);
    if (problem) return { error: problem };
    data.preferredDate = body.preferredDate;
  }

  if (!isAbsent(body.description)) {
    if (typeof body.description !== 'string') return { error: 'description must be text' };
    if (Buffer.byteLength(body.description, 'utf8') > DESCRIPTION_MAX_BYTES) return { error: `description can be at most ${DESCRIPTION_MAX_BYTES} bytes` };
    data.description = body.description;
  }

  // The care level: the Ground and Commercial Air rules (the four keys) were already applied by the controller. For every service it must be text of at most 191 characters.
  if (!isAbsent(body.careLevel)) {
    if (typeof body.careLevel !== 'string') return { error: 'careLevel must be text' };
    if (codePoints(body.careLevel) > TEXT_MAX) return { error: `careLevel can be at most ${TEXT_MAX} characters` };
    data.careLevel = body.careLevel;
  }

  // The medical page's own fields were validated by the controller (their values, and which services may send them); they are passed on exactly as sent.
  for (const field of ['mobility', 'equipOxygen', 'equipOxygenLpm', 'equipCardiacMonitor', 'equipVentilator', 'urgency']) {
    if (!isAbsent(body[field])) data[field] = body[field];
  }

  // 3. stage 1 of unknown keys: names only
  const unknownFields = Object.keys(body).filter((key) => !KEPT.has(key) && !RETIRED.has(key) && !REFUSED_FIELDS.includes(key)).map(safeName);
  return { data, unknownFields };
}

// The one log line for stage 1. Field NAMES only (each a short plain identifier), the service key only when it is one the server knows (else "unknown"), at most 20 names; never
// a value and nothing about the person. `knownKeys` is the controller's set of service keys.
function unknownFieldsLogLine(serviceKey, unknownFields, knownKeys) {
  const key = typeof serviceKey === 'string' && knownKeys.has(serviceKey) ? serviceKey : serviceKey === undefined ? 'none' : 'unknown';
  return `[generic-request] unknown fields ignored (service ${key}): ${unknownFields.slice(0, 20).join(', ')}`;
}

module.exports = {
  KEPT_FIELDS, REFUSED_FIELDS, RETIRED_LEGACY_FIELDS, TEXT_MAX, AGE_MAX, DESCRIPTION_MAX_BYTES, validateGenericRequest, unknownFieldsLogLine,
};
