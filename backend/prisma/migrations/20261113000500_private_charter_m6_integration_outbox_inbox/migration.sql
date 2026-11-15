-- Private Charter M6: durable integration outbox and inbox. Additive only: two new tables, one foreign key
-- (integration_outbox.case_id -> cases). No existing table, column, row or index is changed. The existing
-- Bitrix Lead integration (service_requests / cases bitrix_lead_id and retry columns, and its retry sweep)
-- is untouched, Corporate workflows are untouched, nothing is backfilled, no Lead is converted into a Deal,
-- and no Bitrix call is made. Code deployed before this migration ignores both tables, so it can be applied
-- first. Rolling back is down.sql in this folder (run by hand), with a destructive warning.
--
-- PRIVATE CHARTER ONLY: only the Private Charter Deal workflow uses these tables. The database cannot
-- enforce that, so the future service decides which events it writes.
--
-- integration_outbox: the durable record of an outbound event, written in the same transaction as the
-- business change that causes it. status is 'pending', 'processing', 'completed', 'failed' or 'ambiguous'.
--   * 'ambiguous': the external call was started and its outcome is UNKNOWN (timeout, lost response, or a
--     worker that died or lost its lease mid-call). Such an event must never simply be sent again; it goes
--     through reconciliation rules R1-R5 below.
--   * 'failed': a DEFINITIVE outcome, for example a clear error response proving that no Deal was created,
--     or retries used up. It is terminal for automatic processing: nothing retries, resolves or re-sends it
--     automatically, and it needs an explicit HUMAN decision before any retry or resolution. Like any other
--     result it may be written only by a worker whose lease is still valid.
--   * A non-completed event that has external_call_started_at set is NOT automatically 'ambiguous'; see
--     Expiry and recovery below.
--   * idempotency_key is unique and names the event itself, so the same event cannot be written twice. The
--     key is PERMANENT for its event: it is never reused or overwritten. A deliberate new Deal-creation
--     attempt requires an explicit, separately authorised recovery decision and a NEW event with a new key
--     (a new event identity); the original event and its history stay as they were. The key is stored
--     exactly as given and compared case-sensitively (utf8mb4_bin). utf8mb4_bin ignores trailing spaces,
--     so the writing code MUST reject (never silently trim or transform) an idempotency_key or entity_id
--     with leading or trailing whitespace.
--   * Claiming and fencing: a worker takes an event with a compare-and-swap UPDATE (status, attempts and
--     the lock columns in the WHERE clause, rows affected checked), setting locked_by, locked_until (the
--     lease end) and attempts = attempts + 1.
--     A lease is the worker's authority to write. When locked_until passes, that authority ENDS
--     immediately, whether or not anyone has re-claimed the event. Every result update (completed, failed,
--     ambiguous, or a reschedule) MUST be ONE UPDATE whose WHERE verifies ALL of: the event id; status =
--     'processing'; attempts equal to the value this worker claimed; locked_by equal to this worker; and
--     locked_until still in the future. The rows written are checked. An expired worker therefore writes
--     0 rows: it can NEVER record a success or a failure, even if nobody has re-claimed the event, and a
--     stale worker can never overwrite a newer result.
--     CLOCK: the lease is set and checked with the SAME database-side UTC clock expression, for example
--     locked_until = UTC_TIMESTAMP(3) + INTERVAL <lease> SECOND when claiming, and locked_until >
--     UTC_TIMESTAMP(3) in the result update. Application-generated timestamps (what the Prisma client
--     writes) must NOT be mixed with MySQL's session-local NOW(3) for lease fencing: if the server's time
--     zone is not UTC the two differ by the zone offset. The same applies to next_attempt_at: set it
--     explicitly with the same UTC expression and do not rely on its column default (CURRENT_TIMESTAMP(3)
--     is session-local). Ordinary Prisma client update methods use the application's clock, so the claim
--     and the lease-fenced result update need an appropriate database-side SQL operation (for example
--     $executeRaw); a Prisma client update is NOT sufficient unless it preserves this same-clock
--     guarantee. This has not been tested here.
--     LIMIT: database fencing CANNOT cancel an external Bitrix call that is already in progress. An
--     expired or stale worker can still finish its HTTP call, and Bitrix may create the Deal, while the
--     database refuses to record that worker's result; two external calls for one event can overlap. The
--     lease must be longer than the client's request timeout with a generous margin, the worker must
--     re-check its claim just before a call, and the effect of such a call is found by reconciliation,
--     never assumed absent.
--   * Expiry and recovery: the recovery sweep MUST tell these cases apart, and may move an event only with
--     the same fenced compare-and-swap, never by the expired worker:
--       (a) 'processing', lease EXPIRED, external_call_started_at NULL: no external call was started, so
--           the event may safely return to 'pending'.
--       (b) 'processing', lease EXPIRED, external_call_started_at SET: the outcome of the call is
--           unknown, so the event MUST become 'ambiguous' and goes through reconciliation rules R1-R5.
--       (c) 'failed': a definitive outcome was already recorded. The sweep leaves it alone, whether or
--           not external_call_started_at is set; it waits for a human decision.
--     external_call_started_at is set and committed BEFORE the external call, only by the current
--     claimant (with the same lease check), and is kept as historical evidence that a call was attempted.
--     It is never cleared, and it does not by itself make an event 'ambiguous': only (b) does. A
--     definitive response that proves no Deal was created may be recorded as 'failed' by a worker whose
--     lease is still valid. If its lease has already expired the write is refused and the event is
--     handled by (b), which is the safe outcome.
--   * Ordering: events of one entity (entity_type + entity_id) are applied strictly in creation order
--     (id). A later event MUST NOT be claimed while any earlier event of the same entity is 'pending',
--     'processing' or 'ambiguous', nor 'failed' (which stays blocking until a person decides). The
--     database does not enforce this: the claim must be ONE atomic step that checks for an earlier
--     non-final event and takes the claim (for example a transaction with a locking read of the entity's
--     rows; MySQL does not allow an UPDATE to subquery its own table directly). Not tested here.
--   * Exactly-once delivery is NOT claimed: this is at-least-once delivery with ambiguity-aware recovery.
--     Reconciliation rules R1-R5 for an ambiguous Deal create (the Bitrix API code of the "Primary Deal
--     Reference" custom field is NOT verified or invented here; the create call must write the stable
--     Private Charter reference into it):
--       R1. Reconcile first: search Bitrix for a Deal with that reference. If a matching Deal is found,
--           adopt its exact Deal ID (stored as text, untouched) and complete the event; the Deal ID, the
--           'completed' status and the bitrix_deal_links update are saved in one database transaction.
--       R2. If the lookup fails, times out, or its result is uncertain in any way, the event stays
--           'ambiguous'.
--       R3. One empty search result is NOT proof that no Deal exists (the search may lag behind a
--           creation, or the field may have been edited in Bitrix). Reconciliation must be repeated, over
--           a conservative waiting period (its length is a business decision, not set here), before
--           another create is even considered.
--       R4. If any uncertainty remains after that, the event is left for MANUAL REVIEW. HumanCare MUST
--           NEVER automatically create another Deal while the previous outcome is uncertain.
--       R5. A duplicate Deal found later (two Deals with one reference) is reported and alerted, and MUST
--           NEVER be deleted automatically; a person decides.
--     Other limits: whether Bitrix can filter on the reference field, and the fact that Bitrix does not
--     enforce its uniqueness, are not verified; a periodic duplicate-reference check is required.
--   * payload holds only allowlisted fields (stable ids and the few values the target needs): never medical
--     content, reports, document contents, passwords, tokens, webhook URLs or other secrets, and no
--     unnecessary patient detail. last_error must never hold a webhook URL, token or other secret.
--
-- integration_inbox: the durable record of an inbound event (for example a Bitrix webhook), stored before it
-- is processed. status is 'received', 'processing', 'processed', 'failed' or 'ignored'; 'processed' and
-- 'ignored' are final and never claimed again, so an event is never applied twice.
--   * (source, external_event_id) is unique, so a repeated delivery is recorded once. It is NOT assumed that
--     Bitrix supplies a unique delivery id. Before the handler is built, the implementation MUST verify
--     whether one exists, from Bitrix's documentation for the exact event type and a real sample delivery
--     from a NON-production Bitrix account (recording only the shape of the payload, never tokens or
--     secrets), and write the finding down. If a reliable delivery id exists, external_event_id is that id.
--     If not, it is built deterministically from the source, the event name, the external entity id and the
--     event's own timestamp, and these limits apply: two genuinely different updates of the same entity with
--     the same event name and the same timestamp (the timestamp's precision is not verified) produce the SAME
--     key, and the second would be suppressed as a "duplicate"; and a repeated delivery whose timestamp
--     differs is NOT recognised as a duplicate. Deduplication is not what keeps the data correct: the payload
--     is only a hint, and the worker always reads the entity's current state from Bitrix and applies it by
--     comparing modified times, so processing an event twice is harmless and a suppressed event loses nothing
--     as long as the state is read again. A periodic reconciliation sweep that re-reads the current state of
--     every open Deal is REQUIRED as a safety net, and the key must use the finest timestamp precision
--     Bitrix provides. The table keeps no count of suppressed duplicates; adding one is a possible future
--     change, not made here.
--   * external_event_id and entity_id are opaque identifiers, stored exactly as given or built and compared
--     case-sensitively (utf8mb4_bin). utf8mb4_bin ignores trailing spaces when comparing, so the writing
--     code MUST reject (never silently trim or normalise) an external_event_id or an entity_id with leading
--     or trailing whitespace.
--   * Claiming and fencing work as for integration_outbox, including its CLOCK rule: locked_until and
--     next_attempt_at are set and checked with the same database-side UTC expression (for example
--     UTC_TIMESTAMP(3)), never with application-generated timestamps mixed with MySQL's session-local
--     NOW(3), which needs database-side SQL rather than ordinary Prisma client updates. A result is written
--     only by a worker whose lease is still valid (id, status, claimed attempts, locked_by and locked_until
--     in the future, all checked in one UPDATE), so an expired or stale worker writes nothing. Because each
--     event is applied by reading Bitrix's current state, strict ordering between inbox events of one
--     entity is not needed for correctness, and repeating a read is harmless.
--   * The handler authenticates the delivery first and never stores its authentication block or token,
--     nor any webhook URL, secret, medical content or unnecessary patient detail. To apply an event the
--     worker reads the current state from Bitrix and applies it only if Bitrix's modified time is newer
--     than bitrix_deal_links.external_modified_at, so a late or out-of-order event cannot move a Case
--     backwards.
-- Both tables are kept for good; nothing purges them. The Case foreign key is RESTRICT.

-- CreateTable
CREATE TABLE `integration_outbox` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `event_type` VARCHAR(64) NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `case_id` INTEGER NULL,
    `idempotency_key` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `payload` JSON NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `locked_by` VARCHAR(64) NULL,
    `locked_until` DATETIME(3) NULL,
    `external_call_started_at` DATETIME(3) NULL,
    `last_error` TEXT NULL,
    `correlation_id` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `completed_at` DATETIME(3) NULL,

    UNIQUE INDEX `integration_outbox_idempotency_key_key`(`idempotency_key`),
    INDEX `integration_outbox_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    INDEX `integration_outbox_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    INDEX `integration_outbox_case_id_idx`(`case_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_inbox` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `source` VARCHAR(32) NOT NULL,
    `external_event_id` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `event_type` VARCHAR(64) NOT NULL,
    `entity_type` VARCHAR(40) NULL,
    `entity_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `external_occurred_at` DATETIME(3) NULL,
    `payload` JSON NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'received',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `locked_by` VARCHAR(64) NULL,
    `locked_until` DATETIME(3) NULL,
    `last_error` TEXT NULL,
    `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed_at` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `integration_inbox_source_external_event_id_key`(`source`, `external_event_id`),
    INDEX `integration_inbox_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    INDEX `inbox_entity_modified_idx`(`entity_type`, `entity_id`, `external_occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `integration_outbox` ADD CONSTRAINT `integration_outbox_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
