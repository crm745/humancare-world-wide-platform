// Stable error codes for the patient request and document-upload API, so the mobile app can show every refusal in the person's own language (EN, HI, MR, GU, TE, AR).
//
// The server's `error` text stays exactly as it was (English): it is the fallback for an app that does not know a code, and for logs and other clients. What is ADDED to a 4xx answer, never
// changed or removed:
//   code         a stable identifier from CODES below (kept if the answer already had one)
//   field        the request field the message is about, when it names one of the known patient-form fields
//   params       the numbers a translated sentence needs ({ max: 30 }, { min: 1, max: 120 }): only numbers taken from the message, never a value the patient sent
//   fieldCodes   for an answer that carries a `fields` object ({ field: message }): the same code (and params) for each field
// HTTP statuses, the `error` text and every existing key are untouched. Nothing here ever reads or repeats what the patient typed, an identifier, a path or a server detail: a code is picked from the
// SHAPE of the message ("... is required", "... cannot be in the past"), and 5xx answers are not touched at all. The mobile app maps each code to a dictionary key in all six languages
// (apps/mobile/src/data/serverErrorKeys.json, with tests that keep the two lists identical).
//
// Pure (classify) plus one tiny Express middleware (attachErrorCodes) that decorates res.json for a router.

// Every code this module can produce, plus the codes the request/upload code already sends itself. Frozen: the mobile mapping and its tests are checked against this list.
const CODES = Object.freeze([
  // validation of a request body
  'required', 'phone_invalid', 'date_past', 'date_tomorrow', 'date_future', 'date_invalid', 'text_too_long', 'number_range', 'name_invalid', 'city_invalid', 'chars_invalid', 'value_invalid',
  'not_accepted', 'choice_invalid', 'oxygen_rate_required', 'oxygen_rate_range', 'oxygen_rate_invalid', 'travel_type_required', 'service_invalid', 'id_invalid', 'body_invalid',
  'validation_failed', 'app_update_required',
  // requests and documents
  'not_found', 'no_case_yet', 'uploads_not_available', 'file_required', 'file_unreadable', 'file_type_unsupported', 'file_type_mismatch', 'file_too_large', 'file_empty', 'file_upload_invalid',
  'too_many_documents', 'request_closed', 'request_approved', 'client_upload_id_reused', 'client_request_id_reused', 'file_infected', 'scan_unavailable', 'document_not_clean', 'document_not_scanned',
  'rate_limited',
]);
const CODE_SET = new Set(CODES);

// The patient-form field names a message may start with (so `field` is only ever one of these, never arbitrary text).
const KNOWN_FIELDS = new Set([
  'patientName', 'patientAge', 'patientGender', 'patientContact', 'patientLocation', 'country', 'origin', 'destination', 'originCity', 'destinationCity', 'currentCity', 'preferredDate',
  'careLevel', 'description', 'mobility', 'urgency', 'equipOxygen', 'equipOxygenLpm', 'equipCardiacMonitor', 'equipVentilator', 'consultationScope', 'consultationType', 'currentAddress',
  'presentMedicalIssue', 'allergyDetails', 'homeAddress', 'careRequirement', 'caretakerTypes', 'companyName', 'employeeCount', 'programmes', 'officeAddress', 'officeCountry', 'specialty',
  'otherSpecialty', 'treatmentScope', 'serviceScope', 'medicalHistory', 'details', 'deceasedName', 'deceasedRelation', 'placeOfDeath', 'dateOfDeath', 'transferScope', 'transportMode',
  'serviceKey', 'serviceType', 'utcOffsetMinutes', 'clientRequestId', 'clientUploadId', 'file',
]);

const number = (text) => Number(text);

