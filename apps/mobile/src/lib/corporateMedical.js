import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { isValidMobileNumber, isValidName } from './validators';
import { nameOf } from './phoneCountry';

// Pure rules of the Corporate Medical Solutions request, patient side (no React, no native modules), kept apart so they can be unit-tested: what is valid, what is
// sent, how the server's description is read back, and how a NEW-format request is told from an older one.
//
// Self-contained on purpose (own text rules, own description parser, own copies of the two small Home Healthcare helpers below, so no library imports another service's and
// there is no import cycle with lib/requestForm.js). Patient Contact and Preferred Date follow Home Healthcare's conventions EXACTLY: the same contact formatter, the same
// date rule (today or later), and the same date-picker component on screen (components/request/HomeDateField.js); a test checks the copies against Home's. Its server counterpart is backend/src/modules/requests/corporate-medical.validation.js, which is the contract; this file only builds what that
// expects and never relaxes it.
//
// The form has eleven fields:
//   Company Name | No. of Employees | Name of Employee | Gender | Patient Contact | Programmes (one or more of seven) | Preferred Date | Office Address | Office Country  (all required)
//   Any Requirement | Special Requirement  (optional)
// No. of Employees and Name of Employee are two separate fields: neither replaces the other. The draft keeps the employee's name in `name`, the gender in `gender`, the contact
// number in `phone` / `cc` / `phoneCountry` and the Preferred Date in `date` (the existing fields, with the same meaning); the office details are in their OWN keys
// (corpOfficeAddress, corpOfficeCountry, corpOfficeCountryIso), never in the patient's country fields: the Office Country is the COMPANY OFFICE's country, independent of the
// phone number's country code. Everything else is in the other `corp*` keys.

export const CORPORATE_SERVICE_KEY = 'corporate';
// Must equal the service title in data/services.json and the backend constant.
export const CORPORATE_SERVICE_TYPE = 'Corporate Medical Solutions';
export const isCorporateService = (serviceKey) => serviceKey === CORPORATE_SERVICE_KEY;

// The seven programmes, in the order shown. The keys are what is sent and stored; the labels are the English names (a test fails when this list and the
// backend's differ).
export const PROGRAMME_KEYS = [
  'doctor', 'nurse', 'medical_room_management', 'first_aid_training', 'acls_bls_training', 'events', 'pre_employment_health_checkup',
];
export const PROGRAMME_LABELS = {
  doctor: 'Doctor',
  nurse: 'Nurse',
  medical_room_management: 'Medical room management',
  first_aid_training: 'First aid training',
  acls_bls_training: 'ACLS & BLS training',
  events: 'Events',
  pre_employment_health_checkup: 'Pre-employment health checkup',
};
// The approved gender options (the same three every request form offers).
export const GENDERS = ['Male', 'Female', 'Other'];

export const COMPANY_MAX = 191; // characters (code points)
export const EMPLOYEES_MIN = 1;
export const EMPLOYEES_MAX = 10000; // the approved maximum for a new request
// A row saved before the maximum was set to 10,000 may hold a larger count (the first version allowed up to 1,000,000): reading one still works. Mirrors the server.
export const STORED_EMPLOYEES_MAX = 1000000;
export const TEXT_MAX = 2000; // Unicode code points, for each requirement
export const ADDRESS_MAX = 2000; // Unicode code points, for the Office Address (the server stores it in a VARCHAR(2000) column)
export const FRAME_MAX = TEXT_MAX * 2; // the largest UTF-16 framing length the parser accepts

