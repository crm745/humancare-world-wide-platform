-- Commercial Air request, medical page: the oxygen flow rate in litres per minute (LPM), asked
-- when Oxygen is chosen under "Required on board". Additive only: one nullable column, so every
-- existing request keeps working and nothing is guessed for it. Only Commercial Air requests
-- fill it; Private Charter and every other service leave it NULL. Rolling back is down.sql in
-- this folder (run by hand; Prisma has no automatic down migrations).
ALTER TABLE `service_requests` ADD COLUMN `equip_oxygen_lpm` DOUBLE NULL;
