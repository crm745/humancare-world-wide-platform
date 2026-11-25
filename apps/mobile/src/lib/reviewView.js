// What the New Request review step (step 3) shows, worked out from the form's draft. Pure (no React, no native modules), so it can be unit-tested.
// It returns the SAME shapes Request Details draws (lib/requestDetailsView.js detailsView), so both pages use the same blocks
// (components/request/DetailsBlocks.js) and look the same.
//
// Rules in one place:
//   - a field whose value is empty (lib/emptyValue.js) is not returned, so it is not drawn, label and all; never a "—", "None" or "N/A";
//   - a section with no field left is not returned; the service card always is;
//   - every stored key is shown through i18n; dates are written in the app's current language ("15 Nov 2026"), never "2026-11-15";
//   - every field the form collects for the service is here (see FORM_FIELDS below, which the tests check against the draft).
import { hasValue } from './emptyValue';
import {
  baseServiceName, charterTravelLabel, countryLabel, criticalLevelLabel, oxygenLabel, extOf, formatDateOnly, genderLabel, isMortalKey, isTransportRequest, mobilityLabel, phoneLabel, relationLabel,
  textOf, transferTypeKey, travelTypeKey, urgencyView,
} from './requestDetailsView';
import { serviceKeyOf } from './myRequestsView';
import { formatSize } from './documentHistoryView';
import { asksEquipment, parseOxygenLpm } from './requestForm';
import { TELE_SCOPE_LABEL_KEYS, TELE_SERVICE_KEY, TELE_TYPE_LABEL_KEYS, isHouseCall } from './teleConsultation';
import { MORTAL_MODE_LABEL_KEYS, MORTAL_SCOPE_LABEL_KEYS } from './mortalRemains';
import { CARETAKER_KEYS, CARETAKER_LABEL_KEYS, HOURS_KEYS, HOURS_LABEL_KEYS, LEVEL_KEYS, LEVEL_LABEL_KEYS, HOME_SERVICE_KEY } from './homeHealthcare';
import { MVT_OTHER_SPECIALTY, MVT_SERVICE_KEY, MVT_SCOPES, mvtText } from './medicalValueTravel';
import { MARINE_SCOPES, MARINE_SERVICE_KEY, chosenCriticalLevels, marineText } from './marineMedicalSafety';
import { CORPORATE_SERVICE_KEY, chosenProgrammes, corporateText, parseEmployeeCount, programmeNames } from './corporateMedical';

const field = (key, label, value, full) => (hasValue(value) ? { key, label, value: textOf(value), full: !!full } : null);
const compact = (list) => list.filter(Boolean);

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp'];
const EQUIPMENT = [['equipOxygen', 'equip_oxygen'], ['equipCardiac', 'equip_cardiac_monitor'], ['equipVentilator', 'equip_ventilator']];

