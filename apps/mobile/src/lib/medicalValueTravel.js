import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { isValidMobileNumber } from './validators';
import { nameOf } from './phoneCountry';

// Pure rules of the Medical Value Travel request (no React, no native modules), kept apart so they can be unit-tested: what is valid, what is sent, how the
// server's composed description is read back, and how a NEW-format request is told from a legacy one.
//
// Self-contained on purpose, like lib/homeHealthcare.js: it imports nothing from the other services' libraries (own text rules, own date helpers, own contact
// formatter, own description parser). Its server counterpart is backend/src/modules/requests/medical-value-travel.validation.js, which is the contract; this
// file only builds what that expects and never relaxes it.

export const MVT_SERVICE_KEY = 'medvalue';
// Must equal the service title in data/services.json and the backend constant.
export const MVT_SERVICE_TYPE = 'Medical Value Travel';
export const isMvtService = (serviceKey) => serviceKey === MVT_SERVICE_KEY;

// Where the treatment is: inside the patient's country or abroad. Stored in the request's transfer_scope (the column Mortal Remains also uses).
export const MVT_SCOPES = ['domestic', 'international'];

// The approved initial list, in the order shown; "Other" is last and asks for its own text. Shown and stored as these English labels. The server holds the
// same list (medical-value-travel.validation.js); a backend test fails when the two differ. Keep it ONE plain array literal (that test reads it).
export const MVT_SPECIALTIES = [
  'Cardiology and Cardiac Surgery',
  'Oncology',
  'Orthopedics and Joint Replacement',
  'Neurology and Neurosurgery',
  'Transplant (Kidney, Liver, Bone Marrow)',
  'Gastroenterology',
  'Urology',
  'Nephrology',
  'Gynecology and IVF',
  'Pediatrics',
  'Ophthalmology',
  'ENT',
  'Dermatology',
  'Dental',
  'Bariatric and Weight Loss',
  'Spine',
  'Pulmonology',
  'Endocrinology',
  'Plastic and Cosmetic Surgery',
  'General Surgery',
  'Internal Medicine',
  'Rehabilitation and Physiotherapy',
  'Ayurveda and Wellness',
  'Other',
];
export const MVT_OTHER_SPECIALTY = 'Other';
export const GENDERS = ['Male', 'Female', 'Other'];

export const NAME_MAX = 191;
export const AGE_MAX = 129;
export const CITY_MAX = 191;
export const OTHER_MAX = 191;
export const HISTORY_MAX = 2000; // Unicode code points (what the person sees in the counter)
export const FRAME_MAX = 4000; // the largest UTF-16 framing length the parser accepts for the history (2,000 code points are at most 4,000 code units)
const OTHER_FRAME_MAX = OTHER_MAX * 2;

// ---- the words on screen ---------------------------------------------------------------------------------------------------------------------------
// The wording specific to this service. Each has an i18n key (translations are added separately, under these keys) and an English default that is shown
// until a translation exists in the selected language; nothing breaks while a key is missing. {{name}} is filled from `values`.
export const MVT_TEXT = {
  mvt_scope: 'Treatment scope',
  mvt_scope_domestic: 'Domestic',
  mvt_scope_international: 'International',
  mvt_scope_placeholder: 'Domestic or International',
  mvt_current_city: 'Current city',
  mvt_destination_city: 'Destination city',
  mvt_treatment_date: 'Preferred treatment date',
  mvt_treatment_date_hint: 'The day you would like the treatment to start, not the travel date.',
  mvt_date_clear: 'Clear date',
  mvt_specialty: 'Specialty required',
  mvt_specialty_placeholder: 'Select a specialty',
  mvt_other_specialty: 'Other specialty',
  mvt_other_specialty_placeholder: 'Enter the specialty',
  mvt_history: 'Medical History',
  mvt_history_placeholder: 'e.g. Knee pain for two years, advised joint replacement.',
  mvt_review_heading: 'Treatment',
  mvt_err_age: 'Enter an age from 0 to {{max}}.',
  mvt_err_date: 'Enter today or a later date.',
  mvt_err_current_country: 'This city is not in {{country}}. Pick a city in {{country}}, or change the country.',
  mvt_err_domestic_destination: 'For a Domestic request the destination must be in {{country}}.',
  mvt_err_international_destination: 'For an International request the destination must be in a different country than {{country}}.',
  mvt_err_too_long: 'Use at most {{max}} characters.',
  mvt_err_chars: 'This text contains characters that cannot be saved.',
  mvt_err_one_line: 'Enter this on a single line.',
};
const fill = (text, values) => (values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name) => (values[name] == null ? '' : String(values[name]))) : text);
// The text for a key: the translation when there is one, else the English default. `t` is the app's translate function (it returns the key itself when
// the language and English both lack it).
export function mvtText(t, key, values) {
  const found = typeof t === 'function' ? t(key, values) : key;
  return found && found !== key ? found : fill(MVT_TEXT[key] || key, values);
}

