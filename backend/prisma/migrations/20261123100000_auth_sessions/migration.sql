-- Per-device sessions for patients and corporate users (the server-side session architecture): one row per signed-in device. Every access and refresh token carries the row's id; a token whose session
-- is revoked, idle (30 minutes without a request) or older than 7 days is refused, so one device can be signed out alone, a password reset or an account retirement ends them all, and refresh tokens
-- rotate (a reused one revokes the session). Only a SHA-256 hash of the current / previous refresh token id is stored, never a token.
--
-- Additive and non-destructive: ONE NEW TABLE with its indexes and two foreign keys to existing tables; no existing table, column or row is touched. Nobody is signed out by it: a session started before
-- this migration has no row, and its refresh token is exchanged once for a session on its next refresh (src/modules/auth/session.service.js).
-- (MySQL does not allow a CHECK on columns that have a cascading foreign key, so "exactly one of user_id / corporate_user_id" is enforced by the only writer, createSession.)
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations). It drops only this table.

-- CreateTable
CREATE TABLE `auth_sessions` (
    `id` CHAR(36) NOT NULL,
    `user_id` INTEGER NULL,
    `corporate_user_id` INTEGER NULL,
    `refresh_hash` CHAR(64) NOT NULL,
    `previous_hash` CHAR(64) NULL,
    `rotated_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_activity_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `absolute_expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_reason` VARCHAR(64) NULL,
    `user_agent` VARCHAR(255) NULL,

    INDEX `auth_sessions_user_id_revoked_at_absolute_expires_at_idx`(`user_id`, `revoked_at`, `absolute_expires_at`),
    INDEX `auth_sessions_corporate_user_id_revoked_at_absolute_expires__idx`(`corporate_user_id`, `revoked_at`, `absolute_expires_at`),
    INDEX `auth_sessions_absolute_expires_at_idx`(`absolute_expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_corporate_user_id_fkey` FOREIGN KEY (`corporate_user_id`) REFERENCES `corporate_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
