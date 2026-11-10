import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Pure rules of the Private Charter request (no React, no native modules), kept apart so they can
// be unit-tested against the backend validator: which draft is a Private Charter request, exactly
// what is sent, and how the API's field errors map back to the form.
//
// The backend validator (backend/src/modules/requests/private-charter.validation.js) is the
// contract. This file only builds what it expects; it never relaxes anything.

export const PRIVATE_CHARTER_KEY = 'privatecharter';
// Must equal the service name in data/services.json and the backend constant.
export const PRIVATE_CHARTER_SERVICE_TYPE = 'Private Charter Air Ambulance Service';

// The app's generic "air" service is the Private Charter tile under an older key (the form
// already shows it as Private Charter). A request is always sent under the real key.
export const normalizeServiceKey = (serviceKey) => (serviceKey === 'air' ? PRIVATE_CHARTER_KEY : serviceKey);
export const isPrivateCharter = (serviceKey) => normalizeServiceKey(serviceKey) === PRIVATE_CHARTER_KEY;

// A city the person picked from the search: only what the server returned for it.
export function toCityChoice(city) {
  return { geonameId: city.geonameId, name: city.name, label: city.label, countryCode: city.countryCode };
}

// The contact number as the server stores it (E.164), worked out with the same library and the
// same steps as the backend's normalizeMobile: national digits behind the calling code, trunk
// prefix dropped by the country's own rules. null when it is not a valid number.
export function contactE164(callingCode, nationalNumber) {
  const cc = String(callingCode || '').replace(/\D/g, '');
  const digits = String(nationalNumber || '').replace(/\D/g, '');
  if (!cc || !digits) return null;
  const parsed = parsePhoneNumberFromString(`+${cc}${digits}`);
  return parsed && parsed.isValid() ? parsed.number : null;
}

// A Private Charter request cannot be submitted without at least one document. (The server keeps a request
// with no document as a draft: it is not a submission, Admin does not see it in the queue, and it cannot be approved.)
export const needsDocument = (draft) => isPrivateCharter(draft.service) && !(draft.files && draft.files.length);

// The age limit the server applies to Private Charter (the form's general check allows up to 129).
export const PRIVATE_CHARTER_MAX_AGE = 120;
export const isPrivateCharterAge = (value) => {
  const text = String(value ?? '').trim();
  return /^\d{1,3}$/.test(text) && Number(text) >= 1 && Number(text) <= PRIVATE_CHARTER_MAX_AGE;
};

// The request body for POST /requests, in the formats the backend stores: gender in lower case,
// the contact number in E.164, the country as an ISO code, each city as { geonameId } only, the
// care level as a list of keys, the date as YYYY-MM-DD. There is no patientLocation, and no
// deceased fields. Optional values the person left empty are left out.
export function buildPrivateCharterPayload(draft) {
  const contact = contactE164(draft.cc, draft.phone);
  return {
    serviceKey: PRIVATE_CHARTER_KEY,
    serviceType: PRIVATE_CHARTER_SERVICE_TYPE,
    patientName: draft.name,
    patientAge: isPrivateCharterAge(draft.age) ? Number(String(draft.age).trim()) : draft.age || undefined,
    patientGender: draft.gender ? String(draft.gender).toLowerCase() : undefined,
    patientContact: contact || (draft.phone ? `${draft.cc} ${draft.phone}` : undefined),
    country: draft.countryIso || undefined,
    origin: draft.originCity ? { geonameId: draft.originCity.geonameId } : undefined,
    destination: draft.destCity ? { geonameId: draft.destCity.geonameId } : undefined,
    preferredDate: draft.date || undefined,
    careLevel: draft.care && draft.care.length ? [...draft.care] : undefined,
    description: draft.desc || undefined,
    mobility: draft.mobility || undefined,
    equipOxygen: !!draft.equipOxygen,
    equipCardiacMonitor: !!draft.equipCardiac,
    equipVentilator: !!draft.equipVentilator,
    urgency: draft.urgency || undefined,
  };
}