// ---- the character rules for free text -----------------------------------------------------------------------------------------------------------------
// The same rules as the server, as the same explicit code-unit loops. Rejected: every control character (Unicode category Cc) EXCEPT TAB, LF and CR
// and unpaired surrogates. Everything else is accepted and kept as typed.
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
// The line and paragraph separators U+2028 and U+2029, by code so this source stays plain ASCII.
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
  if (problem === 'too_long') return mvtText(t, 'mvt_err_too_long', { max });
  if (problem === 'characters') return mvtText(t, 'mvt_err_chars');
  if (problem === 'one_line') return mvtText(t, 'mvt_err_one_line');
  if (problem === 'required' && attempted) return t('req_required');
  return null;
}

// ---- the patient --------------------------------------------------------------------------------------------------------------------------------------------
// Name: at least 2 and at most 191 characters, with a letter, no line break or control character.
export function isValidMvtName(value) {
  const text = String(value == null ? '' : value).trim();
  const length = codePointLength(text);
  return length >= 2 && length <= NAME_MAX && /\p{L}/u.test(text) && !hasDisallowedControl(text) && !hasUnpairedSurrogate(text) && !/[\t]/.test(text) && !hasLineBreak(text);
}
// Age: a whole number from 0 to 129.
export function isValidMvtAge(value) {
  const text = String(value == null ? '' : value).trim();
  return /^(0|[1-9]\d{0,2})$/.test(text) && Number(text) <= AGE_MAX;
}

// The Country the form starts with: the account's Nationality (an ISO code), else the country of the account's phone number; '' when neither is known (the
// person must then pick one). Only a real country counts. The person can always change it afterwards.
export function defaultCountryIso(profile) {
  for (const code of [profile && profile.nationality, profile && profile.phoneCountry]) {
    const iso = String(code || '').trim().toUpperCase();
    if (iso && nameOf(iso)) return iso;
  }
  return '';
}

// ---- the Preferred Treatment Date: optional; today or later by the person's own calendar --------------------------------------------------------
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
// Empty is fine (the date is optional); otherwise a real day, today or later.
export function isValidTreatmentDate(value, now = new Date()) {
  const text = String(value == null ? '' : value).trim();
  if (text === '') return true;
  return stringToDate(text) !== null && text >= todayString(now);
}

// ---- the two cities and the scope ------------------------------------------------------------------------------------------------------------------------
// A city is "picked" when it came from the suggestions: { geonameId, name, label, countryCode } (the country is the verified GeoNames record's). A city
// typed by hand has no country the app can trust, and none is invented for it: the rules below are applied to picked cities only (the server does the same,
// and says nothing about a typed one).
const code = (value) => String(value == null ? '' : value).trim().toUpperCase();

// What is wrong with the two cities, or null for each: 'required'; for a picked city 'wrong_country' (Current City, or a Domestic destination, outside the
// selected country) or 'same_country' (an International destination inside it).
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
  if (problem === 'wrong_country') return mvtText(t, kind === 'location' ? 'mvt_err_current_country' : 'mvt_err_domestic_destination', { country: countryName });
  if (problem === 'same_country') return mvtText(t, 'mvt_err_international_destination', { country: countryName });
  if (problem === 'required' && attempted) return t('req_required');
  return undefined;
}

