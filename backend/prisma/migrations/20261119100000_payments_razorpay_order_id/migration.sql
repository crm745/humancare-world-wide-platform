-- Razorpay (Phase 2): the Razorpay order a payment row belongs to. ADDITIVE ONLY: one nullable column, its unique index and three CHECKs
-- on `payments`. No existing column, row, index or foreign key is changed. Nothing is backfilled: every existing (manual / legacy)
-- payment keeps razorpay_order_id NULL, so each new CHECK passes by its first branch and the unique index ignores them (MySQL allows
-- many NULLs). Refunds never carry an order id. Code deployed before this migration ignores the column.
-- Must run AFTER 20261118100000_phase2_case_quotations. NOT applied by the change that created it: run it by hand against
-- humancare_test only (node scripts/test-db.js migrate), after review. Rolling back is down.sql in this folder (run by hand).
--
-- One Razorpay order = one payment row (unique). Razorpay lets a customer retry inside one order with a new payment id, so the
-- service must keep an order-linked row pending on payment.failed and complete it on payment.captured (see the service rules); the
-- database cannot express that. The order id is set once when the order is created and never changed (service rule).
-- razorpay_order_id is case-sensitive (utf8mb4_bin; Prisma cannot express a collation) and must be stored exactly as Razorpay returned
-- it: the service MUST reject (never trim or transform) a value with leading or trailing whitespace, because utf8mb4_bin ignores
-- trailing spaces when comparing (the REGEXP below also refuses it).
-- The CHECKs use `kind`, `status` and `external_reference`; `kind` is already used in M7's RESTRICT foreign key and M7 CHECKs. They
-- were verified on prefixed scratch copies of these exact statements before this file was approved; the service still validates every rule.

ALTER TABLE `payments`
    ADD COLUMN `razorpay_order_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD UNIQUE INDEX `payments_razorpay_order_id_key` (`razorpay_order_id`);

-- the form of an order id
ALTER TABLE `payments`
    ADD CONSTRAINT `payments_razorpay_order_form_chk`
    CHECK (
        `razorpay_order_id` IS NULL
        OR `razorpay_order_id` REGEXP '^order_[A-Za-z0-9]+$'
    );

-- only a payment can belong to an order; a refund never does
ALTER TABLE `payments`
    ADD CONSTRAINT `payments_razorpay_order_kind_chk`
    CHECK (
        `razorpay_order_id` IS NULL OR `kind` = 'payment'
    );

-- a completed Razorpay payment must record the gateway payment id
ALTER TABLE `payments`
    ADD CONSTRAINT `payments_razorpay_completed_ref_chk`
    CHECK (
        `razorpay_order_id` IS NULL
        OR `status` <> 'completed'
        OR `external_reference` IS NOT NULL
    );
