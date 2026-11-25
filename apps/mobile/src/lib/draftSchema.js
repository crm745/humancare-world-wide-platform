// Phase 6: what an encrypted request draft may contain, and how a restored one is checked. Pure (no React, no native modules).
//
// A draft holds ONLY the answers a person typed or chose in the request form, plus the step they were on. Everything else in the form's state is deliberately NOT here:
// file picks (their uri/contents), sentRequest, uploaded, uploadErrors, changingService, and anything about authentication or the Phase 4 submission (keys, payloads).
// The list below is a WHITELIST: a key that is not in it for the service is dropped, both when a draft is written and again when one is restored.
export const DRAFT_VERSION = 1;
export const DRAFT_STEPS = [1, 2, 3]; // Patient, Medical, Review

// The services that have a request form (data/services.json minus the hospital listing). `air` is the Private Charter tile under its older key.
export const DRAFT_SERVICES = ['air', 'privatecharter', 'commercialair', 'ground', 'mortal', 'homecare', 'tele', 'marine', 'medvalue', 'corporate'];

const SHORT = 400; // UTF-16 units: the longest short field (names, cities, a company) the forms allow is 191 characters
const LONG = 4000; // the forms' FRAME_MAX: 2,000 code points are at most 4,000 units

const ISO = /^[A-Z]{2}$/;
const isString = (value, max) => typeof value === 'string' && value.length <= max;
const oneOf = (list) => (value) => typeof value === 'string' && (value === '' || list.includes(value));
const text = (max) => (value) => isString(value, max);
const bool = (value) => typeof value === 'boolean';
const listOf = (list, max) => (value) => Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string' && list.includes(item)) && new Set(value).size === value.length;

// A date the form stores as YYYY-MM-DD: empty, or a real calendar date.
export function isIsoDate(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// A city picked from the verified suggestions: only what the server returned for it (lib/privateCharter.js toCityChoice).
function isCity(value) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const id = value.geonameId;
  return (typeof id === 'number' || typeof id === 'string') && String(id).length <= 20
    && isString(value.name, SHORT) && isString(value.label, SHORT) && typeof value.countryCode === 'string' && ISO.test(value.countryCode);
}

const GENDERS = ['Male', 'Female', 'Other'];
const CARE = ['care_icu', 'care_stable', 'care_ambulatory', 'care_na', 'crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo'];
const URGENCY = ['critical_6h', 'urgent_24h', 'planned'];
const SCOPES = ['domestic', 'international'];
export const MVT_SPECIALTY_KEYS = [
  'Cardiology and Cardiac Surgery', 'Oncology', 'Orthopedics and Joint Replacement', 'Neurology and Neurosurgery', 'Transplant (Kidney, Liver, Bone Marrow)', 'Gastroenterology', 'Urology',
  'Nephrology', 'Gynecology and IVF', 'Pediatrics', 'Ophthalmology', 'ENT', 'Dermatology', 'Dental', 'Bariatric and Weight Loss', 'Spine', 'Pulmonology', 'Endocrinology',
  'Plastic and Cosmetic Surgery', 'General Surgery', 'Internal Medicine', 'Rehabilitation and Physiotherapy', 'Ayurveda and Wellness', 'Other',
];
const PROGRAMMES = ['doctor', 'nurse', 'medical_room_management', 'first_aid_training', 'acls_bls_training', 'events', 'pre_employment_health_checkup'];
const RELATIONS = ['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Son', 'Daughter', 'Friend', 'Other'];

// One validator per answer; each takes a restored value and says whether it is acceptable as is (nothing is repaired: a wrong value makes the whole draft unusable).
export const FIELD_VALIDATORS = {
  name: text(SHORT),
  age: (value) => typeof value === 'string' && /^\d{0,3}$/.test(value),
  gender: oneOf(GENDERS),
  location: text(SHORT),
  dest: text(SHORT),
  originCity: isCity,
  destCity: isCity,
  country: text(SHORT),
  countryIso: (value) => value === '' || (typeof value === 'string' && ISO.test(value)),
  cc: (value) => typeof value === 'string' && /^\+\d{1,4}$/.test(value),
  phoneCountry: (value) => typeof value === 'string' && ISO.test(value),
  ccEdited: bool,
  phone: (value) => typeof value === 'string' && /^[\d\s()+-]{0,24}$/.test(value),
  care: listOf(CARE, 1),
  airlineMode: oneOf(['stretcher', 'wheelchair']),
  desc: text(LONG),
  date: isIsoDate,
  mobility: oneOf(['bedridden', 'wheelchair', 'walking']),
  equipOxygen: bool,
  equipCardiac: bool,
  equipVentilator: bool,
  oxygenLpm: (value) => typeof value === 'string' && /^[\d.]{0,6}$/.test(value),
  urgency: oneOf(URGENCY),
  // Mortal Remains
  transferScope: oneOf(SCOPES),
  transportMode: oneOf(['private_charter', 'commercial_air_cargo', 'ground_transportation']),
  relation: oneOf(RELATIONS),
  deathPlace: text(SHORT),
  deathDate: isIsoDate,
  // Teleconsultation
  teleScope: oneOf(SCOPES),
  teleType: oneOf(['online', 'house_call']),
  address: text(LONG),
  allergies: text(LONG),
  // Home Healthcare
  homeAddress: text(LONG),
  homeCaretakers: listOf(['nurse', 'caretaker'], 2),
  homeCareHours: oneOf(['12_hours', '24_hours']),
  homeCareLevel: oneOf(['full_icu', 'semi_icu']),
  homeOxygen: oneOf(['yes', 'no']),
  // Medical Value Travel
  treatmentScope: oneOf(SCOPES),
  specialty: oneOf(MVT_SPECIALTY_KEYS),
  otherSpecialty: text(SHORT),
  // Marine Medical Safety
  serviceScope: oneOf(SCOPES),
  marineCare: listOf(['crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo'], 4),
  marineOxygen: oneOf(['yes', 'no']),
  // Corporate Medical Solutions
  corpCompany: text(SHORT),
  corpEmployees: (value) => typeof value === 'string' && /^\d{0,7}$/.test(value),
  corpProgrammes: listOf(PROGRAMMES, 7),
  corpAny: text(LONG),
  corpSpecial: text(LONG),
  corpOfficeAddress: text(LONG),
  corpOfficeCountry: text(SHORT),
  corpOfficeCountryIso: (value) => value === '' || (typeof value === 'string' && ISO.test(value)),
};

