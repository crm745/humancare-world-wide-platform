-- Rollback for 20261106100000_geonames_city_metadata. Not run by Prisma: run it by hand.
-- Drops the city columns of service_requests (their values are lost; the readable `origin` and
-- `destination` labels stay) and drops the GeoNames table (re-import it to restore).
-- If 20261106110000_preferred_date_to_date is applied, roll that one back first.
-- Prisma refuses `migrate resolve --rolled-back` for a migration that applied successfully (P3012),
-- so afterwards delete that migration's row from _prisma_migrations by hand, or leave the history
-- as it is and roll forward with a new migration.
ALTER TABLE `service_requests` DROP COLUMN `origin_geoname_id`,
    DROP COLUMN `origin_city_name`,
    DROP COLUMN `origin_country_code`,
    DROP COLUMN `origin_timezone`,
    DROP COLUMN `destination_geoname_id`,
    DROP COLUMN `destination_city_name`,
    DROP COLUMN `destination_country_code`;

DROP TABLE `geonames_cities`;
