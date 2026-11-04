-- New Request form, medical page: patient mobility, equipment needed on board and how urgent
-- the request is. Additive only: every column is nullable, so existing requests keep working
-- and nothing is guessed for them. Rolling back is down.sql in this folder (run by hand;
-- Prisma has no automatic down migrations).
ALTER TABLE `service_requests` ADD COLUMN `mobility` VARCHAR(16) NULL,
    ADD COLUMN `equip_oxygen` BOOLEAN NULL,
    ADD COLUMN `equip_cardiac_monitor` BOOLEAN NULL,
    ADD COLUMN `equip_ventilator` BOOLEAN NULL,
    ADD COLUMN `urgency` VARCHAR(16) NULL;
