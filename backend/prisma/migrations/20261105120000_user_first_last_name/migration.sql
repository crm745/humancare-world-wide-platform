-- Create Account form: first name and last name as two fields. Additive only: both columns are
-- nullable, so existing accounts keep working and nothing is guessed for them. users.name stays
-- the full name everything else reads. Rolling back is down.sql in this folder (run by hand;
-- Prisma has no automatic down migrations).
ALTER TABLE `users` ADD COLUMN `first_name` VARCHAR(50) NULL,
    ADD COLUMN `last_name` VARCHAR(50) NULL;