// Where each field the form collects now appears, per kind of service. The draft's key -> the section it is shown in. Every collected field
// must be in here (a test walks the draft's keys against this list), so nothing collected can be left off the page.
export const FORM_FIELDS = {
  always: {
    name: 'patient', age: 'patient', gender: 'patient', phone: 'patient', cc: 'patient', country: 'patient',
    location: 'trip', dest: 'trip', date: 'trip', urgency: 'medical', desc: 'medical', files: 'documents',
  },
  transport: { care: 'medical', mobility: 'medical', equipOxygen: 'medical', equipCardiac: 'medical', equipVentilator: 'medical' },
  // Private Charter (revised form) asks these in place of care level, mobility, equipment and urgency.
  privatecharter: { travelType: 'trip', criticalLevel: 'medical', oxygenRequired: 'medical', oxygenFlowLpm: 'medical' },
  commercialair: { airlineMode: 'medical', oxygenLpm: 'medical' },
  // Mortal Remains: the deceased's details, and the Transfer Scope and Transport Mode (two separate choices), are patient details.
  mortal: { transferScope: 'patient', transportMode: 'patient', relation: 'patient', deathPlace: 'patient', deathDate: 'patient' },
  // Teleconsultation: Scope, Type and the Current Address are patient details; the allergies and the House Call's visit date (`date`) are medical.
  tele: { teleScope: 'patient', teleType: 'patient', address: 'patient', allergies: 'medical' },
  // Home Healthcare: the Complete Home Address is a patient detail (with the Service Date, `date`); the care selections are medical details.
  home: { homeAddress: 'patient', homeCaretakers: 'medical', homeCareHours: 'medical', homeCareLevel: 'medical', homeOxygen: 'medical' },
  // Medical Value Travel: the Treatment Scope is a patient detail; the Specialty (and the Other text) and the Preferred Treatment Date (`date`) are medical ones.
  mvt: { treatmentScope: 'patient', specialty: 'medical', otherSpecialty: 'medical' },
  // Marine Medical Safety: the Service Scope is a patient detail; the Critical Level, the Oxygen answer and the Date of Service (`date`) are medical ones.
  marine: { serviceScope: 'patient', marineCare: 'medical', marineOxygen: 'medical' },
  // Corporate Medical Solutions: the company, the number of employees (and, from the patient fields, the Name of Employee and the Gender) are patient details; the
  // programmes and the two optional requirements are medical ones. It asks nothing else (no age, contact, country, trip, urgency or documents).
  // (Update: it also asks the contact number `phone` / `cc` and the Preferred Date `date` (the usual patient fields), the Office Address and the Office Country, all patient details.)
  corporate: {
    corpCompany: 'patient', corpEmployees: 'patient', corpOfficeAddress: 'patient', corpOfficeCountry: 'patient', corpProgrammes: 'medical', corpAny: 'medical', corpSpecial: 'medical',
  },
};
// Draft keys that are not answers the person gave (internal bookkeeping), so they are not shown.
export const NOT_SHOWN = [
  'service', 'sentRequest', 'uploaded', 'uploadErrors', 'uploadUnknown', 'originCity', 'destCity', 'countryIso', 'phoneCountry', 'ccEdited', 'changingService',
  'mortalTransfer', // the single "Transfer type" choice of older builds: no longer asked (Transfer Scope and Transport Mode replaced it)
  'corpOfficeCountryIso', // the ISO code of the Office Country, which is shown by its name (corpOfficeCountry)
];

// Teleconsultation's patient section: Scope, Consultation Type, then the patient and the complete Current Address as typed (it is what is sent).
function teleFields(d, t) {
  const scope = TELE_SCOPE_LABEL_KEYS[d.teleScope];
  const type = TELE_TYPE_LABEL_KEYS[d.teleType];
  return compact([
    field('type', t('field_consult_type'), type ? t(type) : ''),
    // Only a House Call has a Scope (an Online Consultation has none, and an older draft's leftover is not shown).
    ...(isHouseCall(d) ? [field('scope', t('field_consult_scope'), scope ? t(scope) : '')] : []),
    field('name', t('lbl_name'), d.name, true),
    field('age', t('rd_age'), hasValue(d.age) ? String(Number(String(d.age).trim())) : ''),
    field('gender', t('field_gender'), genderLabel(d.gender, t)),
    field('country', t('field_country'), countryLabel(d.country)),
    field('contact', t('rd_contact'), hasValue(d.phone) ? phoneLabel(`${textOf(d.cc)} ${textOf(d.phone)}`) : ''),
    field('address', t('field_current_address'), d.address, true),
  ]);
}

// Mortal Remains' patient section, in the order of the approved review: the deceased person, the relationship, the two choices, then where and when.
function mortalFields(d, t) {
  const scope = MORTAL_SCOPE_LABEL_KEYS[d.transferScope];
  const mode = MORTAL_MODE_LABEL_KEYS[d.transportMode];
  return compact([
    field('name', t('lbl_deceased_name'), d.name, true),
    field('age', t('rd_age'), hasValue(d.age) ? String(Number(String(d.age).trim())) : ''),
    field('gender', t('field_gender'), genderLabel(d.gender, t)),
    field('relation', t('rd_relation'), relationLabel(d.relation, t), true),
    field('scope', t('field_mortal_scope'), scope ? t(scope) : ''),
    field('mode', t('field_mortal_mode'), mode ? t(mode) : ''),
    field('deathPlace', t('field_place_of_death'), d.deathPlace, true),
    field('country', t('field_country'), countryLabel(d.country)),
    field('deathDate', t('field_date_of_death'), formatDateOnly(d.deathDate), true),
    field('contact', t('rd_contact'), hasValue(d.phone) ? phoneLabel(`${textOf(d.cc)} ${textOf(d.phone)}`) : ''),
  ]);
}

