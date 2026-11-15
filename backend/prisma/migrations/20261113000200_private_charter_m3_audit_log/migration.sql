-- Private Charter M3: append-only business audit log. Additive only: one new table with one foreign key
-- to cases. No existing table, column, row or index is changed. Code deployed before this migration
-- ignores the table, so it can be applied first.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations), and is
-- only safe while audit_logs is empty or its rows have been exported: it deletes the audit history.
--
-- audit_logs is separate from security_events (a retention-purged security log). Nothing purges it.
-- The foreign key is RESTRICT, so a Case that has audit history cannot be deleted; case_id is nullable
-- for events that belong to no Case. The unique key lets a retried write of the same event be refused;
-- MySQL allows any number of rows with a NULL idempotency_key.
--
-- Collation: the table default stays utf8mb4_unicode_ci (case-insensitive, like the rest of the schema),
-- but entity_id and idempotency_key are opaque identifiers (a Bitrix Deal ID, an invoice number, a client
-- key) and are compared case-sensitively with utf8mb4_bin, so "AbC" and "abc" are different values, also
-- inside the unique key. Values are stored exactly as given. Note that utf8mb4_bin is a PAD SPACE
-- collation: values that differ only by trailing spaces compare equal, so the writing code MUST reject
-- (never silently trim or transform) entity_id and idempotency_key values with leading or trailing
-- whitespace. entity_type stays case-insensitive: it is a fixed
-- lowercase vocabulary, not an opaque identifier.
--
-- Sensitive data: before_data / after_data hold only allowlisted audit fields; never medical content,
-- document contents, passwords, tokens or webhook URLs. Enforced by the future audit-writing service.

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `case_id` INTEGER NULL,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `action` VARCHAR(64) NOT NULL,
    `actor_type` VARCHAR(16) NOT NULL,
    `actor_id` VARCHAR(64) NULL,
    `actor_role` VARCHAR(32) NULL,
    `source` VARCHAR(32) NOT NULL,
    `is_override` BOOLEAN NOT NULL DEFAULT false,
    `reason_code` VARCHAR(64) NULL,
    `reason_text` TEXT NULL,
    `before_data` JSON NULL,
    `after_data` JSON NULL,
    `correlation_id` VARCHAR(64) NULL,
    `idempotency_key` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `occurred_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `recorded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `audit_logs_entity_type_entity_id_idempotency_key_key`(`entity_type`, `entity_id`, `idempotency_key`),
    INDEX `audit_logs_case_id_occurred_at_idx`(`case_id`, `occurred_at`),
    INDEX `audit_logs_entity_type_entity_id_occurred_at_idx`(`entity_type`, `entity_id`, `occurred_at`),
    INDEX `audit_logs_actor_type_actor_id_occurred_at_idx`(`actor_type`, `actor_id`, `occurred_at`),
    INDEX `audit_logs_action_occurred_at_idx`(`action`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
