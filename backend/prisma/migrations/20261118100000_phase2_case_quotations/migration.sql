-- Phase 2 (payment gateway): quotation versions, and the links from invoices to them. ADDITIVE ONLY: one new table
-- (case_quotations), one new unique index on bitrix_deal_links, and new columns / one unique index / two foreign keys / CHECKs on
-- invoices. No existing column, row or index is changed or dropped. Nothing is backfilled: every existing invoice keeps
-- source = 'manual', quotation_id NULL and allow_partial_payment = 0. Code deployed before this migration ignores all of it.
-- NOT applied by the change that created it: run it by hand against humancare_test only (node scripts/test-db.js migrate), after review.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
--
-- No database triggers. Immutability and the lifecycle are enforced by the single backend writer (row locking, compare-and-set on
-- `revision`, one transaction per transition), by the CHECK constraints and unique keys below, by audit_logs and by file hash
-- verification. See the model comment in prisma/schema.prisma for the lifecycle, the slot rules and the immutable fields.
--
-- CHECK constraints are not visible to Prisma. They were verified on humancare_test (MySQL 26.7.0) with prefixed scratch copies of
-- these exact statements before this file was approved; the service still validates every rule. A CHECK accepts a row whose condition
-- evaluates to NULL, so every condition below that could be NULL is written NULL-safe (<=>, COALESCE).
--
-- MONEY: amount DECIMAL(14,3), major units, never rounded by HumanCare. MySQL itself ROUNDS a value with more than three fractional
-- digits (verified), so the service MUST validate the currency's precision (0, 2 or 3 digits, ISO 4217) BEFORE the database.
--
-- LEGACY BILLING: PATCH /admin/cases/:id/billing (cases.billing_* columns) still updates Private Charter Cases. The application work
-- MUST make it reject them; this migration does not and cannot.

