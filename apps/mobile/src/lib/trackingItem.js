// Pure shaping of what the Tracking screen shows (no React, no native modules), so it can be unit-tested.
// A patient's ServiceRequest (with its linked Case nested inside, once one exists) and a corporate's Case
// are different shapes from the backend; each is flattened into the one item the screen reads.
import { isMortalRequest } from './requestShape';
import { reviewPill, reviewState } from './requestDocuments';

// Opens a patient's request on the Tracking screen: the request id (never a Case id), no `kind`.
// The screen then loads GET /requests/me/:id, which carries the Case and its stage events once the
// request is approved, so the same link keeps working before and after approval.
export const trackingRoute = (request, tab) => ({ pathname: '/tracking', params: { id: request.id, ...(tab ? { tab } : {}) } });

export function trackingItemFromRequest(request) {
  const c = request.case;
  return {
    referenceNumber: request.referenceNumber,
    serviceType: request.serviceType,
    origin: request.origin,
    destination: request.destination,
    status: request.status,
    mortal: isMortalRequest(request),
    patientLabel: `${request.patientName}${request.patientAge ? `, ${request.patientAge}` : ''}${request.patientGender ? ` / ${request.patientGender}` : ''}`,
    stageEvents: c?.stageEvents || [],
    documents: c?.documents || [],
    // Request-first review workflow (Private Charter): its status chip and its documents come from the
    // request, not from the Case. `request` is kept for those components; null for everything else.
    workflow: reviewState(request) !== null,
    reviewPill: reviewPill(request),
    request: reviewState(request) !== null ? request : null,
  };
}

export function trackingItemFromCase(c) {
  return {
    referenceNumber: c.referenceNumber,
    serviceType: c.serviceType,
    origin: c.origin,
    destination: c.destination,
    status: c.status,
    patientLabel: c.patientName,
    stageEvents: c.stageEvents || [],
    documents: c.documents || [],
    workflow: false,
    reviewPill: null,
    request: null,
  };
}
