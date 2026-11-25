-- Account retirement: when a patient deletes their account the users row is KEPT (their requests, cases and documents still reference it), its identity
-- is cleared, and this column records when. Additive only: one nullable column, so every existing account stays live (NULL) and nothing is guessed for it.
-- Rolling back is down.sql in this folder (run by hand; Prisma has no automatic down migrations).
ALTER TABLE `users` ADD COLUMN `deleted_at` DATETIME(3) NULL;
