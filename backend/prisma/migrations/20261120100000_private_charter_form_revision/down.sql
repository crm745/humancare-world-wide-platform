-- Rollback for 20261120100000_private_charter_form_revision. Not run by Prisma: run it by hand, then
-- `prisma migrate resolve --rolled-back 20261120100000_private_charter_form_revision`.
-- Drops the stored travel type, critical level and oxygen values of every request.
ALTER TABLE `service_requests` DROP COLUMN `travel_type`,
    DROP COLUMN `critical_level`,
    DROP COLUMN `oxygen_required`,
    DROP COLUMN `oxygen_flow_lpm`;
