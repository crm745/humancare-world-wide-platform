-- Rollback for 20261118100000_user_deleted_at. Not run by Prisma: run it by hand, then remove the row for this migration from `_prisma_migrations`
-- (or use `prisma migrate resolve --rolled-back 20261118100000_user_deleted_at`).
-- Drops only the retirement timestamp. An account that was already retired stays anonymised (its name, email and sign-in details are gone for good),
-- but without this column nothing marks it as retired, so deploy the code that no longer reads the column BEFORE running this.
ALTER TABLE `users` DROP COLUMN `deleted_at`;
