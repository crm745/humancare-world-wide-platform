// Jest configuration for the INTEGRATION runner, which uses the existing `humancare_test` database but never goes
// through the ordinary global setup. Run with `npm run test:integration` (sets HUMANCARE_INTEGRATION_RUN=true).
//
// Its global setup does NOT empty, delete, truncate, seed or migrate anything. It only: requires the explicit opt-in,
// takes the session lock (which makes the ordinary `npm test` refuse to run while this runner works), confirms the
// database identity with the server, and checks that no other session is connected. The global teardown releases the
// lock. Test files are named *.integration.js, which the ordinary jest.config.js (default *.test.js / *.spec.js
// pattern) never picks up, and this configuration never matches *.test.js.
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  globalSetup: '<rootDir>/tests/integration/global-setup.js',
  globalTeardown: '<rootDir>/tests/integration/global-teardown.js',
  setupFiles: ['<rootDir>/tests/integration/setup.js'],
  testMatch: ['<rootDir>/tests/integration/**/*.integration.js'],
  testTimeout: 30000,
  maxWorkers: 1,
};
