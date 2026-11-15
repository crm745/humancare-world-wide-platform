-- M9: change the foreign key cases.service_request_id -> service_requests.id from ON DELETE SET NULL to
-- ON DELETE RESTRICT, keeping ON UPDATE CASCADE. This closes the integrity risk recorded in M5: deleting a
-- service request used to silently detach its Case (service_request_id set to NULL) while the Case's
-- bitrix_deal_links row remained, losing the link between the request and its Deal. After this, a service
-- request that has a Case cannot be deleted.
--
-- Only this one foreign key is replaced. The column service_request_id (INTEGER NULL), its unique index
-- cases_service_request_id_key, every other foreign key and every row are untouched. No data is updated or
-- deleted. Corporate Cases keep service_request_id NULL: a foreign key is never checked for a NULL column, so
-- they stay valid. Cases with a value keep pointing at the same service request. No code deletes service
-- requests today, so no existing feature changes. A future cleanup that must remove a service request has to
-- deal with its Case first.
--
-- Two statements, same constraint name. MySQL DDL is not transactional: if the second statement failed, the
-- table would be left WITHOUT this foreign key (the first having succeeded) and it would have to be re-added
-- by hand, with down.sql's ADD statement as the previous definition. Adding the foreign key re-validates the
-- existing rows and briefly locks `cases`. The unique index serves as the foreign key's index and stays.
-- Rolling back is down.sql in this folder (run by hand).

-- DropForeignKey
ALTER TABLE `cases` DROP FOREIGN KEY `cases_service_request_id_fkey`;

-- AddForeignKey
ALTER TABLE `cases` ADD CONSTRAINT `cases_service_request_id_fkey` FOREIGN KEY (`service_request_id`) REFERENCES `service_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
