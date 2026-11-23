// Jest configuration for the DEVELOPMENT-DATABASE session tests (tests/devdb/*.devdb.js). Run with `npm run test:devdb`.
//
// These tests use the real MySQL schema of `humancare_dev` (the auth_sessions table, its foreign keys and indexes) through a separate generated Prisma client (backend/.devdb/client, see
// package.json "devdb:generate"). They create only synthetic rows with a unique marker and delete only those. They NEVER run against humancare_test (the normal jest.config.js empties that database)
// and never against anything but `humancare_dev` on localhost: tests/devdb/guard.js refuses to start otherwise.
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  setupFiles: ['<rootDir>/tests/devdb/guard.js'],
  testMatch: ['<rootDir>/tests/devdb/**/*.devdb.js'],
  moduleNameMapper: { '^@prisma/client$': '<rootDir>/.devdb/client' },
  maxWorkers: 1,
  testTimeout: 30000,
};