// ---- the words on screen --------------------------------------------------------------------------------------------------------------------------------
// English defaults for every word this form adds: the app's own translation is used when it has the key, so a language that is added later wins; until then
// the English shows (the translation files are not changed by this form).
export const CORPORATE_TEXT = {
  corp_heading: 'Corporate details',
  corp_company: 'Company Name',
  corp_company_placeholder: 'Enter the company name',
  corp_employees: 'No. of Employees',
  corp_employees_placeholder: 'Number of employees',
  corp_patient_contact: 'Patient Contact',
  corp_preferred_date: 'Preferred Date',
  corp_office_address: 'Office Address',
  corp_office_address_placeholder: "The company's complete office address",
  corp_office_country: 'Office Country',
  corp_office_country_placeholder: 'Select the office country',
  corp_err_contact: 'Enter a valid number for the selected country.',
  corp_err_date: 'Pick today or a later date.',
  corp_err_address_long: 'Use at most {{max}} characters.',
  corp_err_address_chars: 'This text has a character that cannot be saved.',
  corp_employee_name: 'Name of Employee',
  corp_employee_name_placeholder: "Enter the employee's full name",
  corp_programmes: 'Programmes',
  corp_programmes_hint: 'Choose one or more',
  corp_any: 'Any Requirement',
  corp_any_placeholder: 'Anything you would like us to know (optional)',
  corp_special: 'Special Requirement',
  corp_special_placeholder: 'Any special requirement (optional)',
  corp_required: 'This field is required.',
  corp_err_name: 'Enter a valid name.',
  corp_err_company_long: 'Use at most {{max}} characters.',
  corp_err_company_chars: 'This text has a character that cannot be saved.',
  corp_err_employees: 'Enter a whole number from {{min}} to {{max}}.',
  corp_err_programmes: 'Choose at least one programme.',
  corp_err_too_long: 'Use at most {{max}} characters.',
  corp_err_text_chars: 'This text has a character that cannot be saved.',
};
const fill = (text, values) => String(text).replace(/\{\{(\w+)\}\}/g, (match, name) => (values && values[name] !== undefined ? String(values[name]) : match));
// `t` is the app's translate function: its text when it has the key, else the English default.
export function corporateText(t, key, values) {
  const found = typeof t === 'function' ? t(key, values) : key;
  return found && found !== key ? found : fill(CORPORATE_TEXT[key] || key, values);
}

// ---- the character rules for free text ------------------------------------------------------------------------------------------------------------------
// The same rules as the server, as the same explicit code-unit loops. Rejected: every control character (Unicode category Cc) EXCEPT TAB, LF and CR and
// unpaired surrogates. Everything else is accepted and kept as typed.
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

// What is wrong with a requirement text, or null: 'characters' or 'too_long'. (Both requirements are optional, so empty is fine; the text itself is never trimmed.)
export function requirementProblem(value) {
  const text = value == null ? '' : String(value);
  if (hasDisallowedControl(text) || hasUnpairedSurrogate(text)) return 'characters';
  if (codePointLength(text) > TEXT_MAX) return 'too_long';
  return null;
}
// What is wrong with the Company Name, or null: 'required', 'characters' (a control character, a tab or a line break) or 'too_long'.
export function companyProblem(value) {
  const text = value == null ? '' : String(value);
  if (text.trim() === '') return 'required';
  if (hasDisallowedControl(text) || hasUnpairedSurrogate(text) || hasLineBreak(text) || /\t/.test(text)) return 'characters';
  if (codePointLength(text) > COMPANY_MAX) return 'too_long';
  return null;
}
// ---- Patient Contact and Preferred Date: Home Healthcare's rules (copies; a test checks they agree with lib/homeHealthcare.js) ---------------------------------------------
// The contact number the way the server stores it ("+91 98765 43210"): the calling code and the number as typed, with the trunk zero dropped by the country's own rules. If it
// cannot be read (the form does not let that through) it is sent as typed and the server decides.
export function contactNumber(callingCode, nationalNumber) {
  const cc = String(callingCode || '').replace(/\D/g, '');
  const digits = String(nationalNumber || '').replace(/\D/g, '');
  const parsed = cc && digits ? parsePhoneNumberFromString(`+${cc}${digits}`) : null;
  return parsed && parsed.isValid() ? parsed.formatInternational() : `${callingCode} ${nationalNumber}`.trim();
}
// "YYYY-MM-DD" that is a real calendar day, as a local Date at midnight; null when it is not.
const realDay = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
};
// The device's today as "YYYY-MM-DD" (by the LOCAL calendar, what the date picker shows).
const todayText = (now) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
// The Preferred Date: a real day, today or later.
export function isValidServiceDate(value, now = new Date()) {
  const text = String(value || '').trim();
  return realDay(text) !== null && text >= todayText(now);
}

// What is wrong with the Office Address, or null: 'required' (empty or whitespace only; judged on a trimmed copy, the text itself is never trimmed or cut), 'characters' (a character
// that cannot be saved) or 'too_long' (more than 2,000 characters: it is refused, never cut).
export function officeAddressProblem(value) {
  const text = value == null ? '' : String(value);
  if (text.trim() === '') return 'required';
  if (hasDisallowedControl(text) || hasUnpairedSurrogate(text)) return 'characters';
  if (codePointLength(text) > ADDRESS_MAX) return 'too_long';
  return null;
}
// The Office Country is chosen from the country list, as an ISO code that the list knows. (Not derived from the phone's country code.)
export const isValidOfficeCountry = (iso) => typeof iso === 'string' && /^[A-Z]{2}$/.test(iso) && nameOf(iso) !== '';

