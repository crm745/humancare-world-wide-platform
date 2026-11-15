-- Rolls back 20261113000800_private_charter_m9_case_service_request_fk. Run by hand (Prisma has no automatic
-- down migrations).
--
-- Restores the previous foreign key: cases.service_request_id -> service_requests.id ON DELETE SET NULL
-- ON UPDATE CASCADE. No row, column or index is changed or deleted, so no Case or service request is lost.
-- RISK: after this, deleting a service request silently sets its Case's service_request_id to NULL (detaching
-- the Case, which then looks like a Corporate Case) while its bitrix_deal_links row remains. Only roll back if
-- that is acceptable, and never while service requests are being deleted.
-- MySQL DDL is not transactional: if the ADD statement fails after the DROP, the table has no foreign key until
-- it is re-added by hand. The statement briefly locks `cases`.
-- Afterwards remove the migration's row from _prisma_migrations by hand.
ALTER TABLE `cases` DROP FOREIGN KEY `cases_service_request_id_fkey`;
ALTER TABLE `cases` ADD CONSTRAINT `cases_service_request_id_fkey` FOREIGN KEY (`service_request_id`) REFERENCES `service_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
