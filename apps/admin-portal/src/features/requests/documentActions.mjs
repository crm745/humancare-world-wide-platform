// What an Admin may do with a document, mirroring the backend rules (request-review.service.js).
// The server enforces all of this again on every call; these only decide what the page offers.
// Pure and DOM-free so `node --test` can run it.

export const REASON_MIN = 3;
export const REASON_MAX = 1000;

/**
 * { download, approve, reject, note }:
 *  - download: the file is clean and current (the server refuses anything else). It stays available
 *    once the request is approved.
 *  - approve:  clean, current, and still pending (a decided document is not approved again).
 *  - reject:   clean, current, not already rejected (an approved one may still be rejected).
 *  - none of the review actions once the request is approved.
 *  - note: why nothing is offered, where the card does not already say so (null otherwise).
 */
export function documentActions(doc, request) {
  const none = { download: false, approve: false, reject: false };
  if (doc.supersededAt) return { ...none, note: 'Replaced by a newer version. Only the current version can be opened or reviewed.' };
  if (doc.scanStatus === 'infected' || doc.scanStatus === 'error' || doc.scanStatus === 'failed') return { ...none, note: null }; // the card already explains
  if (doc.scanStatus !== 'clean') return { ...none, note: 'Available once the virus scan completes cleanly.' };

  const download = true;
  if (request?.reviewStatus === 'approved') {
    return { download, approve: false, reject: false, note: 'The request is approved, so its documents can no longer be reviewed.' };
  }
  if (doc.reviewStatus === 'rejected') return { download, approve: false, reject: false, note: 'Rejected. Waiting for the patient to upload a replacement.' };
  return { download, approve: doc.reviewStatus === 'pending', reject: true, note: null };
}

/**
 * Whether the Admin may ask the patient for more documents. Mirrors the backend
 * (POST /admin/requests/:id/request-documents): only a submitted request that is IN REVIEW can be asked.
 *  - a draft is refused with 409 request_is_draft (nothing is submitted yet);
 *  - a request in "changes requested" is refused with 409 documents_request_already_pending (the patient has
 *    an earlier ask or a rejected document to answer first, and a second ask would overwrite the reason);
 *  - an approved request is refused with 409 request_approved.
 * `reason` says why it is not offered, or is null.
 */
export function canRequestDocuments(request) {
  const status = request?.reviewStatus;
  if (status === 'in_review') return { allowed: true, reason: null };
  if (status === 'awaiting_documents') return { allowed: false, reason: 'A draft has not been submitted yet, so documents cannot be requested.' };
  if (status === 'changes_requested') return { allowed: false, reason: 'The patient has already been asked for changes and has not responded yet.' };
  if (status === 'approved') return { allowed: false, reason: 'The request is approved. Documents can no longer be requested.' };
  return { allowed: false, reason: 'This request is not in the document review workflow.' };
}

/**
 * A reason the patient will read (why a document is rejected, which documents are needed). Same limits as
 * the server: 3 to 1000 characters, trimmed. `purpose` completes "Enter the reason for …" when it is empty.
 */
export function validateReason(text, purpose = 'rejecting this document') {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length < REASON_MIN) {
    return { ok: false, value: trimmed, error: trimmed.length === 0 ? `Enter the reason for ${purpose}.` : `The reason must be at least ${REASON_MIN} characters.` };
  }
  if (trimmed.length > REASON_MAX) return { ok: false, value: trimmed, error: `The reason must be at most ${REASON_MAX} characters.` };
  return { ok: true, value: trimmed, error: null };
}

/** A name that is safe to hand to the browser as a download name: no path parts, no control characters. */
export function safeFileName(name, fallback = 'document') {
  const cleaned = String(name ?? '').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '').trim().replace(/^\.+/, '');
  return (cleaned || fallback).slice(0, 191);
}

/**
 * The file name in a Content-Disposition header (RFC 6266), or null. Handles both
 * `filename*=UTF-8''...` and `filename="..."`. A cross-origin browser may not be allowed to read the
 * header at all; callers then use the name they already know.
 */
export function fileNameFromDisposition(header) {
  if (typeof header !== 'string' || !header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return safeFileName(decodeURIComponent(star[2].trim()), '') || null;
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  if (!plain) return null;
  const raw = (plain[1] ?? plain[2] ?? '').replace(/\\(.)/g, '$1').trim();
  return safeFileName(raw, '') || null;
}
