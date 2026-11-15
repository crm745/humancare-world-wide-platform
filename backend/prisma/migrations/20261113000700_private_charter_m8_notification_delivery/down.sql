-- Rolls back 20261113000700_private_charter_m8_notification_delivery. Run by hand (Prisma has no automatic
-- down migrations).
--
-- DESTRUCTIVE: this deletes every notification delivery record and every delivery attempt for good. That is
-- the only record of which push or SMS messages were sent, accepted, confirmed or failed, and of which sends
-- were left "uncertain"; dropping it loses that evidence and could let a later retry send a duplicate. Run it
-- ONLY while both tables are empty, or after their rows have been exported and the export checked.
--   SELECT (SELECT COUNT(*) FROM notification_deliveries) AS deliveries, (SELECT COUNT(*) FROM notification_delivery_attempts) AS attempts;
-- The in-app notifications table and its rows are NOT touched, so in-app notifications are unaffected. Messages
-- already sent to devices or phones cannot be recalled.
-- notification_delivery_attempts is dropped first because it references notification_deliveries. No other
-- table is dropped or altered.
-- Afterwards remove the migration's row from _prisma_migrations by hand.
DROP TABLE `notification_delivery_attempts`;
DROP TABLE `notification_deliveries`;
