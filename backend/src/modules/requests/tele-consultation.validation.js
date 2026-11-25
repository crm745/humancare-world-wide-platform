// Strict validation of a Teleconsultation request in the structured format (serviceKey "tele" plus the consultation fields).
// Pure: no database, no network. The controller calls it before anything is written, and passes the returned `data` (never the raw body) on
// to createRequest, which stores it exactly as it stores any other service's request.
//
// The app sends the consultation answers as structured fields and the address once, as typed. THIS file derives what is stored:
//   origin / patient_location   the address as one line (lines trimmed, blanks dropped, joined with ", "), at most 191 characters
//                               (the columns are VARCHAR(191)); a longer one is cut at a comma or space and ends with "…"
//   destination                 '' (a consultation has no destination; nothing is invented)
//   consultation_type           "online" | "house_call"
//   transfer_scope              "domestic" | "international" for a House Call; NULL for an Online Consultation
//   description                 labelled sections: Present medical issue, Allergic issue (only the ones given). The type, the scope and the address are NOT repeated in it.
//                               NOTE: the address now lives only in origin / patient_location (VARCHAR(191)); an address longer than that, or with line breaks, is kept
//                               in its one-line, shortened form (see above). Rows saved before this change also carry "Scope:", "Consultation type:" and "Current address:"
//                               sections in the description, which the readers still understand.
//   preferred_date              the visit day for a House Call, otherwise nothing: tomorrow or later by the PATIENT's own calendar (today and every
//                               past day are refused). The server is not told a time zone, so the app sends the device's UTC offset
//                               (utcOffsetMinutes) and the server works out the patient's today from it, the same clock the date picker uses.
// A request WITHOUT any of the structured fields (an older app build) is not handled here: it keeps the original generic path.
//
// Not covered here, on purpose: documents (refused in the controller), Bitrix (untouched; it reads the stored request as it always did).
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const TELE_SERVICE_KEY = 'tele';
const TELE_SERVICE_TYPE = 'Tele Consultation & House Call';

const SCOPES = { domestic: 'Domestic', international: 'International' };
const TYPES = { online: 'Online Consultation', house_call: 'House Call' };
const GENDERS = { male: 'Male', female: 'Female', other: 'Other' };

const ORIGIN_MAX = 191; // service_requests.origin / patient_location are VARCHAR(191): this many characters (code points)
const ADDRESS_MAX = 2000;
const TEXT_MAX = 2000;
const NAME_MIN = 2;
const NAME_MAX = 100;
const COUNTRY_MAX = 100;
const AGE_MAX = 129;
// The UTC offsets that exist: UTC-12 to UTC+14, in minutes east of UTC.
const OFFSET_MIN = -720;
const OFFSET_MAX = 840;
// A shortened address is cut at the last comma or space only if that keeps at least this many characters; otherwise it is cut at the limit.
const BOUNDARY_MIN = 100;

