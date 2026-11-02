// Every scheduled background job. To add one, create <name>.job.js and list it here.
const bitrixRetryJob = require('./bitrix-retry.job');
const securityLogPurgeJob = require('./security-log-purge.job');

module.exports = { jobs: [bitrixRetryJob, securityLogPurgeJob] };
