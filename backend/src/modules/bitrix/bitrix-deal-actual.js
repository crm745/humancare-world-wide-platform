// Turns a Private Charter Case and its request into the fields of a Deal in the ACTUAL Air Ambulance pipeline (Category 0).
// Pure: no network, no database. The test pipeline's builder (bitrix-deal.js) is untouched and never used here.
//
// Rules:
//   * Private Charter only. Any other service key is refused (Commercial Charter shares this pipeline but is not mapped here).
//   * A List value with no verified option id (null or absent in bitrix-profiles.js) is NEVER guessed: mapping a value that needs
//     it throws DealMappingError "enum_pending" BEFORE anything is sent. A missing value is simply left out.
//   * Critical Level keeps every selected value, in the form's order, as an array of option ids (the field must be MULTIPLE).
//   * Oxygen Flow Rate is sent only when Oxygen Required is Yes.
//   * Origin / Destination City are the readable labels (a GeoNames city reads "Mumbai, Maharashtra, India", a manual one reads as
//     typed, with its country when known), so both kinds are supported without a separate field.
//   * Medical Report is NEVER written here: it is a file field attached later by the document-sharing step, as an original file
//     through the supported crm.item.update upload. No path or file id is ever sent at creation.
//   * Never sent: patient email. No Contact is created.
const { DealMappingError } = require('./bitrix-deal');
const { ACTUAL_PROFILE, ACTUAL_FIELD, ACTUAL_OPTIONS, ACTUAL_CRITICAL_LEVEL_MULTIPLE } = require('./bitrix-profiles');
const { criticalLevelList } = require('../../common/constants/request.constants');

const E164 = /^\+[1-9]\d{6,14}$/;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

// One option id for one stored value. Missing -> undefined. No Bitrix option for it -> refused. Option id missing -> refused.
function singleOption(table, value, code, label) {
  if (value == null || value === '') return undefined;
  if (!own(table, value)) throw new DealMappingError(`${code}_unknown`, `${label} has no Bitrix option.`);
  if (table[value] == null) throw new DealMappingError('enum_pending', `${label}: no verified Bitrix option id.`);
  return table[value];
}

function criticalLevelOptions(stored, table, multiple) {
  const keys = criticalLevelList(stored);
  if (!keys || keys.length === 0) return undefined;
  for (const key of keys) {
    if (!own(table, key)) throw new DealMappingError('critical_level_unknown', 'Critical level has no Bitrix option.');
  }
  if (multiple !== true) throw new DealMappingError('enum_pending', 'Critical level: the Bitrix field must be a multiple list.');
  const ids = keys.map((key) => table[key]);
  if (ids.some((id) => id == null)) throw new DealMappingError('enum_pending', 'Critical level: no verified Bitrix option id.');
  return ids;
}

function dateOnly(value) {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new DealMappingError('date_invalid', 'Preferred date is not a valid date.');
  return date.toISOString().slice(0, 10);
}

function ageValue(age) {
  if (age == null || age === '') return undefined;
  if (!Number.isInteger(age) || age < 1 || age > 120) throw new DealMappingError('age_invalid', 'Patient age is not a whole number from 1 to 120.');
  return age;
}

// `config` exists so tests can supply verified-looking option ids; production always uses the frozen values from bitrix-profiles.js.
function buildActualPrivateCharterFields(caseRecord, request, config = {}) {
  const options = config.options || ACTUAL_OPTIONS;
  const criticalMultiple = config.criticalLevelMultiple === undefined ? ACTUAL_CRITICAL_LEVEL_MULTIPLE : config.criticalLevelMultiple;
  if (!caseRecord || !request) throw new DealMappingError('missing_input', 'A Case and its request are required.');
  if (!ACTUAL_PROFILE.services.includes(request.serviceKey)) throw new DealMappingError('service_not_mapped', 'Only Private Charter is mapped for the actual pipeline.');
  const reference = caseRecord.referenceNumber;
  if (typeof reference !== 'string' || reference === '' || reference !== reference.trim()) {
    throw new DealMappingError('reference_invalid', 'The Case reference is missing or has surrounding whitespace.');
  }
  const mobile = request.patientContact;
  if (mobile != null && mobile !== '' && !E164.test(mobile)) throw new DealMappingError('mobile_not_e164', 'Contact number is not in E.164 format.');

  const oxygenYes = request.oxygenRequired === true;
  const oxygenNo = request.oxygenRequired === false;
  let flow;
  if (oxygenYes && request.oxygenFlowLpm != null) {
    if (!Number.isInteger(request.oxygenFlowLpm) || request.oxygenFlowLpm < 1) throw new DealMappingError('oxygen_flow_invalid', 'Oxygen flow rate is not a positive whole number.');
    flow = request.oxygenFlowLpm;
  }

  const F = ACTUAL_FIELD;
  const fields = {
    TITLE: reference,
    CATEGORY_ID: ACTUAL_PROFILE.categoryId,
    STAGE_ID: ACTUAL_PROFILE.newStageId,
    [F.CASE_REFERENCE]: reference, // the exact Case reference (validated above: no surrounding whitespace)
    [F.PATIENT_NAME]: text(request.patientName) ?? text(caseRecord.patientName),
    [F.PATIENT_AGE]: ageValue(request.patientAge),
    [F.GENDER]: singleOption(options.GENDER, typeof request.patientGender === 'string' ? request.patientGender.trim().toLowerCase() : request.patientGender, 'gender', 'Gender'),
    [F.TRAVEL_TYPE]: singleOption(options.TRAVEL_TYPE, request.travelType, 'travel_type', 'Travel type'),
    [F.ORIGIN_CITY]: text(request.origin),
    [F.DESTINATION_CITY]: text(request.destination),
    [F.MEDICAL_HISTORY]: text(request.description),
    [F.CRITICAL_LEVEL]: criticalLevelOptions(request.criticalLevel, options.CRITICAL_LEVEL, criticalMultiple),
    [F.OXYGEN_REQUIRED]: oxygenYes ? singleOption(options.OXYGEN_REQUIRED, 'yes', 'oxygen', 'Oxygen required')
      : oxygenNo ? singleOption(options.OXYGEN_REQUIRED, 'no', 'oxygen', 'Oxygen required') : undefined,
    [F.OXYGEN_FLOW_LPM]: flow,
    [F.COUNTRY]: text(request.country),
    [F.CONTACT_NUMBER]: mobile || undefined,
    [F.PREFERRED_DATE]: dateOnly(request.preferredDate),
  };
  // Unknown values are left out (Bitrix reads an explicit null as "clear"). The Medical Report field is never in this object.
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

module.exports = { buildActualPrivateCharterFields };
