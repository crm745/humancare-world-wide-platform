-- Rolls back 20261113000000_private_charter_m1_case_stage_fields. Run by hand (Prisma has no automatic down
-- migrations). Only the three Private Charter stage columns are lost; no other column or row changes.
-- Check first that nothing has written to them yet:
--   SELECT COUNT(*) FROM cases WHERE charter_stage IS NOT NULL OR closed_at IS NOT NULL OR stage_version <> 0;
-- Afterwards remove the migration's row from _prisma_migrations by hand.
ALTER TABLE `cases` DROP COLUMN `charter_stage`,
    DROP COLUMN `closed_at`,
    DROP COLUMN `stage_version`;
