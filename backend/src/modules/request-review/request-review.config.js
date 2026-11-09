// Names and limits of the request-first review workflow (Private Charter only).
// See backend/REQUEST-REVIEW-WORKFLOW.md.

// The workflow is switched on per environment. Off (the default), a Private Charter request is
// created exactly as before, with its Case. On, a new Private Charter request waits for documents
// and review, and its Case is created only when an Admin approves it. Read at call time.
const isRequestReviewEnabled = () => process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW === 'true';

// ServiceRequest.reviewStatus (NULL = created before the workflow existed).
const REQUEST_STATUS = {
  AWAITING_DOCUMENTS: 'awaiting_documents',
  IN_REVIEW: 'in_review',
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED: 'approved',
};
const REQUEST_STATUSES = Object.values(REQUEST_STATUS);

// RequestDocument.scanStatus and reviewStatus.
// 'error' = the scan could not run for now and is retried; 'failed' = it can never run (file gone or altered): final.
const SCAN = { PENDING: 'pending', CLEAN: 'clean', INFECTED: 'infected', ERROR: 'error', FAILED: 'failed' };
const REVIEW = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' };

// Bounded retries with exponential backoff for document scans (RequestDocument.scanAttempts / scanNextAttemptAt).
// maxAttempts counts the first attempt. The wait after attempt n is initialDelayMs * multiplier^(n-1), capped at
// maxDelayMs, then spread by +-jitter; with these values: about 1, 2, 4, 8, 16, 32 minutes, then 60 minutes.
// leaseMs is how long a claimed attempt is protected from other workers; a worker that dies mid-scan leaves a lease
// that simply runs out (the scan itself is cut off after CLAMAV_TIMEOUT_MS, 20 s by default).
const SCAN_RETRY = Object.freeze({
  maxAttempts: 10,
  initialDelayMs: 60 * 1000,
  multiplier: 2,
  maxDelayMs: 60 * 60 * 1000,
  jitter: 0.2,
  leaseMs: 5 * 60 * 1000,
  // When the STORAGE (not the document, not ClamAV) is what failed, no attempt is used up; the document is looked at again after this.
  storageRecheckMs: 5 * 60 * 1000,
});

// File-system errors that say the storage is in trouble, not that this document is bad: no permission, an I/O error, a busy,
// stale, read-only or timed-out volume, too many open files, a device that is gone, or the upload folder replaced by a file.
// They can heal by themselves, so they never use up a retry attempt. (ENOENT is handled separately: see confirmFileMissing.)
const STORAGE_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EIO', 'EBUSY', 'EMFILE', 'ENFILE', 'ENXIO', 'ENODEV', 'ESTALE', 'ETIMEDOUT', 'EROFS', 'ENOTDIR']);
const isStorageErrorCode = (code) => STORAGE_ERROR_CODES.has(code);

// How long to wait after attempt number `attempts` (1 = the first) failed for now. `rng` returns [0, 1).
// The result never exceeds maxDelayMs, jitter included, and is never below 1 ms.
function scanBackoffMs(attempts, { rng = Math.random, retry = SCAN_RETRY } = {}) {
  const n = Math.max(1, Math.floor(Number(attempts)) || 1);
  const base = Math.min(retry.maxDelayMs, retry.initialDelayMs * retry.multiplier ** (n - 1));
  const factor = 1 + (rng() * 2 - 1) * retry.jitter;
  return Math.max(1, Math.min(retry.maxDelayMs, Math.round(base * factor)));
}

// RequestEvent.action
const ACTION = {
  REQUEST_CREATED: 'request_created',
  DOCUMENT_UPLOADED: 'document_uploaded',
  DOCUMENT_REPLACED: 'document_replaced',
  SCAN_CLEAN: 'scan_clean',
  SCAN_INFECTED: 'scan_infected',
  SCAN_ERROR: 'scan_error',
  SCAN_FAILED: 'scan_failed',
  DOCUMENT_DOWNLOADED: 'document_downloaded',
  DOCUMENT_APPROVED: 'document_approved',
  DOCUMENT_REJECTED: 'document_rejected',
  DOCUMENTS_REQUESTED: 'documents_requested',
  STATUS_CHANGED: 'status_changed',
  REQUEST_APPROVED: 'request_approved',
  CASE_CREATED: 'case_created',
};

const MAX_DOCUMENTS_PER_REQUEST = 30; // every version counts, including replaced ones
const REASON_MIN = 3;
const REASON_MAX = 1000;

// What a patient may see of a document: never the stored file name, the checksum, or who reviewed it.
const PATIENT_DOCUMENT_SELECT = {
  id: true, originalName: true, sizeBytes: true, uploadedAt: true, replacesId: true, supersededAt: true,
  scanStatus: true, reviewStatus: true, rejectionReason: true,
};

module.exports = {
  isRequestReviewEnabled, REQUEST_STATUS, REQUEST_STATUSES, SCAN, REVIEW, ACTION, SCAN_RETRY, scanBackoffMs, isStorageErrorCode,
  MAX_DOCUMENTS_PER_REQUEST, REASON_MIN, REASON_MAX, PATIENT_DOCUMENT_SELECT,
};
