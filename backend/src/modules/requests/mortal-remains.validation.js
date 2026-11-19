// Strict validation of a Mortal Remains Transportation request (serviceKey "mortal"). Pure: no database, no network. The controller calls it
// before anything is written and passes the returned `data` (never the raw body) on to createRequest, which stores it like any other request.
//
// What is stored, and where (existing columns are reused; only transfer_scope and transport_mode are new):
//   patient_name / patient_age / patient_gender    the DECEASED person
//   deceased_relation, place_of_death, date_of_death
//   transfer_scope ("domestic" | "international"), transport_mode ("private_charter" | "commercial_air_cargo" | "ground_transportation")
//   origin (current location), patient_location (the same text), destination, country, patient_contact, preferred_date, urgency
//   description  labelled lines, composed HERE so the existing Bitrix "Requirement" comment carries the scope and mode (Bitrix is not changed):
//                  Transfer Scope: International
//                  Transport Mode: Private Charter
//
//                  Additional Details: <the user's Details, only when entered>
// The app sends the user's own text as `details`; `description` and `patientLocation` are never accepted from the client.
//
// Dates are judged by the PATIENT's own calendar: the server has no time zone, so the app sends the device's UTC offset (utcOffsetMinutes, minutes
// east of UTC) and the server works out the patient's today from it (the same approach as Teleconsultation).
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { URGENCY } = require('../../common/constants/request.constants');

const MORTAL_SERVICE_KEY = 'mortal';
const MORTAL_SERVICE_TYPE = 'Mortal Remains Transportation';

const SCOPES = { domestic: 'Domestic', international: 'International' };
const MODES = { private_charter: 'Private Charter', commercial_air_cargo: 'Commercial Air Cargo', ground_transportation: 'Ground Transportation' };
const GENDERS = { male: 'Male', female: 'Female', other: 'Other' };
const RELATIONS = ['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Son', 'Daughter', 'Friend', 'Other'];

const COLUMN_MAX = 191; // origin, destination, place_of_death, deceased_relation ... are VARCHAR(191)
const COUNTRY_MAX = 100;
const DETAILS_MAX = 2000;
const NAME_MIN = 2;
const NAME_MAX = 100;
const AGE_MAX = 129;
const OFFSET_MIN = -720;
const OFFSET_MAX = 840;

