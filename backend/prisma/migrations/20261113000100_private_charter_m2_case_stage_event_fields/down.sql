-- Rolls back 20261113000100_private_charter_m2_case_stage_event_fields. Run by hand (Prisma has no automatic
-- down migrations). Only the unique index and the eight Private Charter transition columns are lost; no other
-- column, index or row changes.
-- Check first that nothing has written to them yet:
--   SELECT COUNT(*) FROM case_stage_events WHERE previous_stage IS NOT NULL OR actor_type IS NOT NULL
--     OR actor_id IS NOT NULL OR source IS NOT NULL OR reason_code IS NOT NULL OR reason_text IS NOT NULL
--     OR idempotency_key IS NOT NULL OR external_modified_at IS NOT NULL;
-- Afterwards remove the migration's row from _prisma_migrations by hand.
DROP INDEX `case_stage_events_case_id_idempotency_key_key` ON `case_stage_events`;
ALTER TABLE `case_stage_events` DROP COLUMN `actor_id`,
    DROP COLUMN `actor_type`,
    DROP COLUMN `external_modified_at`,
    DROP COLUMN `idempotency_key`,
    DROP COLUMN `previous_stage`,
    DROP COLUMN `reason_code`,
    DROP COLUMN `reason_text`,
    DROP COLUMN `source`;
