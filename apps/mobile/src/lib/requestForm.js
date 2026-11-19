import { dialOf, nameOf, pickNationality, pickPhoneCountry } from './phoneCountry';
import { isTeleService } from './teleConsultation';
import { isCorporateService } from './corporateMedical';

// Pure rules of the New Request form (no React, no native modules), kept apart so they can be
// unit-tested: which services are patient transport, what changing service keeps, and how the
// contact number's country code follows the country.

// Care level, mobility and equipment only matter for patient transport: the air ambulance
// options and ground ambulance.
const CARE_LEVEL_SERVICES = ['air', 'privatecharter', 'commercialair', 'ground'];
export const needsCareLevel = (serviceKey) => CARE_LEVEL_SERVICES.includes(serviceKey);

// Commercial Air and Ground Ambulance have their OWN care-level options: ICU, Ventilated, Tracheostomy, ECMO (stored and sent as these keys,
// never as the labels). Every other service keeps the original four (components/ui.js CARE_LEVELS). The two sets are never mixed: the backend
// refuses anything else for these two, so swapping the service into or out of them starts the care level again (see draftForService).
export const COMMERCIAL_AIR_CARE_LEVELS = ['crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo'];
export const isGroundService = (serviceKey) => serviceKey === 'ground';
// Ground Ambulance's medical page is Commercial Air's without Travel type: critical levels, Oxygen only on board (with its flow rate), no Patient mobility.
// Keyed on 'ground' alone: Private Charter and the older 'air' key keep the original page.
export const usesCriticalLevels = (serviceKey) => serviceKey === 'commercialair' || isGroundService(serviceKey);
export const careLevelOptionsFor = (serviceKey, originalOptions) => (usesCriticalLevels(serviceKey) ? COMMERCIAL_AIR_CARE_LEVELS : originalOptions);

// Commercial Air and Ground Ambulance: choosing Oxygen under "Required on board" asks for the oxygen flow rate in litres per minute (LPM). It is
// mandatory while Oxygen is on, cleared when Oxygen goes off, and sent only for those two (the backend refuses it for any other
// service; Private Charter has its own form rules and never asks it). The limits are the backend's own (request.constants.js).
export const OXYGEN_LPM_MAX = 15;
export const needsOxygenRate = (serviceKey) => usesCriticalLevels(serviceKey);

// What was typed, as a number: a positive number up to OXYGEN_LPM_MAX with at most one decimal ("4", "2.5", "0,5" from a decimal-comma
// keyboard). null when it is empty or not acceptable.
export function parseOxygenLpm(text) {
  const clean = String(text == null ? '' : text).trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d)?$/.test(clean)) return null;
  const value = Number(clean);
  return value > 0 && value <= OXYGEN_LPM_MAX ? value : null;
}
export const isValidOxygenLpm = (text) => parseOxygenLpm(text) !== null;

// What is wrong with the flow rate of this draft: null when nothing (not asked, or fine), 'required' (Oxygen is on and nothing is typed),
// 'invalid' (typed, but not an acceptable flow rate).
export function oxygenLpmProblem(draft) {
  if (!needsOxygenRate(draft.service) || !draft.equipOxygen) return null;
  if (!String(draft.oxygenLpm == null ? '' : draft.oxygenLpm).trim()) return 'required';
  return isValidOxygenLpm(draft.oxygenLpm) ? null : 'invalid';
}

// Ground Ambulance: the Present medical issue (the description) is mandatory; whitespace alone does not count. Every other service is unchanged.
export const presentIssueMissing = (draft) => isGroundService(draft.service) && !String(draft.desc == null ? '' : draft.desc).trim();