// ---- what is wrong, in page order ---------------------------------------------------------------------------------------------------------------------
// Each is [anchor id, wrong?]; the first wrong one is where the page scrolls to.
export function mvtStep1Problems(d) {
  const cities = cityProblems({ scope: d.treatmentScope, countryIso: d.countryIso, location: d.location, originCity: d.originCity, dest: d.dest, destCity: d.destCity });
  return [
    ['scope', !MVT_SCOPES.includes(d.treatmentScope)],
    ['name', !isValidMvtName(d.name)],
    ['age', !isValidMvtAge(d.age) || !GENDERS.includes(d.gender)],
    ['country', !d.countryIso],
    ['phone', !isValidMobileNumber(d.phone, d.cc)],
    ['location', cities.location !== null || freeTextProblem(d.location, { max: CITY_MAX, oneLine: true }) !== null],
    ['dest', cities.dest !== null || freeTextProblem(d.dest, { max: CITY_MAX, oneLine: true }) !== null],
  ];
}
// Step 2 is the treatment: the optional date, the specialty (and the Other text) and the optional Medical History.
export function mvtStep2Problems(d, now = new Date()) {
  return [
    ['date', !isValidTreatmentDate(d.date, now)],
    ['specialty', !MVT_SPECIALTIES.includes(d.specialty)],
    ['otherSpecialty', d.specialty === MVT_OTHER_SPECIALTY && freeTextProblem(d.otherSpecialty, { required: true, max: OTHER_MAX, oneLine: true }) !== null],
    ['history', freeTextProblem(d.desc, { required: false, max: HISTORY_MAX }) !== null],
  ];
}

// ---- what is sent -------------------------------------------------------------------------------------------------------------------------------------------
// The contact number in E.164 ("+919876543210"): the calling code and the number as typed, with the trunk zero dropped by the country's own rules. If it
// cannot be read (the form does not let that through) it is sent as typed and the server decides.
export function contactE164(callingCode, nationalNumber) {
  const cc = String(callingCode || '').replace(/\D/g, '');
  const digits = String(nationalNumber || '').replace(/\D/g, '');
  const parsed = cc && digits ? parsePhoneNumberFromString(`+${cc}${digits}`) : null;
  return parsed && parsed.isValid() ? parsed.number : `${callingCode} ${nationalNumber}`.trim();
}

// A city as the server takes it: { geonameId } when it was picked from the suggestions, { text } (exactly as typed) when it was typed.
export const cityRef = (city, text) => (city && city.geonameId ? { geonameId: city.geonameId } : { text: String(text == null ? '' : text) });

// The body of POST /requests for a Medical Value Travel request. Typed text (the cities, the Other specialty and the Medical History) is sent exactly as
// typed. No description, origin, destination, urgency or transport field is ever sent: the server composes what is stored. The device's UTC offset lets the
// server work out the person's own "today" for the Preferred Treatment Date. `now` is the moment the request is built (a test passes its own).
export function buildMvtPayload(draft, now = new Date()) {
  const d = draft || {};
  const history = String(d.desc == null ? '' : d.desc);
  return {
    serviceType: MVT_SERVICE_TYPE,
    serviceKey: MVT_SERVICE_KEY,
    treatmentScope: d.treatmentScope,
    patientName: d.name,
    patientAge: Number(String(d.age).trim()),
    patientGender: d.gender,
    country: d.countryIso,
    patientContact: contactE164(d.cc, d.phone),
    currentCity: cityRef(d.originCity, d.location),
    destinationCity: cityRef(d.destCity, d.dest),
    specialty: d.specialty,
    ...(d.specialty === MVT_OTHER_SPECIALTY ? { otherSpecialty: d.otherSpecialty } : {}),
    // Whitespace-only counts as not entered.
    ...(history.trim() !== '' ? { medicalHistory: history } : {}),
    ...(String(d.date || '').trim() !== '' ? { preferredDate: String(d.date).trim() } : {}),
    // The device's UTC offset (minutes EAST of UTC; JavaScript reports it the other way round), read from the same moment as the date picker's "today".
    utcOffsetMinutes: 0 - now.getTimezoneOffset(),
  };
}

// ---- the description the server composed: the strict parser ------------------------------------------------------------------------------------------
// Mirrors parseMvtDescription in the backend module (same grammar, same algorithm): { ok: true, specialty, other, history } or { ok: false }. Linear; it
// never searches inside patient text (the header's lengths, in UTF-16 code units, say where the two texts end); it never throws; any deviation is
// "invalid" and nothing is partially parsed.
const SPECIALTY_LABEL = 'Specialty: ';
const OTHER_LEAD = '\nOther Specialty:\n';
const HISTORY_LEAD = '\nMedical History:\n';
const HEADER = /^Medical Value Travel v1 \(other (0|[1-9]\d{0,3}), history (0|[1-9]\d{0,3})\)$/;
const INVALID = Object.freeze({ ok: false });

