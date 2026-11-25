// Every scheduled background job. To add one, create <name>.job.js and list it here.
// Not listed on purpose: push-delivery.job.js and case-stage-notification-reconcile.job.js. Patient push delivery and the recovery of missed patient stage
// notifications run in their OWN process (src/push-delivery-worker.js, `npm run start:worker:push`), which is their only scheduler, so they keep running
// when the Bitrix settings stop this worker from starting. Do not add them here.
const bitrixRetryJob = require('./bitrix-retry.job');
const bitrixDealJob = require('./bitrix-deal.job');
const bitrixDealInboxJob = require('./bitrix-deal-inbox.job');
const bitrixDealReconcileJob = require('./bitrix-deal-reconcile.job');
const bitrixDealDocumentJob = require('./bitrix-deal-document.job');
const bitrixQuotationJob = require('./bitrix-quotation.job');
const scanCaseQuotationsJob = require('./scan-case-quotations.job');
const securityLogPurgeJob = require('./security-log-purge.job');
const scanRequestDocumentsJob = require('./scan-request-documents.job');
const adminAuditPurgeJob = require('./admin-audit-purge.job');
const invoiceFromQuotationJob = require('./invoice-from-quotation.job');
const paymentOrderRecoveryJob = require('./payment-order-recovery.job');
const razorpayWebhookInboxJob = require('./razorpay-webhook-inbox.job');
const quotationAutoPublishJob = require('./quotation-auto-publish.job');

module.exports = { jobs: [bitrixRetryJob, bitrixDealJob, bitrixDealInboxJob, bitrixDealReconcileJob, bitrixDealDocumentJob, bitrixQuotationJob, scanCaseQuotationsJob, invoiceFromQuotationJob, securityLogPurgeJob, scanRequestDocumentsJob, adminAuditPurgeJob, paymentOrderRecoveryJob, razorpayWebhookInboxJob, quotationAutoPublishJob] };
