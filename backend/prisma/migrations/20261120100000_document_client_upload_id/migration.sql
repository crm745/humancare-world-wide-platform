-- Phase 5 of the network work, in two parts that ship together. Not applied yet.
--
-- PART 1: idempotent document uploads. The mobile app sends one random UUID (`clientUploadId`) per logical file upload and reuses it for every retry of that upload; the server then saves
-- a document at most once per (request, id), however many times, and however concurrently, that upload arrives. Both document tables get the same protection: `documents` (the original
-- upload, attached to a Case) and `request_documents` (the review workflow, attached to the request).
--
-- PART 2: legacy document scan protection. `request_documents` already records a ClamAV scan for every file; `documents` never did, so a document uploaded before scanning existed has no
-- record at all. These columns give `documents` the same record, mirroring `request_documents`: scan_status NULL means "never scanned" and is treated as NOT clean (the Bitrix24 sender and
-- the corporate download refuse it; see src/modules/documents/document-scan.js). New uploads are stored only after a confirmed clean verdict and carry it; the backfill worker
-- (scripts/backfill-legacy-document-scans.js) scans the older files and records the outcome. The index serves the backfill's selection of rows still to scan.
--
-- Additive and non-destructive: only NEW nullable columns (and one NOT NULL column with a default, scan_attempts) and NEW indexes. No existing column or row is changed, dropped or
-- rewritten: adding a nullable column is a metadata change in MySQL 8 and every existing row simply has NULL (scan_attempts 0). MySQL's unique index treats NULLs as distinct, so any
-- number of documents without an upload id (every document already saved, and every upload from an older app build) coexist. Each unique index includes the owning case/request, so the
-- id is scoped to it: the same id used on two different requests never collides. The index builds read each table once; both tables are small.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
ALTER TABLE `documents`
  ADD COLUMN `client_upload_id` VARCHAR(36) NULL,
  ADD COLUMN `sha256` CHAR(64) NULL,
  ADD COLUMN `scan_status` VARCHAR(16) NULL,
  ADD COLUMN `scan_engine` VARCHAR(40) NULL,
  ADD COLUMN `scan_detail` VARCHAR(255) NULL,
  ADD COLUMN `scanned_at` DATETIME(3) NULL,
  ADD COLUMN `scan_attempts` INT NOT NULL DEFAULT 0,
  ADD COLUMN `scan_next_attempt_at` DATETIME(3) NULL,
  ADD UNIQUE INDEX `uq_documents_case_client_upload` (`case_id`, `client_upload_id`),
  ADD INDEX `idx_documents_scan_status` (`scan_status`, `scan_next_attempt_at`);

ALTER TABLE `request_documents`
  ADD COLUMN `client_upload_id` VARCHAR(36) NULL,
  ADD UNIQUE INDEX `uq_request_documents_request_client_upload` (`service_request_id`, `client_upload_id`);
