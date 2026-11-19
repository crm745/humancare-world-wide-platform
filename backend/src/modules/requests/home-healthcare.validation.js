// Strict validation of a Home Healthcare Services request (serviceKey "homecare"). Pure: no database, no network. The controller calls it before anything
// is written and passes the returned `data` (never the raw body) on to createRequest, which stores it like any other request.
//
// This module is deliberately self-contained: it imports nothing from the Teleconsultation or Mortal Remains modules (own address helper, own date
// helpers). It uses only neutral shared code (libphonenumber-js and the oxygen flow-rate rule in request.constants.js).
//
// What the app sends and what is stored
//   homeAddress       the Complete Home Address, as typed. Stored EXACTLY (no trimming, no line-ending conversion, no Unicode normalization) inside
//                     `description`. origin / patient_location get a one-line CONVENIENCE copy of it (at most 191 characters); destination is ''.
//   medicalHistory    optional free text, stored exactly inside `description` (the existing Condition & Diagnosis field, relabelled).
//   preferredDate     the Service Date, required: today or later by the PATIENT's own calendar (utcOffsetMinutes, minutes east of UTC, is required).
//   caretakerTypes    optional, ["nurse", "caretaker"]            -> caretaker_types  ("nurse,caretaker", canonical order)
//   careRequirement   optional, "12_hours" | "24_hours"            -> care_requirement
//   careLevel         optional, "full_icu" | "semi_icu"            -> care_level       ("Full ICU" / "Semi ICU")
//   equipOxygen       optional boolean                             -> equip_oxygen
//   equipOxygenLpm    required when equipOxygen is true, refused otherwise -> equip_oxygen_lpm
//
// The description is composed HERE (a client-sent `description` is refused) in a versioned, length-framed format, so patient text can never be mistaken
// for system text and is never searched for markers:
//
//   Home Healthcare v1 (address <A>, history <H>)
//   Complete home address:
//   <exactly A UTF-16 code units: the address as typed>
//   Medical History:                             (only when entered)
//   <exactly H UTF-16 code units: the text as typed>
//
// <A> and <H> are JavaScript string lengths (UTF-16 code units). The patient-facing limit is separate and counts Unicode code points (2,000).
// The care answers are NOT in the description (they are in caretaker_types, care_requirement, care_level, equip_oxygen, equip_oxygen_lpm). Rows saved before that change
// also carry optional care lines (Nurse / Caretaker, Care Requirement, Care Level, Oxygen) between the header and the address; parseHomeDescription still reads them.
// A request is "new format" only when its serviceKey is homecare AND this whole text parses (parseHomeDescription); anything else is legacy.
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { oxygenLpmProblem } = require('../../common/constants/request.constants');

const HOME_SERVICE_KEY = 'homecare';
const HOME_SERVICE_TYPE = 'Home Healthcare Services';

const CARETAKERS = { nurse: 'Nurse', caretaker: 'Caretaker' }; // the only options; this is also the canonical order
const HOURS = { '12_hours': '12 Hours', '24_hours': '24 Hours' };
const LEVELS = { full_icu: 'Full ICU', semi_icu: 'Semi ICU' };
const GENDERS = { male: 'Male', female: 'Female', other: 'Other' };

const TEXT_MAX = 2000; // Unicode code points, for the address and for Medical History (the patient-facing limit)
const FRAME_MAX = 4000; // 2,000 code points are at most 4,000 UTF-16 code units: the largest framing length the parser accepts
const ONE_LINE_MAX = 191; // origin / patient_location are VARCHAR(191)
const BOUNDARY_MIN = 100;
const NAME_MIN = 2;
const NAME_MAX = 100;
const COUNTRY_MAX = 100;
const AGE_MIN = 1;
const AGE_MAX = 129;
const OFFSET_MIN = -720;
const OFFSET_MAX = 840;

