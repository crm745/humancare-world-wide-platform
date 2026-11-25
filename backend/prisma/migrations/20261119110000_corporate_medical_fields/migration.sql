-- Corporate Medical Solutions, employee-submitted (patient-side) requests. Additive only: three nullable columns, so every existing request stays valid (NULL)
-- and nothing is guessed for it; requests made before these columns keep their free-text description and are shown the way they always were.
--   company_name         the company the request is for (Company Name).
--   employee_count       how many employees it covers (No. of Employees), a whole number.
--   selected_programmes  the programmes chosen, a JSON array of keys (for example ["doctor","nurse"]).
-- The employee's name and gender reuse patient_name and patient_gender. Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
ALTER TABLE `service_requests`
  ADD COLUMN `company_name` VARCHAR(191) NULL,
  ADD COLUMN `employee_count` INTEGER NULL,
  ADD COLUMN `selected_programmes` JSON NULL;