// What is wrong with No. of Employees, or null: 'required' (empty) or 'invalid' (not a whole number from 1 to 10,000: no decimals, signs, letters or spaces inside).
export function employeeCountProblem(value) {
  const text = String(value == null ? '' : value).trim();
  if (text === '') return 'required';
  if (!/^\d{1,7}$/.test(text)) return 'invalid';
  const n = Number(text);
  return n >= EMPLOYEES_MIN && n <= EMPLOYEES_MAX ? null : 'invalid';
}
// The count as a number, or null when it is not a valid one.
export const parseEmployeeCount = (value) => (employeeCountProblem(value) === null ? Number(String(value).trim()) : null);

// The programmes chosen, in the canonical order (the order the list shows them, whatever order they were tapped in); anything that is not one of the seven is dropped.
export const chosenProgrammes = (d) => PROGRAMME_KEYS.filter((key) => Array.isArray(d && d.corpProgrammes) && d.corpProgrammes.includes(key));

// ---- what is wrong, in page order ------------------------------------------------------------------------------------------------------------------------
// Each is [anchor id, wrong?]; the first wrong one is where the page scrolls to.
export function corporateStep1Problems(d, now = new Date()) {
  return [
    ['company', companyProblem(d.corpCompany) !== null],
    ['employees', employeeCountProblem(d.corpEmployees) !== null],
    ['name', !isValidName(d.name)],
    ['gender', !GENDERS.includes(d.gender)],
    ['phone', !isValidMobileNumber(d.phone, d.cc)],
    ['programmes', chosenProgrammes(d).length === 0],
    ['date', !isValidServiceDate(d.date, now)],
    ['address', officeAddressProblem(d.corpOfficeAddress) !== null],
    ['country', !isValidOfficeCountry(d.corpOfficeCountryIso)],
  ];
}
// Both requirements are optional: only the characters and the length can be wrong.
export function corporateStep2Problems(d) {
  return [
    ['any', requirementProblem(d.corpAny) !== null],
    ['special', requirementProblem(d.corpSpecial) !== null],
  ];
}

// ---- what is sent ----------------------------------------------------------------------------------------------------------------------------------------
// The body of POST /requests for a Corporate Medical Solutions request. The two requirements and the Office Address are sent exactly as typed (never trimmed or cut), the
// requirements only when something other than whitespace was typed. The contact number goes in international form like Home Healthcare's, the date as "YYYY-MM-DD" with the
// device's UTC offset (minutes EAST of UTC; JavaScript reports it the other way round) so the server judges "today" by the person's own calendar, and the Office Country as its
// ISO code. No origin, destination, country, description, age, urgency or document is ever sent: the server composes what is stored. `now` is the moment the request is built.
export function buildCorporatePayload(draft, now = new Date()) {
  const d = draft || {};
  const text = (value) => (value == null ? '' : String(value));
  return {
    serviceType: CORPORATE_SERVICE_TYPE,
    serviceKey: CORPORATE_SERVICE_KEY,
    companyName: text(d.corpCompany).trim(),
    employeeCount: parseEmployeeCount(d.corpEmployees),
    patientName: text(d.name).trim(),
    patientGender: d.gender,
    patientContact: contactNumber(d.cc, d.phone),
    preferredDate: d.date,
    utcOffsetMinutes: 0 - now.getTimezoneOffset(),
    officeAddress: text(d.corpOfficeAddress),
    officeCountry: d.corpOfficeCountryIso,
    programmes: chosenProgrammes(d),
    ...(text(d.corpAny).trim() !== '' ? { anyRequirement: d.corpAny } : {}),
    ...(text(d.corpSpecial).trim() !== '' ? { specialRequirement: d.corpSpecial } : {}),
  };
}

// ---- the description the server composed: the strict parser ------------------------------------------------------------------------------------------
// Mirrors parseCorporateDescription in the backend module (same grammar, same algorithm): { ok: true, any, special } or { ok: false }. Linear; it never searches inside
// patient text (the header's lengths, in UTF-16 code units, say where each text ends); it never throws; any deviation is "invalid" and nothing is partially parsed.
// An empty or missing description is valid: both texts are ''.
const ANY_LEAD = '\nAny Requirement:\n';
const SPECIAL_LEAD = '\nSpecial Requirement:\n';
const HEADER = /^Corporate Medical Solutions v1 \(any (0|[1-9]\d{0,3}), special (0|[1-9]\d{0,3})\)$/;
const INVALID = Object.freeze({ ok: false });

