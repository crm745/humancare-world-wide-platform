// Loaded before every SAFE test (see jest.safe.config.js). Makes sure that a test which forgets to mock Prisma or
// the network cannot reach a real database or CRM: the database URL points at a closed local port, the Bitrix
// settings are cleared, and fetch is refused. It reads no .env file.
process.env.DATABASE_URL = 'mysql://blocked:blocked@127.0.0.1:1/blocked_by_safe_tests';
for (const key of ['BITRIX24_WEBHOOK_URL', 'BITRIX_SYNC_ENABLED', 'BITRIX_PRIVATE_CHARTER_DEAL_ENABLED', 'PRIVATE_CHARTER_REVIEW_WORKFLOW']) {
  delete process.env[key];
}
global.fetch = () => Promise.reject(new Error('The network is blocked in the safe tests.'));
