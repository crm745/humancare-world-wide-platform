-- Rolls back 20261116110000_bitrix_deal_documents. Run by hand (Prisma has no automatic down migrations), and ONLY while
-- bitrix_deal_documents is empty, or after its rows have been exported: dropping it deletes the record of which HumanCare
-- documents were shared with which Bitrix24 Deal and which Bitrix file each one became (the files in Bitrix24 stay).
--   SELECT COUNT(*) FROM bitrix_deal_documents;
-- Afterwards remove the migration's row from _prisma_migrations by hand.
ALTER TABLE `bitrix_deal_links` DROP COLUMN `file_locked_by`, DROP COLUMN `file_locked_until`;
DROP TABLE `bitrix_deal_documents`;
