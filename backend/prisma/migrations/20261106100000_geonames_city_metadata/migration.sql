-- Private Charter: the verified origin and destination city (GeoNames id, name, country code and,
-- for the origin, its timezone) on the request, and the local GeoNames populated-place table the
-- cities are searched and verified against.
-- Additive only: every new column is nullable, so existing requests and every other service keep
-- working untouched, and nothing is guessed for older rows. Rolling back is down.sql in this folder
-- (run by hand; Prisma has no automatic down migrations).
ALTER TABLE `service_requests` ADD COLUMN `origin_geoname_id` INTEGER NULL,
    ADD COLUMN `origin_city_name` VARCHAR(200) NULL,
    ADD COLUMN `origin_country_code` VARCHAR(2) NULL,
    ADD COLUMN `origin_timezone` VARCHAR(64) NULL,
    ADD COLUMN `destination_geoname_id` INTEGER NULL,
    ADD COLUMN `destination_city_name` VARCHAR(200) NULL,
    ADD COLUMN `destination_country_code` VARCHAR(2) NULL;

-- CreateTable
CREATE TABLE `geonames_cities` (
    `geoname_id` INTEGER NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `ascii_name` VARCHAR(200) NOT NULL,
    `admin1_name` VARCHAR(200) NULL,
    `country_code` VARCHAR(2) NOT NULL,
    `feature_code` VARCHAR(10) NOT NULL,
    `population` INTEGER NOT NULL DEFAULT 0,
    `timezone` VARCHAR(64) NOT NULL,
    `verified_at` DATETIME(3) NOT NULL,

    INDEX `geonames_cities_name_idx`(`name`),
    INDEX `geonames_cities_ascii_name_idx`(`ascii_name`),
    PRIMARY KEY (`geoname_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
