-- Private Charter M5: link between a Private Charter Case and its one Bitrix24 Deal. Additive only: one
-- new table with one foreign key to cases. No existing table, column, row or index is changed. The Lead
-- integration is untouched: service_requests.bitrix_lead_id, cases.bitrix_lead_id and their retry
-- columns keep every existing value, and no Lead ID is copied into the new table or converted into a
-- Deal. Nothing is backfilled. Code deployed before this migration ignores the table, so it can be
-- applied first. No Bitrix call is made.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations), and is
-- only safe while bitrix_deal_links is empty or its rows have been exported: it loses the Deal links.
--
-- PRIVATE CHARTER ONLY: Corporate Cases and every other service never use this table. The database
-- cannot enforce that, so the future service MUST, in the transaction that creates a row, load the Case
-- and refuse unless cases.service_request_id is set and that service request's service_key is the
-- Private Charter key (PRIVATE_CHARTER_KEY, 'privatecharter'). Corporate Cases (service_request_id NULL)
-- and Cases of any other service must be refused.
--
-- At most one Deal per request: case_id is unique here and cases.service_request_id is unique, so a
-- request has at most one Case and therefore at most one link. The service request is derived through the
-- Case and is deliberately not stored in this table, so there is no second reference that could
-- disagree. bitrix_deal_id is unique and nullable: the row may be created before Bitrix is called, and
-- MySQL allows any number of NULLs in a unique index, so only real Deal IDs are kept unique. A row with a
-- NULL bitrix_deal_id is not a Deal.
--
-- M6 RELIABILITY REQUIREMENT (not implemented here): a pre-created link with a NULL bitrix_deal_id does
-- NOT by itself guarantee exactly-once Deal creation. If Bitrix creates the Deal but HumanCare crashes
-- (or loses the response) before saving the returned Deal ID, the row still reads "no Deal yet" and a
-- retry would create a second Deal. M6 MUST provide durable idempotency and recovery / reconciliation
-- for that case, so retries can never create duplicate Deals.
--
-- Bitrix IDs (bitrix_deal_id, category_id, stage_id) are stored as text exactly as Bitrix returned them,
-- never generated, renumbered, truncated, padded or normalised, and a Deal ID is never a Lead ID.
-- bitrix_deal_id and stage_id use utf8mb4_bin (case-sensitive, exact). utf8mb4_bin ignores trailing
-- spaces when comparing, so the writing code MUST reject (never silently trim) values with leading or
-- trailing whitespace. last_error must never hold a webhook URL, token or other secret.
-- The foreign key is RESTRICT, so a Case with a Deal link cannot be deleted.
--
-- KNOWN INTEGRITY RISK, FIXED IN M9 (not in M5): cases.service_request_id currently has a foreign key
-- with ON DELETE SET NULL. Deleting a service request would therefore detach its Case from the service
-- request while its bitrix_deal_links row remains, losing the historical link between the request and its
-- Deal. No code deletes service requests today. M9 MUST change that foreign key to ON DELETE RESTRICT
-- ON UPDATE CASCADE, and MUST preserve every existing Corporate Case, where service_request_id is NULL.
-- M5 does not change this foreign key.

-- CreateTable
CREATE TABLE `bitrix_deal_links` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `case_id` INTEGER NOT NULL,
    `bitrix_deal_id` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `category_id` VARCHAR(16) NULL,
    `stage_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `sync_status` VARCHAR(24) NOT NULL DEFAULT 'pending',
    `last_attempt_at` DATETIME(3) NULL,
    `last_synced_at` DATETIME(3) NULL,
    `external_modified_at` DATETIME(3) NULL,
    `last_error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `bitrix_deal_links_case_id_key`(`case_id`),
    UNIQUE INDEX `bitrix_deal_links_bitrix_deal_id_key`(`bitrix_deal_id`),
    INDEX `bitrix_deal_links_sync_status_last_attempt_at_idx`(`sync_status`, `last_attempt_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `bitrix_deal_links` ADD CONSTRAINT `bitrix_deal_links_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
