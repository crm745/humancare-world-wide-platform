-- Rollback for 20261119130000_service_request_client_request_id. Not run by Prisma: run it by hand, then remove the row for this migration from `_prisma_migrations`
-- (or use `prisma migrate resolve --rolled-back 20261119130000_service_request_client_request_id`).
-- Deploy the code that no longer reads or writes client_request_id BEFORE running this. Dropping the column discards the keys (they only protect against duplicates
-- while a submission is being retried; no request data is lost).
ALTER TABLE `service_requests`
  DROP INDEX `uq_service_requests_user_client_request`,
  DROP COLUMN `client_request_id`;
