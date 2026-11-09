// @ts-check
// REAL-BROWSER suite: the actual Admin Portal in Chromium, the actual backend, the dedicated
// `humancare_test` database, a local SMTP capture sink and Chromium's CDP virtual authenticator
// (real WebAuthn in the browser - the fake WebAuthn used by the mocked suite is NOT installed here).
//
//   npx playwright test -c playwright.real.config.js
//
// Starts three servers itself and never reuses one already running (so it can never talk to a
// development server by accident):
//   - mail sink      127.0.0.1:1025 (SMTP, accepts only @e2e.humancare.invalid) / :1080 (HTTP, read)
//   - E2E backend    http://localhost:4100  (backend/scripts/e2e-server.js: .env.test only, guarded)
//   - Admin Portal   http://localhost:3100  (Vite dev, API = the E2E backend; E2E_PORTAL_PORT overrides)
// Fixtures create only their own uniquely-named @e2e.humancare.invalid accounts and remove only
// those; nothing wipes or resets the database. Traces are off: they would store one-time links.
const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

const backend = path.resolve(__dirname, '../../backend');
// The portal under test has its own port, so a development portal on 3000 is never touched or reused.
// (backend/scripts/e2e-env.js derives the WebAuthn origin and link base from the same variable.)
const PORTAL_PORT = Number(process.env.E2E_PORTAL_PORT || 3100);

module.exports = defineConfig({
  testDir: './tests/real',
  outputDir: 'test-results/real',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/real-report.json' }]],
  use: { baseURL: `http://localhost:${PORTAL_PORT}`, trace: 'off', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'node scripts/e2e-mail-sink.js', cwd: backend, url: 'http://127.0.0.1:1080/messages', reuseExistingServer: false, timeout: 30_000 },
    { command: 'node scripts/e2e-server.js', cwd: backend, url: 'http://localhost:4100/health', reuseExistingServer: false, timeout: 60_000 },
    { command: `npm run dev -- --port ${PORTAL_PORT}`, cwd: __dirname, url: `http://localhost:${PORTAL_PORT}`, reuseExistingServer: false, timeout: 90_000, env: { VITE_API_BASE_URL: 'http://localhost:4100' } },
  ],
});
