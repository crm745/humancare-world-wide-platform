-- Rolls back 20261123100000_auth_sessions: drops the per-device session table (run by hand; Prisma has no automatic down migrations).
-- Roll the code back first: tokens that carry a session id are refused by the code that checks it. Nothing else is touched.
DROP TABLE `auth_sessions`;
