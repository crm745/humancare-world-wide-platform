// Turns a Private Charter Case (and its ServiceRequest) into the fields of a Bitrix24 DEAL in Category 38.
// Pure: no network, no database. Kept apart from bitrix-lead.js on purpose: a Deal never uses a Lead field code,
// and the Lead mapping (including its old "Required Service" id 2820) is untouched.
//
// Field codes and option ids are the verified values supplied for the Private Charter Deal. Nothing here is
// invented: a value with no approved mapping is LEFT OUT (age, origin and destination; an UNSUPPORTED gender is refused, a missing one left out).
//
// Never sent: medical description, medical documents (the Documents file field is reserved below and is NOT written at
// Deal creation: files are attached later, by the document-sharing step), patient email, and no Contact (the Deal carries
// the patient's mobile in its own field; no CONTACT_ID is ever set or created).

const DEAL = {
  CATEGORY_ID: 38,
  STAGE_ID: 'C38:NEW',
  SOURCE_ID: 'UC_0AYN3R',
};

const FIELD = {
  REFERENCE: 'UF_CRM_1794548440549', // Primary Deal Reference = the exact Case reference
  PATIENT_NAME: 'UF_CRM_1775637288921',
  PATIENT_GENDER: 'UF_CRM_1775813710026',
  DATE_OF_SERVICE: 'UF_CRM_1775813920874',
  REQUIRED_SERVICE: 'UF_CRM_6A2FB92FE1881',
  INDUSTRY: 'UF_CRM_69EB460B879E4',
  PATIENT_MOBILE: 'UF_CRM_PHONE_MOBILE',
  CARE_LEVEL: 'UF_CRM_1794548015097', // list, multiple
  MOBILITY: 'UF_CRM_1794830631', // Patient Mobility, list, multiple
  REQUIRED_ON_BOARD: 'UF_CRM_1794830302', // Oxygen / Cardiac Monitor / Ventilator, list, multiple
  URGENCY: 'UF_CRM_1794831027', // Treatment Urgency - Private Charter, list, exactly one
  PATIENT_AGE: 'UF_CRM_1768195253912', // number (the same code the Lead mapping uses for Patient Age)
  ORIGIN: 'UF_CRM_1779270456180', // Origin Location, address
  DESTINATION: 'UF_CRM_69EB460B79B1D', // Destination Location, string
};

// Medical Reports / Documents: a MULTIPLE FILE field (field id 5724). Reserved for the document-sharing step. buildDealFields
// never writes it (a test proves it), so no file is ever attached at Deal creation.
const DOCUMENTS_FIELD = 'UF_CRM_1794832401';

const REQUIRED_SERVICE_PRIVATE_CHARTER = 2844; // the Deal's own option; NOT the old Lead option 2820
const INDUSTRY_PRIVATE_CHARTER = 1726;

const CARE_LEVEL_OPTION = { care_icu: 5880, care_stable: 5882, care_ambulatory: 5884, care_na: 5886 };
const CARE_LEVEL_EXCLUSIVE = 'care_na'; // Not Applicable can only be chosen on its own
const MOBILITY_OPTION = { bedridden: 6012, wheelchair: 6014, walking: 6016 };
// The request's three equipment flags, in the order they are sent. A flag that is true selects its option; false or missing selects nothing.
const EQUIPMENT_OPTION = { equipOxygen: 6006, equipCardiacMonitor: 6008, equipVentilator: 6010 };
// Critical and Urgent have separate options.
const URGENCY_OPTION = { critical_6h: 6018, urgent_24h: 6020, planned: 6022 };

// Patient Gender: the Deal's own list (UF_CRM_1775813710026). HumanCare stores 'male' | 'female' | 'other'.
const GENDER_OPTION = { male: 1290, female: 1292, other: 1294 }; // Male | Female | Others

// Raised when a Case cannot be turned into a correct Deal payload. It is raised BEFORE any Bitrix call, so the
// worker records a definitive failure (nothing was sent). The message holds field NAMES only, never patient data.
class DealMappingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DealMappingError';
    this.code = code;
  }
}

const E164 = /^\+[1-9]\d{6,14}$/;

// A stored comma-joined list ("care_icu,care_stable") -> the option ids, in the table's order. Unknown, empty or repeated pieces
// are refused (never guessed or dropped). Missing -> undefined (the field is left out).
function optionList(stored, table, codePrefix, label) {
  if (stored == null || stored === '') return undefined;
  const pieces = String(stored).split(',').map((piece) => piece.trim());
  for (const piece of pieces) {
    if (!Object.prototype.hasOwnProperty.call(table, piece)) throw new DealMappingError(`${codePrefix}_unknown`, `${label} has no Bitrix option.`);
  }
  if (new Set(pieces).size !== pieces.length) throw new DealMappingError(`${codePrefix}_duplicate`, `${label} lists the same value twice.`);
  return Object.keys(table).filter((key) => pieces.includes(key)).map((key) => table[key]);
}