const PERSON = ['name', 'age', 'gender', 'cc', 'phoneCountry', 'ccEdited', 'phone', 'country', 'countryIso'];
const TRIP = ['location', 'dest', 'originCity', 'destCity'];

// The answers each kind of request form asks for. Anything else is dropped.
const FAMILY_KEYS = {
  transport: [...PERSON, ...TRIP, 'care', 'airlineMode', 'desc', 'date', 'mobility', 'equipOxygen', 'equipCardiac', 'equipVentilator', 'oxygenLpm', 'urgency'],
  mortal: [...PERSON, ...TRIP, 'relation', 'deathPlace', 'deathDate', 'desc', 'date', 'transferScope', 'transportMode', 'urgency'],
  home: [...PERSON, 'homeAddress', 'homeCaretakers', 'homeCareHours', 'homeCareLevel', 'homeOxygen', 'oxygenLpm', 'desc', 'date', 'urgency'],
  tele: [...PERSON, 'teleScope', 'teleType', 'address', 'allergies', 'desc', 'date'],
  marine: [...PERSON, ...TRIP, 'serviceScope', 'marineCare', 'marineOxygen', 'oxygenLpm', 'desc', 'date', 'urgency'],
  medvalue: [...PERSON, ...TRIP, 'treatmentScope', 'specialty', 'otherSpecialty', 'desc', 'date', 'urgency'],
  corporate: [...PERSON, 'corpCompany', 'corpEmployees', 'corpProgrammes', 'corpAny', 'corpSpecial', 'corpOfficeAddress', 'corpOfficeCountry', 'corpOfficeCountryIso'],
};
const FAMILY_OF = { air: 'transport', privatecharter: 'transport', commercialair: 'transport', ground: 'transport', mortal: 'mortal', homecare: 'home', tele: 'tele', marine: 'marine', medvalue: 'medvalue', corporate: 'corporate' };

export const isDraftService = (service) => typeof service === 'string' && Object.prototype.hasOwnProperty.call(FAMILY_OF, service);
export const draftKeysFor = (service) => (isDraftService(service) ? FAMILY_KEYS[FAMILY_OF[service]].slice() : []);
export const isDraftStep = (step) => DRAFT_STEPS.includes(step);

// Writing: the answers of `draft` that belong to its service, taken as they are, but only the ones that are valid (a field that does not pass is simply not saved).
export function pickAnswers(service, draft) {
  const values = {};
  if (!isDraftService(service) || !draft || typeof draft !== 'object') return values;
  for (const key of FAMILY_KEYS[FAMILY_OF[service]]) {
    if (!Object.prototype.hasOwnProperty.call(draft, key)) continue;
    const value = draft[key];
    if (FIELD_VALIDATORS[key](value)) values[key] = value;
  }
  return values;
}

// Restoring: `raw` is what was decrypted. Unknown keys are stripped; every known key must be valid; the result is merged over `defaults` (the form's empty draft) so a field that
// was not saved has its normal empty value. Returns { ok: true, values } or { ok: false, reason }. Nothing is repaired, and no value is ever put in `reason` (it is medical text).
export function validateAnswers(service, raw, defaults) {
  if (!isDraftService(service)) return { ok: false, reason: 'service' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'shape' };
  const allowed = FAMILY_KEYS[FAMILY_OF[service]];
  const values = {};
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) continue; // unknown or not this service's: stripped
    if (!FIELD_VALIDATORS[key](raw[key])) return { ok: false, reason: `field:${key}` };
    values[key] = raw[key];
  }
  const merged = { ...(defaults || {}), ...values, service };
  // Consistency a typed form could never produce: the code follows its country, a company office country needs both parts, and so on are re-checked by the normal validators on Continue.
  if (values.phoneCountry !== undefined && values.cc !== undefined && !/^\+\d{1,4}$/.test(values.cc)) return { ok: false, reason: 'field:cc' };
  return { ok: true, values: merged };
}

// Whether the answers are worth saving at all: a draft with nothing typed or chosen is not stored (and an existing draft is not replaced by an empty one).
export function hasAnswers(service, draft, defaults) {
  const picked = pickAnswers(service, draft);
  return Object.keys(picked).some((key) => {
    if (key === 'cc' || key === 'phoneCountry' || key === 'ccEdited') return false; // the code and its country are preset, not an answer
    const base = defaults ? defaults[key] : undefined;
    return JSON.stringify(picked[key]) !== JSON.stringify(base === undefined ? '' : base);
  });
}
