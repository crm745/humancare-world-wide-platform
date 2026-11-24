-- Notification System Phase 1 foundation. ADDITIVE ONLY: no column, table, index or row is dropped except the
-- superseded delivery unique index (replaced first by its wider successor). Existing notifications are kept and
-- keep their meaning; M8 tables, CHECKs and the notification_delivery_attempts table are untouched.
--
-- NOT changed here: users.push_token (kept during the compatibility period). NO notification_deliveries rows are
-- created and no worker exists; the existing direct Expo push paths stay active. Rolling back is down.sql in this
-- folder (run by hand), with a destructive warning.
--
-- notifications:
--   * updated_at, deleted_at (soft delete), idempotency_key (nullable, UNIQUE, utf8mb4_bin; legacy rows stay NULL
--     and MySQL allows many NULLs), is_mandatory (snapshot of the backend catalogue, default false), data (JSON),
--     and three optional references case_id / service_request_id / quotation_id to cases / service_requests /
--     case_quotations (all INT, same type as their primary keys), each ON DELETE SET NULL.
--   * recipient_type / recipient_id stay polymorphic with no foreign key. Cross-entity consistency and recipient
--     ownership are validated by the notification service, not by the database.
--   * No CHECK is placed on the three SET NULL foreign-key columns (MySQL forbids it).
-- notification_devices: owner (polymorphic), device_id (app-generated UUID, GLOBALLY unique), expo_push_token
--   (GLOBALLY unique), platform, status. Ownership transfer is done by the service (it cancels the previous owner's
--   pending deliveries first), never by a second row.
-- notification_preferences: one row per owner, in-app and push default ON.
-- notification_deliveries: device_id (nullable, SET NULL) and destination_key (NOT NULL, never empty). Uniqueness
--   becomes (notification_id, channel, destination_key). The new unique index is created BEFORE the old one is
--   dropped, because the notification_id foreign key needs an index that starts with notification_id at all times.
--
-- MySQL DDL is not transactional. If a statement fails midway, fix the cause and run the remaining statements by
-- hand in order, or use down.sql. All timestamps are DATETIME(3) like the rest of the schema.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. notifications
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE `notifications`
    ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `deleted_at` DATETIME(3) NULL,
    ADD COLUMN `idempotency_key` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN `is_mandatory` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `case_id` INTEGER NULL,
    ADD COLUMN `service_request_id` INTEGER NULL,
    ADD COLUMN `quotation_id` INTEGER NULL,
    ADD COLUMN `data` JSON NULL;

-- Existing rows: "last updated" is when they were created, not when this migration ran.
UPDATE `notifications` SET `updated_at` = `created_at`;

CREATE UNIQUE INDEX `notifications_idempotency_key_key` ON `notifications`(`idempotency_key`);
CREATE INDEX `notifications_recipient_active_idx` ON `notifications`(`recipient_type`, `recipient_id`, `deleted_at`, `created_at`);
CREATE INDEX `notifications_case_id_idx` ON `notifications`(`case_id`);
CREATE INDEX `notifications_service_request_id_idx` ON `notifications`(`service_request_id`);
CREATE INDEX `notifications_quotation_id_idx` ON `notifications`(`quotation_id`);

ALTER TABLE `notifications`
    ADD CONSTRAINT `notifications_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `notifications_service_request_id_fkey` FOREIGN KEY (`service_request_id`) REFERENCES `service_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `notifications_quotation_id_fkey` FOREIGN KEY (`quotation_id`) REFERENCES `case_quotations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. notification_devices
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE `notification_devices` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `owner_type` VARCHAR(32) NOT NULL,
    `owner_id` INTEGER NOT NULL,
    `device_id` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `expo_push_token` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `platform` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    `last_registered_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NULL,
    `disabled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `notification_devices_device_id_key`(`device_id`),
    UNIQUE INDEX `notification_devices_expo_push_token_key`(`expo_push_token`),
    INDEX `notification_devices_owner_type_owner_id_status_idx`(`owner_type`, `owner_id`, `status`),
    PRIMARY KEY (`id`),
    CONSTRAINT `notification_devices_owner_type_chk` CHECK (`owner_type` IN ('patient', 'corporate_user')),
    CONSTRAINT `notification_devices_platform_chk` CHECK (`platform` IN ('android', 'ios')),
    CONSTRAINT `notification_devices_status_chk` CHECK (`status` IN ('active', 'inactive'))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. notification_preferences
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE `notification_preferences` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `owner_type` VARCHAR(32) NOT NULL,
    `owner_id` INTEGER NOT NULL,
    `in_app_enabled` BOOLEAN NOT NULL DEFAULT true,
    `push_enabled` BOOLEAN NOT NULL DEFAULT true,
    `category_preferences` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `notification_preferences_owner_key`(`owner_type`, `owner_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `notification_preferences_owner_type_chk` CHECK (`owner_type` IN ('patient', 'corporate_user'))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. notification_deliveries: device-specific delivery with a non-null destination
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE `notification_deliveries`
    ADD COLUMN `device_id` INTEGER NULL,
    ADD COLUMN `destination_key` VARCHAR(64) NULL;

-- The table has no rows today and Phase 1 creates none; this only keeps the migration safe if a row ever exists.
UPDATE `notification_deliveries` SET `destination_key` = 'user' WHERE `destination_key` IS NULL;

ALTER TABLE `notification_deliveries` MODIFY `destination_key` VARCHAR(64) NOT NULL;

-- New unique index first, then drop the superseded one (see header).
CREATE UNIQUE INDEX `notification_deliveries_dest_key` ON `notification_deliveries`(`notification_id`, `channel`, `destination_key`);
DROP INDEX `notification_deliveries_notification_id_channel_key` ON `notification_deliveries`;
CREATE INDEX `notification_deliveries_device_id_idx` ON `notification_deliveries`(`device_id`);

ALTER TABLE `notification_deliveries`
    ADD CONSTRAINT `notification_deliveries_device_id_fkey` FOREIGN KEY (`device_id`) REFERENCES `notification_devices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `notification_deliveries_destination_key_chk` CHECK (`destination_key` <> '');
