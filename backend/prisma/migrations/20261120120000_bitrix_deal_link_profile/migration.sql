-- Bitrix profile isolation. Every Deal link records the Bitrix profile ("test" = Category 38, "actual" = Category 0) it belongs to.
ALTER TABLE `bitrix_deal_links` ADD COLUMN `profile` VARCHAR(16) NULL;

-- Everything that exists today was created for the Test Pipeline (the actual profile did not exist): state that explicitly, so no
-- existing record can ever be read as the actual profile. Links are marked "test"; queued or finished Bitrix outbox events get the
-- same stamp in their payload (payload.profile).
UPDATE `bitrix_deal_links` SET `profile` = 'test' WHERE `profile` IS NULL;
UPDATE `integration_outbox`
   SET `payload` = JSON_SET(`payload`, '$.profile', 'test')
 WHERE `event_type` LIKE 'bitrix.%' AND `payload` IS NOT NULL AND JSON_TYPE(`payload`) = 'OBJECT' AND JSON_EXTRACT(`payload`, '$.profile') IS NULL;
