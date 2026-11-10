-- Request-first review workflow (Private Charter only). Additive only: four nullable columns on
-- service_requests and two new tables. No existing column, table, row or index is changed, so
-- every existing request keeps working untouched: review_status stays NULL for all of them, and
-- NULL means "created before this workflow" (their Case already exists and is not touched).
-- Code deployed before this migration ignores the new columns, so it can be applied first.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations),
-- and is only safe while the two new tables are empty.
--
-- request_documents and request_events keep their rows for good: the foreign keys are RESTRICT, so
-- a request that has history cannot be deleted, and nothing purges either table.

-- AlterTable
ALTER TABLE `service_requests` ADD COLUMN `documents_request_reason` TEXT NULL,
    ADD COLUMN `review_status` VARCHAR(24) NULL,
    ADD COLUMN `reviewed_at` DATETIME(3) NULL,
    ADD COLUMN `submitted_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `request_documents` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `service_request_id` INTEGER NOT NULL,
    `original_name` VARCHAR(191) NOT NULL,
    `storage_key` VARCHAR(191) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `mime_type` VARCHAR(191) NULL,
    `sha256` CHAR(64) NULL,
    `uploaded_by_user_id` INTEGER NOT NULL,
    `uploaded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `replaces_id` INTEGER NULL,
    `superseded_at` DATETIME(3) NULL,
    `scan_status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `scan_engine` VARCHAR(40) NULL,
    `scan_detail` VARCHAR(255) NULL,
    `scanned_at` DATETIME(3) NULL,
    `review_status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `reviewed_by_admin_id` INTEGER NULL,
    `reviewed_at` DATETIME(3) NULL,
    `rejection_reason` TEXT NULL,
    `case_document_id` INTEGER NULL,

    UNIQUE INDEX `request_documents_storage_key_key`(`storage_key`),
    UNIQUE INDEX `request_documents_case_document_id_key`(`case_document_id`),
    INDEX `request_documents_service_request_id_idx`(`service_request_id`),
    INDEX `request_documents_scan_status_idx`(`scan_status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `request_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `service_request_id` INTEGER NOT NULL,
    `document_id` INTEGER NULL,
    `action` VARCHAR(40) NOT NULL,
    `from_status` VARCHAR(24) NULL,
    `to_status` VARCHAR(24) NULL,
    `actor_type` VARCHAR(12) NOT NULL,
    `actor_id` INTEGER NULL,
    `detail` JSON NULL,
    `occurred_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `request_events_service_request_id_occurred_at_idx`(`service_request_id`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `service_requests_review_status_created_at_idx` ON `service_requests`(`review_status`, `created_at`);

-- AddForeignKey
ALTER TABLE `request_documents` ADD CONSTRAINT `request_documents_service_request_id_fkey` FOREIGN KEY (`service_request_id`) REFERENCES `service_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `request_events` ADD CONSTRAINT `request_events_service_request_id_fkey` FOREIGN KEY (`service_request_id`) REFERENCES `service_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
