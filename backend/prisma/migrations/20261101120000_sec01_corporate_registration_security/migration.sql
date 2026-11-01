-- SEC-01: secure corporate registration and provisioning.
--
-- Purely additive: every statement adds a nullable or defaulted column, an index, or a
-- new table. No existing row is deleted or rewritten; existing values stay exactly as
-- they are and the new columns read NULL / false for them. The code that is deployed
-- before this migration ignores the new columns, so this can be applied first.
--
-- MySQL DDL is not transactional: if a statement fails part-way, the earlier ones stay
-- applied. Apply it to a copy first and keep a backup.

-- Corporate registrations: the verified mobile (from a Firebase phone sign-in, never the
-- form), which Admin rejected / provisioned a registration, and the review of a contact
-- email that changed after submission.
ALTER TABLE `corporate_registrations`
    ADD COLUMN `mobile_e164` VARCHAR(32) NULL,
    ADD COLUMN `mobile_verified_at` DATETIME(3) NULL,
    ADD COLUMN `rejected_by` INTEGER NULL,
    ADD COLUMN `provisioned_by` INTEGER NULL,
    ADD COLUMN `provisioned_at` DATETIME(3) NULL,
    ADD COLUMN `email_reviewed_by` INTEGER NULL,
    ADD COLUMN `email_reviewed_at` DATETIME(3) NULL;

CREATE INDEX `corporate_registrations_mobile_e164_idx` ON `corporate_registrations`(`mobile_e164`);

-- Single-use ledger of Firebase phone sign-ins consumed by corporate flows. `proof_key`
-- is a hash of the sign-in and is UNIQUE, so using the same sign-in twice fails atomically.
CREATE TABLE `phone_proofs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proof_key` CHAR(64) NOT NULL,
    `purpose` VARCHAR(64) NOT NULL,
    `phone_e164` VARCHAR(32) NOT NULL,
    `registration_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `phone_proofs_proof_key_key`(`proof_key`),
    INDEX `phone_proofs_purpose_created_at_idx`(`purpose`, `created_at`),
    INDEX `phone_proofs_registration_id_idx`(`registration_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Corporate logins: a login whose password someone else chose must change it first.
-- Every existing login starts as false, so nobody is forced to change anything.
ALTER TABLE `corporate_users`
    ADD COLUMN `must_change_password` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `password_changed_at` DATETIME(3) NULL;

-- Security events: who acted when it was not a patient. NULL on every existing row.
ALTER TABLE `security_events`
    ADD COLUMN `actor_type` VARCHAR(16) NULL,
    ADD COLUMN `actor_id` INTEGER NULL;

CREATE INDEX `security_events_actor_type_actor_id_created_at_idx` ON `security_events`(`actor_type`, `actor_id`, `created_at`);

-- Admins: who may review corporate registrations besides superadmins. Everyone starts as
-- false; superadmins are authorised by their role, others only when granted by a script.
ALTER TABLE `admin_users` ADD COLUMN `corporate_review` BOOLEAN NOT NULL DEFAULT false;
