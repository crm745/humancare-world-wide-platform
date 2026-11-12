// Which tracking design a request uses (no React, no native modules).
// Decided only from the service KEY, never from the display title: titles carry suffixes
// ("— Stretcher (CAS)", "— Domestic") and are translated, so matching them is unreliable.
import { PRIVATE_CHARTER_KEY } from '../privateCharter';

export const TRACKING_FAMILY = Object.freeze({ PRIVATE_CHARTER: 'privatecharter', GENERIC: 'generic' });

// 'privatecharter' only for the canonical Private Charter key. The legacy key "air" (older "Air Ambulance"
// requests, not necessarily Private Charter) and every other, missing or unknown key are 'generic'.
// This is deliberately not the "air" alias the request form applies when it builds a new request.
export function familyForServiceKey(serviceKey) {
  return serviceKey === PRIVATE_CHARTER_KEY ? TRACKING_FAMILY.PRIVATE_CHARTER : TRACKING_FAMILY.GENERIC;
}

// The family of a request as the API returns it (reads `serviceKey` only).
export const resolveTrackingFamily = (request) => familyForServiceKey(request?.serviceKey);

export const isPrivateCharterTracking = (request) => resolveTrackingFamily(request) === TRACKING_FAMILY.PRIVATE_CHARTER;
