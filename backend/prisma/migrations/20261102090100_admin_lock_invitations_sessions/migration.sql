-- Admin Lock System 2/3: recovery requests, invitations, sessions and refresh tokens.
--
-- New tables only; no existing table is altered. admin_recovery_requests is created before
-- admin_invitations because an invitation can reference the recovery request it belongs to.
-- Foreign keys to admin_users are RESTRICT so security history cannot be erased by deleting
-- an Admin (Admins are soft-disabled instead). The one SET NULL is the refresh-token chain
-- pointer, which lets the 365-day purge remove old tokens in any order.
--
-- MySQL DDL is not transactional: if a statement fails part-way, the earlier ones stay
-- applied. Apply it to a copy first and keep a backup.

-- CreateTable
CREATE TABLE `admin_recovery_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `admin_id` INTEGER NOT NULL,
    `requested_by_admin_id` INTEGER NULL,
    `requested_via` VARCHAR(16) NOT NULL,
    `request_ip` VARCHAR(191) NULL,
    `reason` VARCHAR(500) NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
    `approvals_required` INTEGER NOT NULL DEFAULT 2,
    `approved_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `admin_recovery_requests_admin_id_status_idx`(`admin_id`, `status`),
    INDEX `admin_recovery_requests_status_expires_at_idx`(`status`, `expires_at`),
    INDEX `admin_recovery_requests_requested_by_admin_id_idx`(`requested_by_admin_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_invitations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `admin_id` INTEGER NOT NULL,
    `purpose` VARCHAR(24) NOT NULL,
    `recovery_request_id` INTEGER NULL,
    `token_hash` CHAR(64) NOT NULL,
    `sent_to_email` VARCHAR(191) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `admin_invitations_token_hash_key`(`token_hash`),
    INDEX `admin_invitations_admin_id_created_at_idx`(`admin_id`, `created_at`),
    INDEX `admin_invitations_expires_at_idx`(`expires_at`),
    INDEX `admin_invitations_recovery_request_id_idx`(`recovery_request_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `admin_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_activity_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `idle_expires_at` DATETIME(3) NOT NULL,
    `absolute_expires_at` DATETIME(3) NOT NULL,
    `locked_at` DATETIME(3) NULL,
    `unlock_failed_count` INTEGER NOT NULL DEFAULT 0,
    `unlock_locked_until` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_reason` VARCHAR(64) NULL,
    `revoked_by` INTEGER NULL,
    `ip_address` VARCHAR(191) NULL,
    `user_agent` VARCHAR(255) NULL,

    INDEX `admin_sessions_admin_id_revoked_at_absolute_expires_at_idx`(`admin_id`, `revoked_at`, `absolute_expires_at`),
    INDEX `admin_sessions_absolute_expires_at_idx`(`absolute_expires_at`),
    INDEX `admin_sessions_revoked_at_idx`(`revoked_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_refresh_tokens` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `session_id` INTEGER NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `replaced_by_id` INTEGER NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `admin_refresh_tokens_token_hash_key`(`token_hash`),
    UNIQUE INDEX `admin_refresh_tokens_replaced_by_id_key`(`replaced_by_id`),
    INDEX `admin_refresh_tokens_session_id_idx`(`session_id`),
    INDEX `admin_refresh_tokens_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `admin_recovery_requests` ADD CONSTRAINT `admin_recovery_requests_admin_id_fkey` FOREIGN KEY (`admin_id`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_recovery_requests` ADD CONSTRAINT `admin_recovery_requests_requested_by_admin_id_fkey` FOREIGN KEY (`requested_by_admin_id`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_invitations` ADD CONSTRAINT `admin_invitations_admin_id_fkey` FOREIGN KEY (`admin_id`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_invitations` ADD CONSTRAINT `admin_invitations_recovery_request_id_fkey` FOREIGN KEY (`recovery_request_id`) REFERENCES `admin_recovery_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_sessions` ADD CONSTRAINT `admin_sessions_admin_id_fkey` FOREIGN KEY (`admin_id`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_refresh_tokens` ADD CONSTRAINT `admin_refresh_tokens_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `admin_sessions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_refresh_tokens` ADD CONSTRAINT `admin_refresh_tokens_replaced_by_id_fkey` FOREIGN KEY (`replaced_by_id`) REFERENCES `admin_refresh_tokens`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
