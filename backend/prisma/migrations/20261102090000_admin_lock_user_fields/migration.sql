-- Admin Lock System 1/3: Admin account lifecycle fields.
--
-- Additive, except that password_hash is relaxed to NULL so an invited Admin can exist
-- before choosing a password. Every added column is nullable or has a default, and no row
-- is updated or deleted: existing Admins keep their id, email, password_hash, role,
-- corporate_review and created_at. They read status = 'active' and failed_login_count = 0
-- through the column defaults, and updated_at is the time this migration runs.
-- Code deployed before this migration ignores the new columns, so it can be applied first.
--
-- MySQL DDL is not transactional: if a statement fails part-way, the earlier ones stay
-- applied. Apply it to a copy first and keep a backup.

-- AlterTable
ALTER TABLE `admin_users` ADD COLUMN `disabled_at` DATETIME(3) NULL,
    ADD COLUMN `disabled_by` INTEGER NULL,
    ADD COLUMN `disabled_reason` VARCHAR(255) NULL,
    ADD COLUMN `email_verified_at` DATETIME(3) NULL,
    ADD COLUMN `failed_login_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `last_login_at` DATETIME(3) NULL,
    ADD COLUMN `locked_until` DATETIME(3) NULL,
    ADD COLUMN `password_changed_at` DATETIME(3) NULL,
    ADD COLUMN `status` VARCHAR(24) NOT NULL DEFAULT 'active',
    ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    MODIFY `password_hash` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `admin_users_status_idx` ON `admin_users`(`status`);
