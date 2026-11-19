-- Rollback for 20261117100000_mortal_remains_scope_and_mode. Not run by Prisma: run it by hand, then
-- remove the row for this migration from `_prisma_migrations` (or use
-- `prisma migrate resolve --rolled-back 20261117100000_mortal_remains_scope_and_mode`).
-- Drops the stored transfer scope and transport mode of every request; nothing else is affected.
-- Deploy the backend code that no longer reads the columns BEFORE running this, or requests will fail.
ALTER TABLE `service_requests`
  DROP COLUMN `transfer_scope`,
  DROP COLUMN `transport_mode`;