// --- The API's field errors, back onto the form ---------------------------------------------
// API field -> the form step it is on (1 patient and trip, 2 medical) and the anchor to scroll to.
// A field that is not on the form (serviceKey, serviceType, anything unexpected) has no entry.
export const API_FIELD_LOCATION = {
  patientName: { step: 1, anchor: 'name' },
  patientAge: { step: 1, anchor: 'age' },
  patientGender: { step: 1, anchor: 'age' },
  country: { step: 1, anchor: 'country' },
  origin: { step: 1, anchor: 'location' },
  destination: { step: 1, anchor: 'dest' },
  patientContact: { step: 1, anchor: 'phone' },
  preferredDate: { step: 1, anchor: 'date' },
  careLevel: { step: 2, anchor: 'care' },
  description: { step: 2, anchor: 'desc' },
  mobility: { step: 2, anchor: 'mobility' },
  equipOxygen: { step: 2, anchor: 'equipment' },
  equipCardiacMonitor: { step: 2, anchor: 'equipment' },
  equipVentilator: { step: 2, anchor: 'equipment' },
  urgency: { step: 2, anchor: 'urgency' },
};

// Draft key -> the API field it feeds. Changing one clears that field's server error.
const DRAFT_TO_API = {
  name: ['patientName'], age: ['patientAge'], gender: ['patientGender'],
  phone: ['patientContact'], cc: ['patientContact'], phoneCountry: ['patientContact'],
  country: ['country'], countryIso: ['country'],
  location: ['origin'], originCity: ['origin'], dest: ['destination'], destCity: ['destination'],
  date: ['preferredDate'], care: ['careLevel'], desc: ['description'], mobility: ['mobility'],
  equipOxygen: ['equipOxygen'], equipCardiac: ['equipCardiacMonitor'], equipVentilator: ['equipVentilator'],
  urgency: ['urgency'],
};

// The `fields` object of a 400 response, as { apiField: message } (text values only), or null.
export function fieldErrorsFromError(err) {
  const fields = err && err.status === 400 && err.data && err.data.fields;
  if (!fields || typeof fields !== 'object') return null;
  const out = {};
  for (const [field, message] of Object.entries(fields)) {
    if (typeof message === 'string' && message) out[field] = message;
  }
  return Object.keys(out).length ? out : null;
}

// The errors still standing after the person changed these draft keys.
export function clearErrorsForPatch(errors, patch) {
  if (!errors) return errors;
  let next = errors;
  for (const key of Object.keys(patch)) {
    for (const field of DRAFT_TO_API[key] || []) {
      if (field in next) { if (next === errors) next = { ...errors }; delete next[field]; }
    }
  }
  return Object.keys(next).length ? next : null;
}

// Where to send the person: the earliest step holding an error, and the first field on it.
// `step` is 0 when none of the errors belongs to a field on the form.
export function firstErrorLocation(errors) {
  const located = Object.keys(errors || {}).map((field) => API_FIELD_LOCATION[field]).filter(Boolean);
  if (!located.length) return { step: 0, anchor: null };
  const step = Math.min(...located.map((l) => l.step));
  return { step, anchor: firstAnchorOnStep(errors, step) };
}

// Page order of the anchors on each step: where a step scrolls to first.
const ANCHOR_ORDER = {
  1: ['name', 'age', 'country', 'location', 'dest', 'phone', 'date'],
  2: ['desc', 'care', 'mobility', 'equipment', 'urgency'],
};
export function firstAnchorOnStep(errors, step) {
  const here = new Set(Object.keys(errors || {}).map((field) => API_FIELD_LOCATION[field]).filter((l) => l && l.step === step).map((l) => l.anchor));
  return (ANCHOR_ORDER[step] || []).find((anchor) => here.has(anchor)) || null;
}

// The messages for errors that no field on the form shows (for a toast).
export function unplacedMessages(errors) {
  return Object.entries(errors || {}).filter(([field]) => !API_FIELD_LOCATION[field]).map(([, message]) => message);
}
