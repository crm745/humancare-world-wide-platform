-- Rolls back 20261113000300_private_charter_m4_document_request. Run by hand (Prisma has no automatic down
-- migrations), and ONLY while no request_documents row is linked to a document request and
-- document_requests is empty, or after its rows have been exported: dropping them loses the requests and
-- the link between each request and its uploads for good. The uploads themselves (request_documents rows
-- and files) are not deleted.
--   SELECT (SELECT COUNT(*) FROM document_requests) AS requests,
--          (SELECT COUNT(*) FROM request_documents WHERE document_request_id IS NOT NULL) AS linked_uploads;
-- Afterwards remove the migration's row from _prisma_migrations by hand.
-- Order matters: the foreign key and its index go before the column, and the column before the table.
ALTER TABLE `request_documents` DROP FOREIGN KEY `request_documents_document_request_id_fkey`;
DROP INDEX `request_documents_document_request_id_idx` ON `request_documents`;
ALTER TABLE `request_documents` DROP COLUMN `document_request_id`;
DROP TABLE `document_requests`;
