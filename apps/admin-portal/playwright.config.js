// @ts-check
const { defineConfig } = require('@playwright/test');

// The specs drive the React app on :3000 (started by `webServer` below) and talk to the
// centralized backend on :4000, which must already be running against whichever database
// it is pointed at. Authentication is the backend's HTTP-only cookie: global-setup logs in
// once and stores that cookie as Playwright storage state (no token is ever put in
// localStorage/sessionStorage). Specs that exercise the login form override it to empty.
module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  globalSetup: require.resolve('./tests/global-setup.js'),
  use: {
    baseURL: 'http://localhost:3000',
    storageState: 'tests/.auth/admin.json',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
  },
});
