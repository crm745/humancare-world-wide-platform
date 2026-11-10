-- Worker reliability, Phase 2: bounded retries with exponential backoff for document scans.
-- Additive only: two columns on request_documents and one index. No existing column, row or index is
-- changed. Existing rows get scan_attempts = 0 and scan_next_attempt_at = NULL ("due now"), so every
-- document that is waiting keeps being picked up and gets the full retry budget.
-- Code deployed before this migration ignores both columns, so it can be applied first.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
--
--   scan_attempts         scan attempts started so far (counted when an attempt is claimed, so a worker
--                         that crashes mid-scan still uses one).
--   scan_next_attempt_at  earliest time the next attempt may start; while an attempt is running it is the
--                         end of that attempt's lease. NULL = due now.

-- AlterTable
ALTER TABLE `request_documents` ADD COLUMN `scan_attempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `scan_next_attempt_at` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `request_documents_scan_status_scan_next_attempt_at_idx` ON `request_documents`(`scan_status`, `scan_next_attempt_at`);
