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
  baseServiceName, countryLabel, extOf, formatDateOnly, genderLabel, isMortalKey, isTransportRequest, mobilityLabel, phoneLabel, relationLabel,
  textOf, transferTypeKey, travelTypeKey, urgencyView,
} from './requestDetailsView';
import { serviceKeyOf } from './myRequestsView';
import { formatSize } from './documentHistoryView';

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
  commercialair: { airlineMode: 'trip' },
  mortal: { mortalTransfer: 'trip', relation: 'patient', deathPlace: 'patient', deathDate: 'patient' },
};
// Draft keys that are not answers the person gave (internal bookkeeping), so they are not shown.
export const NOT_SHOWN = [
  'service', 'sentRequest', 'uploaded', 'uploadErrors', 'originCity', 'destCity', 'countryIso', 'phoneCountry', 'ccEdited', 'changingService',
];

// `draft`: the form's draft. `service`: { key, title } from requestService(draft, services) (key is e.g. "commercialair_stretcher").
// `t`: the app's translate function.
export function reviewView(draft, service, t) {
  const d = draft || {};
  // The same service object Request Details works from, so the same helpers apply.
  const asRequest = { serviceKey: service.key, serviceType: service.title };
  const mortal = isMortalKey(asRequest);
  const transport = isTransportRequest(asRequest);
  const travel = travelTypeKey(asRequest);
  const transfer = transferTypeKey(asRequest);

  const patientFields = compact([
    field('name', t(mortal ? 'lbl_deceased_name' : 'lbl_name'), d.name, true),
    field('age', t('rd_age'), d.age),
    field('gender', t('field_gender'), genderLabel(d.gender, t)),
    field('contact', t('rd_contact'), hasValue(d.phone) ? phoneLabel(`${textOf(d.cc)} ${textOf(d.phone)}`) : ''),
    field('country', t('field_country'), countryLabel(d.country)),
    ...(mortal ? [
      field('relation', t('rd_relation'), relationLabel(d.relation, t), true),
      field('deathPlace', t('field_place_of_death'), d.deathPlace, true),
      field('deathDate', t('field_date_of_death'), formatDateOnly(d.deathDate), true),
    ] : []),
  ]);

  const trip = {
    from: textOf(d.location),
    to: textOf(d.dest),
    rows: compact([
      field('date', t(mortal ? 'rd_date_transfer' : 'rd_date_service'), formatDateOnly(d.date)),
      field('travel', t('field_airline_mode'), travel ? t(travel) : ''),
      field('transfer', t('field_mortal_transfer'), transfer ? t(transfer) : ''),
    ]),
  };

  const items = transport ? EQUIPMENT.filter(([flag]) => d[flag] === true).map(([, key]) => t(key)) : [];
  const medical = {
    urgency: urgencyView(d.urgency, t),
    conditionLabel: t(mortal ? 'req_details' : 'req_condition'),
    condition: textOf(d.desc),
    care: transport ? (Array.isArray(d.care) ? d.care.filter(hasValue).map((key) => t(key)) : []) : [],
    mobility: transport ? mobilityLabel(d.mobility, t) : '',
    // Only the items that are on: none on means the whole row is left out.
    equipment: items.length ? { items, none: false } : null,
  };

  const docType = t(mortal ? 'lbl_death_certificate' : 'lbl_medical_report');
  const documents = (Array.isArray(d.files) ? d.files : []).filter((f) => f && (hasValue(f.name) || hasValue(f.uri))).map((f) => {
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

  const medicalShown = !!(medical.urgency || medical.condition || medical.care.length || medical.mobility || medical.equipment);
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
  if (['air', 'privatecharter', 'commercialair', 'ground'].includes(base)) Object.assign(out, FORM_FIELDS.transport);
  if (base === 'commercialair') Object.assign(out, FORM_FIELDS.commercialair);
  if (base === 'mortal') Object.assign(out, FORM_FIELDS.mortal);
  return out;
}