// Medical Value Travel's patient section: the Treatment Scope first, then the patient, the country and the contact number (the cities are the trip).
function mvtPatientFields(d, t) {
  return compact([
    field('scope', mvtText(t, 'mvt_scope'), MVT_SCOPES.includes(d.treatmentScope) ? mvtText(t, `mvt_scope_${d.treatmentScope}`) : '', true),
    field('name', t('lbl_name'), d.name, true),
    field('age', t('rd_age'), hasValue(d.age) ? String(Number(String(d.age).trim())) : ''),
    field('gender', t('field_gender'), genderLabel(d.gender, t)),
    field('country', t('field_country'), countryLabel(d.country)),
    field('contact', t('rd_contact'), hasValue(d.phone) ? phoneLabel(`${textOf(d.cc)} ${textOf(d.phone)}`) : ''),
  ]);
}
// Its medical rows: the Specialty ("Other: <text>" when Other) and the optional Preferred Treatment Date.
function mvtMedicalRows(d, t) {
  const specialty = d.specialty === MVT_OTHER_SPECIALTY ? (hasValue(d.otherSpecialty) ? `${MVT_OTHER_SPECIALTY}: ${d.otherSpecialty}` : MVT_OTHER_SPECIALTY) : d.specialty;
  return compact([
    exactField('specialty', mvtText(t, 'mvt_specialty'), specialty, true),
    field('treatmentDate', mvtText(t, 'mvt_treatment_date'), formatDateOnly(d.date), true),
  ]);
}

// Marine Medical Safety's patient section: the Service Scope first, then the patient, the country and the contact number (the two places are the trip).
function marinePatientFields(d, t) {
  return compact([
    field('scope', marineText(t, 'marine_scope'), MARINE_SCOPES.includes(d.serviceScope) ? marineText(t, `marine_scope_${d.serviceScope}`) : '', true),
    field('name', t('lbl_name'), d.name, true),
    field('age', t('rd_age'), hasValue(d.age) ? String(Number(String(d.age).trim())) : ''),
    field('gender', t('field_gender'), genderLabel(d.gender, t)),
    field('country', t('field_country'), countryLabel(d.country)),
    field('contact', t('rd_contact'), hasValue(d.phone) ? phoneLabel(`${textOf(d.cc)} ${textOf(d.phone)}`) : ''),
  ]);
}
// Its medical rows: the optional Date of Service, the Critical Level names (in the order chosen) and the Oxygen answer (Yes with its flow rate, or No).
function marineMedicalRows(d, t) {
  const levels = chosenCriticalLevels(d).map((key) => t(key)).join(', ');
  const lpm = d.marineOxygen === 'yes' ? parseOxygenLpm(d.oxygenLpm) : null;
  const oxygen = d.marineOxygen === 'yes' ? (lpm !== null ? t('equip_oxygen_lpm', { n: lpm }) : t('answer_yes')) : d.marineOxygen === 'no' ? t('answer_no') : '';
  return compact([
    field('serviceDate', marineText(t, 'marine_date'), formatDateOnly(d.date), true),
    field('criticalLevel', marineText(t, 'marine_critical'), levels, true),
    field('oxygen', t('equip_oxygen'), oxygen, true),
  ]);
}

// Corporate Medical Solutions' patient section: the Company Name, No. of Employees, Name of Employee, Gender, Patient Contact, Preferred Date, Office Address (as typed, line
// breaks kept) and Office Country (by its name, labelled as the office's): separate fields, none standing in for another.
function corporatePatientFields(d, t) {
  return compact([
    exactField('company', corporateText(t, 'corp_company'), typeof d.corpCompany === 'string' ? d.corpCompany.trim() : '', true),
    field('employees', corporateText(t, 'corp_employees'), parseEmployeeCount(d.corpEmployees) !== null ? String(parseEmployeeCount(d.corpEmployees)) : '', true),
    field('name', corporateText(t, 'corp_employee_name'), d.name, true),
    field('gender', t('field_gender'), genderLabel(d.gender, t)),
    field('contact', corporateText(t, 'corp_patient_contact'), hasValue(d.phone) ? phoneLabel(`${textOf(d.cc)} ${textOf(d.phone)}`) : '', true),
    field('serviceDate', corporateText(t, 'corp_preferred_date'), formatDateOnly(d.date), true),
    exactField('officeAddress', corporateText(t, 'corp_office_address'), typeof d.corpOfficeAddress === 'string' && d.corpOfficeAddress.trim() !== '' ? d.corpOfficeAddress.trim() : '', true),
    field('officeCountry', corporateText(t, 'corp_office_country'), typeof d.corpOfficeCountry === 'string' ? d.corpOfficeCountry : '', true),
  ]);
}
// Its medical rows: the programmes chosen, each by its own name (in the list's order, comma-separated), and the two optional requirements exactly as typed.
function corporateMedicalRows(d, t) {
  return compact([
    field('programmes', corporateText(t, 'corp_programmes'), programmeNames(chosenProgrammes(d), t).join(', '), true),
    exactField('anyRequirement', corporateText(t, 'corp_any'), typeof d.corpAny === 'string' && d.corpAny.trim() !== '' ? d.corpAny : '', true),
    exactField('specialRequirement', corporateText(t, 'corp_special'), typeof d.corpSpecial === 'string' && d.corpSpecial.trim() !== '' ? d.corpSpecial : '', true),
  ]);
}

