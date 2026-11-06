// Strict validation of a Private Charter Air Ambulance request (serviceKey "privatecharter").
// Pure: no database, no network. The controller calls it before anything is written, and
// passes the returned `data` (never the raw body) on to createRequest.
//
// Every problem is reported at once, keyed by the API field name:
//   { fields: { patientAge: 'Age must be a whole number from 1 to 120.', ... }, data, legacy }
// `data` is only meaningful when `fields` is empty.
//
// Cities: origin and destination are { geonameId } selections. The caller looks each id up in the
// local GeoNames table first (geo.service#resolveCityRefs) and passes the verified cities in as
// `cities`; this file never trusts a name, country or timezone from the client.
//
// Not covered here, on purpose: documents, Bitrix and encryption.
const { COUNTRIES } = require('../../common/constants/countries');
const { normalizeMobile } = require('../../common/utils/phone');
const { isValidTimeZone, todayInTimeZone } = require('../../common/utils/local-date');
const { readCityRef } = require('../geo/city-ref');
const {
  MOBILITY, URGENCY, EQUIPMENT, GENDERS, CARE_LEVEL_KEYS, CARE_LEVEL_EXCLUSIVE, CARE_LEVEL_LEGACY_LABELS,
  PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE,
} = require('../../common/constants/request.constants');

const ISO_COUNTRY_CODES = new Set(COUNTRIES.map((country) => country.code));
const EQUIPMENT_FIELDS = EQUIPMENT.map(([field]) => field);

// Fields a Private Charter request may carry. Anything else is refused, not dropped.
// `patientLocation` is not one of them: it only repeated `origin`, so it is refused (see
// SPECIFIC_FIELD_MESSAGES) instead of being stored twice.
const ALLOWED_FIELDS = new Set([
  'serviceKey', 'serviceType', 'patientName', 'patientAge', 'patientGender', 'patientContact',
  'country', 'origin', 'destination', 'preferredDate', 'careLevel', 'description', 'mobility', 'urgency',
  ...EQUIPMENT_FIELDS,
]);
const DECEASED_FIELDS = new Set(['deceasedRelation', 'placeOfDeath', 'dateOfDeath']);
const SPECIFIC_FIELD_MESSAGES = {
  patientLocation: 'Location is not accepted for Private Charter requests; send the origin city as origin.',
};

const NAME_MIN = 2;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 2000;
const PHONE_INPUT_MAX = 32;

// Characters as a person counts them (an emoji is one, not two UTF-16 units).
const length = (text) => Array.from(text).length;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (value) => value === undefined || value === null;

// Care-level labels from every app language, to the key they stand for (NFC-normalised).
const LEGACY_CARE_LABEL_TO_KEY = new Map(
  Object.entries(CARE_LEVEL_LEGACY_LABELS).flatMap(([key, labels]) => labels.map((label) => [label.normalize('NFC'), key])),
);

// "YYYY-MM-DD" that is a real calendar day ("2026-02-30" is refused), or null.
function calendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  const real = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  return real ? value : null;
}

