-- Rolls back 20261118100000_phase2_case_quotations. Run by hand (Prisma has no automatic down migrations).
--
-- DESTRUCTIVE: dropping case_quotations deletes every quotation version, its confirmation / publication / withdrawal record and the
-- patient's acceptance or rejection evidence, for good. Dropping the invoice columns deletes which quotation an invoice was created
-- for and who authorized partial payment. Run it ONLY while these are empty or after they have been exported and the export checked.
-- Check first (every count must be 0):
--   SELECT (SELECT COUNT(*) FROM case_quotations) AS quotations,
--          (SELECT COUNT(*) FROM invoices WHERE source <> 'manual' OR quotation_id IS NOT NULL OR allow_partial_payment <> 0) AS linked_invoices;
-- Never run it once a real quotation has been published or an invoice has been created from one. Existing (legacy) invoices and
-- payments are not touched: only the added columns, constraints and indexes are removed. The uploaded quotation files are not deleted.
-- The audit_logs rows that describe quotations are not deleted either, but would then describe records that no longer exist.
-- Order matters: foreign keys and CHECKs first (MySQL will not drop a column a CHECK or key uses), then the table, then the index
-- on bitrix_deal_links (the table's foreign key used it). The foreign keys' implicit helper indexes are dropped by name.
-- Afterwards remove the migration's row from _prisma_migrations by hand.

ALTER TABLE `invoices` DROP FOREIGN KEY `invoices_quotation_id_case_id_currency_amount_fkey`;
ALTER TABLE `invoices` DROP FOREIGN KEY `invoices_partial_payment_authorized_by_admin_id_fkey`;
ALTER TABLE `invoices` DROP CHECK `invoices_partial_payment_auth_chk`;
ALTER TABLE `invoices` DROP CHECK `invoices_quotation_required_chk`;
ALTER TABLE `invoices` DROP CHECK `invoices_source_chk`;
ALTER TABLE `invoices` DROP INDEX `invoices_quotation_id_case_id_currency_amount_fkey`;
ALTER TABLE `invoices` DROP INDEX `invoices_partial_payment_authorized_by_admin_id_fkey`;
ALTER TABLE `invoices` DROP INDEX `invoices_quotation_id_key`;
ALTER TABLE `invoices`
    DROP COLUMN `partial_payment_authorized_at`,
    DROP COLUMN `partial_payment_authorized_by_admin_id`,
    DROP COLUMN `allow_partial_payment`,
    DROP COLUMN `quotation_id`,
    DROP COLUMN `source`;

DROP TABLE `case_quotations`;

ALTER TABLE `bitrix_deal_links` DROP INDEX `bitrix_deal_links_id_case_id_key`;
