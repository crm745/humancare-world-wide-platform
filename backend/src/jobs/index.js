// Every scheduled background job. To add one, create <name>.job.js and list it here.
const bitrixRetryJob = require('./bitrix-retry.job');
const securityLogPurgeJob = require('./security-log-purge.job');
const scanRequestDocumentsJob = require('./scan-request-documents.job');

module.exports = { jobs: [bitrixRetryJob, securityLogPurgeJob, scanRequestDocumentsJob] };