function careLevelOptions(stored) {
  const options = optionList(stored, CARE_LEVEL_OPTION, 'care_level', 'Care level');
  if (options && options.length > 1 && options.includes(CARE_LEVEL_OPTION[CARE_LEVEL_EXCLUSIVE])) {
    throw new DealMappingError('care_level_na_combined', 'Care level Not Applicable cannot be combined with another value.');
  }
  return options;
}

const mobilityOptions = (stored) => optionList(stored, MOBILITY_OPTION, 'mobility', 'Mobility');

// Required on Board: the selected equipment, or undefined when nothing is selected (the field is then left out).
function equipmentOptions(request) {
  const options = Object.entries(EQUIPMENT_OPTION).filter(([flag]) => request[flag] === true).map(([, option]) => option);
  return options.length ? options : undefined;
}

// Patient Age: a whole number, left out when missing.
function ageValue(age) {
  if (age == null || age === '') return undefined;
  if (!Number.isInteger(age) || age < 1 || age > 120) throw new DealMappingError('age_invalid', 'Patient age is not a whole number from 1 to 120.');
  return age;
}

// Origin and Destination: the verified city label as text, left out when missing.
const placeText = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

function lookup(table, value, code, label) {
  if (value == null || value === '') return undefined;
  const option = Object.prototype.hasOwnProperty.call(table, value) ? table[value] : undefined;
  if (option === undefined) throw new DealMappingError(code, `${label} has no Bitrix option.`);
  return option;
}

// A calendar day as YYYY-MM-DD. preferredDate is a SQL DATE stored as 00:00 UTC, so the UTC day is the day.
function dateOnly(value) {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new DealMappingError('date_invalid', 'Date of service is not a valid date.');
  return date.toISOString().slice(0, 10);
}

// Builds the `fields` object for crm.deal.add. `caseRecord.referenceNumber` is used exactly as stored.
function buildDealFields(caseRecord, request) {
  if (!caseRecord || !request) throw new DealMappingError('missing_input', 'A Case and its request are required.');
  const reference = caseRecord.referenceNumber;
  if (typeof reference !== 'string' || reference === '' || reference !== reference.trim()) {
    throw new DealMappingError('reference_invalid', 'The Case reference is missing or has surrounding whitespace.');
  }
  const mobile = request.patientContact;
  if (mobile != null && mobile !== '' && !E164.test(mobile)) {
    throw new DealMappingError('mobile_not_e164', 'Patient mobile is not in E.164 format.');
  }
  // Missing -> left out. A value with no approved option is refused (never guessed, never sent as text).
  // Required Service, Care Level, Mobility and Required on Board are MULTI-value list fields in Bitrix: they are sent as arrays
  // of option ids (never comma-joined text). Urgency is exactly one option.
  const careLevel = careLevelOptions(request.careLevel);
  const mobility = mobilityOptions(request.mobility);
  const equipment = equipmentOptions(request);
  const gender = lookup(GENDER_OPTION, typeof request.patientGender === 'string' ? request.patientGender.trim().toLowerCase() : request.patientGender, 'gender_unknown', 'Gender');

  const fields = {
    TITLE: reference,
    CATEGORY_ID: DEAL.CATEGORY_ID,
    STAGE_ID: DEAL.STAGE_ID,
    SOURCE_ID: DEAL.SOURCE_ID,
    [FIELD.REFERENCE]: reference,
    [FIELD.PATIENT_NAME]: request.patientName ?? caseRecord.patientName,
    [FIELD.PATIENT_GENDER]: gender,
    [FIELD.DATE_OF_SERVICE]: dateOnly(request.preferredDate),
    [FIELD.REQUIRED_SERVICE]: [REQUIRED_SERVICE_PRIVATE_CHARTER],
    [FIELD.INDUSTRY]: INDUSTRY_PRIVATE_CHARTER,
    [FIELD.PATIENT_MOBILE]: mobile || undefined,
    [FIELD.CARE_LEVEL]: careLevel,
    [FIELD.MOBILITY]: mobility,
    [FIELD.REQUIRED_ON_BOARD]: equipment,
    [FIELD.URGENCY]: lookup(URGENCY_OPTION, request.urgency, 'urgency_unknown', 'Urgency'),
    [FIELD.PATIENT_AGE]: ageValue(request.patientAge),
    [FIELD.ORIGIN]: placeText(request.origin),
    [FIELD.DESTINATION]: placeText(request.destination),
  };
  // Leave unknown values out (Bitrix would read an explicit null as "clear"); `false` is a real value and stays.
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

module.exports = {
  buildDealFields, DealMappingError, DEAL, FIELD, DOCUMENTS_FIELD, CARE_LEVEL_OPTION, CARE_LEVEL_EXCLUSIVE, MOBILITY_OPTION, EQUIPMENT_OPTION,
  URGENCY_OPTION, REQUIRED_SERVICE_PRIVATE_CHARTER, INDUSTRY_PRIVATE_CHARTER, GENDER_OPTION,
};
