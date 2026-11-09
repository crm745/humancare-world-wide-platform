// What an Admin sees for a request in the review workflow, derived from the list API's
// `reviewStatus` and `documents` summary. Pure and DOM-free so `node --test` can run it.
//
// The summary counts only CURRENT documents (replaced versions are left out):
//   current, awaitingScan (never scanned OR the scan failed), scanErrors (the failed part of
//   awaitingScan), scanFailed (can never be scanned; not part of awaitingScan), infected, awaitingReview,
//   approved, rejected.

export const REVIEW_STATUS_LABEL = {
  awaiting_documents: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
};

export const URGENCY_LABEL = {
  critical_6h: 'Critical (6h)',
  urgent_24h: 'Urgent (24h)',
  planned: 'Planned',
};

// The two statuses that mean "submitted, not yet approved". Sent as one comma-separated
// `status` value; the approved ones and the drafts are not part of it.
export const OPEN_STATUSES = 'in_review,changes_requested';

/**
 * The badges that explain where a submission's documents stand, most urgent first.
 * Each is { key, label, tone, prominent?, title? }.
 */
export function documentBadges(request) {
  const d = request.documents ?? {};
  const badges = [];
  if (d.infected > 0) {
    badges.push({ key: 'infected', label: d.infected === 1 ? 'Infected document' : `${d.infected} infected documents`, tone: 'danger', prominent: true, title: 'A document failed the virus scan and is quarantined.' });
  }
  // scanErrors is a subset of awaitingScan; an API that does not send it counts as none.
  const scanErrors = Math.min(d.scanErrors ?? 0, d.awaitingScan ?? 0);
  if (scanErrors > 0) {
    badges.push({ key: 'scanError', label: 'Scan error', tone: 'danger', title: 'The virus scan could not be completed. It is retried automatically; the document cannot be opened or approved until it succeeds.' });
  }
  if (d.scanFailed > 0) {
    badges.push({ key: 'scanFailed', label: d.scanFailed === 1 ? 'Scan failed, needs a replacement' : `${d.scanFailed} scans failed, need replacements`, tone: 'danger', title: 'The file is missing or was altered, so it can never be scanned. The patient must upload a replacement.' });
  }
  if (d.awaitingScan - scanErrors > 0) {
    badges.push({ key: 'scan', label: 'Awaiting scan', tone: 'warning', title: 'Not scanned yet.' });
  }
  if (d.rejected > 0) {
    badges.push({ key: 'rejected', label: 'Rejected, awaiting replacement', tone: 'warning' });
  }
  if (d.awaitingReview > 0) {
    badges.push({ key: 'review', label: 'Awaiting review', tone: 'info' });
  }
  if (request.reviewStatus === 'changes_requested' && request.documentsRequestReason) {
    badges.push({ key: 'requested', label: 'Documents requested', tone: 'warning', title: request.documentsRequestReason });
  }
  if (isReadyForApproval(request)) {
    badges.push({ key: 'ready', label: 'Ready for approval', tone: 'success' });
  }
  if (!badges.length && (d.current ?? 0) === 0) {
    badges.push({ key: 'none', label: 'No current document', tone: 'neutral' });
  }
  return badges;
}

/** In review, with at least one current document, every one clean and approved. */
export function isReadyForApproval(request) {
  const d = request.documents ?? {};
  return (
    request.reviewStatus === 'in_review' &&
    d.current > 0 &&
    d.awaitingScan === 0 &&
    (d.scanFailed ?? 0) === 0 &&
    d.infected === 0 &&
    d.awaitingReview === 0 &&
    d.rejected === 0 &&
    d.approved === d.current
  );
}

export function statusTone(reviewStatus) {
  if (reviewStatus === 'changes_requested') return 'warning';
  if (reviewStatus === 'approved') return 'success';
  if (reviewStatus === 'in_review') return 'info';
  return 'neutral';
}
