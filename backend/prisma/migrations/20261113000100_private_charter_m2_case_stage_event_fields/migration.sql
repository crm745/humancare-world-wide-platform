-- Private Charter M2: transition and actor metadata on case_stage_events. Additive only: eight nullable
-- columns and one unique index on one table. No existing column, row, index or constraint is changed.
-- Existing rows get NULL in all eight columns. The unique index covers (case_id, idempotency_key): MySQL
-- allows any number of rows with a NULL idempotency_key, so existing rows and rows written without a key
-- can never conflict; only two rows with the same case and the same non-NULL key are refused.
-- Code deployed before this migration ignores the new columns, so it can be applied first.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).

-- AlterTable
ALTER TABLE `case_stage_events` ADD COLUMN `actor_id` VARCHAR(191) NULL,
    ADD COLUMN `actor_type` VARCHAR(191) NULL,
    ADD COLUMN `external_modified_at` DATETIME(3) NULL,
    ADD COLUMN `idempotency_key` VARCHAR(191) NULL,
    ADD COLUMN `previous_stage` VARCHAR(191) NULL,
    ADD COLUMN `reason_code` VARCHAR(191) NULL,
    ADD COLUMN `reason_text` TEXT NULL,
    ADD COLUMN `source` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `case_stage_events_case_id_idempotency_key_key` ON `case_stage_events`(`case_id`, `idempotency_key`);
