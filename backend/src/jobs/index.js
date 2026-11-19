// Every scheduled background job. To add one, create <name>.job.js and list it here.
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

module.exports = { jobs: [bitrixRetryJob, bitrixDealJob, bitrixDealInboxJob, bitrixDealReconcileJob, bitrixDealDocumentJob, bitrixQuotationJob, scanCaseQuotationsJob, invoiceFromQuotationJob, securityLogPurgeJob, scanRequestDocumentsJob, adminAuditPurgeJob, paymentOrderRecoveryJob, razorpayWebhookInboxJob] };
