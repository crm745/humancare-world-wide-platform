// What the New Request form's medical page sends (mobile src/app/request/step2.js). The same
// values are used by the validation, the Case/Bitrix urgency mapping and the readable lines
// in the lead comment and the PDF summary.

const MOBILITY = ['bedridden', 'wheelchair', 'walking'];
const MOBILITY_LABEL = { bedridden: 'Bedridden', wheelchair: 'Wheelchair', walking: 'Walking' };

// Mobility is stored as one key ("walking") or, for Private Charter, several joined with commas ("bedridden,wheelchair"). How a
// stored value reads on a screen, a PDF or a lead comment: the English labels joined with ", ". An unknown piece is left out, and
// nothing known gives undefined, exactly as the old single-value lookup did.
function mobilityText(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  const labels = value.split(',').map((piece) => piece.trim()).filter((piece) => Object.prototype.hasOwnProperty.call(MOBILITY_LABEL, piece)).map((piece) => MOBILITY_LABEL[piece]);
  return labels.length ? labels.join(', ') : undefined;
}

const URGENCY = ['critical_6h', 'urgent_24h', 'planned'];
const URGENCY_LABEL = { critical_6h: 'Critical (within 6h)', urgent_24h: 'Urgent (24h)', planned: 'Planned' };
// The Case (and Bitrix "Transfer Urgency") use the older three-step scale.
const URGENCY_TO_CASE = { critical_6h: 'critical', urgent_24h: 'urgent', planned: 'routine' };

// [request field, label]: the three things that can be asked for on board.
const EQUIPMENT = [
  ['equipOxygen', 'Oxygen'],
  ['equipCardiacMonitor', 'Cardiac monitor'],
  ['equipVentilator', 'Ventilator'],
];

// Patient transport: air (private charter, commercial airline) and ground ambulance. Only
// these ask for mobility and equipment. The key may carry a suffix ("commercialair_stretcher").
const isTransportKey = (serviceKey) => /^(air|privatecharter|commercialair|ground)(_|$)/.test(serviceKey || '');

// --- Private Charter Air Ambulance (serviceKey "privatecharter") --------------------------
// The strict validation in modules/requests/private-charter.validation.js applies to this
// key only. The service name is the backend's own: a client-sent serviceType must match it.
const PRIVATE_CHARTER_KEY = 'privatecharter';
const PRIVATE_CHARTER_SERVICE_TYPE = 'Private Charter Air Ambulance Service';

const GENDERS = ['male', 'female', 'other'];

// Stable care-level keys, in the order the form shows them. "care_na" (Not Applicable) can
// only be chosen on its own.
const CARE_LEVEL_KEYS = ['care_icu', 'care_stable', 'care_ambulatory', 'care_na'];
const CARE_LEVEL_EXCLUSIVE = 'care_na';

// The translated labels older app builds sent in place of the keys (they sent
// `care.map(t).join(', ')`). Copied from the care_* entries of every language in the mobile
// app's src/data/i18n.json; a test compares this table with that file so a new language or
// a reworded label cannot drift unnoticed. Accepted during the 90-day compatibility period.
const CARE_LEVEL_LEGACY_LABELS = {
  care_icu: ['ICU / Critical', 'ICU / गंभीर', 'ICU / ગંભીર', 'ICU / క్రిటికల్', 'عناية مركزة / حرجة'],
  care_stable: ['Stable / Monitored', 'स्थिर / निगरानी में', 'स्थिर / निरीक्षणाखाली', 'સ્થિર / નિરીક્ષણ હેઠળ', 'స్థిరంగా / పర్యవేక్షణలో', 'مستقر / تحت المراقبة'],
  care_ambulatory: ['Ambulatory', 'एंबुलेटरी', 'अँब्युलेटरी', 'એમ્બ્યુલેટરી', 'అంబులేటరీ', 'متنقل (غير طريح الفراش)'],
  care_na: ['Not Applicable', 'लागू नहीं', 'लागू नाही', 'લાગુ નથી', 'వర్తించదు', 'غير منطبق'],
};

// The English label of each key, for the places that cannot translate (the PDF summary, the Bitrix
// lead comment). A test compares it with the English strings of the mobile app.
const CARE_LEVEL_LABEL_EN = {
  care_icu: 'ICU / Critical',
  care_stable: 'Stable / Monitored',
  care_ambulatory: 'Ambulatory',
  care_na: 'Not Applicable',
};

// Private Charter form (revised): Travel Type is a single choice, Critical Level a multi-select; Oxygen Required is yes/no and,
// only when yes, carries a flow rate in litres per minute. These replace care level, mobility, on-board equipment
// and urgency for NEW Private Charter requests. Those older columns stay (other services use them, and older
// Private Charter requests keep their values).
const TRAVEL_TYPES = ['patient_transfer', 'organ_transfer'];
const TRAVEL_TYPE_LABEL = { patient_transfer: 'Patient Transfer', organ_transfer: 'Organ Transfer' };
const CRITICAL_LEVELS = ['icu', 'ventilated', 'tracheostomy', 'ecmo'];
const CRITICAL_LEVEL_LABEL = { icu: 'ICU', ventilated: 'Ventilated', tracheostomy: 'Tracheostomy', ecmo: 'ECMO' };
const OXYGEN_FLOW_MIN = 1;
const OXYGEN_FLOW_MAX = 60;

// Critical Level is a MULTI-select: the request carries an array of keys; it is stored in one column as the keys joined
// with commas, in the order of CRITICAL_LEVELS (so the same choice is always stored the same way). A value stored
// before the multi-select (one key) is a list of one. Unknown keys in a stored value are dropped when read.
const CRITICAL_LEVEL_COLUMN_MAX = 64;
const criticalLevelList = (value) => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const keys = raw.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((key) => CRITICAL_LEVELS.includes(key));
  return CRITICAL_LEVELS.filter((key) => keys.includes(key));
};
const criticalLevelColumn = (value) => { const list = criticalLevelList(value); return list.length ? list.join(',') : null; };
const criticalLevelText = (value) => criticalLevelList(value).map((key) => CRITICAL_LEVEL_LABEL[key]).join(', ');

// A city typed by hand (not found in GeoNames): its name, in characters as a person counts them.
const CITY_NAME_MIN = 2;
const CITY_NAME_MAX = 100;

module.exports = {
  TRAVEL_TYPES, TRAVEL_TYPE_LABEL, CRITICAL_LEVELS, CRITICAL_LEVEL_LABEL, OXYGEN_FLOW_MIN, OXYGEN_FLOW_MAX,
  CRITICAL_LEVEL_COLUMN_MAX, criticalLevelList, criticalLevelColumn, criticalLevelText, CITY_NAME_MIN, CITY_NAME_MAX,
  CARE_LEVEL_LABEL_EN,
  MOBILITY, MOBILITY_LABEL, mobilityText, URGENCY, URGENCY_LABEL, URGENCY_TO_CASE, EQUIPMENT, isTransportKey,
  PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE, GENDERS, CARE_LEVEL_KEYS, CARE_LEVEL_EXCLUSIVE, CARE_LEVEL_LEGACY_LABELS,
};
