-- Rolls back 20261107120000_request_first_workflow. Run by hand (Prisma has no automatic down
-- migrations), and ONLY while request_documents and request_events are empty, or after their rows
-- have been exported: dropping them deletes the document history and the audit trail for good.
--   SELECT (SELECT COUNT(*) FROM request_documents) AS documents, (SELECT COUNT(*) FROM request_events) AS events;
-- Afterwards remove the migration's row from _prisma_migrations by hand.
DROP TABLE `request_events`;
DROP TABLE `request_documents`;
DROP INDEX `service_requests_review_status_created_at_idx` ON `service_requests`;
ALTER TABLE `service_requests` DROP COLUMN `documents_request_reason`,
    DROP COLUMN `review_status`,
    DROP COLUMN `reviewed_at`,
    DROP COLUMN `submitted_at`;
