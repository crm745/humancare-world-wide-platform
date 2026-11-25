// Idempotency for patient document uploads (Phase 5 of the network work).
//
// The mobile app makes one random UUID (`clientUploadId`) when a file first enters the upload workflow and sends it with EVERY attempt to upload that same file. Together with the
// request it belongs to, it identifies the logical upload: the database holds a UNIQUE index on (case_id, client_upload_id) for `documents` and on (service_request_id,
// client_upload_id) for `request_documents`, so however many times (and however concurrently) the same upload arrives, at most one document exists for it.
//
//   - the id is OPTIONAL: an older app build sends none, and its uploads are saved exactly as before (the column stays NULL; MySQL's unique index allows many NULLs)
//   - it is scoped to the request, and a request is only ever looked up for its OWNER first (getRequestForUser / the locked, owner-checked request), so an id can never be used to reach
//     another patient's document
//   - it is not a secret and not patient data; it is only ever sent back to the owner
//   - a repeat is recognised by this id ALONE, never by file name or size. It is answered with the original only if its content is the original's, proved by SHA-256 (the review
//     workflow keeps the digest; the original path hashes the stored file). A repeat whose content differs, or whose digest cannot be checked, is refused (409 client_upload_id_reused)
//     instead of silently returning a document that does not match what was sent.
//
// This file holds only the pure parts so the controller and the review workflow share them.
const { UUID_PATTERN, isUniqueViolation } = require('./client-request-id');

// What a multipart field says about the id.
//   { present: false }                       none sent (an older app build): nothing about idempotency applies
//   { present: true, valid: false }          sent but not a UUID: refused (400), never guessed at
//   { present: true, valid: true, id }       the id, lower-cased so the same UUID is always the same id
// `null` and an empty string count as "none sent" (multipart has no null; a client may send an unset field as '').
function parseClientUploadId(value) {
  if (value === undefined || value === null || value === '') return { present: false };
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return { present: true, valid: false };
  return { present: true, valid: true, id: value.toLowerCase() };
}

// Whether a replay carries the same CONTENT as the stored original: both SHA-256 digests must exist and be equal. A missing digest is not a match (it cannot be vouched for).
// (The original path's digest is taken from the stored file: see documents/legacy-scan.js sameStoredContent.)
const sameReviewFile = (stored, sha256) => !!stored.sha256 && !!sha256 && stored.sha256 === sha256;

module.exports = { parseClientUploadId, sameReviewFile, isUniqueViolation };
