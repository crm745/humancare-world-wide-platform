-- Rolls back 20261109100000_scan_retry_backoff. Run by hand (Prisma has no automatic down migrations).
-- Only the retry bookkeeping is lost; no scan verdict or document is affected.
-- Afterwards remove the migration's row from _prisma_migrations by hand.
DROP INDEX `request_documents_scan_status_scan_next_attempt_at_idx` ON `request_documents`;
ALTER TABLE `request_documents` DROP COLUMN `scan_attempts`,
    DROP COLUMN `scan_next_attempt_at`;
