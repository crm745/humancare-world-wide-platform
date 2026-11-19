import { isValidMobileNumber, isValidName } from './validators';
import { codePointLength, contactNumber, dateToString, stringToDate } from './teleConsultation';
import { locationProblems } from './locationRules';

// Pure rules of the Mortal Remains request (no React, no native modules), kept apart so they can be unit-tested: which options exist, what is
// valid, the dates, what is sent, and how a request made in the new format is told from an older one.
//
// The service is "Mortal Remains Transportation", key "mortal". Two independent choices (Transfer Scope and Transport Mode, six combinations) are
// sent as their own fields. The SERVER derives the stored description (it starts with the scope and mode so Bitrix's Requirement line carries
// them). See backend/src/modules/requests/mortal-remains.validation.js, which is the contract: this file only builds what it expects and never
// relaxes it.

export const MORTAL_SERVICE_KEY = 'mortal';
// Must equal the service title in data/services.json and the backend constant.
export const MORTAL_SERVICE_TYPE = 'Mortal Remains Transportation';
export const isMortalService = (serviceKey) => serviceKey === MORTAL_SERVICE_KEY;
// Any Mortal Remains request, new ("mortal") or an older stored one ("mortal_domestic", "mortal_international"): the same pattern the rest of the
// system uses.
export const isMortalRequestKey = (serviceKey) => /^mortal(_|$)/.test(String(serviceKey || ''));

export const MORTAL_SCOPES = ['domestic', 'international'];
export const MORTAL_MODES = ['private_charter', 'commercial_air_cargo', 'ground_transportation'];
// i18n keys of what each option says on screen.
export const MORTAL_SCOPE_LABEL_KEYS = { domestic: 'mortal_scope_domestic', international: 'mortal_scope_international' };
export const MORTAL_MODE_LABEL_KEYS = {
  private_charter: 'mortal_mode_private_charter',
  commercial_air_cargo: 'mortal_mode_commercial_air_cargo',
  ground_transportation: 'mortal_mode_ground_transportation',
};
export const MORTAL_GENDERS = ['Male', 'Female', 'Other'];
export const MORTAL_RELATIONS = ['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Son', 'Daughter', 'Friend', 'Other'];

export const AGE_MAX = 129;
export const PLACE_MAX = 191; // the server's column limits (VARCHAR(191))
export const DETAILS_MAX = 2000;

// Age: a whole number from 0 to 129, zero included (the form's general age rule refuses 0; a newborn can be the deceased).
export function isValidMortalAge(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d{1,3}$/.test(text)) return false;
  return Number(text) <= AGE_MAX;
}

// ---- dates, by the person's own calendar --------------------------------------------------------------------------------------------------------
// Today as "YYYY-MM-DD" by the device's LOCAL calendar (what the date picker uses and what the server works out from the UTC offset we send).
export const todayString = (now = new Date()) => dateToString(now);
export const todayDate = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

// Date of Death: a real day, today or earlier.
export function isValidDeathDate(value, now = new Date()) {
  const text = String(value || '').trim();
  return stringToDate(text) !== null && text <= todayString(now);
}
// Preferred Transfer Date: a real day, today or later.
export function isValidTransferDate(value, now = new Date()) {
  const text = String(value || '').trim();
  return stringToDate(text) !== null && text >= todayString(now);
}

const tooLong = (text, max) => codePointLength(String(text || '').trim()) > max;

// ---- what is wrong, in page order ---------------------------------------------------------------------------------------------------------------
// Each is [anchor id, wrong?]; the first wrong one is where the page scrolls to.
export function mortalStep1Problems(d, now = new Date()) {
  const places = locationProblems(d, false);
  return [
    ['scope', !MORTAL_SCOPES.includes(d.transferScope)],
    ['mode', !MORTAL_MODES.includes(d.transportMode)],
    ['name', !isValidName(d.name)],
    ['age', !isValidMortalAge(d.age) || !MORTAL_GENDERS.includes(d.gender)],
    ['relation', !MORTAL_RELATIONS.includes(d.relation)],
    ['deathPlace', !String(d.deathPlace || '').trim() || tooLong(d.deathPlace, PLACE_MAX)],
    ['deathDate', !isValidDeathDate(d.deathDate, now)],
    ['country', !d.country],
    ['phone', !isValidMobileNumber(d.phone, d.cc)],
    ['location', places.location !== null || tooLong(d.location, PLACE_MAX)],
    ['dest', places.dest !== null || tooLong(d.dest, PLACE_MAX)],
    ['date', !isValidTransferDate(d.date, now)],
  ];
}

export function mortalStep2Problems(d) {
  return [
    ['desc', tooLong(d.desc, DETAILS_MAX)],
    ['urgency', !d.urgency],
  ];
}

// ---- what is sent -------------------------------------------------------------------------------------------------------------------------------
const hasText = (value) => String(value == null ? '' : value).trim() !== '';

// The body of POST /requests for a Mortal Remains request. `patientName` / `patientAge` / `patientGender` are the DECEASED person's. The user's
// own text goes as `details` (the server composes the stored description); no `description`, `patientLocation` or any patient-transport field is
// sent, because the server refuses them. `now` is the moment the request is built (a test passes its own; a real clock otherwise).
export function buildMortalPayload(draft, now = new Date()) {
  const d = draft || {};
  return {
    serviceType: MORTAL_SERVICE_TYPE,
    serviceKey: MORTAL_SERVICE_KEY,
    transferScope: d.transferScope,
    transportMode: d.transportMode,
    patientName: d.name,
    patientAge: Number(String(d.age).trim()),
    patientGender: d.gender,
    deceasedRelation: d.relation,
    placeOfDeath: d.deathPlace,
    dateOfDeath: d.deathDate,
    country: d.country,
    origin: d.location,
    destination: d.dest,
    patientContact: contactNumber(d.cc, d.phone),
    preferredDate: d.date,
    urgency: d.urgency,
    // The device's UTC offset (minutes EAST of UTC; JavaScript reports it the other way round), read from the same moment as the date pickers'
    // "today". The server works out the person's own today from it, so "today or earlier / later" means the same day on the phone and there.
    utcOffsetMinutes: 0 - now.getTimezoneOffset(),
    ...(hasText(d.desc) ? { details: d.desc } : {}),
  };
}

// ---- older and newer requests -------------------------------------------------------------------------------------------------------------------
// A request made in the new format has its scope in its own field; an older one carries it only as the suffix of its service key.
export const hasScopeAndMode = (request) => !!request && !!request.transferScope && !!request.transportMode;

// Details as the person typed them. A new request's stored description starts with the composed scope and mode lines (for Bitrix); a screen that
// shows those as their own rows shows only what follows "Additional Details: ". A description without the header (an older request) is returned as it is.
// Mirrors userDetailsOf in backend/src/modules/requests/mortal-remains.validation.js.
const HEADER = /^Transfer Scope: [^\n]*\nTransport Mode: [^\n]*(?:\n\nAdditional Details: ([\s\S]*))?$/;
export function userDetailsOf(description) {
  if (typeof description !== 'string') return '';
  const match = HEADER.exec(description);
  if (!match) return description;
  return match[1] || '';
}