export function parseCorporateDescription(text) {
  try {
    if (text === null || text === undefined || text === '') return { ok: true, any: '', special: '' };
    if (typeof text !== 'string') return INVALID;
    let pos = text.indexOf('\n');
    if (pos < 0) return INVALID;
    const header = HEADER.exec(text.slice(0, pos));
    if (!header) return INVALID;
    const anyLength = Number(header[1]);
    const specialLength = Number(header[2]);
    if ((anyLength === 0 && specialLength === 0) || anyLength > FRAME_MAX || specialLength > FRAME_MAX) return INVALID;
    let any = '';
    let special = '';
    if (anyLength > 0) {
      if (text.slice(pos, pos + ANY_LEAD.length) !== ANY_LEAD) return INVALID;
      pos += ANY_LEAD.length;
      if (pos + anyLength > text.length) return INVALID;
      any = text.slice(pos, pos + anyLength);
      pos += anyLength;
    }
    if (specialLength > 0) {
      if (text.slice(pos, pos + SPECIAL_LEAD.length) !== SPECIAL_LEAD) return INVALID;
      pos += SPECIAL_LEAD.length;
      if (pos + specialLength !== text.length) return INVALID;
      special = text.slice(pos);
      pos += specialLength;
    }
    if (pos !== text.length) return INVALID;
    if (hasUnpairedSurrogate(any) || hasUnpairedSurrogate(special)) return INVALID;
    return { ok: true, any, special };
  } catch {
    return INVALID;
  }
}

// ---- new and older requests ------------------------------------------------------------------------------------------------------------------------------
// The programmes of a stored row as an array of valid, distinct keys, or null when it is not one. (An older build of the API, or a value that came back as a JSON string,
// is not a list of keys, so the row is read as an older one rather than guessed at.)
function storedProgrammes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROGRAMME_KEYS.length) return null;
  if (!value.every((key) => typeof key === 'string' && PROGRAMME_KEYS.includes(key))) return null;
  return new Set(value).size === value.length ? [...value] : null;
}

// Mirrors corporateFieldsOf in the backend module. { ok: true, companyName, employeeCount, programmes (keys), anyRequirement, specialRequirement } or { ok: false }.
export function corporateFieldsOf(request) {
  if (!request || request.serviceKey !== CORPORATE_SERVICE_KEY) return INVALID;
  const { companyName, employeeCount } = request;
  if (typeof companyName !== 'string' || companyName.trim() === '') return INVALID;
  if (!Number.isInteger(employeeCount) || employeeCount < EMPLOYEES_MIN || employeeCount > STORED_EMPLOYEES_MAX) return INVALID;
  const programmes = storedProgrammes(request.selectedProgrammes);
  if (!programmes) return INVALID;
  const parsed = parseCorporateDescription(request.description);
  if (!parsed.ok) return INVALID;
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    ok: true, companyName, employeeCount, programmes, anyRequirement: parsed.any, specialRequirement: parsed.special,
    patientContact: text(request.patientContact), preferredDate: request.preferredDate || null, officeAddress: text(request.origin), officeCountry: text(request.country),
  };
}

// A NEW-format Corporate Medical Solutions request: its key is corporate, its three columns are valid and its description is empty or parses. Anything else (every
// request made before this format) is an older request and keeps the generic display everywhere. Works on a request from the API.
export const isNewCorporateRequest = (request) => corporateFieldsOf(request).ok;

// The names of the chosen programmes, each one on its own (never a JSON string), in the order stored.
// One programme's name: the app's translation when it has one (the key corp_programme_<key>), else the English name.
export function programmeName(key, t) {
  const textKey = `corp_programme_${key}`;
  const found = typeof t === 'function' ? t(textKey) : textKey;
  return found && found !== textKey ? found : PROGRAMME_LABELS[key];
}
export const programmeNames = (keys, t) => (Array.isArray(keys) ? keys : []).filter((key) => PROGRAMME_KEYS.includes(key)).map((key) => programmeName(key, t));

// What a stored new-format request shows, or null for an older one. `t` is the app's translate function.
export function corporateFromRequest(request, t) {
  const fields = corporateFieldsOf(request);
  if (!fields.ok) return null;
  return {
    company: fields.companyName,
    employees: String(fields.employeeCount),
    programmes: programmeNames(fields.programmes, t),
    anyRequirement: fields.anyRequirement,
    specialRequirement: fields.specialRequirement,
    // the four fields a request saved before they existed does not have: '' / null, never invented
    patientContact: fields.patientContact,
    preferredDate: fields.preferredDate,
    officeAddress: fields.officeAddress,
    officeCountry: fields.officeCountry,
  };
}
