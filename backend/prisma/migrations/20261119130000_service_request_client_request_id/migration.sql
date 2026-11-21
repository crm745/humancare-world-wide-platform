-- Idempotent request submission. The mobile app sends one random UUID (`clientRequestId`) per logical submission and reuses it for every retry; the server saves a
-- request at most once per (user, key), however many times, and however concurrently, that submission arrives.
--
-- Additive and non-destructive: one NEW nullable column and one NEW unique index on `service_requests`. No existing column or row is changed, dropped, rewritten or
-- locked for long: adding a nullable column is a metadata change in MySQL 8, and every existing row simply has NULL. MySQL's unique index treats NULLs as distinct, so any
-- number of requests without a key (every request already saved, and every request from an older app build) coexist. The index is on (user_id, client_request_id), so the key
-- is scoped to the patient: two patients using the same key never collide.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
ALTER TABLE `service_requests`
  ADD COLUMN `client_request_id` VARCHAR(36) NULL,
  ADD UNIQUE INDEX `uq_service_requests_user_client_request` (`user_id`, `client_request_id`);
