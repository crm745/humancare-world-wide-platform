// Jest configuration for a SCOPED run of a DB-backed suite against the EXISTING `humancare_test` database.
// It NEVER uses tests/global-setup.js (which empties every table). Run with `npm run test:scoped:request-review`.
//
// Its global setup does not delete, truncate, reset, seed or migrate anything: it takes the session lock, confirms the
// database identity, takes a backup and a per-table snapshot. Its global teardown deletes ONLY the rows this run created
// (found through the run id in their e-mail addresses) and verifies that every table is back to the snapshot.
// See src/common/safety/scoped-test-run.js for the full list of guarantees.
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  globalSetup: '<rootDir>/tests/scoped/global-setup.js',
  globalTeardown: '<rootDir>/tests/scoped/global-teardown.js',
  setupFiles: ['<rootDir>/tests/scoped/setup.js'],
  // Only the suites that have been made safe for a populated database are listed here.
  testMatch: ['<rootDir>/tests/request-review.test.js'],
  testTimeout: 30000,
  maxWorkers: 1,
};