const ALLOWED_FIELDS = new Set([
  'serviceType', 'serviceKey', 'patientName', 'patientAge', 'patientGender', 'country', 'patientContact', 'homeAddress', 'preferredDate', 'utcOffsetMinutes',
  'caretakerTypes', 'careRequirement', 'careLevel', 'equipOxygen', 'equipOxygenLpm', 'medicalHistory',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (value) => value === undefined || value === null;
// Unicode code points, as a person (and MySQL utf8mb4) counts characters: an emoji is one.
const codePoints = (text) => Array.from(text).length;
// The Unicode line and paragraph separators, by code point so this source stays plain ASCII.
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const LINE_SPLIT = new RegExp(`\\r\\n|[\\r\\n${SEPARATORS}]`);
const hasLineBreak = (text) => /[\n\r]/.test(text) || text.includes(SEPARATORS[0]) || text.includes(SEPARATORS[1]);

// ---- the character rules for patient free text -----------------------------------------------------------------------------------------------------
// Rejected: every control character (Unicode category Cc) EXCEPT TAB, LF and CR, i.e. U+0000-0008, U+000B, U+000C, U+000E-001F, DEL (U+007F) and
// U+0080-009F; and unpaired surrogates (not valid text; they cannot survive UTF-8 storage). Everything else is accepted as typed: Unicode separators,
// zero-width and bidirectional format characters, emoji and ZWJ sequences, combining marks and every script. An explicit code-unit loop (not a regex)
// so the result is identical on every JavaScript engine, and so the mobile form can use the very same rule.
function hasDisallowedControl(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
    if (c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}
function hasUnpairedSurrogate(text) {
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
// Why a free-text value cannot be accepted, or null. The text itself is never changed. `required` means not empty or whitespace-only, judged on a
// trimmed COPY (the stored value is the original).
function freeTextProblem(field, value, { required }) {
  if (typeof value !== 'string') return required ? `${field} is required` : `${field} must be text`;
  if (required && value.trim() === '') return `${field} is required`;
  if (hasDisallowedControl(value) || hasUnpairedSurrogate(value)) return `${field} contains characters that cannot be saved`;
  if (codePoints(value) > TEXT_MAX) return `${field} can be at most ${TEXT_MAX} characters`;
  return null;
}

// ---- the address: a one-line convenience copy ----------------------------------------------------------------------------------------------------------
const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (text) => (segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text));

// At most `max` characters; a longer text is cut on a character boundary (never inside an emoji sequence or a letter with its accents), at the last
// comma or space when that is not too far back, and ends with "…".
function shortenLine(text, max = ONE_LINE_MAX) {
  if (codePoints(text) <= max) return text;
  const room = max - 1;
  let out = '';
  let count = 0;
  for (const piece of graphemes(text)) {
    const size = codePoints(piece);
    if (count + size > room) break;
    out += piece;
    count += size;
  }
  const cut = Math.max(out.lastIndexOf(', '), out.lastIndexOf(' '));
  if (cut > 0 && codePoints(out.slice(0, cut)) >= BOUNDARY_MIN) out = out.slice(0, cut);
  return `${out.replace(/[\s,]+$/, '')}…`;
}
// The address as one line: every line trimmed, blank lines dropped, joined with ", ", then shortened. Never the exact text (that is in the description).
function oneLineAddress(address) {
  return shortenLine(address.split(LINE_SPLIT).map((line) => line.trim()).filter(Boolean).join(', '));
}

// ---- dates (the patient's own calendar) ---------------------------------------------------------------------------------------------------------------------
// "YYYY-MM-DD" that is a real calendar day ("2026-02-30" is refused), or null.
function calendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  const real = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  return real ? value : null;
}
// The patient's own today: the moment `now` seen on a clock `utcOffsetMinutes` minutes east of UTC (what the app's date picker uses).
const patientToday = (now, utcOffsetMinutes) => new Date(now.getTime() + utcOffsetMinutes * 60000).toISOString().slice(0, 10);

// ---- the description: compose and parse ----------------------------------------------------------------------------------------------------------------
const ADDRESS_LABEL = 'Complete home address:';
const HISTORY_LABEL = 'Medical History:';
const HEADER = /^Home Healthcare v1 \(address (0|[1-9]\d{0,3}), history (0|[1-9]\d{0,3})\)$/;
// The care lines, in their fixed order. Each is matched exactly; none ever holds patient text.
const CARE_LINES = [
  ['caretaker', /^Nurse \/ Caretaker: (Nurse|Caretaker|Nurse, Caretaker)$/],
  ['hours', /^Care Requirement: (12 Hours|24 Hours)$/],
  ['level', /^Care Level: (Full ICU|Semi ICU)$/],
  ['oxygen', /^Oxygen: (No|Yes \((\d{1,2}(?:\.\d)?) LPM\))$/],
];

// The description of a NEW request: only the Complete Home Address and the Medical History. The care answers (caretaker types, care requirement, care level, oxygen) are
// stored in their own columns and are NOT repeated here. `care` is only for the care lines that rows saved BEFORE this change carry (the parser below still reads them);
// the validator never passes it.
// `care`: { caretakerTypes: ['nurse', ...], careRequirement, careLevel, equipOxygen: true|false|undefined, equipOxygenLpm } (all optional).
function composeHomeDescription({ care = {}, address, history = '' }) {
  const lines = [];
  const caretakers = (care.caretakerTypes || []).map((key) => CARETAKERS[key]).filter(Boolean);
  if (caretakers.length) lines.push(`Nurse / Caretaker: ${caretakers.join(', ')}`);
  if (care.careRequirement) lines.push(`Care Requirement: ${HOURS[care.careRequirement]}`);
  if (care.careLevel) lines.push(`Care Level: ${LEVELS[care.careLevel]}`);
  if (care.equipOxygen === true) lines.push(`Oxygen: Yes (${care.equipOxygenLpm} LPM)`);
  else if (care.equipOxygen === false) lines.push('Oxygen: No');
  const parts = [`Home Healthcare v1 (address ${address.length}, history ${history.length})`, ...lines, `${ADDRESS_LABEL}\n${address}`];
  if (history !== '') parts.push(`${HISTORY_LABEL}\n${history}`);
  return parts.join('\n');
}

const INVALID = Object.freeze({ ok: false });
// The strict parser. { ok: true, address, history, care } or { ok: false }. Linear; it never searches inside patient text (the lengths in the header
// say where the address and the history end); it never throws; any deviation at all is "invalid" and nothing is partially parsed.
function parseHomeDescription(text) {
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
    // a frame that cut a surrogate pair in two, or a corrupted text, is not valid
    if (hasUnpairedSurrogate(address) || hasUnpairedSurrogate(history)) return INVALID;
    return { ok: true, address, history, care };
  } catch {
    return INVALID;
  }
}

// True for a stored request that is a NEW-format Home Healthcare request: its key is homecare and its whole description parses. A missing or invalid
// marker, an unknown version or a corrupted text is a legacy request. The destination is never consulted.
const isNewHomeFormat = (request) => !!request && request.serviceKey === HOME_SERVICE_KEY && parseHomeDescription(request.description).ok;

// ---- the validator ------------------------------------------------------------------------------------------------------------------------------------------------
// Returns { error } (the first problem, as the other validators report one) or { data } for createRequest.
function validateHomeRequest(body, { now = new Date() } = {}) {
  if (!isObject(body)) return { error: 'The request body must be a JSON object.' };

  // Anything the Home Healthcare format does not carry (description, origin, destination, patientLocation, urgency, mobility, other equipment...).
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) return { error: `${key} is not accepted for Home Healthcare requests` };
  }
  if (body.serviceKey !== HOME_SERVICE_KEY) return { error: 'serviceKey must be "homecare" for Home Healthcare requests' };
  if (body.serviceType !== HOME_SERVICE_TYPE) return { error: `serviceType must be "${HOME_SERVICE_TYPE}" for Home Healthcare requests` };

  // Patient
  if (typeof body.patientName !== 'string') return { error: 'patientName is required' };
  const name = body.patientName.trim();
  if (hasDisallowedControl(name) || hasUnpairedSurrogate(name) || /[\t]/.test(name) || hasLineBreak(name)) return { error: 'patientName contains characters that are not allowed' };
  if (codePoints(name) < NAME_MIN || codePoints(name) > NAME_MAX || !/\p{L}/u.test(name)) return { error: `patientName must be ${NAME_MIN} to ${NAME_MAX} characters and include a letter` };

  const ageText = typeof body.patientAge === 'number' ? String(body.patientAge) : body.patientAge;
  if (typeof ageText !== 'string' || !/^[1-9]\d{0,2}$/.test(ageText.trim()) || Number(ageText) < AGE_MIN || Number(ageText) > AGE_MAX) {
    return { error: `patientAge must be a whole number from ${AGE_MIN} to ${AGE_MAX}` };
  }
  const age = Number(ageText);

  const gender = typeof body.patientGender === 'string' ? GENDERS[body.patientGender.trim().toLowerCase()] : undefined;
  if (!gender) return { error: 'patientGender must be Male, Female or Other' };

  if (typeof body.country !== 'string') return { error: 'country is required' };
  const country = body.country.trim();
  if (!country || codePoints(country) > COUNTRY_MAX || hasDisallowedControl(country) || hasUnpairedSurrogate(country) || /[\t]/.test(country) || hasLineBreak(country)) {
    return { error: 'country is required' };
  }

  const phone = typeof body.patientContact === 'string' && body.patientContact.trim().startsWith('+') ? parsePhoneNumberFromString(body.patientContact.trim()) : null;
  if (!phone || !phone.isValid()) return { error: 'patientContact must be a valid phone number with its country code' };

  // The Complete Home Address and Medical History: exact text, never altered.
  const addressProblem = freeTextProblem('homeAddress', body.homeAddress, { required: true });
  if (addressProblem) return { error: addressProblem };
  let history = '';
  if (!missing(body.medicalHistory)) {
    const historyProblem = freeTextProblem('medicalHistory', body.medicalHistory, { required: false });
    if (historyProblem) return { error: historyProblem };
    // Whitespace-only is "not provided": nothing is stored (and no Medical History section is written).
    history = body.medicalHistory.trim() === '' ? '' : body.medicalHistory;
  }

  // The Service Date, by the patient's own calendar.
  if (!Number.isInteger(body.utcOffsetMinutes) || body.utcOffsetMinutes < OFFSET_MIN || body.utcOffsetMinutes > OFFSET_MAX) {
    return { error: `utcOffsetMinutes is required: a whole number of minutes from ${OFFSET_MIN} to ${OFFSET_MAX} (minutes east of UTC)` };
  }
  if (typeof body.preferredDate !== 'string' || !calendarDate(body.preferredDate)) return { error: 'preferredDate must be a valid date (YYYY-MM-DD)' };
  if (body.preferredDate < patientToday(now, body.utcOffsetMinutes)) return { error: 'preferredDate cannot be in the past' };

  // The care selections: all optional.
  let caretakerTypes = [];
  if (!missing(body.caretakerTypes)) {
    if (!Array.isArray(body.caretakerTypes)) return { error: `caretakerTypes must be a list of: ${Object.keys(CARETAKERS).join(', ')}` };
    for (const value of body.caretakerTypes) {
      if (typeof value !== 'string' || !Object.hasOwn(CARETAKERS, value)) return { error: `caretakerTypes must be a list of: ${Object.keys(CARETAKERS).join(', ')}` };
    }
    if (new Set(body.caretakerTypes).size !== body.caretakerTypes.length) return { error: 'caretakerTypes cannot repeat a value' };
    caretakerTypes = Object.keys(CARETAKERS).filter((key) => body.caretakerTypes.includes(key)); // canonical order
  }
  if (!missing(body.careRequirement) && (typeof body.careRequirement !== 'string' || !Object.hasOwn(HOURS, body.careRequirement))) {
    return { error: `careRequirement must be one of: ${Object.keys(HOURS).join(', ')}` };
  }
  if (!missing(body.careLevel) && (typeof body.careLevel !== 'string' || !Object.hasOwn(LEVELS, body.careLevel))) {
    return { error: `careLevel must be one of: ${Object.keys(LEVELS).join(', ')}` };
  }
  let oxygen;
  let oxygenLpm = null;
  if (!missing(body.equipOxygen)) {
    if (typeof body.equipOxygen !== 'boolean') return { error: 'equipOxygen must be true or false' };
    oxygen = body.equipOxygen;
  }
  if (oxygen === true) {
    if (missing(body.equipOxygenLpm)) return { error: 'equipOxygenLpm is required when Oxygen is Yes' };
    const lpmProblem = oxygenLpmProblem(body.equipOxygenLpm);
    if (lpmProblem) return { error: lpmProblem };
    oxygenLpm = Number(body.equipOxygenLpm.toFixed(1)); // one decimal at most, so the text form is exactly what the parser expects
  } else if (!missing(body.equipOxygenLpm)) {
    return { error: 'equipOxygenLpm is only accepted when Oxygen is Yes' };
  }

  const careRequirement = missing(body.careRequirement) ? null : body.careRequirement;
  const careLevel = missing(body.careLevel) ? null : body.careLevel;
  const line = oneLineAddress(body.homeAddress);
  return {
    data: {
      serviceType: HOME_SERVICE_TYPE,
      serviceKey: HOME_SERVICE_KEY,
      patientName: name,
      patientAge: age,
      patientGender: gender,
      patientContact: phone.formatInternational(),
      country,
      origin: line,
      patientLocation: line,
      destination: '',
      preferredDate: body.preferredDate,
      careRequirement,
      caretakerTypes: caretakerTypes.length ? caretakerTypes.join(',') : null,
      careLevel: careLevel ? LEVELS[careLevel] : null,
      ...(oxygen !== undefined ? { equipOxygen: oxygen } : {}),
      ...(oxygen === true ? { equipOxygenLpm: oxygenLpm } : {}),
      // Only the address and the medical history: the care answers are in their columns above and are not repeated.
      description: composeHomeDescription({ address: body.homeAddress, history }),
    },
  };
}

module.exports = {
  HOME_SERVICE_KEY, HOME_SERVICE_TYPE, CARETAKERS, HOURS, LEVELS, GENDERS, TEXT_MAX, FRAME_MAX, ONE_LINE_MAX,
  isHomeKey: (serviceKey) => serviceKey === HOME_SERVICE_KEY,
  validateHomeRequest, composeHomeDescription, parseHomeDescription, isNewHomeFormat,
  hasDisallowedControl, hasUnpairedSurrogate, freeTextProblem, oneLineAddress, shortenLine, calendarDate, patientToday,
};
