// What an Admin sees and may do about sharing a document with the Bitrix24 Deal, and about post-Case document requests. Mirrors the
// backend rules (deal-document.service.js); the server enforces them again on every call, so these only decide what the page offers.
// Pure and DOM-free so `node --test` can run it. Reviewing a document NEVER shares it: sharing is a separate, explicit Authorize.

// Status of a share (BitrixDealDocument.status) -> how it reads. `attention` = a person has to look at it.
export const SHARE_STATUS = {
  authorized: { label: 'Authorized, waiting to attach', tone: 'info' },
  attaching: { label: 'Attaching to the Deal', tone: 'info' },
  attached: { label: 'Attached to the Deal', tone: 'success' },
  ambiguous: { label: 'Needs checking', tone: 'warning', attention: true },
  failed: { label: 'Attach failed', tone: 'danger', attention: true },
  revoking: { label: 'Removing from the Deal', tone: 'info' },
  revoked: { label: 'Revoked', tone: 'neutral' },
  revoke_failed: { label: 'Removal failed', tone: 'danger', attention: true },
};

// The same lists the server uses (REVOCABLE, retry).
const REVOCABLE = ['authorized', 'attaching', 'attached', 'ambiguous', 'failed'];
const RETRYABLE = ['failed', 'revoke_failed'];

/** The newest share of each document: { [requestDocumentId]: share }. Older generations (revoked, then authorized again) are not shown. */
export function latestShares(shares) {
  const latest = {};
  for (const share of Array.isArray(shares) ? shares : []) {
    if (!share || !Number.isInteger(share.requestDocumentId)) continue;
    const held = latest[share.requestDocumentId];
    const generation = share.generation ?? 0;
    const heldGeneration = held?.generation ?? 0;
    if (!held || generation > heldGeneration || (generation === heldGeneration && share.id > held.id)) latest[share.requestDocumentId] = share;
  }
  return latest;
}

/**
 * One share as the card shows it:
 *  - label / tone / attention: the status and whether it needs a person;
 *  - failed:      the attach or the removal failed for good (a retry is offered);
 *  - tryText:     the retry status, e.g. "Try 2 · 1 attempt so far", or null for a first try that has not started;
 *  - error:       the last error code the worker stored (a code, never a file or token), or null;
 *  - canRevoke / canRetry.
 */
export function shareView(share) {
  const known = SHARE_STATUS[share?.status];
  const status = known ?? { label: String(share?.status ?? 'unknown'), tone: 'neutral' };
  const tries = Number.isInteger(share?.tryCount) ? share.tryCount : 1;
  const attempts = Number.isInteger(share?.attempts) ? share.attempts : 0;
  const tryText = tries > 1 || attempts > 0 ? `Try ${tries} · ${attempts} attempt${attempts === 1 ? '' : 's'} so far` : null;
  const failed = RETRYABLE.includes(share?.status);
  return {
    id: share?.id,
    status: share?.status,
    label: status.label,
    tone: status.tone,
    attention: Boolean(status.attention) || Boolean(share?.needsAttention),
    failed,
    tryText,
    error: typeof share?.lastError === 'string' && share.lastError ? share.lastError : null,
    detail: share?.status === 'revoked' && share.revokeReason ? `Revoked: ${share.revokeReason}` : null,
    canRevoke: REVOCABLE.includes(share?.status),
    canRetry: failed,
  };
}

/**
 * Whether the Authorize button is offered for a document (the server's authorizeShare checks): the request is approved and has a Case,
 * the document is clean, approved, current and part of the Case, and it has no share that is still active (a revoked one may be authorized again).
 * `reason` says why not, where the card does not already say so.
 */
export function canAuthorize(doc, request, share) {
  const no = (reason) => ({ allowed: false, reason });
  if (request?.reviewStatus !== 'approved' || !request?.case) return no(null); // nothing about sharing before the approval and the Case
  if (doc.supersededAt) return no(null);
  if (doc.scanStatus !== 'clean') return no('Only a document whose virus scan is clean can be shared.');
  if (doc.reviewStatus !== 'approved') return no('Approve this document first. Only an approved document can be shared.');
  if (doc.caseDocumentId == null) return no('This document is not part of the Case yet.');
  if (share && share.status !== 'revoked') return no(null);
  return { allowed: true, reason: null };
}

/** Whether sharing is part of this request at all (approved, with a Case): decides whether a card shows a "Bitrix sharing" row. */
export const sharingApplies = (request) => request?.reviewStatus === 'approved' && Boolean(request?.case);

/** The shares that need a person (failed, removal failed, ambiguous): the newest share of each document only. */
export const sharesNeedingAttention = (shares) => Object.values(latestShares(shares)).filter((share) => shareView(share).attention);

// ---- post-Case document requests ------------------------------------------------------------------------------------------------

export const DOCUMENT_REQUEST_STATUS = {
  open: { label: 'Open, waiting for the patient', tone: 'warning' },
  fulfilled: { label: 'Fulfilled', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/**
 * The post-Case document requests with the documents the patient sent for each (matched by documentRequestId), oldest first.
 * Each: { id, description, reason, status, label, tone, createdAt, resolvedAt, documents: [] }. Anything malformed is skipped.
 */
export function documentRequestRows(request) {
  const list = Array.isArray(request?.case?.documentRequests) ? request.case.documentRequests : [];
  const documents = Array.isArray(request?.requestDocuments) ? request.requestDocuments : [];
  return list
    .filter((item) => item && Number.isInteger(item.id))
    .map((item) => {
      const known = DOCUMENT_REQUEST_STATUS[item.status] ?? { label: String(item.status ?? 'unknown'), tone: 'neutral' };
      return {
        id: item.id,
        description: item.description ?? '',
        reason: item.reason || null,
        status: item.status,
        label: known.label,
        tone: known.tone,
        createdAt: item.createdAt ?? null,
        resolvedAt: item.resolvedAt ?? null,
        documents: documents.filter((d) => d.documentRequestId === item.id),
      };
    })
    .sort((a, b) => a.id - b.id);
}

/** Whether the Admin may open a post-Case document request: the request is approved and has a Case (the server checks the same). */
export function canOpenDocumentRequest(request) {
  if (request?.reviewStatus !== 'approved') return { allowed: false, reason: 'A document request can be made only after the request is approved.' };
  if (!request.case) return { allowed: false, reason: 'The request has no Case.' };
  return { allowed: true, reason: null };
}
