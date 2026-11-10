-- Create Account form: gender, nationality (ISO alpha-2) and the country picked for the phone's
-- calling code. Additive only: every column is nullable, so existing accounts keep working and
-- nothing is guessed for them. Rolling back is down.sql in this folder (run by hand; Prisma has
-- no automatic down migrations).
ALTER TABLE `users` ADD COLUMN `gender` VARCHAR(20) NULL,
    ADD COLUMN `nationality` VARCHAR(2) NULL,
    ADD COLUMN `phone_country` VARCHAR(2) NULL;
