// Turns the stored values of older requests into the formats the Private Charter validation
// stores today. Pure functions: nothing here touches a database, and no result ever carries the
// value it was given (only reason codes), so a report built from them can be shared safely.
//
// Every function returns { status, value?, reason? }:
//   "empty"      nothing stored, nothing to do
//   "unchanged"  already in today's format
//   "normalize"  a lossless rewrite to `value` (the one unambiguous reading of the old text)
//   "review"     cannot be read with certainty: a person must look; the row is never rewritten
//
// The rule behind every "review": guessing is worse than leaving the old text where it is.

const {
  GENDERS, CARE_LEVEL_KEYS, CARE_LEVEL_EXCLUSIVE, CARE_LEVEL_LEGACY_LABELS,
} = require('../constants/request.constants');
const { COUNTRIES } = require('../constants/countries');
const { normalizeMobile } = require('./phone');

const empty = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const unchanged = () => ({ status: 'unchanged' });
const normalize = (value) => ({ status: 'normalize', value });
const review = (reason) => ({ status: 'review', reason });

// --- Gender: "Male" / "Female" / "Other" (older builds) -> "male" / "female" / "other" -----------
function normalizeGender(value) {
  if (empty(value)) return { status: 'empty' };
  if (typeof value !== 'string') return review('gender_not_text');
  if (GENDERS.includes(value)) return unchanged();
  const folded = value.trim().toLowerCase();
  if (GENDERS.includes(folded)) return normalize(folded);
  return review('gender_unrecognised');
}

// --- Care level: one comma-joined string of keys -----------------------------------------------
const LABEL_TO_KEY = new Map(
  Object.entries(CARE_LEVEL_LEGACY_LABELS).flatMap(([key, labels]) => labels.map((label) => [label.normalize('NFC'), key])),
);

// Reads "care_icu,care_stable", the corporate portal's "care_icu, care_stable" and the mobile
// app's translated "ICU / Critical, Stable / Monitored" (any of the six languages, mixed or not).
function normalizeCareLevel(value) {
  if (empty(value)) return { status: 'empty' };
  if (typeof value !== 'string') return review('care_level_not_text');
  const keys = [];
  let sawLabel = false;
  for (const raw of value.split(',')) {
    const token = raw.trim().normalize('NFC');
    if (CARE_LEVEL_KEYS.includes(token)) keys.push(token);
    else if (LABEL_TO_KEY.has(token)) { keys.push(LABEL_TO_KEY.get(token)); sawLabel = true; }
    else return review('care_level_unrecognised_value');
  }
  const distinct = [...new Set(keys)];
  // "Not applicable" is only valid on its own; the person's real intent is unknowable.
  if (distinct.includes(CARE_LEVEL_EXCLUSIVE) && distinct.length > 1) return review('care_level_not_applicable_combined');
  const joined = distinct.join(',');
  if (joined === value && !sawLabel) return unchanged();
  return normalize(joined);
}

// --- Country: English name (what the app used to send) -> ISO 3166-1 alpha-2 --------------------
const fold = (text) => String(text)
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[’`]/g, "'").replace(/&/g, ' and ').replace(/\./g, '')
  .replace(/\s+/g, ' ').trim();

const CODES = new Set(COUNTRIES.map((c) => c.code));
const NAME_TO_CODE = new Map(COUNTRIES.map((c) => [fold(c.name), c.code]));
// Only spellings with exactly one reading. "Korea" or "Congo" alone are deliberately absent.
const COUNTRY_ALIASES = new Map([
  ['usa', 'US'], ['united states of america', 'US'], ['uae', 'AE'], ['turkey', 'TR'],
  ['czech republic', 'CZ'], ['ivory coast', 'CI'], ['swaziland', 'SZ'], ['macedonia', 'MK'],
].map(([name, code]) => [fold(name), code]));

function normalizeCountry(value) {
  if (empty(value)) return { status: 'empty' };
  if (typeof value !== 'string') return review('country_not_text');
  if (CODES.has(value)) return unchanged();
  const trimmed = value.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed) && CODES.has(trimmed.toUpperCase())) return normalize(trimmed.toUpperCase());
  const code = NAME_TO_CODE.get(fold(trimmed)) || COUNTRY_ALIASES.get(fold(trimmed));
  return code ? normalize(code) : review('country_unrecognised');
}

// --- Contact number: "+971 501234567" -> "+971501234567" ----------------------------------------
// A number without its "+" has no country to be checked against, and the country field cannot
// stand in for it (the patient's country is not their phone's country): review, never a guess.
function normalizePhone(value) {
  if (empty(value)) return { status: 'empty' };
  if (typeof value !== 'string') return review('phone_not_text');
  const raw = value.trim();
  if (!raw.startsWith('+')) return review('phone_without_country_code');
  const parsed = normalizeMobile(raw);
  if (!parsed) return review('phone_invalid');
  return parsed.e164 === value ? unchanged() : normalize(parsed.e164);
}

// The four columns, in one place (column name -> classifier) for the report and the backfill.
const FIELD_NORMALIZERS = {
  patientGender: normalizeGender,
  careLevel: normalizeCareLevel,
  country: normalizeCountry,
  patientContact: normalizePhone,
};

module.exports = {
  normalizeGender, normalizeCareLevel, normalizeCountry, normalizePhone, FIELD_NORMALIZERS,
};
