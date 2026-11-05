-- Rollback for 20261105120000_user_first_last_name. Not run by Prisma: run it by hand, then
-- `prisma migrate resolve --rolled-back 20261105120000_user_first_last_name`.
-- Drops the stored first and last names; users.name (the full name) is untouched.
ALTER TABLE `users` DROP COLUMN `first_name`,
    DROP COLUMN `last_name`;
