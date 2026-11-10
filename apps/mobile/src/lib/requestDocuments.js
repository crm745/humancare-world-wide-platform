// Pure rules for showing a patient the documents of a request that goes through the review workflow
// (no React, no native modules, no network), so they can be unit-tested.
//
// The server (GET /requests/me/:id) sends `reviewStatus`, `documentsRequestReason` and a
// `requestDocuments` list. Everything here reads only a fixed set of those fields and returns a
// fresh object with the fields the screens may show: whatever else a response carries (storage names,
// checksums, file URLs, reviewer ids, sync errors) never passes through this file.

// Same as the backend's MAX_DOCUMENTS_PER_REQUEST: every version counts, replaced ones included.
export const MAX_DOCUMENTS_PER_REQUEST = 30;

// ServiceRequest.reviewStatus values the backend uses.
const REQUEST_STATUS = {
  AWAITING_DOCUMENTS: 'awaiting_documents',
  IN_REVIEW: 'in_review',
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED: 'approved',
};

// Who the request is waiting for:
//   'waiting_patient'  the patient has to send documents (nothing uploaded yet, or the Admin asked for more)
//   'under_review'     the documents are with the Admin
//   'approved'         done; no more documents can be added
//   null               not in the review workflow (older requests and other services), or an unknown value
export function reviewState(request) {
  switch (request?.reviewStatus) {
    case REQUEST_STATUS.AWAITING_DOCUMENTS:
    case REQUEST_STATUS.CHANGES_REQUESTED:
      return 'waiting_patient';
    case REQUEST_STATUS.IN_REVIEW:
      return 'under_review';
    case REQUEST_STATUS.APPROVED:
      return 'approved';
    default:
      return null;
  }
}

// The banner at the top of a workflow request: where the request stands, in the patient's words.
// `tone` is 'warning' (waiting for the patient), 'info' (with the Admin) or 'success'. `reason` is what
// the Admin asked the patient to provide (documentsRequestReason, written for the patient), shown only
// while changes are requested. null when the request is not in the review workflow.
const BANNERS = {
  awaiting_documents: { key: 'awaiting_documents', title: 'Waiting for you to upload documents.', tone: 'warning' },
  changes_requested: { key: 'changes_requested', title: 'Waiting for you to respond to the Admin.', tone: 'warning' },
  in_review: { key: 'in_review', title: 'Under Admin review.', tone: 'info' },
  approved: { key: 'approved', title: 'Approved.', tone: 'success' },
};

const knownReviewStatus = (request) => {
  const status = request?.reviewStatus;
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(BANNERS, status) ? status : null;
};

// The status chip of a workflow request, in the same words as the banner (same `key`, same tone), so the
// two never disagree. A request's own `status` ("submitted") does not move on approval; it follows the
// Case afterwards. So the chip is:
//   not approved yet               the review chip ("Awaiting documents", "Action needed", "In review")
//   approved, Case not started     "Approved"
//   approved, Case under way/done  null: the usual chip for that stage ("In progress", "Completed")
//   cancelled (any review status)  null: the usual "Cancelled" chip
// null also means "not a workflow request". The banner below is hidden whenever the chip is "Cancelled".
const PILLS = {
  awaiting_documents: { key: 'awaiting_documents', label: 'Awaiting documents', tone: 'warning' },
  changes_requested: { key: 'changes_requested', label: 'Action needed', tone: 'warning' },
  in_review: { key: 'in_review', label: 'In review', tone: 'info' },
  approved: { key: 'approved', label: 'Approved', tone: 'success' },
};

export function reviewPill(request) {
  const status = knownReviewStatus(request);
  if (!status || request.status === 'cancelled') return null;
  if (status === REQUEST_STATUS.APPROVED && request.status !== 'submitted') return null;
  return { ...PILLS[status] };
}

export function reviewBanner(request) {
  const status = knownReviewStatus(request);
  if (!status || request.status === 'cancelled') return null;
  const reason = typeof request.documentsRequestReason === 'string' ? request.documentsRequestReason.trim() : '';
  return { ...BANNERS[status], reason: status === REQUEST_STATUS.CHANGES_REQUESTED && reason ? reason : null };
}

// What a patient is told about one document. `key` is stable (for styling and tests), `label` is the
// English text until the strings move to i18n. Scan details are never shown, only the outcome.
export const DOCUMENT_STATUS = {
  checking: { key: 'checking', label: 'Being checked' },
  awaiting_review: { key: 'awaiting_review', label: 'Waiting for review' },
  approved: { key: 'approved', label: 'Approved' },
  rejected: { key: 'rejected', label: 'Needs to be replaced' },
  unsafe: { key: 'unsafe', label: "Couldn't be accepted" },
  // The server could not check this file and never will (it is missing or no longer matches what was uploaded).
  // Unlike "checking" nothing is on its way: the patient has to send it again.
  scan_failed: { key: 'scan_failed', label: "Couldn't be checked" },
};

