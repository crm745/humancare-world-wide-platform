-- Private Charter: Mobility becomes multi-select. A request may now hold several mobility keys joined with commas
-- ("bedridden,wheelchair,walking" is 28 characters), which does not fit VARCHAR(16).
-- Widening only: no row is changed, no value is lost, and every existing single key ("walking") stays valid.
-- Same size and convention as care_level (VARCHAR(191)). The change needs a table rebuild (the length prefix of a utf8mb4
-- column changes above 63 characters), so apply it when no heavy write traffic is running; service_requests is small.
-- Code deployed before this migration keeps working (it only writes single keys), so the migration can be applied first.
-- NOT applied by the code change that added it: run it by hand, first against humancare_test (node scripts/test-db.js migrate).
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
ALTER TABLE `service_requests` MODIFY `mobility` VARCHAR(191) NULL;
