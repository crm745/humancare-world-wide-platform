-- Rolls back 20261119100000_payments_razorpay_order_id. Run by hand (Prisma has no automatic down migrations).
--
-- DESTRUCTIVE: dropping the column deletes the link between each payment row and its Razorpay order for good. Run it ONLY while no
-- payment has a Razorpay order id, or after those rows have been exported and the export checked. Check first (must be 0):
--   SELECT COUNT(*) FROM payments WHERE razorpay_order_id IS NOT NULL;
-- Manual / legacy payments and refunds are not touched (their column is NULL). Order matters: the CHECKs that use the column first,
-- then its unique index, then the column. Afterwards remove the migration's row from _prisma_migrations by hand.

ALTER TABLE `payments` DROP CHECK `payments_razorpay_completed_ref_chk`;
ALTER TABLE `payments` DROP CHECK `payments_razorpay_order_kind_chk`;
ALTER TABLE `payments` DROP CHECK `payments_razorpay_order_form_chk`;
ALTER TABLE `payments` DROP INDEX `payments_razorpay_order_id_key`;
ALTER TABLE `payments` DROP COLUMN `razorpay_order_id`;
