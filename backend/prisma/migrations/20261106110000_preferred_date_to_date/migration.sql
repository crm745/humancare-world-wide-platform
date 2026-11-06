-- service_requests.preferred_date: DATETIME(3) -> DATE. A preferred date is a calendar day, not a
-- moment: it was always written from a "YYYY-MM-DD" string as that day at 00:00 UTC, so the date
-- part of every stored value IS the day the patient chose and nothing shifts.
--
-- Shared by every service. Check first on any database that holds real data whether any value
-- carries a time of day (they would lose it; the day itself is kept either way):
--   SELECT COUNT(*) FROM service_requests
--   WHERE preferred_date IS NOT NULL AND preferred_date <> CAST(DATE(preferred_date) AS DATETIME(3));
-- (Do not compare TIME(preferred_date) with the text '00:00:00': that compares as text and reports
-- every row.) Back up the table first. The ALTER rebuilds the table, which is brief at this size.
--
-- MySQL ROUNDS when it changes DATETIME(3) to DATE (23:59:59.999 became the NEXT day when tried),
-- so the time of day is cut off explicitly first: after the UPDATE every value is its own day at
-- 00:00:00.000 and the type change cannot move a date.
-- Rolling back is down.sql in this folder.
UPDATE `service_requests` SET `preferred_date` = CAST(DATE(`preferred_date`) AS DATETIME(3))
WHERE `preferred_date` IS NOT NULL AND `preferred_date` <> CAST(DATE(`preferred_date`) AS DATETIME(3));

ALTER TABLE `service_requests` MODIFY `preferred_date` DATE NULL;
