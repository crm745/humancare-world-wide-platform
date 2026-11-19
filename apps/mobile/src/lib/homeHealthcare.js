import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { isValidMobileNumber, isValidName } from './validators';
import { OXYGEN_LPM_MAX, parseOxygenLpm } from './requestForm';

// Pure rules of the Home Healthcare Services request (no React, no native modules), kept apart so they can be unit-tested: what is valid, what is sent,
// how the server's composed description is read back, and how a NEW-format request is told from a legacy one.
//
// Self-contained on purpose: it imports nothing from the Teleconsultation or Mortal Remains libraries (own date helpers, own contact formatter, own
// description parser). Its server counterpart is backend/src/modules/requests/home-healthcare.validation.js, which is the contract; this file only builds
// what that expects and never relaxes it. Both parsers are checked against the same golden vectors (backend/tests/fixtures/home-healthcare-vectors.json).

export const HOME_SERVICE_KEY = 'homecare';
// Must equal the service title in data/services.json and the backend constant.
export const HOME_SERVICE_TYPE = 'Home Healthcare Services';
export const isHomeService = (serviceKey) => serviceKey === HOME_SERVICE_KEY;

// The only options. i18n keys of what each says on screen.
export const CARETAKER_KEYS = ['nurse', 'caretaker'];
export const CARETAKER_LABEL_KEYS = { nurse: 'caretaker_nurse', caretaker: 'caretaker_caretaker' };
export const HOURS_KEYS = ['12_hours', '24_hours'];
export const HOURS_LABEL_KEYS = { '12_hours': 'care_hours_12', '24_hours': 'care_hours_24' };
export const LEVEL_KEYS = ['full_icu', 'semi_icu'];
export const LEVEL_LABEL_KEYS = { full_icu: 'home_level_full_icu', semi_icu: 'home_level_semi_icu' };
// The Care Level is stored (and sent to Bitrix) as this English text; older rows and the PDF read it the same way.
export const LEVEL_STORED = { full_icu: 'Full ICU', semi_icu: 'Semi ICU' };
export const LEVEL_FROM_STORED = { 'Full ICU': 'home_level_full_icu', 'Semi ICU': 'home_level_semi_icu' };
export const GENDERS = ['Male', 'Female', 'Other'];

export const TEXT_MAX = 2000; // Unicode code points (what the person sees in the counter) for the address and for Medical History
export const FRAME_MAX = 4000; // the largest UTF-16 framing length the parser accepts (2,000 code points are at most 4,000 code units)
export const AGE_MIN = 1;
export const AGE_MAX = 129;
export { OXYGEN_LPM_MAX };

// Characters as a person counts them (an emoji is one, not two UTF-16 units): the patient-facing limit. The server counts the same way.
export const codePointLength = (text) => Array.from(String(text == null ? '' : text)).length;

