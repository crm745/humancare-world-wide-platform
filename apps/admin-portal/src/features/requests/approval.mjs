// When an Admin may approve a request (which makes the backend open an operational Case). Mirrors the
// backend's approvalBlockers (request-review.service.js); the server checks again, in a transaction, and
// is the only place a Case is ever created. Pure and DOM-free so `node --test` can run it.

// The Case details page (Phase G) is at /cases/:id.
export const CASE_DETAILS_AVAILABLE = true;

/** Where to open the operational Case, or null while its page does not exist. */
export function caseDetailsPath(caseRecord) {
  if (!CASE_DETAILS_AVAILABLE || !caseRecord?.id) return null;
  return `/cases/${encodeURIComponent(caseRecord.id)}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * { allowed, blockers }: `blockers` are the plain-language reasons approval is not offered (empty when allowed).
 * Rules: the request is in review, has at least one current document, and every current document is clean
 * (scanned, not infected, no scan error) and approved by an Admin (none pending, none rejected).
 * An approved request is not "blocked": there is nothing left to approve (`approved: true`).
 */
export function approvalEligibility(request) {
  const status = request?.reviewStatus;
  if (status === 'approved') return { allowed: false, approved: true, blockers: [] };

  const blockers = [];
  if (status === 'awaiting_documents') blockers.push('This request is a draft: the patient has not submitted it yet.');
  else if (status === 'changes_requested') {
    blockers.push(
      request.documentsRequestReason
        ? 'Additional documents were requested and the patient has not responded yet.'
        : 'The patient has not yet replaced the rejected document(s).',
    );
  } else if (status !== 'in_review') blockers.push('This request is not in the document review workflow.');

  const d = request?.documentSummary;
  if (!d) {
    blockers.push('The document summary is unavailable. Refresh the page.');
    return { allowed: false, approved: false, blockers };
  }
  const current = d.current ?? 0;
  if (current === 0 && status !== 'awaiting_documents') blockers.push('The request has no current document.');
  const scanErrors = Math.min(d.scanErrors ?? 0, d.awaitingScan ?? 0); // a subset of awaitingScan
  const unscanned = (d.awaitingScan ?? 0) - scanErrors;
  if (d.infected > 0) blockers.push(`${plural(d.infected, 'document failed', 'documents failed')} the virus scan and ${d.infected === 1 ? 'is' : 'are'} quarantined.`);
  if (scanErrors > 0) blockers.push(`${plural(scanErrors, 'document', 'documents')} could not be scanned (scan error).`);
  if (d.scanFailed > 0) blockers.push(`${plural(d.scanFailed, 'document', 'documents')} can never be scanned (the file is missing or was altered). The patient needs to upload ${d.scanFailed === 1 ? 'a replacement' : 'replacements'}.`);
  if (unscanned > 0) blockers.push(`${plural(unscanned, 'document has', 'documents have')} not been scanned yet.`);
  if (d.awaitingReview > 0) blockers.push(`${plural(d.awaitingReview, 'document is', 'documents are')} waiting for your review.`);
  if (d.rejected > 0) blockers.push(`${plural(d.rejected, 'document was', 'documents were')} rejected and not replaced yet.`);

  // Belt and braces: whatever else is not approved (a count the rules above did not name).
  if (!blockers.length && current > 0 && d.approved !== current) blockers.push('Not every current document has been approved.');
  return { allowed: blockers.length === 0, approved: false, blockers };
}

/** The 409 `approval_blocked` answer lists blockers: [{ code, message }]. Returns their messages. */
export function blockerMessages(body) {
  const list = Array.isArray(body?.blockers) ? body.blockers : [];
  return list.map((b) => (typeof b?.message === 'string' ? b.message : null)).filter(Boolean);
}
