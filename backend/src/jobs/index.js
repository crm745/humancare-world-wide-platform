// Every scheduled background job. To add one, create <name>.job.js and list it here.
const bitrixRetryJob = require('./bitrix-retry.job');
const bitrixDealJob = require('./bitrix-deal.job');
const bitrixDealInboxJob = require('./bitrix-deal-inbox.job');
const bitrixDealReconcileJob = require('./bitrix-deal-reconcile.job');
const bitrixDealDocumentJob = require('./bitrix-deal-document.job');
const securityLogPurgeJob = require('./security-log-purge.job');
const scanRequestDocumentsJob = require('./scan-request-documents.job');
const adminAuditPurgeJob = require('./admin-audit-purge.job');

module.exports = { jobs: [bitrixRetryJob, bitrixDealJob, bitrixDealInboxJob, bitrixDealReconcileJob, bitrixDealDocumentJob, securityLogPurgeJob, scanRequestDocumentsJob, adminAuditPurgeJob] };
