-- Removes two columns of service_requests that nothing uses. document_url was the old "bare
-- URL of the report" (reports are Document rows on the case now) and medical_summary was never
-- sent by the app or read by anything. Nothing writes or reads either; check first on any
-- database that holds real data:
--   SELECT COUNT(*) FROM service_requests WHERE document_url IS NOT NULL OR medical_summary IS NOT NULL;
-- DROP COLUMN cannot be undone: down.sql only puts the empty columns back, not their values.
-- Deploy code that no longer touches these columns before running this.
ALTER TABLE `service_requests` DROP COLUMN `document_url`,
    DROP COLUMN `medical_summary`;
