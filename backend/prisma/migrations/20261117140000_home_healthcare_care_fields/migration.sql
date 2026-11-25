-- Home Healthcare: the two answers that have no column yet (Nurse / Caretaker, and the 12 or 24 hour Care Requirement). Additive only: two nullable
-- columns, so every existing request keeps working and nothing is guessed for it. Only Home Healthcare requests fill them; every other service (and
-- every older Home Healthcare request) leaves them NULL. Oxygen, Oxygen LPM, Care Level and the Service Date reuse equip_oxygen, equip_oxygen_lpm,
-- care_level and preferred_date. Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
ALTER TABLE `service_requests`
  ADD COLUMN `care_requirement` VARCHAR(16) NULL,
  ADD COLUMN `caretaker_types` VARCHAR(255) NULL;
