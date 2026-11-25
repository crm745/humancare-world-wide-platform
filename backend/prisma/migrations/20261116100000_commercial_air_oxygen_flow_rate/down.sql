-- Rollback for 20261116100000_commercial_air_oxygen_flow_rate. Not run by Prisma: run it by hand, then
-- remove the row for this migration from `_prisma_migrations` (or use
-- `prisma migrate resolve --rolled-back 20261116100000_commercial_air_oxygen_flow_rate`).
-- Drops the stored oxygen flow rate of every request; nothing else is affected (equip_oxygen stays).
-- Deploy the backend code that no longer reads the column BEFORE running this, or requests will fail.
ALTER TABLE `service_requests` DROP COLUMN `equip_oxygen_lpm`;
