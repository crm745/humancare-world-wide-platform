// Dashboard figures, derived only from what the existing APIs return completely. Pure and DOM-free so
// `node --test` can run it. A figure that cannot be established is `null` ("unavailable"), never 0 or a guess.
//
// Sources:
//  - GET /admin/requests?status=<s>&limit=1 -> { total }: the server's count of matching requests (it ignores
//    limit/offset, so a one-row page still carries the full count). Only Private Charter requests that entered the
//    review workflow have a reviewStatus, so other services and older requests without one are never counted.
//  - Operational Cases is deliberately NOT calculated: no existing API tells a Case created by approving a Private Charter
//    request from the Cases the legacy flow creates (those also carry a serviceRequestId), and the Approved count must not
//    stand in for it. It is always reported as unavailable.

// reviewStatus values of the request-first workflow (backend request-review.config.js).
export const STAT_STATUS = {
  pending: 'in_review', // submitted, waiting for an Admin to review documents and decide
  awaitingPatient: 'changes_requested', // the patient must act: Admin asked for documents, or a document was rejected
  approved: 'approved', // approved by an Admin; a Case was created
};

/** The server's count from a list response, or null when it did not send a usable one. */
export function countFrom(result) {
  const total = result?.total;
  return Number.isInteger(total) && total >= 0 ? total : null;
}

/** Submitted requests (drafts excluded): in review + awaiting the patient + approved. Null if any part is unknown. */
export function totalRequests(pending, awaitingPatient, approved) {
  return [pending, awaitingPatient, approved].every((n) => Number.isInteger(n)) ? pending + awaitingPatient + approved : null;
}

/** True when a card failed to load (as opposed to being unsupported by the existing APIs). */
export const isFailed = (stat) => stat.value === null && !stat.unsupported;

/** The five cards, in display order. `value` null = unavailable; `unsupported` = it cannot be calculated from the existing APIs. */
export function buildStats({ pending, awaitingPatient, approved }) {
  return [
    { key: 'total', label: 'Total Requests', value: totalRequests(pending, awaitingPatient, approved), hint: 'Submitted Private Charter requests (drafts not included)', to: '/requests' },
    { key: 'pending', label: 'Pending Submissions', value: pending, hint: 'Waiting for an Admin to review', to: '/requests' },
    { key: 'awaiting', label: 'Awaiting Patient Documents', value: awaitingPatient, hint: 'The patient must upload or replace a document', to: '/requests' },
    { key: 'approved', label: 'Approved Requests', value: approved, hint: 'Approved by an Admin', to: null },
    { key: 'cases', label: 'Operational Cases', value: null, unsupported: true, hint: 'Not available: no existing API separates Cases created by approval from legacy Cases', to: '/cases' },
  ];
}
