-- Rollback for 20261120110000_private_charter_critical_level_multi. Not run by Prisma: run it by hand, then
-- `prisma migrate resolve --rolled-back 20261120110000_private_charter_critical_level_multi`.
-- Fails (MySQL strict mode) if a stored value is longer than 24 characters, i.e. a request with several choices:
-- no value is ever truncated silently. Check first: SELECT id, critical_level FROM service_requests WHERE CHAR_LENGTH(critical_level) > 24;
ALTER TABLE `service_requests` MODIFY `critical_level` VARCHAR(24) NULL;
