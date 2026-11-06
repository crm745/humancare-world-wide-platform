-- Other names of a GeoNames city (translations, local spellings, old names, ASCII spellings), so a
-- Private Charter city search finds "München" for Munich. Additive: a new table and one new index;
-- nothing existing changes. Filled by scripts/import-geonames.js from the same dump line as the
-- city; deleting a city deletes its names. Rolling back is down.sql in this folder.
CREATE TABLE `geonames_city_names` (
    `geoname_id` INTEGER NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `population` INTEGER NOT NULL DEFAULT 0,

    INDEX `geonames_city_names_name_population_idx`(`name`, `population`),
    PRIMARY KEY (`geoname_id`, `name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Finds the date of the last import (the newest verified_at) without reading the whole table: the
-- freshness reminder and status command use it.
CREATE INDEX `geonames_cities_verified_at_idx` ON `geonames_cities`(`verified_at`);

-- AddForeignKey
ALTER TABLE `geonames_city_names` ADD CONSTRAINT `geonames_city_names_geoname_id_fkey` FOREIGN KEY (`geoname_id`) REFERENCES `geonames_cities`(`geoname_id`) ON DELETE CASCADE ON UPDATE CASCADE;
