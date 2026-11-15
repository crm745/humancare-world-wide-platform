-- Private Charter M1: stage-tracking columns on cases. Additive only: three columns on one table.
-- No existing column, row, index or constraint is changed. Existing Cases keep every value; they get
-- charter_stage = NULL, closed_at = NULL and stage_version = 0. cases.status is not touched.
-- Code deployed before this migration ignores the new columns, so it can be applied first.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).

-- AlterTable
ALTER TABLE `cases` ADD COLUMN `charter_stage` VARCHAR(191) NULL,
    ADD COLUMN `closed_at` DATETIME(3) NULL,
    ADD COLUMN `stage_version` INTEGER NOT NULL DEFAULT 0;