// ---- the character rules for free text -----------------------------------------------------------------------------------------------------------
// The same rules as the server, as the same explicit code-unit loops. Rejected: every control character (Unicode category Cc) EXCEPT TAB, LF and CR
// (U+0000-0008, U+000B, U+000C, U+000E-001F, DEL, U+0080-009F) and unpaired surrogates. Everything else (Unicode separators, zero-width and
// bidirectional format characters, emoji and ZWJ sequences, combining marks, every script) is accepted and kept as typed.
export function hasDisallowedControl(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
    if (c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}
export function hasUnpairedSurrogate(text) {
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
// What is wrong with a free-text value, or null: 'required' (empty or whitespace only; judged on a trimmed copy, the text itself is never trimmed),
// 'characters' (a character that cannot be saved) or 'too_long' (more than 2,000 code points).
export function freeTextProblem(value, { required } = {}) {
  const text = value == null ? '' : String(value);
  if (required && text.trim() === '') return 'required';
  if (hasDisallowedControl(text) || hasUnpairedSurrogate(text)) return 'characters';
  if (codePointLength(text) > TEXT_MAX) return 'too_long';
  return null;
}

// Age: a whole number from 1 to 129 (the existing rule), required here.
export function isValidHomeAge(value) {
  const text = String(value == null ? '' : value).trim();
  return /^[1-9]\d{0,2}$/.test(text) && Number(text) <= AGE_MAX;
}

// ---- the Service Date, by the person's own calendar ---------------------------------------------------------------------------------------------
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
export const todayString = (now = new Date()) => dateToString(now);
export const todayDate = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate());
// The Service Date: a real day, today or later.
export function isValidServiceDate(value, now = new Date()) {
  const text = String(value || '').trim();
  return stringToDate(text) !== null && text >= todayString(now);
}

// ---- the Oxygen flow rate ------------------------------------------------------------------------------------------------------------------------------
// Only asked when Oxygen is Yes, and then required. null = nothing wrong (not asked, or fine); 'required'; 'invalid' (not 0 < n <= 15, one decimal).
export function homeOxygenProblem(draft) {
  if (!draft || draft.homeOxygen !== 'yes') return null;
  if (!String(draft.oxygenLpm == null ? '' : draft.oxygenLpm).trim()) return 'required';
  return parseOxygenLpm(draft.oxygenLpm) === null ? 'invalid' : null;
}

// ---- what is wrong, in page order ---------------------------------------------------------------------------------------------------------------------
// Each is [anchor id, wrong?]; the first wrong one is where the page scrolls to.
export function homeStep1Problems(d, now = new Date()) {
  return [
    ['name', !isValidName(d.name)],
    ['age', !isValidHomeAge(d.age) || !GENDERS.includes(d.gender)],
    ['country', !d.country],
    ['phone', !isValidMobileNumber(d.phone, d.cc)],
    ['address', freeTextProblem(d.homeAddress, { required: true }) !== null],
    ['date', !isValidServiceDate(d.date, now)],
  ];
}
// Every care selection is optional; only the flow rate (when Oxygen is Yes) and the free text can be wrong.
export function homeStep2Problems(d) {
  return [
    ['oxygenLpm', homeOxygenProblem(d) !== null],
    ['history', freeTextProblem(d.desc, { required: false }) !== null],
  ];
}

// ---- what is sent -------------------------------------------------------------------------------------------------------------------------------------------
// The contact number the way the server stores it ("+91 98765 43210"): the calling code and the number as typed, with the trunk zero dropped by the
// country's own rules. If it cannot be read (the form does not let that through) it is sent as typed and the server decides.
export function contactNumber(callingCode, nationalNumber) {
  const cc = String(callingCode || '').replace(/\D/g, '');
  const digits = String(nationalNumber || '').replace(/\D/g, '');
  const parsed = cc && digits ? parsePhoneNumberFromString(`+${cc}${digits}`) : null;
  return parsed && parsed.isValid() ? parsed.formatInternational() : `${callingCode} ${nationalNumber}`.trim();
}

// The body of POST /requests for a Home Healthcare request. The address and Medical History are sent exactly as typed (never trimmed). Unanswered care
// selections are left out; the flow rate is sent only when Oxygen is Yes. No description, origin, destination, urgency or transport field is ever sent:
// the server composes what is stored. `now` is the moment the request is built (a test passes its own; a real clock otherwise).
export function buildHomePayload(draft, now = new Date()) {
  const d = draft || {};
  const caretakers = CARETAKER_KEYS.filter((key) => (d.homeCaretakers || []).includes(key));
  return {
    serviceType: HOME_SERVICE_TYPE,
    serviceKey: HOME_SERVICE_KEY,
    patientName: d.name,
    patientAge: Number(String(d.age).trim()),
    patientGender: d.gender,
    country: d.country,
    patientContact: contactNumber(d.cc, d.phone),
    homeAddress: d.homeAddress,
    preferredDate: d.date,
    // The device's UTC offset (minutes EAST of UTC; JavaScript reports it the other way round), read from the same moment as the date picker's "today".
    utcOffsetMinutes: 0 - now.getTimezoneOffset(),
    ...(caretakers.length ? { caretakerTypes: caretakers } : {}),
    ...(HOURS_KEYS.includes(d.homeCareHours) ? { careRequirement: d.homeCareHours } : {}),
    ...(LEVEL_KEYS.includes(d.homeCareLevel) ? { careLevel: d.homeCareLevel } : {}),
    ...(d.homeOxygen === 'yes' ? { equipOxygen: true, equipOxygenLpm: parseOxygenLpm(d.oxygenLpm) } : {}),
    ...(d.homeOxygen === 'no' ? { equipOxygen: false } : {}),
    // Whitespace-only counts as not entered; otherwise the text goes exactly as typed.
    ...(String(d.desc == null ? '' : d.desc).trim() !== '' ? { medicalHistory: d.desc } : {}),
  };
}

// ---- the description the server composed: the strict parser ------------------------------------------------------------------------------------------
// Mirrors parseHomeDescription in the backend module (same grammar, same algorithm): { ok: true, address, history, care } or { ok: false }. Linear;
// it never searches inside patient text (the header's lengths, in UTF-16 code units, say where the address and history end); it never throws; any
// deviation is "invalid" and nothing is partially parsed.
const ADDRESS_LABEL = 'Complete home address:';
const HISTORY_LABEL = 'Medical History:';
const HEADER = /^Home Healthcare v1 \(address (0|[1-9]\d{0,3}), history (0|[1-9]\d{0,3})\)$/;
const CARE_LINES = [
  ['caretaker', /^Nurse \/ Caretaker: (Nurse|Caretaker|Nurse, Caretaker)$/],
  ['hours', /^Care Requirement: (12 Hours|24 Hours)$/],
  ['level', /^Care Level: (Full ICU|Semi ICU)$/],
  ['oxygen', /^Oxygen: (No|Yes \((\d{1,2}(?:\.\d)?) LPM\))$/],
];
const INVALID = Object.freeze({ ok: false });

export function parseHomeDescription(text) {
  try {
    if (typeof text !== 'string') return INVALID;
    let pos = text.indexOf('\n');
    if (pos < 0) return INVALID;
    const header = HEADER.exec(text.slice(0, pos));
    if (!header) return INVALID;
    const addressLength = Number(header[1]);
    const historyLength = Number(header[2]);
    if (addressLength < 1 || addressLength > FRAME_MAX || historyLength > FRAME_MAX) return INVALID;
    pos += 1;
    const care = {};
    let next = 0;
    for (;;) {
      const end = text.indexOf('\n', pos);
      const line = text.slice(pos, end < 0 ? text.length : end);
      if (line === ADDRESS_LABEL) break;
      let matched = false;
      for (; next < CARE_LINES.length; next += 1) {
        const found = CARE_LINES[next][1].exec(line);
        if (found) {
          care[CARE_LINES[next][0]] = found[1];
          if (CARE_LINES[next][0] === 'oxygen' && found[2] !== undefined) care.oxygenLpm = Number(found[2]);
          matched = true;
          next += 1;
          break;
        }
      }
      if (!matched || end < 0) return INVALID;
      pos = end + 1;
    }
    pos += ADDRESS_LABEL.length + 1;
    if (pos + addressLength > text.length) return INVALID;
    const address = text.slice(pos, pos + addressLength);
    pos += addressLength;
    let history = '';
    if (historyLength > 0) {
      const lead = `\n${HISTORY_LABEL}\n`;
      if (text.slice(pos, pos + lead.length) !== lead) return INVALID;
      pos += lead.length;
      if (pos + historyLength !== text.length) return INVALID;
      history = text.slice(pos);
      pos += historyLength;
    }
    if (pos !== text.length) return INVALID;
    if (hasUnpairedSurrogate(address) || hasUnpairedSurrogate(history)) return INVALID;
    return { ok: true, address, history, care };
  } catch {
    return INVALID;
  }
}

// ---- new and legacy requests ------------------------------------------------------------------------------------------------------------------------
// A NEW-format Home Healthcare request: its key is homecare AND its whole description parses as the v1 format. A missing or invalid marker, an unknown
// version or a corrupted text is a legacy request and keeps its legacy display and behaviour everywhere. The destination is never consulted. Works on
// a request from the API.
export const isNewHomeRequest = (request) => !!request && request.serviceKey === HOME_SERVICE_KEY && parseHomeDescription(request.description).ok;

// The care selections of a stored new-format request, read from its columns (the description's care lines are only checked for shape). Each is null
// when it was not answered. `t` is the app's translate function.
export function homeCareFromRequest(request, t) {
  const keys = String((request && request.caretakerTypes) || '').split(',').filter((key) => CARETAKER_KEYS.includes(key));
  const hours = request && HOURS_KEYS.includes(request.careRequirement) ? t(HOURS_LABEL_KEYS[request.careRequirement]) : null;
  const level = request && request.careLevel ? (LEVEL_FROM_STORED[request.careLevel] ? t(LEVEL_FROM_STORED[request.careLevel]) : String(request.careLevel)) : null;
  let oxygen = null;
  if (request && request.equipOxygen === true) oxygen = request.equipOxygenLpm != null ? t('home_oxygen_lpm_value', { n: request.equipOxygenLpm }) : t('answer_yes');
  else if (request && request.equipOxygen === false) oxygen = t('answer_no');
  return { caretakers: keys.length ? keys.map((key) => t(CARETAKER_LABEL_KEYS[key])).join(', ') : null, hours, level, oxygen };
}
