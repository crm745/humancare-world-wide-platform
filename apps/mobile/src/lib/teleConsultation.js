import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { isValidMobileNumber, isValidName } from './validators';

// Pure rules of the Teleconsultation request (no React, no native modules), kept apart so they can be unit-tested: which options exist, what is
// valid, the date the visit can be asked for, what is sent, and how an older request is told from a new one.
//
// The service is "Tele Consultation & House Call", key "tele" (unchanged). Four combinations of Scope and Consultation Type share that one key.
// The app sends the answers as structured fields and the address once, as typed; the SERVER derives what is stored (the one-line address fields
// and the labelled description). See backend/src/modules/requests/tele-consultation.validation.js, which is the contract: this file only
// builds what it expects and never relaxes it.

export const TELE_SERVICE_KEY = 'tele';
// Must equal the service title in data/services.json and the backend constant.
export const TELE_SERVICE_TYPE = 'Tele Consultation & House Call';
export const isTeleService = (serviceKey) => serviceKey === TELE_SERVICE_KEY;

export const TELE_SCOPES = ['domestic', 'international'];
export const TELE_TYPES = ['online', 'house_call'];
// i18n keys of what each option says on screen.
export const TELE_SCOPE_LABEL_KEYS = { domestic: 'tele_scope_domestic', international: 'tele_scope_international' };
export const TELE_TYPE_LABEL_KEYS = { online: 'tele_type_online', house_call: 'tele_type_house_call' };

export const ADDRESS_MAX = 2000;
export const TEXT_MAX = 2000;
export const AGE_MAX = 129;

export const isHouseCall = (draft) => !!draft && draft.teleType === 'house_call';
// Domestic / International is asked, required and sent for a House Call only. An Online Consultation has no Scope.
export const asksScope = isHouseCall;

// Characters as a person counts them (an emoji is one, not two UTF-16 units), the same as the server.
export const codePointLength = (text) => Array.from(String(text == null ? '' : text)).length;

// Age: a whole number from 0 to 129, zero included (the form's general age rule refuses 0; a newborn can be a patient).
export function isValidTeleAge(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d{1,3}$/.test(text)) return false;
  return Number(text) <= AGE_MAX;
}

// ---- the visit date -----------------------------------------------------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
// A Date as "YYYY-MM-DD" by its LOCAL calendar day (what the person sees on the picker).
export const dateToString = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// "YYYY-MM-DD" that is a real calendar day, as a local Date at midnight; null when it is not.
export function stringToDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

// The earliest day a House Call can be asked for: tomorrow, by the person's own calendar. Today and every past day are not offered.
export function tomorrowString(now = new Date()) {
  return dateToString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
}
export const tomorrowDate = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

export function isValidVisitDate(value, now = new Date()) {
  const text = String(value || '').trim();
  return stringToDate(text) !== null && text >= tomorrowString(now);
}

// ---- what is wrong, in page order -----------------------------------------------------------------------------------------------------------
// Each is [anchor id, wrong?]; the first wrong one is where the page scrolls to.
export function teleStep1Problems(d) {
  return [
    ['type', !TELE_TYPES.includes(d.teleType)],
    // The Scope is asked for a House Call only (an Online Consultation has none), so it is only required then.
    ['scope', asksScope(d) && !TELE_SCOPES.includes(d.teleScope)],
    ['name', !isValidName(d.name)],
    ['age', !isValidTeleAge(d.age) || !d.gender],
    ['country', !d.country],
    ['phone', !isValidMobileNumber(d.phone, d.cc)],
    ['address', !String(d.address || '').trim() || codePointLength(d.address) > ADDRESS_MAX],
  ];
}

export function teleStep2Problems(d, now = new Date()) {
  return [
    ['issue', codePointLength(d.desc) > TEXT_MAX],
    ['allergies', codePointLength(d.allergies) > TEXT_MAX],
    ['visitDate', isHouseCall(d) && !isValidVisitDate(d.date, now)],
  ];
}

// ---- what is sent ----------------------------------------------------------------------------------------------------------------------------
// The contact number the way the server stores it ("+91 98765 43210"): the calling code and the number as typed, with the trunk zero dropped by
// the country's own rules. If it cannot be read (the form does not let that through) it is sent as typed and the server decides.
export function contactNumber(callingCode, nationalNumber) {
  const cc = String(callingCode || '').replace(/\D/g, '');
  const digits = String(nationalNumber || '').replace(/\D/g, '');
  const parsed = cc && digits ? parsePhoneNumberFromString(`+${cc}${digits}`) : null;
  return parsed && parsed.isValid() ? parsed.formatInternational() : `${callingCode} ${nationalNumber}`.trim();
}

const hasText = (value) => String(value == null ? '' : value).trim() !== '';

// The body of POST /requests for a Teleconsultation. Only what the structured format carries: no origin, destination, description, urgency,
// care level, equipment or files. The visit date is null for an Online Consultation. The two notes are left out when empty. `now` is the moment the
// request is built (a test passes its own; a real clock otherwise).
export function buildTelePayload(draft, now = new Date()) {
  const d = draft || {};
  return {
    serviceType: TELE_SERVICE_TYPE,
    serviceKey: TELE_SERVICE_KEY,
    // Only a House Call has a Scope: an Online Consultation sends none.
    ...(asksScope(d) ? { consultationScope: d.teleScope } : {}),
    consultationType: d.teleType,
    patientName: d.name,
    patientAge: Number(String(d.age).trim()),
    patientGender: d.gender,
    country: d.country,
    patientContact: contactNumber(d.cc, d.phone),
    currentAddress: d.address,
    preferredDate: isHouseCall(d) ? d.date : null,
    // The device's UTC offset (minutes EAST of UTC; JavaScript reports it the other way round), read from the same moment as the date picker's "today".
    // The server works out the patient's own today from it, so "tomorrow or later" means the same day on the phone and on the server.
    utcOffsetMinutes: 0 - now.getTimezoneOffset(),
    ...(hasText(d.desc) ? { presentMedicalIssue: d.desc } : {}),
    ...(hasText(d.allergies) ? { allergyDetails: d.allergies } : {}),
  };
}

// ---- older and newer requests ------------------------------------------------------------------------------------------------------------------
const baseKey = (request) => String((request && request.serviceKey) || '').split('_')[0];

// A Teleconsultation request made in the new format: its destination is empty. Every older one has a destination (the old form and the API
// required one), so they keep their Trip, their urgency and their wording. Works on a request from the API and on a list item.
export function isNewTeleRequest(request) {
  return baseKey(request) === TELE_SERVICE_KEY && !String((request && request.destination) || '').trim();
}
