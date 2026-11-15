-- M8: notification delivery tracking. Additive only: two new tables and their foreign keys. No existing table,
-- column, row or index is changed, including `notifications`: the in-app Notification keeps its meaning and
-- every existing use (list, read/unread, mark-all-read, delete, Corporate portal, patient app, push sent by
-- cases.service.js). Nothing is backfilled: existing notifications get no delivery row and no delivery
-- history is invented. Code deployed before this migration ignores both tables, so it can be applied first.
-- Rolling back is down.sql in this folder (run by hand), with a destructive warning.
--
-- WHAT EXISTS TODAY (not changed here): push is sent best-effort and untracked through Expo
-- (expo-push.service.js); the backend sends NO SMS (OTP SMS is sent by Firebase from the app). `sms` is a
-- channel these tables can describe; no SMS provider is chosen or implied, and `provider` is free text.
--
-- notification_deliveries: one row per (notification, channel); `notification_id` + `channel` is unique, so a
-- notification is tracked at most once per channel, and retries are rows in notification_delivery_attempts.
--   * notification_id is nullable and ON DELETE SET NULL, because users can delete a Notification today and a
--     RESTRICT would break that feature. recipient_type/recipient_id are copied at creation so history still
--     says whose message it was. A delivery with no Notification has nothing to send; the future service
--     MUST cancel it if still pending. No CHECK mentions notification_id (MySQL forbids a CHECK on a column
--     used by a SET NULL foreign key).
--   * No message text and no destination (push token, phone number) is stored; the service reads both at send
--     time from the Notification and the recipient's current record.
--   * status: pending | sending | accepted | delivered | failed | cancelled | uncertain. `accepted` means the
--     provider accepted the request, NOT that the message reached the person. `delivered` is used only when a
--     provider really confirms delivery, by that provider's own definition (to be checked against its
--     documents). `uncertain` = a request may have reached the provider but the outcome is unknown; it is not
--     retried automatically, because a retry could send a duplicate (most providers have no idempotency key).
--   * attempt_count is the number of attempt rows; the future service inserts the attempt and increments it
--     in ONE transaction (the database cannot enforce that). No maximum attempts or backoff is defined here.
--   * Retry processing claims due rows by (status, next_attempt_at) with a lease (locked_by, locked_until),
--     using the same claiming, fencing and database-side UTC clock rule as integration_outbox.
--   * last_error_code / last_error: short, sanitised, application-defined text only. Never a push token, phone
--     number, message text, credential, URL with a secret, raw provider response or patient information.
--   * provider_message_id is the provider's reference for the accepted message (case-sensitive, utf8mb4_bin).
--
-- notification_delivery_attempts: the history of each try, kept for good, never deleted. The worker inserts the
-- row as `started` BEFORE calling the provider and finalises it as accepted / failed / uncertain; a stale
-- `started` row is treated as uncertain. (delivery_id, attempt_number) is unique, so two workers cannot record
-- the same attempt. Foreign key to the delivery is RESTRICT on delete.
--
-- CHECK CONSTRAINTS: SQL CHECKs are used for channel and status values, non-negative counts and the
-- accepted/delivered/finished timestamps. They are not visible to Prisma and the future service must not
-- depend on them. All 8 were tested against MySQL Community Server - GPL 26.7.0 on humancare_test, using
-- temporary, prefixed copies of these tables: the compatibility test passed and each CHECK was enforced.
-- That test did not modify existing application tables or data. This migration itself has NOT yet been
-- applied anywhere.
-- All timestamps are DATETIME(3) like the rest of the schema.

-- CreateTable
CREATE TABLE `notification_deliveries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `notification_id` INTEGER NULL,
    `recipient_type` VARCHAR(32) NOT NULL,
    `recipient_id` INTEGER NOT NULL,
    `channel` VARCHAR(16) NOT NULL,
    `provider` VARCHAR(32) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `locked_by` VARCHAR(64) NULL,
    `locked_until` DATETIME(3) NULL,
    `provider_message_id` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `accepted_at` DATETIME(3) NULL,
    `delivered_at` DATETIME(3) NULL,
    `closed_at` DATETIME(3) NULL,
    `last_error_code` VARCHAR(64) NULL,
    `last_error` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `notification_deliveries_notification_id_channel_key`(`notification_id`, `channel`),
    INDEX `notification_deliveries_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    INDEX `notification_deliveries_recipient_type_recipient_id_idx`(`recipient_type`, `recipient_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `notification_deliveries_channel_chk` CHECK (`channel` IN ('push', 'sms')),
    CONSTRAINT `notification_deliveries_status_chk` CHECK (`status` IN ('pending', 'sending', 'accepted', 'delivered', 'failed', 'cancelled', 'uncertain')),
    CONSTRAINT `notification_deliveries_attempt_count_chk` CHECK (`attempt_count` >= 0),
    CONSTRAINT `notification_deliveries_accepted_has_accepted_at_chk` CHECK (`status` <> 'accepted' OR `accepted_at` IS NOT NULL),
    CONSTRAINT `notification_deliveries_delivered_has_delivered_at_chk` CHECK (`status` <> 'delivered' OR `delivered_at` IS NOT NULL)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_delivery_attempts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `delivery_id` INTEGER NOT NULL,
    `attempt_number` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'started',
    `provider` VARCHAR(32) NULL,
    `provider_message_id` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `error_code` VARCHAR(64) NULL,
    `error_message` VARCHAR(512) NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,

    UNIQUE INDEX `notification_delivery_attempts_delivery_id_attempt_number_key`(`delivery_id`, `attempt_number`),
    INDEX `notification_delivery_attempts_status_started_at_idx`(`status`, `started_at`),
    PRIMARY KEY (`id`),
    CONSTRAINT `notification_delivery_attempts_number_chk` CHECK (`attempt_number` >= 1),
    CONSTRAINT `notification_delivery_attempts_status_chk` CHECK (`status` IN ('started', 'accepted', 'failed', 'uncertain')),
    CONSTRAINT `notification_delivery_attempts_finished_chk` CHECK (`status` = 'started' OR `finished_at` IS NOT NULL)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `notification_deliveries` ADD CONSTRAINT `notification_deliveries_notification_id_fkey` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_delivery_attempts` ADD CONSTRAINT `notification_delivery_attempts_delivery_id_fkey` FOREIGN KEY (`delivery_id`) REFERENCES `notification_deliveries`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
