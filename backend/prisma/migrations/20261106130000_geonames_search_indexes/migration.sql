-- City search speed on the full GeoNames dataset (about 5 million places). With the single-column
-- name indexes, MySQL had to read the table row of every match just to sort by population: a
-- two-letter prefix took 3 seconds, "san" 5 seconds and one letter 11. Indexes that also hold the
-- population answer from the index alone (tens of milliseconds for any prefix). The single-column
-- indexes are a left part of these, so they go. Only indexes change: no data, no columns.
-- Rolling back is down.sql in this folder.
CREATE INDEX `geonames_cities_name_population_idx` ON `geonames_cities`(`name`, `population`);
CREATE INDEX `geonames_cities_ascii_name_population_idx` ON `geonames_cities`(`ascii_name`, `population`);
DROP INDEX `geonames_cities_name_idx` ON `geonames_cities`;
DROP INDEX `geonames_cities_ascii_name_idx` ON `geonames_cities`;
