// @ts-check
const path = require('path');
const { defineConfig } = require('@playwright/test');

// Frontend-only suite: the React app on :3000 against a MOCKED API (see
// tests/helpers/mockApi.js). There is deliberately no globalSetup and no login against a
// real backend, so this can run anywhere without a backend or database.
//
//   npx playwright test -c tests/mocked/playwright.config.js
module.exports = defineConfig({
  testDir: __dirname,
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'npm run dev',
    cwd: path.resolve(__dirname, '../..'),
    url: 'http://localhost:3000',
    reuseExistingServer: true,
  },
});
