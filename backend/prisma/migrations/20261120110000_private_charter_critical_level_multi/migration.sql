-- Private Charter: Critical Level becomes a multi-select. The choices are stored in the same column as the keys
-- joined by commas (for example 'icu,ecmo'), so the column is widened from 24 to 64 characters (all four keys
-- together are 31). Widening keeps every stored value as it is: a single key stored earlier reads as a list of one.
ALTER TABLE `service_requests` MODIFY `critical_level` VARCHAR(64) NULL;
