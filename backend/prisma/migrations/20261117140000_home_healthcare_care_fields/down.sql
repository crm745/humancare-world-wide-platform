-- Rollback for 20261117140000_home_healthcare_care_fields. Not run by Prisma: run it by hand, then remove the row for this migration from
-- `_prisma_migrations` (or use `prisma migrate resolve --rolled-back 20261117140000_home_healthcare_care_fields`).
-- Drops the stored Nurse / Caretaker and Care Requirement answers of every request; nothing else is affected.
-- Deploy the backend code that no longer reads the columns BEFORE running this, or Home Healthcare requests will fail.
ALTER TABLE `service_requests`
  DROP COLUMN `care_requirement`,
  DROP COLUMN `caretaker_types`;
