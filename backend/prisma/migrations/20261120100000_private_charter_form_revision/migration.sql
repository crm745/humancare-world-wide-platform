-- Private Charter form revision: Travel Type, Critical Level, Oxygen Required and Oxygen Flow Rate (LPM).
-- Additive only: every column is nullable and nothing is dropped, so the care level, mobility, equipment
-- and urgency stored on existing requests (and used by other services) are kept as they are.
ALTER TABLE `service_requests` ADD COLUMN `travel_type` VARCHAR(24) NULL,
    ADD COLUMN `critical_level` VARCHAR(24) NULL,
    ADD COLUMN `oxygen_required` BOOLEAN NULL,
    ADD COLUMN `oxygen_flow_lpm` INTEGER NULL;
