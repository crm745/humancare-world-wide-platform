-- Admin Lock System 3/3: passkeys, recovery approvals and WebAuthn challenges.
--
-- New tables only; no existing table is altered. Every foreign key references a table that
-- exists from an earlier migration or from this one. Challenges are short-lived, so they
-- cascade from the Admin and set their invitation / recovery request / session link to NULL
-- when that row is purged; everything durable is RESTRICT.
--
-- MySQL DDL is not transactional: if a statement fails part-way, the earlier ones stay
-- applied. Apply it to a copy first and keep a backup.

-- CreateTable
CREATE TABLE `admin_passkeys` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `admin_id` INTEGER NOT NULL,
    `credential_id_hash` CHAR(64) NOT NULL,
    `credential_id` LONGBLOB NOT NULL,
    `public_key` LONGBLOB NOT NULL,
    `sign_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `transports` JSON NULL,
    `aaguid` VARCHAR(36) NULL,
    `device_type` VARCHAR(16) NULL,
    `backed_up` BOOLEAN NULL,
    `label` VARCHAR(100) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_used_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoked_reason` VARCHAR(64) NULL,
    `revoked_by` INTEGER NULL,

    UNIQUE INDEX `admin_passkeys_credential_id_hash_key`(`credential_id_hash`),
    INDEX `admin_passkeys_admin_id_revoked_at_idx`(`admin_id`, `revoked_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_recovery_approvals` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `request_id` INTEGER NOT NULL,
    `approver_id` INTEGER NOT NULL,
    `approver_role` VARCHAR(16) NOT NULL,
    `decision` VARCHAR(16) NOT NULL,
    `reason` VARCHAR(500) NULL,
    `ip_address` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `admin_recovery_approvals_approver_id_idx`(`approver_id`),
    UNIQUE INDEX `admin_recovery_approvals_request_id_approver_id_key`(`request_id`, `approver_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_webauthn_challenges` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `admin_id` INTEGER NOT NULL,
    `purpose` VARCHAR(32) NOT NULL,
    `challenge` VARCHAR(191) NOT NULL,
    `invitation_id` INTEGER NULL,
    `recovery_request_id` INTEGER NULL,
    `session_id` INTEGER NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `ip_address` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `admin_webauthn_challenges_admin_id_purpose_consumed_at_idx`(`admin_id`, `purpose`, `consumed_at`),
    INDEX `admin_webauthn_challenges_expires_at_idx`(`expires_at`),
    INDEX `admin_webauthn_challenges_invitation_id_idx`(`invitation_id`),
    INDEX `admin_webauthn_challenges_recovery_request_id_idx`(`recovery_request_id`),
    INDEX `admin_webauthn_challenges_session_id_idx`(`session_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `admin_passkeys` ADD CONSTRAINT `admin_passkeys_admin_id_fkey` FOREIGN KEY (`admin_id`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_recovery_approvals` ADD CONSTRAINT `admin_recovery_approvals_request_id_fkey` FOREIGN KEY (`request_id`) REFERENCES `admin_recovery_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_recovery_approvals` ADD CONSTRAINT `admin_recovery_approvals_approver_id_fkey` FOREIGN KEY (`approver_id`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_webauthn_challenges` ADD CONSTRAINT `admin_webauthn_challenges_admin_id_fkey` FOREIGN KEY (`admin_id`) REFERENCES `admin_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_webauthn_challenges` ADD CONSTRAINT `admin_webauthn_challenges_invitation_id_fkey` FOREIGN KEY (`invitation_id`) REFERENCES `admin_invitations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_webauthn_challenges` ADD CONSTRAINT `admin_webauthn_challenges_recovery_request_id_fkey` FOREIGN KEY (`recovery_request_id`) REFERENCES `admin_recovery_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admin_webauthn_challenges` ADD CONSTRAINT `admin_webauthn_challenges_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `admin_sessions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
