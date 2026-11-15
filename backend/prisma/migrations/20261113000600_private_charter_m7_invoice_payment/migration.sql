-- Private Charter M7: invoices and payments. Additive only: two new tables with their foreign keys. No
-- existing table, column, row or index is changed. The legacy billing block on `cases` (billing_amount,
-- billing_currency, billing_status, billing_invoiced_at, billing_paid_at, billing_notes), the /admin/billing
-- endpoints that write it, and Corporate billing are untouched and keep their meaning. Nothing is backfilled:
-- no invoice or payment is created from a legacy value. billing_invoiced_at / billing_paid_at are the time an
-- Admin changed a status, NOT an invoice date or a payment transaction, and must never be copied into
-- issue_date or transacted_at. Code deployed before this migration ignores both tables, so it can be applied
-- first. Rolling back is down.sql in this folder (run by hand), with a destructive warning.
--
-- LEGACY BILLING POLICY (approved, for the future application work; NOT done by this migration): PATCH
-- /admin/cases/:id/billing currently updates any Case, Private Charter ones included. The future
-- implementation MUST make it reject updates for Private Charter Cases, while Corporate Cases and every
-- other Case keep working exactly as before. Private Charter billing uses invoices and payments only.
--
-- PRIVATE CHARTER ONLY: Corporate Cases and every other service never use these tables. The database cannot
-- enforce that, so the future service MUST, in the transaction that creates an invoice, load the Case and
-- refuse unless cases.service_request_id is set and that service request's service_key is the Private
-- Charter key (PRIVATE_CHARTER_KEY, 'privatecharter'). Corporate Cases (service_request_id NULL) and Cases of
-- any other service must be refused. No tax, rounding or accounting rule is defined here; none is approved.
--
-- CHECK CONSTRAINTS: this migration uses SQL CHECK constraints. Whether this database product and version
-- enforces them is NOT verified. MySQL parses and ignores CHECK before 8.0.16; the server version string
-- "26.7.0" does not establish compatibility; and MySQL documents a restriction on CHECK constraints for
-- columns used in foreign-key referential actions, whose application to RESTRICT is not verified here (if it
-- applies, creating `payments` could fail, and because MySQL DDL is not transactional that could leave
-- `invoices` created and `payments` missing). Before relying on the CHECK constraints, and before applying
-- this migration to any shared environment, they MUST be verified independently against the actual database
-- product and version, in a separately authorised scratch environment. No scratch schema was created and no
-- database was contacted to write this file. The future service MUST NOT depend on the CHECK constraints: it
-- validates every rule itself. They are not visible to Prisma.
--
-- MONEY (approved): amount is DECIMAL(14,3), exact, in MAJOR currency units (1250.500 for 1,250.50;
-- 1250.000 for a zero-decimal currency; 12.345 for a three-decimal one). Largest value 99,999,999,999.999.
-- Three fractional digits store ISO 4217 currencies with zero, two or three decimal places exactly;
-- currencies with four decimals (for example CLF, UYW) do not fit and must be refused. The database does not
-- know a currency's precision and would round a value with more than three fractional digits, so the future
-- service MUST validate precision BEFORE the database: use maintained ISO 4217 currency metadata for each
-- currency's number of minor-unit digits (0, 2 or 3), refuse an unsupported currency, refuse any amount with
-- more fractional digits than that currency allows, NEVER silently round, keep unused trailing digits zero,
-- and pass amounts as exact decimal strings, never as JavaScript numbers. No approved list of currencies
-- exists and none is defined here. Currency precision validation belongs to the service layer.
--
-- invoices: many per Case. Rows are kept for good and never deleted or overwritten: a mistaken invoice is
-- voided. status is 'draft', 'issued' or 'void'. There is deliberately NO 'paid', 'partially paid' or
-- 'overdue' status: issuing an invoice and receiving money are separate events, and the paid amount is
-- computed from the payments (completed payments minus completed refunds) at read time, never stored and
-- never inferred from a timestamp. issue_date and due_date are the ACTUAL dates on the invoice, supplied by
-- whoever issues it, never filled from the time a status was changed.
--   * VOID POLICY (approved): a 'draft' invoice may be voided with a MANDATORY reason. An 'issued' invoice may
--     be voided only when it has NO completed payment AND NO unresolved pending payment, and again with a
--     mandatory reason (CHECK: a void invoice has voided_at and a non-blank void_reason; a non-void invoice
--     has neither). An invoice with ANY completed payment can NEVER be voided, even if fully refunded: money
--     is returned by separate refund records. Pending payments must first be cancelled or otherwise resolved
--     before the invoice can be voided. A payment must never be completed against an already voided invoice.
--     If an external payment is confirmed AFTER its record was cancelled, the actual transaction evidence
--     must be preserved and flagged for financial reconciliation: evidence of money received is never
--     discarded. The database cannot see other rows, so the service MUST enforce the void rule in one
--     transaction that locks the invoice row (SELECT ... FOR UPDATE), checks that no completed and no
--     unresolved pending payment exists, and sets the status. Voiding and payment completion MUST use the
--     same invoice-row locking discipline: every payment write locks the same invoice row first and refuses
--     an invoice that is not 'issued', so a void and a payment completion cannot interleave.
--   * invoice_number is the reference printed on the invoice, supplied by Finance exactly as issued;
--     HumanCare never generates or invents one. Optional; unique when present (NULLs never conflict).
--     It, and idempotency_key, are compared case-sensitively (utf8mb4_bin). utf8mb4_bin ignores trailing
--     spaces, so the writing code MUST reject (never silently trim or transform) a value with leading or
--     trailing whitespace.
--   * currency is an ISO 4217 code, three uppercase letters, case-sensitive (utf8mb4_bin); the CHECK covers
--     only its form, not whether the code exists. amount must be greater than zero (CHECK).
--   * (id, case_id, currency) is unique so payments can reference it as a composite foreign key (below).
--   * idempotency_key is unique per Case; NULLs never conflict, so the service should always supply one.
--
-- payments: one money movement against an invoice, either a payment received or a refund. A refund is a
-- separate row of its own pointing at the payment it reverses; the original payment is never edited,
-- overwritten or removed to show it. Partial payments are several rows. Rows are kept for good and never
-- deleted: a mistaken one is marked 'cancelled' or 'failed'. audit_logs (entity_type 'invoice' / 'payment')
-- records who did what, written in the same transaction; these tables keep no actor columns.
--   * Ownership: (invoice_id, case_id, currency) is a composite foreign key to invoices (id, case_id,
--     currency), so the database refuses a payment attached to an invoice of another Case or in another
--     currency. It is RESTRICT on delete and on update, so an invoice's Case or currency cannot be changed
--     under existing payments (an ON UPDATE CASCADE here would silently rewrite payment currencies).
--   * REFUNDS (approved): kind is 'payment' or 'refund'. A refund MUST reference an ORIGINAL payment, never
--     another refund. A foreign key alone does not guarantee that, because it can point at any row, so
--     refund_of_kind is added: for a refund it is always 'payment' (CHECK, written with the NULL-safe <=>
--     because a plain = would evaluate to NULL, which a CHECK accepts, and the foreign key skips rows with a
--     NULL column), and the composite foreign key
--     (refund_of_payment_id, invoice_id, refund_of_kind) references payments (id, invoice_id, kind), so the
--     database refuses a refund whose target is not a 'payment'-kind row of the SAME invoice. A payment has
--     neither refund_of_payment_id nor refund_of_kind (CHECK). The service sets refund_of_kind to 'payment'
--     when it creates a refund. Several refunds against one original payment are allowed.
--   * amount is always positive (CHECK); the direction comes from kind, so no negative amounts are stored.
--   * The database cannot enforce sums or states. The service MUST, in ONE transaction: lock the invoice row
--     and then the original payment row (SELECT ... FOR UPDATE, in that order, to avoid deadlocks); refuse a
--     refund unless the original payment is 'completed'; sum the completed refunds already recorded against
--     it; and refuse the refund if the cumulative completed refunds, including this one, would exceed the
--     original payment's amount. It also refuses a completed payment total above the invoice amount unless an
--     overpayment rule is approved (none is defined). A refund never changes the invoice's status. The
--     service must not infer an invoice's state from payment timestamps.
--   * status is 'pending', 'completed', 'failed' or 'cancelled'; only 'completed' rows count as money
--     received or returned. A 'completed' row MUST have transacted_at (CHECK). transacted_at is the ACTUAL
--     time of the transaction reported by the bank or gateway, not the time HumanCare recorded it.
--   * external_reference is the reference at the bank, gateway or other source, preserved exactly as given
--     (case-sensitive), never generated, normalised or trimmed; the service MUST reject leading or trailing
--     whitespace. It is unique per (invoice_id, kind), so recording the same transfer twice on one invoice is
--     refused. It is deliberately NOT unique across invoices, because one real transfer may be split across
--     several invoices. NULL never conflicts. method is free text; no list is approved yet.
--   * idempotency_key makes a retried create a no-op, unique per invoice (the service should always supply
--     one).
-- All foreign keys are RESTRICT.