// `cities`: { origin, destination }, each the verified city for that field's { geonameId } or
// null/undefined when there is none. `now` is injectable for the timezone tests.
function validatePrivateCharterRequest(body, { now = Date.now(), cities = {} } = {}) {
  const fields = Object.create(null);
  const data = {};
  const legacy = [];
  const fail = (field, message) => { if (!(field in fields)) fields[field] = message; };

  // --- Fields that do not belong ------------------------------------------------------
  for (const key of Object.keys(body)) {
    if (ALLOWED_FIELDS.has(key)) continue;
    const shown = key.slice(0, 64);
    fail(shown, DECEASED_FIELDS.has(key)
      ? 'Deceased details are not accepted for Private Charter requests.'
      // Own-property check: `key` comes from the client ("__proto__" must not find anything).
      : Object.hasOwn(SPECIFIC_FIELD_MESSAGES, key) ? SPECIFIC_FIELD_MESSAGES[key] : 'This field is not accepted for Private Charter requests.');
  }

  // --- Service ------------------------------------------------------------------------
  data.serviceKey = PRIVATE_CHARTER_KEY;
  // The name comes from the backend. A client may omit it, but if it sends one it must match.
  if (!missing(body.serviceType) && body.serviceType !== PRIVATE_CHARTER_SERVICE_TYPE) {
    fail('serviceType', 'serviceType does not match the privatecharter service.');
  }
  data.serviceType = PRIVATE_CHARTER_SERVICE_TYPE;

  // --- Patient name -------------------------------------------------------------------
  if (missing(body.patientName) || body.patientName === '') {
    fail('patientName', 'Patient name is required.');
  } else if (typeof body.patientName !== 'string') {
    fail('patientName', 'Patient name must be text.');
  } else {
    const name = body.patientName.trim();
    if (length(name) < NAME_MIN || length(name) > NAME_MAX || !/\p{L}/u.test(name)) {
      fail('patientName', `Patient name must be ${NAME_MIN} to ${NAME_MAX} characters and contain a letter.`);
    } else {
      data.patientName = name;
    }
  }

  // --- Age: a whole number 1-120, as a JSON integer or a plain digit string -------------
  if (missing(body.patientAge) || body.patientAge === '') {
    fail('patientAge', 'Age is required.');
  } else {
    const raw = body.patientAge;
    let age = null;
    if (typeof raw === 'number' && Number.isInteger(raw)) age = raw;
    else if (typeof raw === 'string' && /^\d{1,3}$/.test(raw)) age = Number(raw);
    if (age === null || age < 1 || age > 120) fail('patientAge', 'Age must be a whole number from 1 to 120.');
    else data.patientAge = age;
  }

  // --- Gender -------------------------------------------------------------------------
  if (missing(body.patientGender) || body.patientGender === '') {
    fail('patientGender', 'Gender is required.');
  } else if (typeof body.patientGender === 'string' && GENDERS.includes(body.patientGender)) {
    data.patientGender = body.patientGender;
  } else if (typeof body.patientGender === 'string' && GENDERS.map((g) => g[0].toUpperCase() + g.slice(1)).includes(body.patientGender)) {
    // 90-day compatibility: older app builds send "Male" / "Female" / "Other".
    data.patientGender = body.patientGender.toLowerCase();
    legacy.push('patientGender');
  } else {
    fail('patientGender', `Gender must be one of: ${GENDERS.join(', ')}.`);
  }

  // --- Country: ISO 3166-1 alpha-2 ------------------------------------------------------
  if (missing(body.country) || body.country === '') {
    fail('country', 'Country is required.');
  } else if (typeof body.country === 'string' && ISO_COUNTRY_CODES.has(body.country)) {
    data.country = body.country;
  } else {
    fail('country', 'Country must be a two-letter ISO 3166-1 code, for example "AE".');
  }

  // --- Origin and destination: a verified city, picked from the list -----------------------
  // The body carries only { geonameId }. The label (what every other part of the system shows),
  // the name, the country code and (origin) the timezone come from the verified record.
  let originTimeZone = null;
  for (const field of ['origin', 'destination']) {
    const label = field === 'origin' ? 'Origin city' : 'Destination city';
    if (missing(body[field]) || body[field] === '') { fail(field, `${label} is required.`); continue; }
    const ref = readCityRef(body[field]);
    if (!ref.id) { fail(field, ref.problem); continue; }
    const city = cities[field];
    if (!city || city.geonameId !== ref.id) { fail(field, 'Select a valid city from the list.'); continue; }
    if (field === 'origin') {
      // The "no past date" rule runs in the origin city's own timezone: refuse a city without one.
      if (!isValidTimeZone(city.timezone)) { fail(field, 'This city cannot be used because its timezone is not available. Choose another city.'); continue; }
      originTimeZone = city.timezone;
      data.originTimezone = city.timezone;
    }
    data[field] = city.label;
    data[`${field}GeonameId`] = city.geonameId;
    data[`${field}CityName`] = city.name;
    data[`${field}CountryCode`] = city.countryCode;
  }

  // --- Contact number: stored as E.164 -------------------------------------------------
  if (missing(body.patientContact) || body.patientContact === '') {
    fail('patientContact', 'Contact number is required.');
  } else if (typeof body.patientContact !== 'string' || body.patientContact.length > PHONE_INPUT_MAX) {
    fail('patientContact', 'Enter a valid contact number in international format, for example +971501234567.');
  } else {
    const raw = body.patientContact.trim();
    // Needs the leading "+": a bare national number has no country to be checked against.
    const parsed = raw.startsWith('+') ? normalizeMobile(raw) : null;
    if (!parsed) {
      fail('patientContact', 'Enter a valid contact number in international format, for example +971501234567.');
    } else {
      data.patientContact = parsed.e164;
      // Older builds send "+971 501234567" (spaces); same number, recognised and normalised.
      if (raw !== parsed.e164) legacy.push('patientContact');
    }
  }

  // --- Preferred date ------------------------------------------------------------------
  // A calendar day. It must not be earlier than today's date in the origin city's own timezone
  // (the same instant is already tomorrow in Auckland and still yesterday in Los Angeles), and
  // today itself is allowed. Without a verified origin the day cannot be judged: the origin field
  // already carries that error, so only the format is checked. Stored as the day at 00:00 UTC in
  // a SQL DATE column, which keeps exactly this day.
  if (missing(body.preferredDate) || body.preferredDate === '') {
    fail('preferredDate', 'Preferred date is required.');
  } else if (typeof body.preferredDate !== 'string' || !calendarDate(body.preferredDate)) {
    fail('preferredDate', 'Preferred date must be a valid date in the form YYYY-MM-DD.');
  } else if (originTimeZone && body.preferredDate < todayInTimeZone(originTimeZone, now)) {
    fail('preferredDate', 'Preferred date cannot be in the past.');
  } else {
    data.preferredDate = body.preferredDate;
  }

  // --- Care level: keys; recognised translated labels during the compatibility period ----
  if (missing(body.careLevel) || body.careLevel === '' || (Array.isArray(body.careLevel) && !body.careLevel.length)) {
    fail('careLevel', 'Select at least one care level.');
  } else {
    // Older builds send one string: the labels joined with ", ".
    const items = Array.isArray(body.careLevel) ? body.careLevel : typeof body.careLevel === 'string' ? body.careLevel.split(',') : null;
    const keys = [];
    let usedLabel = false;
    let valid = items !== null;
    for (const item of items || []) {
      if (typeof item !== 'string') { valid = false; break; }
      const text = item.trim().normalize('NFC');
      if (CARE_LEVEL_KEYS.includes(text) && typeof body.careLevel !== 'string') keys.push(text);
      else if (LEGACY_CARE_LABEL_TO_KEY.has(text)) { keys.push(LEGACY_CARE_LABEL_TO_KEY.get(text)); usedLabel = true; }
      else { valid = false; break; }
    }
    if (!valid) fail('careLevel', `Care level must be a list of: ${CARE_LEVEL_KEYS.join(', ')}.`);
    else if (new Set(keys).size !== keys.length) fail('careLevel', 'Care level must not repeat a value.');
    else if (keys.includes(CARE_LEVEL_EXCLUSIVE) && keys.length > 1) fail('careLevel', 'Not applicable cannot be combined with another care level.');
    else {
      data.careLevel = keys.join(',');
      if (usedLabel || typeof body.careLevel === 'string') legacy.push('careLevel');
    }
  }

  // --- Medical description: optional; only the ends are trimmed -------------------------
  if (!missing(body.description)) {
    if (typeof body.description !== 'string') fail('description', 'Medical description must be text.');
    else if (body.description.includes('\u0000')) fail('description', 'Medical description contains an invalid character.');
    else {
      const text = body.description.trim();
      if (length(text) > DESCRIPTION_MAX) fail('description', `Medical description must be at most ${DESCRIPTION_MAX} characters.`);
      else if (text) data.description = text;
    }
  }

  // --- Mobility, urgency ---------------------------------------------------------------
  if (missing(body.mobility) || body.mobility === '') fail('mobility', 'Mobility is required.');
  else if (typeof body.mobility === 'string' && MOBILITY.includes(body.mobility)) data.mobility = body.mobility;
  else fail('mobility', `Mobility must be one of: ${MOBILITY.join(', ')}.`);

  if (missing(body.urgency) || body.urgency === '') fail('urgency', 'Urgency is required.');
  else if (typeof body.urgency === 'string' && URGENCY.includes(body.urgency)) data.urgency = body.urgency;
  else fail('urgency', `Urgency must be one of: ${URGENCY.join(', ')}.`);

  // --- Equipment: optional, strict booleans ----------------------------------------------
  for (const field of EQUIPMENT_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] === 'boolean') data[field] = body[field];
    else fail(field, 'This must be true or false.');
  }

  return { fields, data, legacy };
}

module.exports = { validatePrivateCharterRequest, isObject };
