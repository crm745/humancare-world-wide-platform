import { isValidMobileNumber } from './validators';
import { OXYGEN_LPM_MAX, parseOxygenLpm } from './requestForm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Pure rules of the Marine Medical Safety request (no React, no native modules), kept apart so they can be unit-tested: what is valid, what is sent, how the
// server's composed description is read back, and how a NEW-format request is told from a legacy one.
//
// Self-contained on purpose, like lib/medicalValueTravel.js and lib/homeHealthcare.js: it imports nothing from another service's lib (own text rules, own date
// helpers, own contact formatter, own description parser). The only shared code is neutral: the contact validator, libphonenumber-js and the Oxygen flow-rate
// parser the other services use. Its server counterpart is backend/src/modules/requests/marine-medical-safety.validation.js, which is the contract; this file only
// builds what that expects and never relaxes it.

export const MARINE_SERVICE_KEY = 'marine';
// Must equal the service title in data/services.json and the backend constant.
export const MARINE_SERVICE_TYPE = 'Marine Medical Safety';
export const isMarineService = (serviceKey) => serviceKey === MARINE_SERVICE_KEY;

// The patient sees this choice as "Service Scope". Sent as `serviceScope`; the server keeps it in transfer_scope.
export const MARINE_SCOPES = ['domestic', 'international'];
// The Critical Level options, in the order shown, and the keys the server accepts (the same four as Ground Ambulance and Commercial Air). One or more, or none.
export const CRITICAL_LEVEL_KEYS = ['crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo'];
export const GENDERS = ['Male', 'Female', 'Other'];

export const NAME_MAX = 191;
export const AGE_MAX = 129;
export const CITY_MAX = 191;
export const HISTORY_MAX = 2000; // Unicode code points (what the person sees in the counter)
export const FRAME_MAX = 4000; // the largest UTF-16 framing length the parser accepts for the history (2,000 code points are at most 4,000 code units)
export { OXYGEN_LPM_MAX };

// ---- the words on screen ---------------------------------------------------------------------------------------------------------------------------
// The wording specific to this service. Each has an i18n key (translations are added separately, under these keys) and an English default that is shown until a
// translation exists in the selected language; nothing breaks while a key is missing. {{name}} is filled from `values`.
export const MARINE_TEXT = {
  marine_scope: 'Service Scope',
  marine_scope_domestic: 'Domestic',
  marine_scope_international: 'International',
  marine_scope_placeholder: 'Domestic or International',
  marine_origin: 'Origin City / Port',
  marine_destination: 'Destination City / Port',
  marine_date: 'Date of Service',
  marine_date_clear: 'Clear date',
  marine_history: 'Medical History',
  marine_history_placeholder: 'e.g. Crew member with chest pain since this morning, stable on oxygen.',
  marine_critical: 'Critical Level',
  marine_oxygen: 'Oxygen',
  marine_oxygen_unanswered: 'Please choose Yes or No.',
  marine_err_age: 'Enter an age from 0 to {{max}}.',
  marine_err_date: 'Enter today or a later date.',
  marine_err_origin_country: 'This city is not in {{country}}. Pick a city in {{country}}, or change the country.',
  marine_err_domestic_destination: 'For a Domestic request the destination must be in {{country}}.',
  marine_err_international_destination: 'For an International request the destination must be in a different country than {{country}}.',
  marine_err_too_long: 'Use at most {{max}} characters.',
  marine_err_chars: 'This text contains characters that cannot be saved.',
  marine_err_one_line: 'Enter this on a single line.',
};
const fill = (text, values) => (values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name) => (values[name] == null ? '' : String(values[name]))) : text);
// The text for a key: the translation when there is one, else the English default. `t` is the app's translate function (it returns the key itself when the
// language and English both lack it).
export function marineText(t, key, values) {
  const found = typeof t === 'function' ? t(key, values) : key;
  return found && found !== key ? found : fill(MARINE_TEXT[key] || key, values);
}

// ---- the character rules for free text -----------------------------------------------------------------------------------------------------------------
// The same rules as the server, as the same explicit code-unit loops. Rejected: every control character (Unicode category Cc) EXCEPT TAB, LF and CR and unpaired
// surrogates. Everything else is accepted and kept as typed.
export const codePointLength = (text) => Array.from(String(text == null ? '' : text)).length;
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
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const hasLineBreak = (text) => /[\n\r]/.test(text) || text.includes(SEPARATORS[0]) || text.includes(SEPARATORS[1]);

