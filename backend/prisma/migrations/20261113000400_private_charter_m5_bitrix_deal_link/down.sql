-- Rolls back 20261113000400_private_charter_m5_bitrix_deal_link. Run by hand (Prisma has no automatic down
-- migrations), and ONLY while bitrix_deal_links is empty, or after its rows have been exported: dropping
-- the table loses the link between each Case and its Bitrix Deal for good. The Deals in Bitrix24 and every
-- existing Lead ID (service_requests.bitrix_lead_id, cases.bitrix_lead_id) are not affected.
--   SELECT COUNT(*) FROM bitrix_deal_links;
-- No other table is affected (cases is only referenced by the table being dropped).
-- Afterwards remove the migration's row from _prisma_migrations by hand.
DROP TABLE `bitrix_deal_links`;
