-- Rollback for 20261120100000_document_client_upload_id. Not run by Prisma: run it by hand, then remove the row for this migration from `_prisma_migrations`
-- (or use `prisma migrate resolve --rolled-back 20261120100000_document_client_upload_id`).
-- Deploy the code that no longer reads or writes these columns BEFORE running this. Dropping them discards the upload ids (they only protect against duplicates while an upload is being
-- retried) AND the legacy documents' scan records (sha256, status, engine, detail, times, attempts): the documents and their files are untouched, but a document would then have to be scanned
-- again before it could be called clean, and the Bitrix24 and corporate-download protection that reads scan_status must be removed from the code first or it would refuse every document.
ALTER TABLE `request_documents`
  DROP INDEX `uq_request_documents_request_client_upload`,
  DROP COLUMN `client_upload_id`;

ALTER TABLE `documents`
  DROP INDEX `idx_documents_scan_status`,
  DROP INDEX `uq_documents_case_client_upload`,
  DROP COLUMN `scan_next_attempt_at`,
  DROP COLUMN `scan_attempts`,
  DROP COLUMN `scanned_at`,
  DROP COLUMN `scan_detail`,
  DROP COLUMN `scan_engine`,
  DROP COLUMN `scan_status`,
  DROP COLUMN `sha256`,
  DROP COLUMN `client_upload_id`;
