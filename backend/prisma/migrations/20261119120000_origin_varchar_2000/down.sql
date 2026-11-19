-- Rollback for 20261119120000_origin_varchar_2000. Not run by Prisma: run it by hand, then remove the row for this migration from `_prisma_migrations`
-- (or use `prisma migrate resolve --rolled-back 20261119120000_origin_varchar_2000`).
-- WARNING: narrowing FAILS (MySQL strict mode) or CUTS the value (otherwise) for any origin longer than 191 characters, which a Corporate Medical Solutions Office Address can
-- be. Check first:  SELECT id, reference_number, CHAR_LENGTH(origin) FROM service_requests WHERE CHAR_LENGTH(origin) > 191;  (and the same on cases)
-- Deploy the code that no longer accepts a long Office Address BEFORE running this.
ALTER TABLE `cases` MODIFY `origin` VARCHAR(191) NOT NULL;
ALTER TABLE `service_requests` MODIFY `origin` VARCHAR(191) NOT NULL;
