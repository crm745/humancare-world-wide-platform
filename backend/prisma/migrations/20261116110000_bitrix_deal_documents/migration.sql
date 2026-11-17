-- Private Charter document sharing: the Admin-authorized documents attached to a Bitrix24 Deal (field UF_CRM_1794832401,
-- a multiple FILE field). One row per authorized share of one HumanCare document to one Deal.
--
-- Additive only: one new table and two nullable columns on bitrix_deal_links. No existing column, row or index is changed.
-- Code deployed before this migration ignores all of it, so it can be applied first. Nothing in the application sends a file
-- to Bitrix24 until the Deal worker is switched on AND an Admin authorizes a document.
-- NOT applied by the code change that added it: run it by hand, first against humancare_test (node scripts/test-db.js migrate),
-- then run `npx prisma generate` so the client knows the new model.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
--
--   share_token       the visible marker put in the remote file name ("HC-D<document>G<generation>-<sha8>__<name>"), unique.
--   file_ids_before   the Deal's file ids read just before an upload; used to find OUR new file after an uncertain outcome.
--   try_count         how many outbox events this share has had (an automatic retry or an Admin retry is a new event with
--                     a new key), so every event key is unique.
--   attempts          failed attempts since the last Admin action (the automatic retry limit counts these).
--   generation        a share that was revoked and is authorized again is a new generation, never a reused row.

CREATE TABLE `bitrix_deal_documents` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deal_link_id` INTEGER NOT NULL,
    `request_document_id` INTEGER NOT NULL,
    `case_document_id` INTEGER NULL,
    `generation` INTEGER NOT NULL DEFAULT 1,
    `sha256` CHAR(64) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `detected_type` VARCHAR(16) NOT NULL,
    `share_token` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'authorized',
    `bitrix_file_id` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `file_ids_before` JSON NULL,
    `try_count` INTEGER NOT NULL DEFAULT 1,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` VARCHAR(500) NULL,
    `authorized_by_admin_id` INTEGER NOT NULL,
    `authorized_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attached_at` DATETIME(3) NULL,
    `revoked_by_admin_id` INTEGER NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoke_reason` VARCHAR(1000) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `bitrix_deal_documents_share_token_key`(`share_token`),
    UNIQUE INDEX `bitrix_deal_documents_link_doc_gen_key`(`deal_link_id`, `request_document_id`, `generation`),
    UNIQUE INDEX `bitrix_deal_documents_deal_link_id_bitrix_file_id_key`(`deal_link_id`, `bitrix_file_id`),
    INDEX `bitrix_deal_documents_status_idx`(`status`),
    INDEX `bitrix_deal_documents_request_document_id_idx`(`request_document_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `bitrix_deal_documents` ADD CONSTRAINT `bitrix_deal_documents_deal_link_id_fkey` FOREIGN KEY (`deal_link_id`) REFERENCES `bitrix_deal_links`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `bitrix_deal_documents` ADD CONSTRAINT `bitrix_deal_documents_request_document_id_fkey` FOREIGN KEY (`request_document_id`) REFERENCES `request_documents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- The per-Deal lease that serializes file updates: Bitrix replaces a file field's whole list on update, so two workers updating
-- one Deal at the same moment could lose a file. Set and checked with the database clock (see deal-document.store.js).
ALTER TABLE `bitrix_deal_links` ADD COLUMN `file_locked_by` VARCHAR(64) NULL, ADD COLUMN `file_locked_until` DATETIME(3) NULL;