// A value shown EXACTLY as stored or typed (Home Healthcare's address and Medical History): no trimming, and no "looks empty" rule except a truly empty text.
const exactField = (key, label, value, full = true) => (typeof value === 'string' && value !== '' ? { key, label, value, full } : null);

// Home Healthcare's patient section: the patient, the Complete Home Address as typed, and the Service Date (both are asked on Step 1).
function homeFields(d, t) {
  return compact([
    field('name', t('lbl_name'), d.name, true),
    field('age', t('rd_age'), hasValue(d.age) ? String(Number(String(d.age).trim())) : ''),
    field('gender', t('field_gender'), genderLabel(d.gender, t)),
    field('country', t('field_country'), countryLabel(d.country)),
    field('contact', t('rd_contact'), hasValue(d.phone) ? phoneLabel(`${textOf(d.cc)} ${textOf(d.phone)}`) : ''),
    exactField('address', t('field_home_address'), d.homeAddress),
    field('serviceDate', t('field_service_date'), formatDateOnly(d.date), true),
  ]);
}
// Home Healthcare's care rows: only the selections that were answered (all four are optional).
function homeCareRows(d, t) {
  const caretakers = CARETAKER_KEYS.filter((key) => (d.homeCaretakers || []).includes(key)).map((key) => t(CARETAKER_LABEL_KEYS[key])).join(', ');
  const lpm = d.homeOxygen === 'yes' ? parseOxygenLpm(d.oxygenLpm) : null;
  const oxygen = d.homeOxygen === 'yes' ? (lpm !== null ? t('home_oxygen_lpm_value', { n: lpm }) : t('answer_yes')) : d.homeOxygen === 'no' ? t('answer_no') : '';
  return compact([
    field('caretaker', t('field_caretaker'), caretakers, true),
    field('hours', t('field_care_requirement'), HOURS_KEYS.includes(d.homeCareHours) ? t(HOURS_LABEL_KEYS[d.homeCareHours]) : '', true),
    field('careLevel', t('field_home_care_level'), LEVEL_KEYS.includes(d.homeCareLevel) ? t(LEVEL_LABEL_KEYS[d.homeCareLevel]) : '', true),
    field('oxygen', t('equip_oxygen'), oxygen, true),
  ]);
}

