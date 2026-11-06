-- Rollback for 20261106130000_geonames_search_indexes. Not run by Prisma: run it by hand.
-- Puts the single-column name indexes back (the city search keeps working, slowly on short prefixes).
-- Prisma refuses `migrate resolve --rolled-back` for a migration that applied successfully (P3012),
-- so afterwards delete that migration's row from _prisma_migrations by hand, or leave the history
-- as it is and roll forward with a new migration.
CREATE INDEX `geonames_cities_name_idx` ON `geonames_cities`(`name`);
CREATE INDEX `geonames_cities_ascii_name_idx` ON `geonames_cities`(`ascii_name`);
DROP INDEX `geonames_cities_name_population_idx` ON `geonames_cities`;
DROP INDEX `geonames_cities_ascii_name_population_idx` ON `geonames_cities`;
