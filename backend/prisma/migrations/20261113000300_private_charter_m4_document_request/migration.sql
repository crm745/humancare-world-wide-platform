-- Private Charter M4: document requests. Additive only: one new table, and one nullable column (with an
-- index and a foreign key) on request_documents. No existing row, value, column or constraint is
-- changed: every existing request_documents row gets document_request_id = NULL. Nothing is backfilled
-- into document_requests. The legacy documents table, Corporate documents, and the upload / scan /
-- review behaviour are untouched. Code deployed before this migration ignores the new table and column,
-- so it can be applied first.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations), and is
-- only safe while document_requests is empty or its rows have been exported.
--
-- PRIVATE CHARTER ONLY: document_requests is intended for Private Charter Cases only; Corporate document
-- workflows are unchanged and never use it, and it has no relation to the legacy documents table. The
-- database cannot enforce this, so the future service MUST, in the transaction that creates a row, load
-- the Case and refuse unless cases.service_request_id is set and that service request's service_key is
-- the Private Charter key (PRIVATE_CHARTER_KEY in the backend). Corporate Cases (service_request_id NULL)
-- and Cases of any other service must be refused. Nothing is backfilled: no historical request or
-- document is converted into a document request.
--
-- A document request is not an uploaded document: the upload stays a request_documents row. There is no
-- expiry column and nothing in the schema expires a request. Both foreign keys are RESTRICT, so a Case
-- that has document requests, and a request that has uploads linked to it, cannot be deleted.
-- idempotency_key is an opaque client key: stored exactly as given and compared case-sensitively
-- (utf8mb4_bin, as in audit_logs). utf8mb4_bin ignores trailing spaces, so the writing code MUST reject
-- (never silently trim) keys with leading or trailing whitespace. MySQL allows any number of rows with a
-- NULL key.

-- CreateTable
CREATE TABLE `document_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `case_id` INTEGER NOT NULL,
    `document_type` VARCHAR(64) NULL,
    `description` TEXT NOT NULL,
    `reason` TEXT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'open',
    `requested_by_type` VARCHAR(16) NOT NULL,
    `requested_by_id` VARCHAR(64) NULL,
    `idempotency_key` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `resolved_at` DATETIME(3) NULL,
    `resolved_by_type` VARCHAR(16) NULL,
    `resolved_by_id` VARCHAR(64) NULL,
    `resolution_note` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `document_requests_case_id_idempotency_key_key`(`case_id`, `idempotency_key`),
    INDEX `document_requests_case_id_status_idx`(`case_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `request_documents` ADD COLUMN `document_request_id` INTEGER NULL;

-- CreateIndex
CREATE INDEX `request_documents_document_request_id_idx` ON `request_documents`(`document_request_id`);

-- AddForeignKey
ALTER TABLE `document_requests` ADD CONSTRAINT `document_requests_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `request_documents` ADD CONSTRAINT `request_documents_document_request_id_fkey` FOREIGN KEY (`document_request_id`) REFERENCES `document_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