// `draft`: the form's draft. `service`: { key, title } from requestService(draft, services) (key is e.g. "commercialair_stretcher").
// `t`: the app's translate function.
export function reviewView(draft, service, t) {
  const d = draft || {};
  // The same service object Request Details works from, so the same helpers apply.
  const asRequest = { serviceKey: service.key, serviceType: service.title };
  const mortal = isMortalKey(asRequest);
  const charter = asRequest.serviceKey === 'privatecharter';
  const transport = isTransportRequest(asRequest);
  const travel = travelTypeKey(asRequest);
  const transfer = transferTypeKey(asRequest);
  const tele = service.key === TELE_SERVICE_KEY;
  const home = service.key === HOME_SERVICE_KEY;
  const mvt = service.key === MVT_SERVICE_KEY;
  const marine = service.key === MARINE_SERVICE_KEY;
  const corporate = service.key === CORPORATE_SERVICE_KEY;

  const patientFields = corporate ? corporatePatientFields(d, t) : marine ?marinePatientFields(d, t) : mvt ? mvtPatientFields(d, t) : tele ? teleFields(d, t) : home ? homeFields(d, t) : mortal ? mortalFields(d, t) : compact([
    field('name', t('lbl_name'), d.name, true),
    field('age', t('rd_age'), d.age),
    field('gender', t('field_gender'), genderLabel(d.gender, t)),
    field('contact', t('rd_contact'), hasValue(d.phone) ? phoneLabel(`${textOf(d.cc)} ${textOf(d.phone)}`) : ''),
    field('country', t('field_country'), countryLabel(d.country)),
  ]);

  // Teleconsultation has no trip (no destination): its address is in the patient section.
  // Medical Value Travel shows its two cities (its date is a medical detail, and it has no transfer type).
  const trip = tele || home || corporate ? { from: '', to: '', rows: [] } : mvt || marine ? { from: textOf(d.location), to: textOf(d.dest), rows: [] } : {
    charter: !!charter,
    from: textOf(d.location),
    to: textOf(d.dest),
    rows: compact([
      field('date', t(mortal ? 'rd_date_transfer' : 'rd_date_service'), formatDateOnly(d.date)),
      field('travelType', t('field_travel_type'), charter ? charterTravelLabel(d.travelType, t) : ''),
      mortal ? null : field('transfer', t('field_mortal_transfer'), transfer ? t(transfer) : ''), // (Mortal Remains' scope is in the patient section)
    ]),
  };

  // Commercial Air: Oxygen carries its flow rate ("Oxygen (4 LPM)"); every other service shows plain Oxygen.
  const commercial = /^commercialair(_|$)/.test(service.key);
  const ground = /^ground(_|$)/.test(service.key);
  const lpm = (commercial || ground) && d.equipOxygen === true ? parseOxygenLpm(d.oxygenLpm) : null;
  // Required on board per service (Commercial Air: no Ventilator; Ground: Oxygen only), and no Patient mobility for either.
  const base = commercial ? 'commercialair' : ground ? 'ground' : service.key;
  const items = transport ? EQUIPMENT.filter(([flag]) => d[flag] === true && asksEquipment(base, flag)).map(([flag, key]) => (flag === 'equipOxygen' && lpm !== null ? t('equip_oxygen_lpm', { n: lpm }) : t(key))) : [];
  const medical = {
    urgency: tele || home || mvt || marine || corporate ? null : urgencyView(d.urgency, t), // Teleconsultation, Home Healthcare and Medical Value Travel have no urgency
    conditionLabel: marine ? marineText(t, 'marine_history') : mvt ? mvtText(t, 'mvt_history') : tele || ground ? t('field_present_issue') : home ? t('req_medical_history') : t(mortal ? 'req_details' : charter ? 'req_medical_history' : 'req_condition'),
    // Home Healthcare's Medical History is shown exactly as typed (whitespace-only counts as not entered).
    condition: corporate ? '' : home || mvt || marine ? (typeof d.desc === 'string' && d.desc.trim() !== '' ? d.desc : '') : textOf(d.desc),
    care: transport ? (Array.isArray(d.care) ? d.care.filter(hasValue).map((key) => t(key)) : []) : [],
    travel: travel ? t(travel) : '',
    mobility: transport && !commercial && !ground ? mobilityLabel(d.mobility, t) : '',
    // Only the items that are on: none on means the whole row is left out.
    equipment: items.length ? { items, none: false } : null,
    criticalLevel: charter ? criticalLevelLabel(d.criticalLevel, t) : '',
    oxygen: charter ? oxygenLabel(d.oxygenRequired, d.oxygenFlowLpm, t) : '',
    // Teleconsultation: the allergies, and the House Call's Preferred Visit Date (an Online Consultation has none).
    details: corporate ? corporateMedicalRows(d, t) : marine ? marineMedicalRows(d, t) : mvt ? mvtMedicalRows(d, t) : tele ? compact([
      field('allergies', t('field_allergy'), d.allergies, true),
      isHouseCall(d) ? field('visitDate', t('field_visit_date'), formatDateOnly(d.date), true) : null,
    ]) : home ? homeCareRows(d, t) : [],
  };

  // Mortal Remains' one upload section holds the certificate and other supporting documents together: the app cannot tell which file is which.
  const docType = t(mortal ? 'lbl_supporting_document' : 'lbl_medical_report');
  const documents = (!tele && !corporate && Array.isArray(d.files) ? d.files : []).filter((f) => f && (hasValue(f.name) || hasValue(f.uri))).map((f) => {
    const name = textOf(f.name) || 'Document';
    const ext = extOf(name);
    return {
      id: textOf(f.uri) || name, name, ext: ext.toUpperCase(),
      isImage: /^image\//.test(String(f.mimeType || '')) || IMAGE_EXT.includes(ext),
      meta: [docType, ext.toUpperCase(), Number.isFinite(f.size) && f.size > 0 ? formatSize(f.size) : ''].filter(Boolean).join(' · '),
      // The request form has no preview of an attached file, so a row here is not tappable (no chevron).
      openable: false, status: null, statusLabel: null, reason: null,
    };
  });

  const medicalShown = !!(medical.urgency || medical.condition || medical.travel || medical.details.length || medical.care.length || medical.mobility || medical.equipment || medical.criticalLevel || medical.oxygen);
  return {
    service: { key: serviceKeyOf(asRequest), name: baseServiceName(asRequest, t) },
    patient: { titleKey: mortal ? 'rd_deceased' : 'rd_patient', fields: patientFields },
    trip,
    medical,
    documents,
    // Which sections are drawn: a section with nothing in it is left out, heading and all.
    show: {
      patient: patientFields.length > 0,
      trip: !!(trip.from || trip.to || trip.rows.length),
      medical: medicalShown,
      documents: documents.length > 0,
    },
  };
}

