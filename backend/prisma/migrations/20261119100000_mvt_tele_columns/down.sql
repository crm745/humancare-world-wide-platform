-- Rollback for 20261119100000_mvt_tele_columns. Not run by Prisma: run it by hand, then remove the row for this migration from `_prisma_migrations`
-- (or use `prisma migrate resolve --rolled-back 20261119100000_mvt_tele_columns`).
-- WARNING: requests made after the migration keep their specialty, other specialty and consultation type ONLY in these columns (not in the description), so dropping
-- them loses those answers for good. Deploy the code that no longer reads the columns BEFORE running this, and back the columns up first if the rows matter.
ALTER TABLE `service_requests`
  DROP COLUMN `specialty`,
  DROP COLUMN `other_specialty`,
  DROP COLUMN `consultation_type`;
