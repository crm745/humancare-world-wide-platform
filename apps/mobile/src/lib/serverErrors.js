// The words of a refusal the SERVER sent, in the person's language. The backend adds a stable `code` (and `field`, `params`, `fieldCodes`) to every refusal of the request and document-upload API
// (backend/src/common/errors/error-codes.js) and leaves its English `error` text as it was. This turns the code into the dictionary text of the current language (EN, HI, MR, GU, TE, AR), using
// the existing translations where there are any (req_required, err_valid_date, err_number_for_country, req_file_type, req_file_big, req_file_max, ...) and the srv_* keys added for the rest.
//
//   localizedServerError(err, t)                      text for an error that carries a known `code`, else null (the caller then shows err.message, the English fallback)
//   localizedFieldError(entry, field, t)              text for one `fieldCodes` entry ({ code, params }) of a refused field, else null
//
// What it never does: show or translate anything the server did not intend to be shown. It reads only the code, the field NAME (to look up a label, never as text), and numbers in `params`.
// A code the app does not know, or a dictionary key that is missing, gives null: the English message from the server is shown instead, as before.
import SERVER_ERRORS from '../data/serverErrorKeys.json';
import UPLOAD_MESSAGES from '../data/serverErrorMessages.json';

// The request field names the server may report, and the dictionary key of each one's label (existing keys).
export const FIELD_LABEL_KEYS = Object.freeze({
  patientName: 'field_patient_name',
  patientAge: 'field_age',
  patientGender: 'field_gender',
  patientContact: 'field_contact_number',
  country: 'field_country',
  origin: 'field_location',
  originCity: 'field_location',
  currentCity: 'field_location',
  destination: 'field_destination',
  destinationCity: 'field_destination',
  preferredDate: 'field_preferred_date',
  careLevel: 'field_care_level',
  description: 'field_case_notes',
  consultationType: 'field_consult_type',
  consultationScope: 'field_consult_scope',
  currentAddress: 'field_current_address',
  homeAddress: 'field_home_address',
  presentMedicalIssue: 'field_present_issue',
  allergyDetails: 'field_allergy',
});

const own = (object, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);
const isCount = (value) => typeof value === 'number' && Number.isFinite(value);

// t(key) that says whether the key exists: the app's t() returns the key itself for a missing one.
function lookup(t, key) {
  const text = typeof t === 'function' ? t(key) : undefined;
  return typeof text === 'string' && text !== '' && text !== key ? text : null;
}

function build(entry, field, params, t) {
  let text = lookup(t, entry.key);
  if (text === null) return null;
  // {name} placeholders: only numbers from `params` are ever substituted (the entry may rename one: req_file_max says {n} for the server's `max`).
  for (const [placeholder, source] of Object.entries(entry.params || {})) {
    const value = params && params[source];
    if (!isCount(value)) return null;
    text = text.split(`{${placeholder}}`).join(String(value));
  }
  for (const [name, value] of Object.entries(params || {})) {
    if (isCount(value)) text = text.split(`{${name}}`).join(String(value));
  }
  if (/\{[a-z]+\}/.test(text)) return null; // a number the sentence needs was not sent: show the server's own text instead
  if (entry.field) {
    const labelKey = own(FIELD_LABEL_KEYS, field);
    const label = labelKey ? lookup(t, labelKey) : null;
    if (label) return `${label}: ${text}`;
  }
  return text;
}

export function localizedServerError(err, t) {
  const code = err && typeof err.code === 'string' ? err.code : null;
  const entry = code ? own(SERVER_ERRORS, code) : undefined;
  if (!entry) return null;
  return build(entry, err.field, err.params, t);
}

export function localizedFieldError(item, field, t) {
  const code = item && typeof item.code === 'string' ? item.code : null;
  const entry = code ? own(SERVER_ERRORS, code) : undefined;
  if (!entry) return null;
  // a field's own message sits under that field already: no label in front of it
  return build({ ...entry, field: false }, field, item.params, t);
}

// A file the server refused is remembered with its English message only (the upload state stores text, not the code: lib/requestUploads.js), so the list of files recognises the upload refusals by
// their fixed English wording and shows the dictionary text instead. Anything it does not recognise (including the app's own messages, already translated) comes back as null: the caller shows the
// stored text. data/serverErrorMessages.json is checked against the backend's real messages by backend/tests/safe/error-codes.test.js.
const UPLOAD_PATTERNS = UPLOAD_MESSAGES.map((item) => ({ ...item, regex: new RegExp(item.pattern) }));
export function localizedUploadMessage(message, t) {
  if (typeof message !== 'string' || message === '') return null;
  for (const item of UPLOAD_PATTERNS) {
    const match = item.regex.exec(message);
    if (!match) continue;
    const params = {};
    (item.params || []).forEach((name, i) => { params[name] = Number(match[i + 1]); });
    return localizedServerError({ code: item.code, params }, t);
  }
  return null;
}

export const SERVER_ERROR_CODES = Object.freeze(Object.keys(SERVER_ERRORS));
