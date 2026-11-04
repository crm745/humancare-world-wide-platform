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

module.exports = { MOBILITY, MOBILITY_LABEL, URGENCY, URGENCY_LABEL, URGENCY_TO_CASE, EQUIPMENT, isTransportKey };