-- CreateTable
CREATE TABLE `invoices` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `case_id` INTEGER NOT NULL,
    `invoice_number` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `amount` DECIMAL(14, 3) NOT NULL,
    `currency` VARCHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'draft',
    `issue_date` DATE NULL,
    `due_date` DATE NULL,
    `voided_at` DATETIME(3) NULL,
    `void_reason` TEXT NULL,
    `idempotency_key` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `invoices_invoice_number_key`(`invoice_number`),
    UNIQUE INDEX `invoices_id_case_id_currency_key`(`id`, `case_id`, `currency`),
    UNIQUE INDEX `invoices_case_id_idempotency_key_key`(`case_id`, `idempotency_key`),
    INDEX `invoices_case_id_status_idx`(`case_id`, `status`),
    PRIMARY KEY (`id`),
    CONSTRAINT `invoices_amount_positive_chk` CHECK (`amount` > 0),
    CONSTRAINT `invoices_currency_form_chk` CHECK (`currency` REGEXP '^[A-Z]{3}$'),
    CONSTRAINT `invoices_issued_has_issue_date_chk` CHECK (`status` <> 'issued' OR `issue_date` IS NOT NULL),
    CONSTRAINT `invoices_void_consistent_chk` CHECK ((`status` = 'void' AND `voided_at` IS NOT NULL AND `void_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`void_reason`)) > 0) OR (`status` <> 'void' AND `voided_at` IS NULL AND `void_reason` IS NULL))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `invoice_id` INTEGER NOT NULL,
    `case_id` INTEGER NOT NULL,
    `currency` VARCHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `kind` VARCHAR(16) NOT NULL DEFAULT 'payment',
    `refund_of_payment_id` INTEGER NULL,
    `refund_of_kind` VARCHAR(16) NULL,
    `amount` DECIMAL(14, 3) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `method` VARCHAR(32) NULL,
    `external_reference` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `transacted_at` DATETIME(3) NULL,
    `idempotency_key` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payments_id_invoice_id_kind_key`(`id`, `invoice_id`, `kind`),
    UNIQUE INDEX `payments_invoice_id_kind_external_reference_key`(`invoice_id`, `kind`, `external_reference`),
    UNIQUE INDEX `payments_invoice_id_idempotency_key_key`(`invoice_id`, `idempotency_key`),
    INDEX `payments_invoice_id_case_id_currency_idx`(`invoice_id`, `case_id`, `currency`),
    INDEX `payments_refund_of_payment_id_invoice_id_refund_of_kind_idx`(`refund_of_payment_id`, `invoice_id`, `refund_of_kind`),
    INDEX `payments_invoice_id_status_idx`(`invoice_id`, `status`),
    INDEX `payments_case_id_idx`(`case_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `payments_amount_positive_chk` CHECK (`amount` > 0),
    CONSTRAINT `payments_currency_form_chk` CHECK (`currency` REGEXP '^[A-Z]{3}$'),
    CONSTRAINT `payments_kind_refund_link_chk` CHECK ((`kind` = 'payment' AND `refund_of_payment_id` IS NULL AND `refund_of_kind` IS NULL) OR (`kind` = 'refund' AND `refund_of_payment_id` IS NOT NULL AND `refund_of_kind` <=> 'payment')),
    CONSTRAINT `payments_completed_has_transacted_at_chk` CHECK (`status` <> 'completed' OR `transacted_at` IS NOT NULL)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_invoice_id_case_id_currency_fkey` FOREIGN KEY (`invoice_id`, `case_id`, `currency`) REFERENCES `invoices`(`id`, `case_id`, `currency`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_refund_of_payment_id_invoice_id_refund_of_kind_fkey` FOREIGN KEY (`refund_of_payment_id`, `invoice_id`, `refund_of_kind`) REFERENCES `payments`(`id`, `invoice_id`, `kind`) ON DELETE RESTRICT ON UPDATE RESTRICT;