-- AlterTable
ALTER TABLE `invoices`
    ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'manual',
    ADD COLUMN `quotation_id` INTEGER NULL,
    ADD COLUMN `allow_partial_payment` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `partial_payment_authorized_by_admin_id` INTEGER NULL,
    ADD COLUMN `partial_payment_authorized_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `case_quotations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `case_id` INTEGER NOT NULL,
    `deal_link_id` INTEGER NOT NULL,
    `bitrix_deal_id` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `version_number` INTEGER NOT NULL,
    `bitrix_file_id` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `bitrix_amount_raw` VARCHAR(64) NULL,
    `bitrix_currency_raw` VARCHAR(32) NULL,
    `bitrix_deal_stage_id` VARCHAR(64) NULL,
    `content_fingerprint` CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `storage_provider` VARCHAR(16) NOT NULL DEFAULT 'local',
    `storage_key` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `sha256` CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `scan_status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `scan_engine` VARCHAR(40) NULL,
    `scan_detail` VARCHAR(255) NULL,
    `scanned_at` DATETIME(3) NULL,
    `scan_attempts` INTEGER NOT NULL DEFAULT 0,
    `scan_next_attempt_at` DATETIME(3) NULL,
    `amount` DECIMAL(14, 3) NULL,
    `currency` VARCHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `validation_error` VARCHAR(64) NULL,
    `valid_until` DATETIME(3) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'draft',
    `working_slot` INTEGER NULL,
    `live_slot` INTEGER NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `last_seen_at` DATETIME(3) NULL,
    `confirmed_by_admin_id` INTEGER NULL,
    `confirmed_at` DATETIME(3) NULL,
    `published_by_admin_id` INTEGER NULL,
    `published_at` DATETIME(3) NULL,
    `withdrawn_by_admin_id` INTEGER NULL,
    `withdrawn_at` DATETIME(3) NULL,
    `withdraw_reason` VARCHAR(1000) NULL,
    `decided_by_user_id` INTEGER NULL,
    `decided_at` DATETIME(3) NULL,
    `rejection_reason` TEXT NULL,
    `superseded_at` DATETIME(3) NULL,
    `superseded_by_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `case_quotations_storage_key_key`(`storage_key`),
    UNIQUE INDEX `case_quotations_case_id_version_number_key`(`case_id`, `version_number`),
    UNIQUE INDEX `case_quotations_case_id_working_slot_key`(`case_id`, `working_slot`),
    UNIQUE INDEX `case_quotations_case_id_live_slot_key`(`case_id`, `live_slot`),
    UNIQUE INDEX `case_quotations_id_case_id_key`(`id`, `case_id`),
    UNIQUE INDEX `case_quotations_id_case_currency_amount_key`(`id`, `case_id`, `currency`, `amount`),
    INDEX `case_quotations_case_id_status_idx`(`case_id`, `status`),
    INDEX `case_quotations_deal_link_id_case_id_idx`(`deal_link_id`, `case_id`),
    INDEX `case_quotations_status_valid_until_idx`(`status`, `valid_until`),
    INDEX `case_quotations_scan_status_scan_next_attempt_at_idx`(`scan_status`, `scan_next_attempt_at`),
    PRIMARY KEY (`id`),

    -- values and shapes
    CONSTRAINT `case_quotations_status_chk` CHECK (`status` IN ('draft','confirmed','published','accepted','rejected','withdrawn','superseded')),
    CONSTRAINT `case_quotations_scan_status_chk` CHECK (`scan_status` IN ('pending','clean','infected','error')),
    CONSTRAINT `case_quotations_storage_provider_chk` CHECK (`storage_provider` IN ('local','s3')),
    CONSTRAINT `case_quotations_counters_chk` CHECK (`version_number` >= 1 AND `revision` >= 0 AND `scan_attempts` >= 0 AND `size_bytes` > 0),
    CONSTRAINT `case_quotations_hashes_chk` CHECK (`sha256` REGEXP '^[0-9a-f]{64}$' AND `content_fingerprint` REGEXP '^[0-9a-f]{64}$'),
    CONSTRAINT `case_quotations_amount_chk` CHECK (`amount` IS NULL OR `amount` > 0),
    CONSTRAINT `case_quotations_currency_chk` CHECK (`currency` IS NULL OR `currency` REGEXP '^[A-Z]{3}$'),
    CONSTRAINT `case_quotations_money_pair_chk` CHECK ((`amount` IS NULL) = (`currency` IS NULL)),

    -- slots: exactly mirror the status (see the model comment); 1 or NULL only
    CONSTRAINT `case_quotations_slot_values_chk` CHECK ((`working_slot` IS NULL OR `working_slot` = 1) AND (`live_slot` IS NULL OR `live_slot` = 1)),
    CONSTRAINT `case_quotations_working_slot_chk` CHECK ((`working_slot` <=> 1) = (`status` IN ('draft','confirmed'))),
    CONSTRAINT `case_quotations_live_slot_chk` CHECK ((`live_slot` <=> 1) = (`status` IN ('published','accepted') AND `superseded_at` IS NULL)),

    -- a quotation that has been confirmed (or went further) is complete, clean and valid
    CONSTRAINT `case_quotations_confirmed_chk` CHECK (`status` NOT IN ('confirmed','published','accepted','rejected','superseded') OR (`scan_status` = 'clean' AND `amount` IS NOT NULL AND `currency` IS NOT NULL AND `validation_error` IS NULL AND `confirmed_by_admin_id` IS NOT NULL AND `confirmed_at` IS NOT NULL)),
    CONSTRAINT `case_quotations_draft_unconfirmed_chk` CHECK (`status` <> 'draft' OR (`confirmed_by_admin_id` IS NULL AND `confirmed_at` IS NULL)),
    CONSTRAINT `case_quotations_published_chk` CHECK (`status` NOT IN ('published','accepted','rejected','superseded') OR (`published_by_admin_id` IS NOT NULL AND `published_at` IS NOT NULL)),
    CONSTRAINT `case_quotations_unpublished_chk` CHECK (`status` NOT IN ('draft','confirmed') OR (`published_by_admin_id` IS NULL AND `published_at` IS NULL)),
    CONSTRAINT `case_quotations_valid_until_chk` CHECK (`valid_until` IS NULL OR `published_at` IS NULL OR `valid_until` > `published_at`),

    -- withdrawal needs the Admin, the time and a non-blank reason; nothing else carries them
    CONSTRAINT `case_quotations_withdrawn_chk` CHECK ((`status` = 'withdrawn') = (`withdrawn_at` IS NOT NULL AND `withdrawn_by_admin_id` IS NOT NULL AND COALESCE(CHAR_LENGTH(TRIM(`withdraw_reason`)), 0) > 0) AND (`status` = 'withdrawn' OR (`withdrawn_at` IS NULL AND `withdrawn_by_admin_id` IS NULL AND `withdraw_reason` IS NULL))),

    -- patient decision: who, when, and a mandatory reason for a rejection; nothing else carries them
    CONSTRAINT `case_quotations_decision_chk` CHECK (
        (`status` = 'accepted' AND `decided_by_user_id` IS NOT NULL AND `decided_at` IS NOT NULL AND `rejection_reason` IS NULL)
        OR (`status` = 'rejected' AND `decided_by_user_id` IS NOT NULL AND `decided_at` IS NOT NULL AND COALESCE(CHAR_LENGTH(TRIM(`rejection_reason`)), 0) > 0)
        OR (`status` NOT IN ('accepted','rejected') AND `decided_by_user_id` IS NULL AND `decided_at` IS NULL AND `rejection_reason` IS NULL)),

    -- supersession: time and successor go together; only published (-> superseded) or accepted rows carry it
    CONSTRAINT `case_quotations_superseded_chk` CHECK ((`status` <> 'superseded' OR `superseded_at` IS NOT NULL) AND ((`superseded_at` IS NULL) = (`superseded_by_id` IS NULL)) AND (`superseded_at` IS NULL OR `status` IN ('accepted','superseded')))
    -- NOT expressible: a row must not supersede itself. MySQL refuses a CHECK that refers to the AUTO_INCREMENT column (error 3818,
    -- found by the scratch test), so the single writer module must refuse superseded_by_id = id.
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `bitrix_deal_links_id_case_id_key` ON `bitrix_deal_links`(`id`, `case_id`);

