-- Mortal Remains: the two independent choices of the request, stored in their own columns instead of
-- being carried in the service key. Additive only: two nullable columns, so every existing request keeps
-- working and nothing is guessed for it. Only Mortal Remains requests fill them; every other service (and
-- every older Mortal Remains request) leaves them NULL. Rolling back is down.sql in this folder (run by
-- hand; Prisma has no automatic down migrations).
ALTER TABLE `service_requests`
  ADD COLUMN `transfer_scope` VARCHAR(16) NULL,
  ADD COLUMN `transport_mode` VARCHAR(32) NULL;
