-- MANUAL ROLLBACK for 20261123000100_notification_system_phase1_foundation. Prisma never runs this file.
--
-- DESTRUCTIVE: this DROPS all data in notification_devices and notification_preferences and in the columns added
-- to notifications (soft-delete timestamps, idempotency keys, is_mandatory, entity references, data) and to
-- notification_deliveries (device_id, destination_key). Take a backup first. Run on humancare_dev only, by hand.
--
-- After it has run successfully, tell Prisma it was rolled back (this edits only _prisma_migrations):
--   npx prisma migrate resolve --rolled-back 20261123000100_notification_system_phase1_foundation
-- and revert the matching schema.prisma changes.
--
-- PRE-CHECKS (run these first; do not continue if a check fails):
--   a) The old unique index (notification_id, channel) can only be restored if no duplicates exist. Expect 0 rows:
--        SELECT notification_id, channel, COUNT(*) FROM notification_deliveries
--          WHERE notification_id IS NOT NULL GROUP BY notification_id, channel HAVING COUNT(*) > 1;
--   b) Code that predates this migration does not know about deleted_at, so soft-deleted notifications would
--      REAPPEAR in the in-app lists. Count them and decide (accept, or hard-delete them knowing history is lost):
--        SELECT COUNT(*) FROM notifications WHERE deleted_at IS NOT NULL;
--   c) Delivery rows pointing at a device lose that link (device_id is dropped):
--        SELECT COUNT(*) FROM notification_deliveries WHERE device_id IS NOT NULL;
--
-- MySQL DDL is not transactional. If a statement fails midway, fix the cause and continue from that statement.

-- 4. notification_deliveries: restore (notification_id, channel) uniqueness, drop the device columns.
-- The old unique index is created BEFORE the wider one is dropped (the notification_id foreign key needs an index).
ALTER TABLE `notification_deliveries` DROP CONSTRAINT `notification_deliveries_destination_key_chk`;
CREATE UNIQUE INDEX `notification_deliveries_notification_id_channel_key` ON `notification_deliveries`(`notification_id`, `channel`);
DROP INDEX `notification_deliveries_dest_key` ON `notification_deliveries`;
ALTER TABLE `notification_deliveries` DROP FOREIGN KEY `notification_deliveries_device_id_fkey`;
DROP INDEX `notification_deliveries_device_id_idx` ON `notification_deliveries`;
ALTER TABLE `notification_deliveries`
    DROP COLUMN `device_id`,
    DROP COLUMN `destination_key`;

-- 3 and 2. New tables (devices after deliveries, because deliveries referenced them).
DROP TABLE `notification_preferences`;
DROP TABLE `notification_devices`;

-- 1. notifications: drop foreign keys, then indexes, then columns.
ALTER TABLE `notifications`
    DROP FOREIGN KEY `notifications_case_id_fkey`,
    DROP FOREIGN KEY `notifications_service_request_id_fkey`,
    DROP FOREIGN KEY `notifications_quotation_id_fkey`;
DROP INDEX `notifications_case_id_idx` ON `notifications`;
DROP INDEX `notifications_service_request_id_idx` ON `notifications`;
DROP INDEX `notifications_quotation_id_idx` ON `notifications`;
DROP INDEX `notifications_recipient_active_idx` ON `notifications`;
DROP INDEX `notifications_idempotency_key_key` ON `notifications`;
ALTER TABLE `notifications`
    DROP COLUMN `updated_at`,
    DROP COLUMN `deleted_at`,
    DROP COLUMN `idempotency_key`,
    DROP COLUMN `is_mandatory`,
    DROP COLUMN `case_id`,
    DROP COLUMN `service_request_id`,
    DROP COLUMN `quotation_id`,
    DROP COLUMN `data`;