// The fields that mark a request as the structured Teleconsultation format.
const STRUCTURED_FIELDS = ['consultationScope', 'consultationType', 'currentAddress', 'presentMedicalIssue', 'allergyDetails'];
const ALLOWED_FIELDS = new Set([
  'serviceType', 'serviceKey', ...STRUCTURED_FIELDS,
  'patientName', 'patientAge', 'patientGender', 'country', 'patientContact', 'preferredDate', 'utcOffsetMinutes',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (value) => value === undefined || value === null;
// Characters as a person (and MySQL) counts them: an emoji is one, not two UTF-16 units.
const length = (text) => Array.from(text).length;
// Control characters other than a tab or a line break are never part of a name, an address or a note.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// The Unicode line and paragraph separators are line breaks too; named by code point so this source stays plain ASCII.
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const hasLineBreak = (text) => /[\n\r]/.test(text) || text.includes(SEPARATORS[0]) || text.includes(SEPARATORS[1]);
// Every kind of line break as \n.
const toLF = (text) => text.replace(/\r\n?/g, '\n').split(SEPARATORS[0]).join('\n').split(SEPARATORS[1]).join('\n');

// True when the body is the structured Teleconsultation format.
function isTeleStructuredRequest(body) {
  return isObject(body) && body.serviceKey === TELE_SERVICE_KEY && STRUCTURED_FIELDS.some((field) => body[field] !== undefined);
}

// A stored request made in the structured format: its destination is empty (every older Teleconsultation request has one, because the old form
// and API required it). Used to decide who gets the new displays, and that new requests take no documents.
function isStructuredTeleRow(request) {
  return !!request && request.serviceKey === TELE_SERVICE_KEY && (request.destination === '' || request.destination === null || request.destination === undefined);
}

// ---- the address -----------------------------------------------------------------------------------------------------------------------------
const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
// What a person sees as one character (an emoji with a skin tone, a flag, a letter with its accents): never split.
const graphemes = (text) => (segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text));

// The address as typed, with line breaks as \n and no space around it.
const originalAddress = (raw) => toLF(raw).trim();
// The one-line form: every line trimmed, blank lines dropped, joined with ", ". Not shortened yet.
const joinLines = (raw) => toLF(raw).split('\n').map((line) => line.trim()).filter(Boolean).join(', ');

// At most `max` characters. A longer text is cut on a character boundary (never inside an emoji or a letter with its accents), at the last
// comma or space when that is not too far back, and ends with "…".
function shorten(text, max = ORIGIN_MAX) {
  if (length(text) <= max) return text;
  const room = max - 1; // the "…"
  let out = '';
  let count = 0;
  for (const piece of graphemes(text)) {
    const size = length(piece);
    if (count + size > room) break;
    out += piece;
    count += size;
  }
  const cut = Math.max(out.lastIndexOf(', '), out.lastIndexOf(' '));
  if (cut > 0 && length(out.slice(0, cut)) >= BOUNDARY_MIN) out = out.slice(0, cut);
  return `${out.replace(/[\s,]+$/, '')}…`;
}

// { line: what goes in origin / patient_location, original: the address as typed, changed: whether the description must carry the original }
function deriveAddress(raw) {
  const original = originalAddress(raw);
  const joined = joinLines(raw);
  const line = shorten(joined);
  return { line, original, changed: joined !== original || line !== joined };
}

// ---- the description -------------------------------------------------------------------------------------------------------------------------
// Labelled sections, in this order, separated by a blank line. A section that was not provided is left out.
// The description of a NEW request holds ONLY the two notes. The consultation type is in consultation_type, the House Call scope in transfer_scope and the current
// address in origin / patient_location; none of them is repeated here. '' when neither note was given (createRequest stores NULL).
function composeDescription({ issue, allergy }) {
  const parts = [];
  if (issue) parts.push(`Present medical issue:\n${issue}`);
  if (allergy) parts.push(`Allergic issue:\n${allergy}`);
  return parts.join('\n\n');
}

// COMPATIBILITY: requests saved before the consultation_type column carry the type, the scope and (when it did not fit a column) the address as labelled sections in the
// description. This builds that older text; it exists for tests and is never used for a new request.
function composeLegacyDescription({ scope, type, address, issue, allergy }) {
  const parts = [scope ? `Scope: ${SCOPES[scope]}\nConsultation type: ${TYPES[type]}` : `Consultation type: ${TYPES[type]}`];
  if (address) parts.push(`Current address:\n${address}`);
  if (issue) parts.push(`Present medical issue:\n${issue}`);
  if (allergy) parts.push(`Allergic issue:\n${allergy}`);
  return parts.join('\n\n');
}

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

// The earliest day a House Call can be asked for: TOMORROW by the patient's own calendar. Their today is the moment `now` seen on a clock that is
// `utcOffsetMinutes` minutes east of UTC (what the app's date picker uses), so the same instant gives the same day on the phone and here. Today and
// every past day are refused; no day that is tomorrow for the patient is.
function earliestVisitDay(now, utcOffsetMinutes) {
  const local = new Date(now.getTime() + utcOffsetMinutes * 60000);
  const tomorrow = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1));
  return tomorrow.toISOString().slice(0, 10);
}

// ---- the validator ---------------------------------------------------------------------------------------------------------------------------
// text(): an optional free-text field: nothing, or a string without control characters, trimmed, at most `max` characters. Returns { value } or { error }.
function text(body, field, max, { required = false } = {}) {
  const raw = body[field];
  if (missing(raw)) return required ? { error: `${field} is required` } : { value: '' };
  if (typeof raw !== 'string') return { error: `${field} must be text` };
  if (CONTROL.test(raw)) return { error: `${field} contains characters that are not allowed` };
  const value = originalAddress(raw);
  if (!value) return required ? { error: `${field} is required` } : { value: '' };
  if (length(value) > max) return { error: `${field} can be at most ${max} characters` };
  return { value };
}

