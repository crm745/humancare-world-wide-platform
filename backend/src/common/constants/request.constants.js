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
  PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE, GENDERS, CARE_LEVEL_KEYS, CARE_LEVEL_EXCLUSIVE, CARE_LEVEL_LEGACY_LABELS,
};
