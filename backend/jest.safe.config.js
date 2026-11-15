// Jest configuration for the SAFE tests: unit tests that mock Prisma and the Bitrix client and never touch a
// database. Run with `npm run test:safe`.
//
// Why a separate configuration: the normal jest.config.js runs tests/global-setup.js before EVERY run, which
// connects to `humancare_test` and EMPTIES EVERY TABLE (except _prisma_migrations), whichever test file is run. Most suites
// also fill and clear tables themselves (tests/request-review.test.js, requests.test.js, geo*.test.js,
// geonames-*.test.js, legacy-backfill.test.js, private-charter-dates.test.js, admin-lock-utilities.test.js). This
// configuration has NO globalSetup and does not load any .env file; tests/safe/no-network-or-database.js points
// DATABASE_URL at a closed local port (so an unmocked query fails at once instead of reaching a real database) and
// blocks fetch. Only DB-free suites are listed in testMatch.
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  setupFiles: ['<rootDir>/tests/safe/no-network-or-database.js'],
  testMatch: [
    '<rootDir>/tests/safe/**/*.test.js',
    '<rootDir>/tests/bitrix-retry.test.js',
    '<rootDir>/tests/bitrix-lead.test.js',
  ],
  testTimeout: 15000,
};