// Returns { error } (the first problem, as the existing generic path reports one) or { data } for createRequest.
function validateTeleRequest(body, { now = new Date() } = {}) {
  if (!isObject(body)) return { error: 'The request body must be a JSON object.' };

  // Anything the structured format does not carry (origin, destination, description, urgency, care level, mobility, equipment, files ...).
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) return { error: `${key} is not accepted for Teleconsultation requests` };
  }
  if (body.serviceKey !== TELE_SERVICE_KEY) return { error: 'serviceKey must be "tele" for Teleconsultation requests' };
  if (body.serviceType !== TELE_SERVICE_TYPE) return { error: `serviceType must be "${TELE_SERVICE_TYPE}" for Teleconsultation requests` };

  if (typeof body.consultationType !== 'string' || !Object.hasOwn(TYPES, body.consultationType)) {
    return { error: `consultationType must be one of: ${Object.keys(TYPES).join(', ')}` };
  }
  // The Scope (Domestic / International) belongs to a House Call only: it is required there. An Online Consultation has none and is not asked for one.
  // A value sent anyway (an older app build always sent it) must still be a real option, and is then ignored: neither stored nor put in the description.
  const houseCall = body.consultationType === 'house_call';
  if ((houseCall || !missing(body.consultationScope)) && (typeof body.consultationScope !== 'string' || !Object.hasOwn(SCOPES, body.consultationScope))) {
    return { error: `consultationScope must be one of: ${Object.keys(SCOPES).join(', ')}` };
  }

  // Patient
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

  if (typeof body.country !== 'string' || !body.country.trim() || length(body.country.trim()) > COUNTRY_MAX || CONTROL.test(body.country) || hasLineBreak(body.country)) {
    return { error: 'country is required' };
  }
  const country = body.country.trim();

  const phone = typeof body.patientContact === 'string' && body.patientContact.trim().startsWith('+') ? parsePhoneNumberFromString(body.patientContact.trim()) : null;
  if (!phone || !phone.isValid()) return { error: 'patientContact must be a valid phone number with its country code' };

  // Address, and the two notes
  const address = text(body, 'currentAddress', ADDRESS_MAX, { required: true });
  if (address.error) return { error: address.error };
  const issue = text(body, 'presentMedicalIssue', TEXT_MAX);
  if (issue.error) return { error: issue.error };
  const allergy = text(body, 'allergyDetails', TEXT_MAX);
  if (allergy.error) return { error: allergy.error };

  // The device's UTC offset, which is how the patient's own date is known here (see earliestVisitDay).
  let offset = null;
  if (!missing(body.utcOffsetMinutes)) {
    if (!Number.isInteger(body.utcOffsetMinutes) || body.utcOffsetMinutes < OFFSET_MIN || body.utcOffsetMinutes > OFFSET_MAX) {
      return { error: `utcOffsetMinutes must be a whole number of minutes from ${OFFSET_MIN} to ${OFFSET_MAX} (minutes east of UTC)` };
    }
    offset = body.utcOffsetMinutes;
  }

  // The visit day: a House Call needs one (tomorrow or later, by the patient's own date), an Online Consultation takes none.
  let preferredDate = null;
  if (body.consultationType === 'house_call') {
    if (missing(body.preferredDate)) return { error: 'preferredDate is required for a House Call' };
    if (typeof body.preferredDate !== 'string' || !calendarDate(body.preferredDate)) return { error: 'preferredDate must be a valid date (YYYY-MM-DD)' };
    if (offset === null) return { error: 'utcOffsetMinutes is required for a House Call (the device\'s minutes east of UTC)' };
    if (body.preferredDate < earliestVisitDay(now, offset)) return { error: 'preferredDate must be tomorrow or later' };
    preferredDate = body.preferredDate;
  } else if (!missing(body.preferredDate)) {
    return { error: 'preferredDate is only accepted for a House Call' };
  }

  const derived = deriveAddress(body.currentAddress);
  return {
    data: {
      serviceType: TELE_SERVICE_TYPE,
      serviceKey: TELE_SERVICE_KEY,
      patientName: name,
      patientAge: age,
      patientGender: gender,
      patientContact: phone.formatInternational(),
      country,
      origin: derived.line,
      patientLocation: derived.line,
      destination: '',
      preferredDate,
      consultationType: body.consultationType,
      transferScope: houseCall ? body.consultationScope : null, // House Call only; an Online Consultation has no scope
      description: composeDescription({ issue: issue.value, allergy: allergy.value }),
    },
  };
}

module.exports = {
  TELE_SERVICE_KEY, TELE_SERVICE_TYPE, SCOPES, TYPES, ORIGIN_MAX, ADDRESS_MAX, TEXT_MAX,
  isTeleStructuredRequest, isStructuredTeleRow, validateTeleRequest, deriveAddress, shorten, composeDescription, composeLegacyDescription, calendarDate, earliestVisitDay,
};