// What is wrong with a free-text value, or null: 'required' (empty or whitespace only; judged on a trimmed copy, the text itself is never trimmed),
// 'characters', 'too_long' (more than `max` code points) or, with `oneLine`, 'one_line'.
export function freeTextProblem(value, { required, max, oneLine } = {}) {
  const text = value == null ? '' : String(value);
  if (required && text.trim() === '') return 'required';
  if (hasDisallowedControl(text) || hasUnpairedSurrogate(text)) return 'characters';
  if (codePointLength(text) > max) return 'too_long';
  if (oneLine && hasLineBreak(text)) return 'one_line';
  return null;
}
// The message under a text field for one of those problems (the "required" message is shown only after Continue was tapped).
export function textErrorMessage(problem, t, { max, attempted }) {
  if (problem === 'too_long') return marineText(t, 'marine_err_too_long', { max });
  if (problem === 'characters') return marineText(t, 'marine_err_chars');
  if (problem === 'one_line') return marineText(t, 'marine_err_one_line');
  if (problem === 'required' && attempted) return t('req_required');
  return null;
}

// ---- the patient --------------------------------------------------------------------------------------------------------------------------------------------
// Name: at least 2 and at most 191 characters, with a letter, no line break or control character.
export function isValidMarineName(value) {
  const text = String(value == null ? '' : value).trim();
  const length = codePointLength(text);
  return length >= 2 && length <= NAME_MAX && /\p{L}/u.test(text) && !hasDisallowedControl(text) && !hasUnpairedSurrogate(text) && !/[\t]/.test(text) && !hasLineBreak(text);
}
// Age: a whole number from 0 to 129.
export function isValidMarineAge(value) {
  const text = String(value == null ? '' : value).trim();
  return /^(0|[1-9]\d{0,2})$/.test(text) && Number(text) <= AGE_MAX;
}

// ---- the Date of Service: optional; today or later by the person's own calendar --------------------------------------------------------------------
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
// Empty is fine (the date is optional); otherwise a real day, today or later.
export function isValidServiceDate(value, now = new Date()) {
  const text = String(value == null ? '' : value).trim();
  if (text === '') return true;
  return stringToDate(text) !== null && text >= todayString(now);
}

// ---- the two places and the scope --------------------------------------------------------------------------------------------------------------------
// A place is "picked" when it came from the suggestions: { geonameId, name, label, countryCode } (the country is the verified GeoNames record's). A city or port typed
// by hand has no country the app can trust, and none is invented for it: the rules below are applied to picked cities only (the server does the same, and says
// nothing about a typed one).
const code = (value) => String(value == null ? '' : value).trim().toUpperCase();

// What is wrong with the two places, or null for each: 'required'; for a picked city 'wrong_country' (the Origin, or a Domestic destination, outside the selected
// country) or 'same_country' (an International destination inside it).
export function cityProblems({ scope, countryIso, location, originCity, dest, destCity }) {
  const iso = code(countryIso);
  const out = { location: null, dest: null };
  if (!originCity) { if (!String(location || '').trim()) out.location = 'required'; } else if (iso && code(originCity.countryCode) !== iso) out.location = 'wrong_country';
  if (!destCity) {
    if (!String(dest || '').trim()) out.dest = 'required';
  } else if (iso) {
    const inside = code(destCity.countryCode) === iso;
    if (scope === 'domestic' && !inside) out.dest = 'wrong_country';
    if (scope === 'international' && inside) out.dest = 'same_country';
  }
  return out;
}
// The message under a city field, or undefined (a "required" waits for Continue).
export function cityErrorMessage(problem, kind, t, { attempted, countryName }) {
  if (problem === 'wrong_country') return marineText(t, kind === 'location' ? 'marine_err_origin_country' : 'marine_err_domestic_destination', { country: countryName });
  if (problem === 'same_country') return marineText(t, 'marine_err_international_destination', { country: countryName });
  if (problem === 'required' && attempted) return t('req_required');
  return undefined;
}

