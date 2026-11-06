-- Rollback for 20261106120000_geonames_city_names. Not run by Prisma: run it by hand.
-- Drops the alternate-name table (re-run the importer to refill it) and the verified_at index.
-- Prisma refuses `migrate resolve --rolled-back` for a migration that applied successfully (P3012),
-- so afterwards delete that migration's row from _prisma_migrations by hand, or leave the history
-- as it is and roll forward with a new migration.
DROP TABLE `geonames_city_names`;

DROP INDEX `geonames_cities_verified_at_idx` ON `geonames_cities`;
