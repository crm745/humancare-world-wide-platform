// Strict validation of a Private Charter Air Ambulance request (serviceKey "privatecharter").
// Pure: no database, no network. The controller calls it before anything is written, and
// passes the returned `data` (never the raw body) on to createRequest.
//
// Every problem is reported at once, keyed by the API field name:
//   { fields: { patientAge: 'Age must be a whole number from 1 to 120.', ... }, data, legacy }
// `data` is only meaningful when `fields` is empty.
//
// Cities: origin and destination are either a { geonameId } selection or a manually entered { name,
// countryCode? } (GeoNames has no match). The caller looks each id up in the local GeoNames table first
// (geo.service#resolveCityRefs) and passes the verified cities in as `cities`; this file never trusts a
// name, country or timezone sent with a geonameId. A manual city is stored as typed (cleaned), with no
// GeoNames id, no timezone, and the country the person gave (an origin falls back to the request's country).
//
// Not covered here, on purpose: documents, Bitrix and encryption.
const { COUNTRIES } = require('../../common/constants/countries');
const { normalizeMobile } = require('../../common/utils/phone');
const { isValidTimeZone, todayInTimeZone } = require('../../common/utils/local-date');
const { readCityRef } = require('../geo/city-ref');
const {
  GENDERS, TRAVEL_TYPES, CRITICAL_LEVELS, OXYGEN_FLOW_MIN, OXYGEN_FLOW_MAX,
  PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE,
} = require('../../common/constants/request.constants');

const ISO_COUNTRY_CODES = new Set(COUNTRIES.map((country) => country.code));

// Fields a Private Charter request may carry. Anything else is refused, not dropped.
// `patientLocation` is not one of them: it only repeated `origin`, so it is refused (see
// SPECIFIC_FIELD_MESSAGES) instead of being stored twice.
const ALLOWED_FIELDS = new Set([
  'serviceKey', 'serviceType', 'patientName', 'patientAge', 'patientGender', 'patientContact',
  'country', 'origin', 'destination', 'preferredDate', 'travelType', 'description', 'criticalLevel',
  'oxygenRequired', 'oxygenFlowLpm',
]);
const DECEASED_FIELDS = new Set(['deceasedRelation', 'placeOfDeath', 'dateOfDeath']);
const SPECIFIC_FIELD_MESSAGES = {
  patientLocation: 'Location is not accepted for Private Charter requests; send the origin city as origin.',
  careLevel: 'Care level is no longer accepted for Private Charter requests; send criticalLevel.',
  mobility: 'Mobility is no longer accepted for Private Charter requests.',
  urgency: 'Urgency is no longer accepted for Private Charter requests.',
  equipOxygen: 'Send oxygenRequired (and oxygenFlowLpm) instead of equipOxygen.',
  equipCardiacMonitor: 'On-board equipment is no longer accepted for Private Charter requests.',
  equipVentilator: 'On-board equipment is no longer accepted for Private Charter requests.',
};

const NAME_MIN = 2;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 2000;
const PHONE_INPUT_MAX = 32;

