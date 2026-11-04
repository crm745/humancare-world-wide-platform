// Pure rules of the New Request form (no React, no native modules), kept apart so they can be
// unit-tested: which services are patient transport, and what changing service keeps.

// Care level, mobility and equipment only matter for patient transport: the air ambulance
// options and ground ambulance.
const CARE_LEVEL_SERVICES = ['air', 'privatecharter', 'commercialair', 'ground'];
export const needsCareLevel = (serviceKey) => CARE_LEVEL_SERVICES.includes(serviceKey);

// What belonged only to the previous service when the service is swapped from inside the form.
const SERVICE_ONLY_FIELDS = { airlineMode: '', mortalTransfer: '', relation: '', deathPlace: '', deathDate: '' };
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
