-- Rolls back 20261113000200_private_charter_m3_audit_log. Run by hand (Prisma has no automatic down
-- migrations), and ONLY while audit_logs is empty, or after its rows have been exported: dropping the
-- table deletes the audit history for good.
--   SELECT COUNT(*) FROM audit_logs;
-- No other table is affected (cases is only referenced by the table being dropped).
-- Afterwards remove the migration's row from _prisma_migrations by hand.
DROP TABLE `audit_logs`;