// Commercial Air's medical page: Travel type (Stretcher or Wheelchair) is asked here, not on Step 1. Required on board is Oxygen and Cardiac
// monitor only (the Ventilator is the Care Level "Ventilated"), and Patient mobility is not asked: Travel type takes its place.
// Everything else (Private Charter, ground ambulance, ...) is unchanged.
export const isCommercialAirService = (serviceKey) => serviceKey === 'commercialair';
// Required on board per service: Commercial Air drops the Ventilator; Ground Ambulance is Oxygen only. Everything else keeps all three.
export const asksEquipment = (serviceKey, field) => {
  if (isCommercialAirService(serviceKey)) return field !== 'equipVentilator';
  if (isGroundService(serviceKey)) return field === 'equipOxygen';
  return true;
};
export const equipmentOptionsFor = (serviceKey, all) => (isCommercialAirService(serviceKey) || isGroundService(serviceKey) ? all.filter(([field]) => asksEquipment(serviceKey, field)) : all);
export const needsTravelType = isCommercialAirService;
// What the Travel type chips on Step 2 say. Only the text on screen: the value, the service key (commercialair_stretcher / _wheelchair) and the
// service name sent with the request (data/mock.js AIRLINE_MODE_LABELS, "Stretcher (CAS)" / "Wheelchair (CAW)") are unchanged.
export const TRAVEL_TYPE_LABELS = { stretcher: 'Stretcher', wheelchair: 'Wheelchair' };
export const asksPatientMobility = (serviceKey) => needsCareLevel(serviceKey) && !isCommercialAirService(serviceKey) && !isGroundService(serviceKey);

// What belonged only to the previous service when the service is swapped from inside the form.
const SERVICE_ONLY_FIELDS = { airlineMode: '', teleScope: '', teleType: '', address: '', allergies: '', oxygenLpm: '', mortalTransfer: '', transferScope: '', transportMode: '', relation: '', deathPlace: '', deathDate: '', homeAddress: '', homeCaretakers: [], homeCareHours: '', homeCareLevel: '', homeOxygen: '', treatmentScope: '', specialty: '', otherSpecialty: '', serviceScope: '', marineCare: [], marineOxygen: '', corpCompany: '', corpEmployees: '', corpProgrammes: [], corpAny: '', corpSpecial: '', corpOfficeAddress: '', corpOfficeCountry: '', corpOfficeCountryIso: '', sentRequest: null, uploaded: [], uploadErrors: {} };
const TRANSPORT_ONLY_FIELDS = { care: [], mobility: '', equipOxygen: false, equipCardiac: false, equipVentilator: false };

// The draft for a newly chosen service. Starting a request fresh gives an empty form. Swapping
// the service from inside the form (`changingService`) keeps the patient, trip and medical
// answers and clears only what belonged to the old service alone.
export function draftForService(previous, service, initial) {
  if (!previous.changingService) return { ...initial, service };
  // The critical levels (Commercial Air, Ground) are a different set from every other service's: none of the old answers fits the other set.
  const careSetChanges = usesCriticalLevels(previous.service) !== usesCriticalLevels(service);
  return {
    ...previous,
    ...SERVICE_ONLY_FIELDS,
    ...(careSetChanges ? { care: [] } : {}),
    // Commercial Air does not ask Patient mobility or the Ventilator: nothing typed for another service is carried into it.
    ...(isCommercialAirService(service) ? { mobility: '', equipVentilator: false } : {}),
    // Ground Ambulance asks neither Patient mobility, Cardiac monitor nor the Ventilator.
    ...(isGroundService(service) ? { mobility: '', equipCardiac: false, equipVentilator: false } : {}),
    // Teleconsultation has no Date of Service, no urgency and no documents: a date typed for another service is not its visit date (and its visit
    // date is not another service's date), and nothing typed elsewhere (files, urgency) is carried into it. Its own answers go on leaving (above).
    ...(isTeleService(previous.service) || isTeleService(service) ? { date: '' } : {}),
    ...(isTeleService(service) ? { files: [], urgency: '' } : {}),
    // Corporate Medical Solutions takes no documents, urgency or date: nothing typed for another service is carried into it.
    ...(isCorporateService(service) ? { files: [], urgency: '', date: '' } : {}),
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