// [pattern, code, params?(match) -> object]. First match wins: the specific ones come before the general predicates.
const RULES = [
  [/^The request body must be a JSON object/, 'body_invalid'],
  [/^Request not found$/, 'not_found'],
  [/^This request has no case yet/, 'no_case_yet'],
  [/^Document uploads are not available for /, 'uploads_not_available'],
  [/^file is required$/, 'file_required'],
  [/uploaded file could not be read/, 'file_unreadable'],
  [/^Unsupported file type/, 'file_type_unsupported'],
  [/^File too large$/, 'file_too_large'],
  [/^Unexpected field|^Too many files|^Multipart|^Field value too long/, 'file_upload_invalid'],
  [/content does not match its type/, 'file_type_mismatch'],
  [/uploaded file is empty/, 'file_empty'],
  [/(?:can hold|can have) at most (\d+) documents/, 'too_many_documents', (m) => ({ max: number(m[1]) })],
  [/Travel type is required/, 'travel_type_required'],
  [/^Unknown serviceKey|^serviceKey must be|^serviceType must be/, 'service_invalid'],
  [/must be a UUID/, 'id_invalid'],
  [/equipOxygenLpm is required when Oxygen/, 'oxygen_rate_required'],
  [/greater than 0 and at most ([\d.]+) LPM/, 'oxygen_rate_range', (m) => ({ max: number(m[1]) })],
  [/equipOxygenLpm (?:must be a number|can have at most one decimal)/, 'oxygen_rate_invalid'],
  // general predicates
  [/is required\b|Missing required field/, 'required'],
  [/valid phone number/, 'phone_invalid'],
  [/cannot be in the past/, 'date_past'],
  [/must be tomorrow or later/, 'date_tomorrow'],
  [/cannot be in the future/, 'date_future'],
  [/valid date/, 'date_invalid'],
  [/(?:can be|must be) at most (\d+) (?:characters|bytes)/, 'text_too_long', (m) => ({ max: number(m[1]) })],
  [/whole number (?:of minutes )?from (-?\d+) to (-?\d+)/, 'number_range', (m) => ({ min: number(m[1]), max: number(m[2]) })],
  [/include a letter|contain a letter|include a letter in/, 'name_invalid'],
  [/two-letter ISO 3166-1/, 'choice_invalid'],
  [/not a valid city|selected country|different country|timezone is not available|must be a city|exactly one of geonameId/, 'city_invalid'],
  [/characters that (?:are not allowed|cannot be saved)|invalid character/, 'chars_invalid'],
  [/must be text|single line|must be true or false/, 'value_invalid'],
  [/not accepted|only accepted/, 'not_accepted'],
  [/must be one of|Use one of|Use one or more|must be Male, Female or Other|must be a list of|must only hold|at least one programme|repeat|only once|listed specialties/, 'choice_invalid'],
];

const leadingField = (message) => {
  const match = /^([a-z][A-Za-z0-9]*)\b/.exec(message);
  return match && KNOWN_FIELDS.has(match[1]) ? match[1] : undefined;
};
// "Missing required field(s): origin, destination" names the first one.
const missingField = (message) => {
  const match = /Missing required field\(s\): ([A-Za-z0-9]+)/.exec(message);
  return match && KNOWN_FIELDS.has(match[1]) ? match[1] : undefined;
};

// { code, field?, params? } for a message. Anything it does not recognise is 'validation_failed'.
function classifyMessage(message) {
  if (typeof message !== 'string' || message === '') return { code: 'validation_failed' };
  const field = missingField(message) || leadingField(message);
  for (const [pattern, code, paramsOf] of RULES) {
    const match = pattern.exec(message);
    if (match) return { code, ...(field ? { field } : {}), ...(paramsOf ? { params: paramsOf(match) } : {}) };
  }
  return { code: 'validation_failed', ...(field ? { field } : {}) };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The answer body with the code fields added. A body that is not an { error: text } object, or that has no message, is returned as it is.
function withErrorCode(body, status = 400) {
  if (!isPlainObject(body) || typeof body.error !== 'string') return body;
  const found = classifyMessage(body.error);
  // 'validation_failed' is the catch-all for a refused BODY (400) only: any other refusal (404, 409, 413, 422, 429) gets a code only when its message is recognised, never a guess
  if (status !== 400 && found.code === 'validation_failed' && !(typeof body.code === 'string' && body.code !== '')) return body;
  const known = typeof body.code === 'string' && body.code !== '';
  const out = { ...body };
  if (!known) out.code = found.code;
  if (out.field === undefined && found.field) out.field = found.field;
  // numbers for the sentence: from the message, for the code the answer ended up with (an explicit code keeps its own, e.g. too_many_documents)
  if (out.params === undefined) {
    const own = known ? classifyMessage(body.error) : found;
    if (own.params && (!known || own.code === body.code)) out.params = own.params;
  }
  if (isPlainObject(body.fields) && out.fieldCodes === undefined) {
    const fieldCodes = {};
    for (const [name, message] of Object.entries(body.fields)) {
      if (typeof message !== 'string') continue;
      const entry = classifyMessage(message);
      fieldCodes[name] = { code: entry.code, ...(entry.params ? { params: entry.params } : {}) };
    }
    if (Object.keys(fieldCodes).length) out.fieldCodes = fieldCodes;
  }
  return out;
}

// Express middleware: the refusals a patient can act on (400, 404, 409, 413, 422, 429) of the router it is mounted on get their code fields (res.json is wrapped; send(object) goes through it too).
// 2xx, 3xx, 5xx and the sign-in answers (401, 403) are never touched.
const DECORATED_STATUSES = new Set([400, 404, 409, 413, 422, 429]);
function attachErrorCodes(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => json(DECORATED_STATUSES.has(res.statusCode) ? withErrorCode(body, res.statusCode) : body);
  next();
}

module.exports = { CODES, CODE_SET, KNOWN_FIELDS, classifyMessage, withErrorCode, attachErrorCodes };
