-- A Corporate Medical Solutions request stores the company's complete Office Address (up to 2,000 characters) in `origin`. Widens the column from VARCHAR(191) to
-- VARCHAR(2000), non-destructively: every existing value is kept exactly (a wider column holds everything a narrower one did), NOT NULL is kept, and no column is
-- dropped, recreated or renamed. Every other service keeps writing at most 191 characters (its validators are unchanged).
-- `cases.origin` is widened the same way, because every request's Case is created with a copy of the request's origin: without this a long Office Address would make the
-- Case insert fail.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
ALTER TABLE `service_requests` MODIFY `origin` VARCHAR(2000) NOT NULL;
ALTER TABLE `cases` MODIFY `origin` VARCHAR(2000) NOT NULL;