// What a patient is told to DO about a current document, in plain words (null when there is nothing to do). Neither text
// names a virus, a scan result or a file location: the outcome is all a patient needs.
const GUIDANCE = {
  unsafe: "This file couldn't be accepted. Please upload a different file.",
  scan_failed: "We couldn't check this file. Please upload a replacement.",
};

// Reads the scan and review outcome of one document. The order matters: a file that failed the virus
// scan, or that could not be checked at all, is never shown as anything else; a decision by the Admin wins
// over a scan that has not finished; "approved" needs a clean scan; otherwise the file is still being checked
// or reviewed. Scan status by scan status: 'pending' and 'error' (the server retries) = checking; 'clean' = waiting
// for review; 'infected' = couldn't be accepted; 'failed' (the server gave up) = couldn't be checked.
export function documentStatus(doc) {
  const scan = doc?.scanStatus;
  const review = doc?.reviewStatus;
  if (scan === 'infected') return DOCUMENT_STATUS.unsafe;
  if (scan === 'failed') return DOCUMENT_STATUS.scan_failed;
  if (review === 'rejected') return DOCUMENT_STATUS.rejected;
  if (review === 'approved' && scan === 'clean') return DOCUMENT_STATUS.approved;
  if (scan !== 'clean') return DOCUMENT_STATUS.checking; // 'pending', 'error' (retried by the server) or a value this app does not know
  return DOCUMENT_STATUS.awaiting_review;
}

const time = (value) => {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

const isId = (value) => Number.isInteger(value);

// The documents of a request as the screens show them: oldest upload first (then by id), every
// version kept. Each item has only:
//   id, name, sizeBytes, uploadedAt
//   isCurrent      false once a newer upload replaced it (it stays in the history)
//   replacesId     the earlier document this one replaces, or null
//   replacedById   the later document that replaced this one, or null
//   status, statusLabel   see documentStatus
//   rejectionReason       the Admin's reason, only for a rejected document (else null)
//   guidance       what to do about it, for a current document that could not be accepted or could not be
//                  checked (else null; a rejected one explains itself with rejectionReason)
//   canReplace     a current document that was rejected, could not be accepted (failed the safety check) or
//                  could not be checked at all: the patient may send a replacement for it. Never true for a replaced version.
export function documentHistory(requestDocuments) {
  const list = Array.isArray(requestDocuments) ? requestDocuments.filter((d) => d && isId(d.id)) : [];
  const ids = new Set(list.map((d) => d.id));

  const replacedBy = new Map();
  for (const d of list) {
    if (isId(d.replacesId) && ids.has(d.replacesId) && !replacedBy.has(d.replacesId)) replacedBy.set(d.replacesId, d.id);
  }

  return [...list]
    .sort((a, b) => time(a.uploadedAt) - time(b.uploadedAt) || a.id - b.id)
    .map((d) => {
      const status = documentStatus(d);
      const isCurrent = !d.supersededAt;
      const rejected = status.key === DOCUMENT_STATUS.rejected.key;
      const needsNewFile = status.key === DOCUMENT_STATUS.unsafe.key || status.key === DOCUMENT_STATUS.scan_failed.key;
      return {
        id: d.id,
        name: typeof d.originalName === 'string' && d.originalName ? d.originalName : 'Document',
        sizeBytes: Number.isFinite(d.sizeBytes) ? d.sizeBytes : null,
        uploadedAt: d.uploadedAt || null,
        isCurrent,
        replacesId: isId(d.replacesId) && ids.has(d.replacesId) ? d.replacesId : null,
        replacedById: replacedBy.get(d.id) ?? null,
        status: status.key,
        statusLabel: status.label,
        rejectionReason: rejected && typeof d.rejectionReason === 'string' && d.rejectionReason ? d.rejectionReason : null,
        guidance: isCurrent && needsNewFile ? GUIDANCE[status.key] : null,
        canReplace: isCurrent && (rejected || needsNewFile),
      };
    });
}

// Why no more documents can be added to this request, or null when they can:
//   'not_workflow'  the request is not in the review workflow
//   'approved'      the request was approved
//   'limit'         the request already holds the most versions the server accepts
export function uploadBlockReason(request, documents) {
  const state = reviewState(request);
  if (state === null) return 'not_workflow';
  if (state === 'approved') return 'approved';
  const count = Array.isArray(documents) ? documents.length : 0;
  if (count >= MAX_DOCUMENTS_PER_REQUEST) return 'limit';
  return null;
}

// `documents` is every version (the request's whole requestDocuments list), not only the current ones.
export const canUploadMore = (request, documents) => uploadBlockReason(request, documents) === null;
