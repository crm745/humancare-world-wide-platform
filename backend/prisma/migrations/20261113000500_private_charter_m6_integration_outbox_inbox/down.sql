-- Rolls back 20261113000500_private_charter_m6_integration_outbox_inbox. Run by hand (Prisma has no
-- automatic down migrations).
--
-- DESTRUCTIVE: this deletes every outbox and inbox row for good. Run it ONLY while both tables are empty,
-- or after their rows have been exported. In particular do NOT run it once any Bitrix Deal-create event has
-- been attempted. An outbox row that is "processing" or "ambiguous" is evidence that a Deal creation may have
-- been attempted without HumanCare having saved its ID, and dropping it would remove that evidence and could
-- let a later retry create a duplicate Deal. It is NOT the only such evidence: a bitrix_deal_links row with a
-- NULL bitrix_deal_id (created before the Bitrix call) may also exist. That table is not dropped here.
-- The Deals in Bitrix24, every Lead ID and bitrix_deal_links are not affected.
--   SELECT (SELECT COUNT(*) FROM integration_outbox) AS outbox, (SELECT COUNT(*) FROM integration_inbox) AS inbox;
-- No other table is dropped or altered. Of the two tables dropped here, only integration_outbox references
-- cases (through its case_id foreign key); the cases table itself is referenced by other tables and is not
-- changed.
-- Afterwards remove the migration's row from _prisma_migrations by hand.
DROP TABLE `integration_inbox`;
DROP TABLE `integration_outbox`;
