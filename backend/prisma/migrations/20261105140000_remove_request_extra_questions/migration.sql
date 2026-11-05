-- The New Request form no longer asks the optional "More details" questions (extra information,
-- special requirements, how did you hear about us). Drops their three columns from
-- service_requests. The corporate Case form keeps its own columns of the same names (cases table).
-- DROP COLUMN cannot be undone: down.sql only puts the empty columns back, not their values.
-- Check first on any database that holds real data, and save what you want to keep:
--   SELECT id, reference_number, additional_info, special_requirements, referral_source
--   FROM service_requests
--   WHERE additional_info IS NOT NULL OR special_requirements IS NOT NULL OR referral_source IS NOT NULL;
-- Deploy code that no longer touches these columns before running this.
ALTER TABLE `service_requests` DROP COLUMN `additional_info`,
    DROP COLUMN `special_requirements`,
    DROP COLUMN `referral_source`;