-- CreateIndex
CREATE UNIQUE INDEX `invoices_quotation_id_key` ON `invoices`(`quotation_id`);

-- AddForeignKey (case_quotations)
ALTER TABLE `case_quotations` ADD CONSTRAINT `case_quotations_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `case_quotations` ADD CONSTRAINT `case_quotations_deal_link_id_case_id_fkey` FOREIGN KEY (`deal_link_id`, `case_id`) REFERENCES `bitrix_deal_links`(`id`, `case_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `case_quotations` ADD CONSTRAINT `case_quotations_confirmed_by_admin_id_fkey` FOREIGN KEY (`confirmed_by_admin_id`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `case_quotations` ADD CONSTRAINT `case_quotations_published_by_admin_id_fkey` FOREIGN KEY (`published_by_admin_id`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `case_quotations` ADD CONSTRAINT `case_quotations_withdrawn_by_admin_id_fkey` FOREIGN KEY (`withdrawn_by_admin_id`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `case_quotations` ADD CONSTRAINT `case_quotations_decided_by_user_id_fkey` FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `case_quotations` ADD CONSTRAINT `case_quotations_superseded_by_id_case_id_fkey` FOREIGN KEY (`superseded_by_id`, `case_id`) REFERENCES `case_quotations`(`id`, `case_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey (invoices). The composite key makes the database refuse an invoice whose Case, currency or amount differs from its
-- quotation (and any later edit that would break the match). It is not checked while quotation_id is NULL (legacy invoices).
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_quotation_id_case_id_currency_amount_fkey` FOREIGN KEY (`quotation_id`, `case_id`, `currency`, `amount`) REFERENCES `case_quotations`(`id`, `case_id`, `currency`, `amount`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_partial_payment_authorized_by_admin_id_fkey` FOREIGN KEY (`partial_payment_authorized_by_admin_id`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CHECKs on invoices (added after the columns exist; existing rows satisfy them: source 'manual', no quotation, no partial payment)
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_source_chk` CHECK (`source` IN ('manual','quotation'));
-- the new quotation workflow cannot create an invoice without its quotation, and a manual (legacy-style) invoice never has one
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_quotation_required_chk` CHECK ((`source` = 'manual' AND `quotation_id` IS NULL) OR (`source` = 'quotation' AND `quotation_id` IS NOT NULL));
-- full payment is the default; partial payment needs the authorizing Admin and the time, together
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_partial_payment_auth_chk` CHECK ((`allow_partial_payment` = 0 AND `partial_payment_authorized_by_admin_id` IS NULL AND `partial_payment_authorized_at` IS NULL) OR (`allow_partial_payment` = 1 AND `partial_payment_authorized_by_admin_id` IS NOT NULL AND `partial_payment_authorized_at` IS NOT NULL));