// Characters as a person counts them (an emoji is one, not two UTF-16 units).
const length = (text) => Array.from(text).length;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (value) => value === undefined || value === null;

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

  // --- Origin and destination: a verified city picked from the list, or one entered by hand --
  // A picked city carries only { geonameId }: the label (what every other part of the system shows),
  // the name, the country code and (origin) the timezone come from the verified record. A manual city
  // is { name, countryCode? }: stored with no geonameId and no timezone.
  let originTimeZone = null;
  let originManual = false;
  for (const field of ['origin', 'destination']) {
    const label = field === 'origin' ? 'Origin city' : 'Destination city';
    if (missing(body[field]) || body[field] === '') { fail(field, `${label} is required.`); continue; }
    const ref = readCityRef(body[field]);
    if (ref.manual) {
      // Country context: the one given with the city; else, for the origin (which is held to the request's country), that country.
      // A destination may be in any country, so it never borrows the request's.
      const code = ref.manual.countryCode || (field === 'origin' && typeof body.country === 'string' && ISO_COUNTRY_CODES.has(body.country) ? body.country : null);
      const countryName = code ? (COUNTRIES.find((country) => country.code === code) || {}).name : null;
      data[field] = countryName ? `${ref.manual.name}, ${countryName}` : ref.manual.name;
      data[`${field}CityName`] = ref.manual.name;
      data[`${field}CountryCode`] = code;
      if (field === 'origin') originManual = true;
      continue;
    }
    if (!ref.id) { fail(field, ref.problem); continue; }
    const city = cities[field];
    if (!city || city.geonameId !== ref.id) { fail(field, 'Select a valid city from the list, or enter the city name.'); continue; }
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
  } else if (originManual && body.preferredDate < todayInTimeZone('Etc/GMT+12', now)) {
    // A manual city has no timezone: judge against the westernmost one (UTC-12), so no real local "today" is ever refused.
    fail('preferredDate', 'Preferred date cannot be in the past.');
  } else {
    data.preferredDate = body.preferredDate;
  }

  // --- Travel type: one of the allowed keys, required -----------------------------------
  if (missing(body.travelType) || body.travelType === '') fail('travelType', 'Travel type is required.');
  else if (typeof body.travelType === 'string' && TRAVEL_TYPES.includes(body.travelType)) data.travelType = body.travelType;
  else fail('travelType', `Travel type must be one of: ${TRAVEL_TYPES.join(', ')}.`);

  // --- Medical history (stored in `description`): optional; only the ends are trimmed -----
  if (!missing(body.description)) {
    if (typeof body.description !== 'string') fail('description', 'Medical history must be text.');
    else if (body.description.includes('\u0000')) fail('description', 'Medical history contains an invalid character.');
    else {
      const text = body.description.trim();
      if (length(text) > DESCRIPTION_MAX) fail('description', `Medical history must be at most ${DESCRIPTION_MAX} characters.`);
      else if (text) data.description = text;
    }
  }

  // --- Critical level: a list of one or more choices, no repeats ---------------------------
  // Always an array (a bare string is refused). Returned in the order of the form, whatever the order sent.
  const levels = body.criticalLevel;
  if (missing(levels) || levels === '' || (Array.isArray(levels) && levels.length === 0)) {
    fail('criticalLevel', 'Select at least one critical level.');
  } else if (!Array.isArray(levels)) {
    fail('criticalLevel', 'Critical level must be a list of one or more choices.');
  } else if (levels.length > CRITICAL_LEVELS.length) {
    fail('criticalLevel', `Critical level can have at most ${CRITICAL_LEVELS.length} choices.`);
  } else if (levels.some((level) => typeof level !== 'string' || !CRITICAL_LEVELS.includes(level))) {
    fail('criticalLevel', `Critical level must only contain: ${CRITICAL_LEVELS.join(', ')}.`);
  } else if (new Set(levels).size !== levels.length) {
    fail('criticalLevel', 'Critical level must not repeat a choice.');
  } else {
    data.criticalLevel = CRITICAL_LEVELS.filter((level) => levels.includes(level));
  }

  // --- Oxygen: Yes/No is required; the flow rate (litres per minute) only with Yes -------------
  if (typeof body.oxygenRequired !== 'boolean') {
    fail('oxygenRequired', missing(body.oxygenRequired) ? 'Oxygen required is required.' : 'Oxygen required must be true or false.');
  } else {
    data.oxygenRequired = body.oxygenRequired;
    const flow = body.oxygenFlowLpm;
    if (body.oxygenRequired) {
      const whole = typeof flow === 'number' ? flow : typeof flow === 'string' && /^\d{1,3}$/.test(flow) ? Number(flow) : NaN;
      if (missing(flow) || flow === '') fail('oxygenFlowLpm', 'Oxygen flow rate (LPM) is required when oxygen is required.');
      else if (!Number.isInteger(whole) || whole < OXYGEN_FLOW_MIN || whole > OXYGEN_FLOW_MAX) {
        fail('oxygenFlowLpm', `Oxygen flow rate must be a whole number from ${OXYGEN_FLOW_MIN} to ${OXYGEN_FLOW_MAX} LPM.`);
      } else data.oxygenFlowLpm = whole;
    } else if (!missing(flow) && flow !== '') {
      // Refused, not dropped: a rate with "No oxygen" is contradictory.
      fail('oxygenFlowLpm', 'Oxygen flow rate must not be sent when oxygen is not required.');
    }
  }

  return { fields, data, legacy };
}

module.exports = { validatePrivateCharterRequest, isObject };
