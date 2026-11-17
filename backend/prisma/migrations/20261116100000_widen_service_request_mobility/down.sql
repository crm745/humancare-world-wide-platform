-- Rolls back 20261116100000_widen_service_request_mobility. Run by hand (Prisma has no automatic down migrations), and ONLY
-- while no row holds more than one mobility key (the narrower column would refuse or truncate it):
--   SELECT COUNT(*) FROM service_requests WHERE CHAR_LENGTH(mobility) > 16;   -- must be 0
-- Afterwards remove the migration's row from _prisma_migrations by hand.
ALTER TABLE `service_requests` MODIFY `mobility` VARCHAR(16) NULL;