// The keys of the draft that the page must account for, for a service (used by the tests).
export function fieldsFor(serviceKey) {
  const base = String(serviceKey || '').split('_')[0];
  const out = { ...FORM_FIELDS.always };
  if (base === 'privatecharter') Object.assign(out, FORM_FIELDS.privatecharter);
  else if (['air', 'commercialair', 'ground'].includes(base)) Object.assign(out, FORM_FIELDS.transport);
  if (base === 'commercialair') {
    Object.assign(out, FORM_FIELDS.commercialair);
    delete out.mobility; // Commercial Air asks neither Patient mobility nor the Ventilator
    delete out.equipVentilator;
  }
  if (base === 'ground') {
    // Ground Ambulance: critical levels and Oxygen with its flow rate; no Patient mobility, Cardiac monitor or Ventilator
    Object.assign(out, { oxygenLpm: FORM_FIELDS.commercialair.oxygenLpm });
    delete out.mobility;
    delete out.equipCardiac;
    delete out.equipVentilator;
  }
  if (base === 'mortal') Object.assign(out, FORM_FIELDS.mortal);
  if (base === 'marine') {
    // Marine Medical Safety: no urgency, mobility or equipment items; the Date of Service (`date`) is a medical detail; the two places are the trip.
    Object.assign(out, FORM_FIELDS.marine, { date: 'medical', oxygenLpm: 'medical' });
    delete out.urgency;
  }
  if (base === 'medvalue') {
    // Medical Value Travel: no urgency; the Preferred Treatment Date (`date`) is a medical detail; the two cities are the trip.
    Object.assign(out, FORM_FIELDS.mvt, { date: 'medical' });
    delete out.urgency;
  }
  if (base === 'homecare') {
    // Home Healthcare: no trip and no urgency; the Service Date (`date`) is a patient detail, the flow rate a medical one.
    Object.assign(out, FORM_FIELDS.home, { date: 'patient', oxygenLpm: 'medical' });
    delete out.location;
    delete out.dest;
    delete out.urgency;
  }
  if (base === 'corporate') {
    // Corporate Medical Solutions: the Name of Employee (`name`), the Gender (`gender`), the contact number (`phone`, `cc`) and the Preferred Date (`date`) of the usual patient
    // fields, plus its own seven. No age, patient country, trip, urgency, medical-history text or documents.
    for (const key of ['age', 'country', 'location', 'dest', 'urgency', 'desc', 'files']) delete out[key];
    Object.assign(out, FORM_FIELDS.corporate);
  }
  if (base === 'tele') {
    // Teleconsultation: no trip, no urgency, no documents; the House Call's visit date is the draft's `date`, shown with the medical details.
    Object.assign(out, FORM_FIELDS.tele, { date: 'medical' });
    delete out.location;
    delete out.dest;
    delete out.urgency;
    delete out.files;
  }
  return out;
}