const ALLOWED_FIELDS = new Set([
  'serviceType', 'serviceKey', 'transferScope', 'transportMode',
  'patientName', 'patientAge', 'patientGender', 'deceasedRelation', 'placeOfDeath', 'dateOfDeath',
  'country', 'origin', 'destination', 'patientContact', 'preferredDate', 'details', 'urgency', 'utcOffsetMinutes',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (value) => value === undefined || value === null;
// Characters as a person (and MySQL) counts them: an emoji is one, not two UTF-16 units.
const length = (text) => Array.from(text).length;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// The Unicode line and paragraph separators, by code point so this source stays plain ASCII.
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const hasLineBreak = (text) => /[\n\r]/.test(text) || text.includes(SEPARATORS[0]) || text.includes(SEPARATORS[1]);
const toLF = (text) => text.replace(/\r\n?/g, '\n').split(SEPARATORS[0]).join('\n').split(SEPARATORS[1]).join('\n');

// True for the single key the app sends now.
const isMortalKey = (serviceKey) => serviceKey === MORTAL_SERVICE_KEY;
// True for any Mortal Remains request, new ("mortal") or an older stored one ("mortal_domestic", "mortal_international"): the same pattern the rest
// of the system (Bitrix routing, the app) uses. Older rows must keep being treated as Mortal Remains (display, uploads).
const isMortalRequestKey = (serviceKey) => /^mortal(_|$)/.test(serviceKey || '');
// The two keys older app builds sent; new requests with them are refused.
const OLD_MORTAL_KEYS = ['mortal_domestic', 'mortal_international'];

// ---- dates -----------------------------------------------------------------------------------------------------------------------------------
// "YYYY-MM-DD" that is a real calendar day ("2026-02-30" is refused), or null.
function calendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  const real = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  return real ? value : null;
}

// The patient's own today ("YYYY-MM-DD"): the moment `now` seen on a clock `utcOffsetMinutes` minutes east of UTC.
function patientToday(now, utcOffsetMinutes) {
  return new Date(now.getTime() + utcOffsetMinutes * 60000).toISOString().slice(0, 10);
}

// ---- fields ----------------------------------------------------------------------------------------------------------------------------------
// A required single-line text of at most `max` characters: { value } or { error }.
function line(body, field, max) {
  const raw = body[field];
  if (typeof raw !== 'string') return { error: `${field} is required` };
  const value = raw.trim();
  if (!value) return { error: `${field} is required` };
  if (CONTROL.test(value) || hasLineBreak(value)) return { error: `${field} contains characters that are not allowed` };
  if (length(value) > max) return { error: `${field} can be at most ${max} characters` };
  return { value };
}

// "Transfer Scope: ...", "Transport Mode: ...", then the user's Details when there are any.
function composeDescription({ scope, mode, details }) {
  const head = `Transfer Scope: ${SCOPES[scope]}\nTransport Mode: ${MODES[mode]}`;
  return details ? `${head}\n\nAdditional Details: ${details}` : head;
}

// The user's own Details out of a stored Mortal Remains description: what follows "Additional Details: " when the description starts with the
// backend-composed scope and mode header, so a screen showing the scope and mode as their own rows does not repeat them. A description without that
// header (an older request) is returned as it is. '' when there are no Details.
const HEADER = /^Transfer Scope: [^\n]*\nTransport Mode: [^\n]*(?:\n\nAdditional Details: ([\s\S]*))?$/;
function userDetailsOf(description) {
  if (typeof description !== 'string') return '';
  const match = HEADER.exec(description);
  if (!match) return description;
  return match[1] || '';
}

// Returns { error } (the first problem) or { data } for createRequest.
function validateMortalRequest(body, { now = new Date() } = {}) {
  if (!isObject(body)) return { error: 'The request body must be a JSON object.' };

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) return { error: `${key} is not accepted for Mortal Remains requests` };
  }
  if (body.serviceKey !== MORTAL_SERVICE_KEY) return { error: 'serviceKey must be "mortal" for Mortal Remains requests' };
  if (body.serviceType !== MORTAL_SERVICE_TYPE) return { error: `serviceType must be "${MORTAL_SERVICE_TYPE}" for Mortal Remains requests` };

  if (typeof body.transferScope !== 'string' || !Object.hasOwn(SCOPES, body.transferScope)) {
    return { error: `transferScope must be one of: ${Object.keys(SCOPES).join(', ')}` };
  }
  if (typeof body.transportMode !== 'string' || !Object.hasOwn(MODES, body.transportMode)) {
    return { error: `transportMode must be one of: ${Object.keys(MODES).join(', ')}` };
  }

  // The deceased
  if (typeof body.patientName !== 'string') return { error: 'patientName is required' };
  const name = body.patientName.trim();
  if (CONTROL.test(name) || hasLineBreak(name)) return { error: 'patientName contains characters that are not allowed' };
  if (length(name) < NAME_MIN || length(name) > NAME_MAX || !/\p{L}/u.test(name)) return { error: `patientName must be ${NAME_MIN} to ${NAME_MAX} characters and include a letter` };

  const ageText = typeof body.patientAge === 'number' ? String(body.patientAge) : body.patientAge;
  if (typeof ageText !== 'string' || !/^\d{1,3}$/.test(ageText.trim()) || Number(ageText) > AGE_MAX) {
    return { error: `patientAge must be a whole number from 0 to ${AGE_MAX}` };
  }
  const age = Number(ageText);

  const gender = typeof body.patientGender === 'string' ? GENDERS[body.patientGender.trim().toLowerCase()] : undefined;
  if (!gender) return { error: 'patientGender must be Male, Female or Other' };

  if (typeof body.deceasedRelation !== 'string' || !RELATIONS.includes(body.deceasedRelation.trim())) {
    return { error: `deceasedRelation must be one of: ${RELATIONS.join(', ')}` };
  }
  const relation = body.deceasedRelation.trim();

  const place = line(body, 'placeOfDeath', COLUMN_MAX);
  if (place.error) return { error: place.error };
  const country = line(body, 'country', COUNTRY_MAX);
  if (country.error) return { error: country.error };
  const origin = line(body, 'origin', COLUMN_MAX);
  if (origin.error) return { error: origin.error };
  const destination = line(body, 'destination', COLUMN_MAX);
  if (destination.error) return { error: destination.error };

  const phone = typeof body.patientContact === 'string' && body.patientContact.trim().startsWith('+') ? parsePhoneNumberFromString(body.patientContact.trim()) : null;
  if (!phone || !phone.isValid()) return { error: 'patientContact must be a valid phone number with its country code' };

  if (typeof body.urgency !== 'string' || !URGENCY.includes(body.urgency)) return { error: `urgency is required. Use one of: ${URGENCY.join(', ')}` };

  // Details: optional
  let details = '';
  if (!missing(body.details)) {
    if (typeof body.details !== 'string') return { error: 'details must be text' };
    if (CONTROL.test(body.details)) return { error: 'details contains characters that are not allowed' };
    details = toLF(body.details).trim();
    if (length(details) > DETAILS_MAX) return { error: `details can be at most ${DETAILS_MAX} characters` };
  }

  // Dates, by the patient's own calendar
  if (!Number.isInteger(body.utcOffsetMinutes) || body.utcOffsetMinutes < OFFSET_MIN || body.utcOffsetMinutes > OFFSET_MAX) {
    return { error: `utcOffsetMinutes is required: a whole number of minutes from ${OFFSET_MIN} to ${OFFSET_MAX} (minutes east of UTC)` };
  }
  const today = patientToday(now, body.utcOffsetMinutes);

  if (typeof body.dateOfDeath !== 'string' || !calendarDate(body.dateOfDeath)) return { error: 'dateOfDeath must be a valid date (YYYY-MM-DD)' };
  if (body.dateOfDeath > today) return { error: 'dateOfDeath cannot be in the future' };

  if (typeof body.preferredDate !== 'string' || !calendarDate(body.preferredDate)) return { error: 'preferredDate must be a valid date (YYYY-MM-DD)' };
  if (body.preferredDate < today) return { error: 'preferredDate cannot be in the past' };

  return {
    data: {
      serviceType: MORTAL_SERVICE_TYPE,
      serviceKey: MORTAL_SERVICE_KEY,
      transferScope: body.transferScope,
      transportMode: body.transportMode,
      patientName: name,
      patientAge: age,
      patientGender: gender,
      deceasedRelation: relation,
      placeOfDeath: place.value,
      dateOfDeath: body.dateOfDeath,
      country: country.value,
      origin: origin.value,
      patientLocation: origin.value,
      destination: destination.value,
      patientContact: phone.formatInternational(),
      preferredDate: body.preferredDate,
      urgency: body.urgency,
      description: composeDescription({ scope: body.transferScope, mode: body.transportMode, details }),
    },
  };
}

module.exports = {
  MORTAL_SERVICE_KEY, MORTAL_SERVICE_TYPE, SCOPES, MODES, GENDERS, RELATIONS, OLD_MORTAL_KEYS, DETAILS_MAX,
  isMortalKey, isMortalRequestKey, validateMortalRequest, composeDescription, userDetailsOf, patientToday, calendarDate,
};
