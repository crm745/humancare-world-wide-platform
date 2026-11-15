// Turns a Private Charter Case (and its ServiceRequest) into the fields of a Bitrix24 DEAL in Category 38.
// Pure: no network, no database. Kept apart from bitrix-lead.js on purpose: a Deal never uses a Lead field code,
// and the Lead mapping (including its old "Required Service" id 2820) is untouched.
//
// Field codes and option ids are the verified values supplied for the Private Charter Deal. Nothing here is
// invented: a value with no approved mapping is LEFT OUT (age, origin and destination; an UNSUPPORTED gender is refused, a missing one left out).
//
// Never sent: medical description, medical documents, patient email, age, origin, destination, and no Contact
// (the Deal carries the patient's mobile in its own field; no CONTACT_ID is ever set or created).

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
  CARE_LEVEL: 'UF_CRM_1794548015097',
  MOBILITY: 'UF_CRM_1794548098759',
  CARDIAC_MONITOR: 'UF_CRM_1794548136025',
  TRANSFER_URGENCY: 'UF_CRM_1775637825406',
};

const REQUIRED_SERVICE_PRIVATE_CHARTER = 2844; // the Deal's own option; NOT the old Lead option 2820
const INDUSTRY_PRIVATE_CHARTER = 1726;

const CARE_LEVEL_OPTION = { care_icu: 5880, care_stable: 5882, care_ambulatory: 5884, care_na: 5886 };
const MOBILITY_OPTION = { bedridden: 5888, wheelchair: 5890, walking: 5892 };
// critical_6h and urgent_24h are both "Urgent" in Bitrix; HumanCare keeps the exact value itself.
const URGENCY_OPTION = { critical_6h: 2014, urgent_24h: 2014, planned: 2016 };

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

function careLevelOption(stored) {
  if (stored == null || stored === '') return undefined;
  const pieces = String(stored).split(',').map((piece) => piece.trim());
  if (pieces.length !== 1) throw new DealMappingError('care_level_not_single', 'Care level must be exactly one value for a Deal.');
  const option = CARE_LEVEL_OPTION[pieces[0]];
  if (option === undefined) throw new DealMappingError('care_level_unknown', 'Care level has no Bitrix option.');
  return option;
}

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
  // Required Service and Care Level are MULTI-value list fields in Bitrix (verified via crm.deal.fields): they are sent
  // as an array, here always with exactly one option.
  const careLevel = careLevelOption(request.careLevel);
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
    [FIELD.CARE_LEVEL]: careLevel === undefined ? undefined : [careLevel],
    [FIELD.MOBILITY]: lookup(MOBILITY_OPTION, request.mobility, 'mobility_unknown', 'Mobility'),
    [FIELD.CARDIAC_MONITOR]: typeof request.equipCardiacMonitor === 'boolean' ? request.equipCardiacMonitor : undefined,
    [FIELD.TRANSFER_URGENCY]: lookup(URGENCY_OPTION, request.urgency, 'urgency_unknown', 'Urgency'),
  };
  // Leave unknown values out (Bitrix would read an explicit null as "clear"); `false` is a real value and stays.
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

module.exports = {
  buildDealFields, DealMappingError, DEAL, FIELD, CARE_LEVEL_OPTION, MOBILITY_OPTION, URGENCY_OPTION,
  REQUIRED_SERVICE_PRIVATE_CHARTER, INDUSTRY_PRIVATE_CHARTER, GENDER_OPTION,
};