// ---- Oxygen: not answered, Yes (the flow rate is required) or No (no flow rate) ---------------------------------------------------------------------
// The draft's `marineOxygen` is '' (not answered yet), 'yes' or 'no'. The person must answer before sending. null = nothing wrong; 'unanswered'; 'lpm_required'
// (Yes, and nothing typed); 'lpm_invalid' (typed, but not 0 < n <= 15 with at most one decimal).
export function marineOxygenProblem(draft) {
  if (!draft || (draft.marineOxygen !== 'yes' && draft.marineOxygen !== 'no')) return 'unanswered';
  if (draft.marineOxygen === 'no') return null;
  if (!String(draft.oxygenLpm == null ? '' : draft.oxygenLpm).trim()) return 'lpm_required';
  return parseOxygenLpm(draft.oxygenLpm) === null ? 'lpm_invalid' : null;
}

// ---- what is wrong, in page order ---------------------------------------------------------------------------------------------------------------------
// Each is [anchor id, wrong?]; the first wrong one is where the page scrolls to.
export function marineStep1Problems(d) {
  const cities = cityProblems({ scope: d.serviceScope, countryIso: d.countryIso, location: d.location, originCity: d.originCity, dest: d.dest, destCity: d.destCity });
  return [
    ['scope', !MARINE_SCOPES.includes(d.serviceScope)],
    ['name', !isValidMarineName(d.name)],
    ['age', !isValidMarineAge(d.age) || !GENDERS.includes(d.gender)],
    ['country', !d.countryIso],
    ['phone', !isValidMobileNumber(d.phone, d.cc)],
    ['location', cities.location !== null || freeTextProblem(d.location, { max: CITY_MAX, oneLine: true }) !== null],
    ['dest', cities.dest !== null || freeTextProblem(d.dest, { max: CITY_MAX, oneLine: true }) !== null],
  ];
}
// Step 2: the optional date, the optional Medical History, the optional Critical Level (nothing to get wrong), Oxygen (an answer is required; Yes needs its flow rate).
export function marineStep2Problems(d, now = new Date()) {
  return [
    ['date', !isValidServiceDate(d.date, now)],
    ['history', freeTextProblem(d.desc, { required: false, max: HISTORY_MAX }) !== null],
    ['oxygen', marineOxygenProblem(d) === 'unanswered'],
    ['oxygenLpm', ['lpm_required', 'lpm_invalid'].includes(marineOxygenProblem(d))],
  ];
}

// ---- what is sent -------------------------------------------------------------------------------------------------------------------------------------------
// The contact number in E.164 ("+919876543210"): the calling code and the number as typed, with the trunk zero dropped by the country's own rules. If it cannot be
// read (the form does not let that through) it is sent as typed and the server decides.
export function contactE164(callingCode, nationalNumber) {
  const cc = String(callingCode || '').replace(/\D/g, '');
  const digits = String(nationalNumber || '').replace(/\D/g, '');
  const parsed = cc && digits ? parsePhoneNumberFromString(`+${cc}${digits}`) : null;
  return parsed && parsed.isValid() ? parsed.number : `${callingCode} ${nationalNumber}`.trim();
}

// A place as the server takes it: { geonameId } when it was picked from the suggestions, { text } (exactly as typed) when it was typed.
export const cityRef = (city, text) => (city && city.geonameId ? { geonameId: city.geonameId } : { text: String(text == null ? '' : text) });

// The chosen Critical Level keys, in the order the person chose them, only the four approved ones, each once.
export const chosenCriticalLevels = (draft) => {
  const list = Array.isArray(draft && draft.marineCare) ? draft.marineCare : [];
  return list.filter((key, i) => CRITICAL_LEVEL_KEYS.includes(key) && list.indexOf(key) === i);
};

