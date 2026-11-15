-- Rolls back 20261113000600_private_charter_m7_invoice_payment. Run by hand (Prisma has no automatic down
-- migrations).
--
-- DESTRUCTIVE: this deletes every invoice and payment row, including refunds, for good. These are financial
-- records, and financial history is never meant to be deleted or overwritten. Run it ONLY while both tables
-- are empty, or after their rows have been exported and the export checked. Never run it once any real
-- invoice or payment has been recorded. The legacy billing columns on cases (billing_amount,
-- billing_currency, billing_status, billing_invoiced_at, billing_paid_at, billing_notes) are not touched, so
-- legacy billing data and the Corporate billing workflow are not affected either way. The audit_logs rows
-- that describe invoices and payments are not deleted either, but would then describe records that no longer
-- exist.
--   SELECT (SELECT COUNT(*) FROM invoices) AS invoices, (SELECT COUNT(*) FROM payments) AS payments;
-- payments is dropped first because it references invoices (and itself, for refunds). No other table is
-- dropped or altered. Of the two tables dropped here, only invoices references cases (through case_id); the
-- cases table itself is referenced by other tables and is not changed.
-- Afterwards remove the migration's row from _prisma_migrations by hand.
DROP TABLE `payments`;
DROP TABLE `invoices`;
