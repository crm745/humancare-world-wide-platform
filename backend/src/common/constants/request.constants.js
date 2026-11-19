// What the New Request form's medical page sends (mobile src/app/request/step2.js). The same
// values are used by the validation, the Case/Bitrix urgency mapping and the readable lines
// in the lead comment and the PDF summary.

const MOBILITY = ['bedridden', 'wheelchair', 'walking'];
const MOBILITY_LABEL = { bedridden: 'Bedridden', wheelchair: 'Wheelchair', walking: 'Walking' };

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

// --- Commercial Air care level ("Critical level") ------------------------------------------------------------
// Commercial Air has its OWN four care-level options, apart from the CARE_LEVEL_KEYS below (which Private Charter, and older
// requests, use and which stay exactly as they are): ICU, Ventilated, Tracheostomy, ECMO. Stored as the keys, comma-joined
// ("crit_icu,crit_ecmo"), in the same careLevel text column. One or more may be chosen, each at most once.
const COMMERCIAL_AIR_CARE_LEVEL_LABEL_EN = {
  crit_icu: 'ICU',
  crit_ventilated: 'Ventilated',
  crit_tracheostomy: 'Tracheostomy',
  crit_ecmo: 'ECMO',
};
const COMMERCIAL_AIR_CARE_LEVEL_KEYS = Object.keys(COMMERCIAL_AIR_CARE_LEVEL_LABEL_EN);
// Why a careLevel is not acceptable for Commercial Air, or null when it is. Only the four keys; the old care levels, the old
// translated labels and free text are refused. A string (not a list), like every other service's careLevel.
function commercialAirCareLevelProblem(value) {
  const allowed = `Use one or more of: ${COMMERCIAL_AIR_CARE_LEVEL_KEYS.join(', ')} (comma-separated).`;
  if (typeof value !== 'string') return `Invalid careLevel. ${allowed}`;
  const pieces = value.split(',').map((piece) => piece.trim());
  if (pieces.some((piece) => !COMMERCIAL_AIR_CARE_LEVEL_KEYS.includes(piece))) return `Invalid careLevel. ${allowed}`;
  if (new Set(pieces).size !== pieces.length) return 'Invalid careLevel. Each option can be chosen only once.';
  return null;
}

// --- Commercial Air oxygen flow rate -------------------------------------------------------------
// Commercial Air only ("commercialair_stretcher" / "commercialair_wheelchair", or the bare key of older
// builds). When Oxygen is chosen under "Required on board" the flow rate in litres per minute (LPM) is
// required; without Oxygen it is refused. A positive number, up to OXYGEN_LPM_MAX, with at most one decimal.
const isCommercialAirKey = (serviceKey) => /^commercialair(_|$)/.test(serviceKey || '');
// Ground Ambulance ("ground") has the same medical page as Commercial Air, without Travel type: the four critical levels, Oxygen with its
// flow rate, and no Patient mobility, Cardiac monitor or Ventilator. Its rules are keyed on this key alone (Private Charter and "air" are not it).
const isGroundKey = (serviceKey) => /^ground(_|$)/.test(serviceKey || '');
// The services that ask the critical levels (crit_*) and the oxygen flow rate.
const usesCriticalLevelPage = (serviceKey) => isCommercialAirKey(serviceKey) || isGroundKey(serviceKey);
const OXYGEN_LPM_MAX = 15;
// Why a value is not an acceptable flow rate, or null when it is. Only a JSON number is accepted (not text).
function oxygenLpmProblem(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'equipOxygenLpm must be a number (litres per minute).';
  if (value <= 0 || value > OXYGEN_LPM_MAX) return `equipOxygenLpm must be greater than 0 and at most ${OXYGEN_LPM_MAX} LPM.`;
  if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) return 'equipOxygenLpm can have at most one decimal place.';
  return null;
}

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

module.exports = {
  CARE_LEVEL_LABEL_EN,
  MOBILITY, MOBILITY_LABEL, URGENCY, URGENCY_LABEL, URGENCY_TO_CASE, EQUIPMENT, isTransportKey,
  isCommercialAirKey, isGroundKey, usesCriticalLevelPage, OXYGEN_LPM_MAX, oxygenLpmProblem,
  COMMERCIAL_AIR_CARE_LEVEL_KEYS, COMMERCIAL_AIR_CARE_LEVEL_LABEL_EN, commercialAirCareLevelProblem,
  PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE, GENDERS, CARE_LEVEL_KEYS, CARE_LEVEL_EXCLUSIVE, CARE_LEVEL_LEGACY_LABELS,
};