export function parseMvtDescription(text) {
  try {
    if (typeof text !== 'string') return INVALID;
    const headerEnd = text.indexOf('\n');
    if (headerEnd < 0) return INVALID;
    const header = HEADER.exec(text.slice(0, headerEnd));
    if (!header) return INVALID;
    const otherLength = Number(header[1]);
    const historyLength = Number(header[2]);
    if (otherLength > OTHER_FRAME_MAX || historyLength > FRAME_MAX) return INVALID;
    let pos = headerEnd + 1;
    const lineEnd = text.indexOf('\n', pos);
    const line = text.slice(pos, lineEnd < 0 ? text.length : lineEnd);
    if (!line.startsWith(SPECIALTY_LABEL)) return INVALID;
    const specialty = line.slice(SPECIALTY_LABEL.length);
    if (specialty === '' || /\r/.test(specialty) || codePointLength(specialty) > CITY_MAX) return INVALID;
    pos += line.length;
    let other = '';
    if (specialty === MVT_OTHER_SPECIALTY) {
      if (otherLength < 1 || text.slice(pos, pos + OTHER_LEAD.length) !== OTHER_LEAD) return INVALID;
      pos += OTHER_LEAD.length;
      if (pos + otherLength > text.length) return INVALID;
      other = text.slice(pos, pos + otherLength);
      pos += otherLength;
    } else if (otherLength !== 0) {
      return INVALID;
    }
    let history = '';
    if (historyLength > 0) {
      if (text.slice(pos, pos + HISTORY_LEAD.length) !== HISTORY_LEAD) return INVALID;
      pos += HISTORY_LEAD.length;
      if (pos + historyLength !== text.length) return INVALID;
      history = text.slice(pos);
      pos += historyLength;
    }
    if (pos !== text.length) return INVALID;
    if (hasUnpairedSurrogate(other) || hasUnpairedSurrogate(history)) return INVALID;
    return { ok: true, specialty, other, history };
  } catch {
    return INVALID;
  }
}

// ---- new and legacy requests ------------------------------------------------------------------------------------------------------------------------
// Mirrors mvtFieldsOf in the backend module: { ok: true, specialty, other, history } or { ok: false }.
//   current requests: the `specialty` column holds an approved specialty, `otherSpecialty` the typed name ("Other" only) and the description is the Medical History.
//   requests made before those columns: no `specialty`, and the whole description parses as the versioned v1 text.
export function mvtFieldsOf(request) {
  if (!request || request.serviceKey !== MVT_SERVICE_KEY || !MVT_SCOPES.includes(request.transferScope)) return INVALID;
  if (request.specialty !== undefined && request.specialty !== null && request.specialty !== '') {
    if (typeof request.specialty !== 'string' || !MVT_SPECIALTIES.includes(request.specialty)) return INVALID;
    const isOther = request.specialty === MVT_OTHER_SPECIALTY;
    const other = typeof request.otherSpecialty === 'string' ? request.otherSpecialty : '';
    if (isOther !== (other !== '')) return INVALID;
    return { ok: true, specialty: request.specialty, other, history: typeof request.description === 'string' ? request.description : '' };
  }
  return parseMvtDescription(request.description);
}

// A NEW-format Medical Value Travel request: its key is medvalue, its transfer_scope is a real scope AND it has its specialty (in its column, or in a v1
// description). Anything else (every request made before this format) is legacy and keeps its generic display everywhere. Works on a request from the API.
export const isNewMvtRequest = (request) => mvtFieldsOf(request).ok;

// What a stored new-format request shows: the scope label, the specialty (with the Other text) and the Medical History. `t` is the app's translate function.
export function mvtFromRequest(request, t) {
  const parsed = mvtFieldsOf(request);
  if (!parsed.ok) return null;
  const specialty = parsed.specialty === MVT_OTHER_SPECIALTY ? `${parsed.specialty}: ${parsed.other}` : parsed.specialty;
  return { scope: mvtText(t, `mvt_scope_${request.transferScope}`), specialty, history: parsed.history };
}