// The body of POST /requests for a Marine Medical Safety request. Typed text (the places and the Medical History) is sent exactly as typed. No description, origin,
// destination, urgency or transport field is ever sent: the server composes what is stored. The device's UTC offset lets the server work out the person's own
// "today" for the Date of Service. `now` is the moment the request is built (a test passes its own).
export function buildMarinePayload(draft, now = new Date()) {
  const d = draft || {};
  const history = String(d.desc == null ? '' : d.desc);
  const levels = chosenCriticalLevels(d);
  const lpm = d.marineOxygen === 'yes' ? parseOxygenLpm(d.oxygenLpm) : null;
  return {
    serviceType: MARINE_SERVICE_TYPE,
    serviceKey: MARINE_SERVICE_KEY,
    serviceScope: d.serviceScope,
    patientName: d.name,
    patientAge: Number(String(d.age).trim()),
    patientGender: d.gender,
    country: d.countryIso,
    patientContact: contactE164(d.cc, d.phone),
    originCity: cityRef(d.originCity, d.location),
    destinationCity: cityRef(d.destCity, d.dest),
    // Whitespace-only counts as not entered.
    ...(history.trim() !== '' ? { medicalHistory: history } : {}),
    ...(String(d.date || '').trim() !== '' ? { preferredDate: String(d.date).trim() } : {}),
    ...(levels.length ? { careLevel: levels.join(',') } : {}),
    // Oxygen is answered before sending (Yes or No); the flow rate goes only with Yes and is never sent with No.
    ...(d.marineOxygen === 'yes' ? { equipOxygen: true, equipOxygenLpm: lpm } : {}),
    ...(d.marineOxygen === 'no' ? { equipOxygen: false } : {}),
    // The device's UTC offset (minutes EAST of UTC; JavaScript reports it the other way round), read from the same moment as the date picker's "today".
    utcOffsetMinutes: 0 - now.getTimezoneOffset(),
  };
}

// ---- the description the server composed: the strict parser ------------------------------------------------------------------------------------------
// Mirrors parseMarineDescription in the backend module (same grammar, same algorithm): { ok: true, history } or { ok: false }. Linear; it never searches inside patient
// text (the header's length, in UTF-16 code units, says where the history ends); it never throws; any deviation is "invalid" and nothing is partially parsed.
const HISTORY_LEAD = '\nMedical History:\n';
const HEADER = /^Marine Medical Safety v1 \(history (0|[1-9]\d{0,3})\)$/;
const INVALID = Object.freeze({ ok: false });

export function parseMarineDescription(text) {
  try {
    if (typeof text !== 'string') return INVALID;
    const headerEnd = text.indexOf('\n');
    const header = HEADER.exec(headerEnd < 0 ? text : text.slice(0, headerEnd));
    if (!header) return INVALID;
    const historyLength = Number(header[1]);
    if (historyLength > FRAME_MAX) return INVALID;
    if (historyLength === 0) return headerEnd < 0 ? { ok: true, history: '' } : INVALID;
    if (headerEnd < 0) return INVALID;
    if (text.slice(headerEnd, headerEnd + HISTORY_LEAD.length) !== HISTORY_LEAD) return INVALID;
    const start = headerEnd + HISTORY_LEAD.length;
    if (start + historyLength !== text.length) return INVALID;
    const history = text.slice(start);
    if (hasUnpairedSurrogate(history)) return INVALID;
    return { ok: true, history };
  } catch {
    return INVALID;
  }
}

// ---- new and legacy requests ------------------------------------------------------------------------------------------------------------------------
// A NEW-format Marine Medical Safety request: its key is marine, its transfer_scope is a real scope AND its whole description parses. Anything else (every request made
// before this format) is legacy and keeps its generic display everywhere. Works on a request from the API.
export const isNewMarineRequest = (request) => !!request
  && request.serviceKey === MARINE_SERVICE_KEY
  && MARINE_SCOPES.includes(request.transferScope)
  && parseMarineDescription(request.description).ok;

// What a stored new-format request shows: the scope label, the Medical History, the Critical Level names and the Oxygen answer. `t` is the app's translate function.
export function marineFromRequest(request, t) {
  const parsed = parseMarineDescription(request && request.description);
  if (!parsed.ok || !request || !MARINE_SCOPES.includes(request.transferScope)) return null;
  const keys = String(request.careLevel || '').split(',').map((piece) => piece.trim()).filter(Boolean);
  const levels = keys.map((key) => (CRITICAL_LEVEL_KEYS.includes(key) ? t(key) : key));
  const lpm = Number(request.equipOxygenLpm);
  let oxygen = null;
  if (request.equipOxygen === true) oxygen = request.equipOxygenLpm != null && Number.isFinite(lpm) && lpm > 0 ? t('equip_oxygen_lpm', { n: lpm }) : t('equip_oxygen');
  else if (request.equipOxygen === false) oxygen = t('answer_no');
  return { scope: marineText(t, `marine_scope_${request.transferScope}`), history: parsed.history, levels: levels.join(', '), oxygen };
}
