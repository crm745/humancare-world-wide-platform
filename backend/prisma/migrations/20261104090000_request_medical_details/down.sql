-- Rollback for 20261104090000_request_medical_details. Not run by Prisma: run it by hand, then
-- remove the row for this migration from `_prisma_migrations` (or use
-- `prisma migrate resolve --rolled-back 20261104090000_request_medical_details`).
-- Drops the stored mobility, equipment and urgency values for every request.
ALTER TABLE `service_requests` DROP COLUMN `mobility`,
    DROP COLUMN `equip_oxygen`,
    DROP COLUMN `equip_cardiac_monitor`,
    DROP COLUMN `equip_ventilator`,
    DROP COLUMN `urgency`;
