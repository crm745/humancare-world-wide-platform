-- Manual rollback (not run by Prisma). Removes the stamp; the payload stamp is harmless and is left in place.
ALTER TABLE `bitrix_deal_links` DROP COLUMN `profile`;
