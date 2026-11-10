-- Rollback for 20261105140000_remove_request_extra_questions. Not run by Prisma: run it by hand,
-- then `prisma migrate resolve --rolled-back 20261105140000_remove_request_extra_questions`.
-- Puts the three columns back EMPTY; any values they held are gone.
ALTER TABLE `service_requests` ADD COLUMN `additional_info` VARCHAR(191) NULL,
    ADD COLUMN `special_requirements` TEXT NULL,
    ADD COLUMN `referral_source` VARCHAR(191) NULL;
