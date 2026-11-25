-- Database normalization for Medical Value Travel and Teleconsultation. Additive only: three nullable columns, so every existing request stays valid (NULL) and
-- nothing is guessed for it; requests made before these columns keep the same facts inside their description, which the apps and the PDF still read.
--   specialty / other_specialty  Medical Value Travel: the approved specialty label, and the typed name when the specialty is "Other".
--   consultation_type            Teleconsultation: "online" | "house_call" (a House Call's Domestic / International scope uses the existing transfer_scope).
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
ALTER TABLE `service_requests`
  ADD COLUMN `specialty` VARCHAR(191) NULL,
  ADD COLUMN `other_specialty` VARCHAR(191) NULL,
  ADD COLUMN `consultation_type` VARCHAR(16) NULL;
