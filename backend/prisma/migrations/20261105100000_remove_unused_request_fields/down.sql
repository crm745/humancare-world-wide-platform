-- Rollback for 20261105100000_remove_unused_request_fields. Not run by Prisma: run it by hand,
-- then `prisma migrate resolve --rolled-back 20261105100000_remove_unused_request_fields`.
-- Puts the two columns back EMPTY; any values they held are gone.
ALTER TABLE `service_requests` ADD COLUMN `document_url` VARCHAR(191) NULL,
    ADD COLUMN `medical_summary` TEXT NULL;
