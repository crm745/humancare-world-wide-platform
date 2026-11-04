-- Rollback for 20261104100000_signup_nationality_gender. Not run by Prisma: run it by hand, then
-- `prisma migrate resolve --rolled-back 20261104100000_signup_nationality_gender`.
-- Drops the stored gender, nationality and phone country of every account.
ALTER TABLE `users` DROP COLUMN `gender`,
    DROP COLUMN `nationality`,
    DROP COLUMN `phone_country`;
