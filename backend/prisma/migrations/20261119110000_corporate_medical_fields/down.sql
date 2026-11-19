-- Rollback for 20261119110000_corporate_medical_fields. Not run by Prisma: run it by hand, then remove the row for this migration from `_prisma_migrations`
-- (or use `prisma migrate resolve --rolled-back 20261119110000_corporate_medical_fields`).
-- WARNING: requests made after the migration keep their company name, employee count and programmes ONLY in these columns, so dropping them loses those answers
-- for good. Deploy the code that no longer reads the columns BEFORE running this, and back the columns up first if the rows matter.
ALTER TABLE `service_requests`
  DROP COLUMN `company_name`,
  DROP COLUMN `employee_count`,
  DROP COLUMN `selected_programmes`;
