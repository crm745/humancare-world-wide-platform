-- Rollback for 20261106110000_preferred_date_to_date. Not run by Prisma: run it by hand.
-- Puts the column back as DATETIME(3): every value becomes its day at 00:00:00.000, which is
-- exactly what the application wrote before the conversion. (Any time of day the UPDATE in the
-- migration cut off is not restored; the application never wrote one.)
-- Prisma refuses `migrate resolve --rolled-back` for a migration that applied successfully (P3012),
-- so afterwards delete that migration's row from _prisma_migrations by hand, or leave the history
-- as it is and roll forward with a new migration.
ALTER TABLE `service_requests` MODIFY `preferred_date` DATETIME(3) NULL;
