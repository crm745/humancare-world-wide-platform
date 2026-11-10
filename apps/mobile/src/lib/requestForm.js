import { dialOf, nameOf, pickNationality, pickPhoneCountry } from './phoneCountry';

// Pure rules of the New Request form (no React, no native modules), kept apart so they can be
// unit-tested: which services are patient transport, what changing service keeps, and how the
// contact number's country code follows the country.

// Care level, mobility and equipment only matter for patient transport: the air ambulance
// options and ground ambulance.
const CARE_LEVEL_SERVICES = ['air', 'privatecharter', 'commercialair', 'ground'];
export const needsCareLevel = (serviceKey) => CARE_LEVEL_SERVICES.includes(serviceKey);

// What belonged only to the previous service when the service is swapped from inside the form.
const SERVICE_ONLY_FIELDS = { airlineMode: '', mortalTransfer: '', relation: '', deathPlace: '', deathDate: '', sentRequest: null, uploaded: [], uploadErrors: {} };
const TRANSPORT_ONLY_FIELDS = { care: [], mobility: '', equipOxygen: false, equipCardiac: false, equipVentilator: false };

// The draft for a newly chosen service. Starting a request fresh gives an empty form. Swapping
// the service from inside the form (`changingService`) keeps the patient, trip and medical
// answers and clears only what belonged to the old service alone.
export function draftForService(previous, service, initial) {
  if (!previous.changingService) return { ...initial, service };
  return {
    ...previous,
    ...SERVICE_ONLY_FIELDS,
    ...(needsCareLevel(service) ? {} : TRANSPORT_ONLY_FIELDS),
    service,
    changingService: false,
  };
}

// Picking the Country sets the contact number's country code to that country's own, until the
// person has changed the code by hand: after that the code is theirs and the country no longer
// moves it. Digits already typed stay; only the code changes. Returns what to put in the draft.
// `country` stays the country's name and `cc` the dial code ("+971"): the formats the backend
// and Bitrix already get.
export function pickRequestCountry(draft, isoCode) {
  const next = pickNationality({ nationality: draft.countryIso, phoneCountry: draft.phoneCountry, codeEdited: draft.ccEdited }, isoCode);
  return { country: nameOf(isoCode), countryIso: isoCode, phoneCountry: next.phoneCountry, cc: dialOf(next.phoneCountry), ccEdited: next.codeEdited };
}

// Picking the code by hand: remember which country it was (so +1 stays US or Canada) and stop
// the Country from moving it.
export function pickRequestPhoneCountry(draft, isoCode) {
  const next = pickPhoneCountry({ nationality: draft.countryIso, phoneCountry: draft.phoneCountry, codeEdited: draft.ccEdited }, isoCode);
  return { phoneCountry: next.phoneCountry, cc: dialOf(next.phoneCountry), ccEdited: true };
}
