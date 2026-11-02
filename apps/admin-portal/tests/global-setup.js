// Logs in once for the whole run and saves the session cookie as storage state, instead of
// every test logging in. Real logins go through the production brute-force limiter
// (5 per 15 min per IP, see backend/src/middleware/rate-limit.middleware.js), so a suite
// that logged in per test would trip it. Credentials come from the environment — nothing
// is hardcoded here.
const fs = require('fs');
const path = require('path');
const { request } = require('@playwright/test');

const API_BASE = process.env.E2E_API_BASE || 'http://localhost:4000';

module.exports = async () => {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (a superadmin account) before running the e2e tests.');
  }
  const ctx = await request.newContext();
  const res = await ctx.post(`${API_BASE}/admin/login`, { data: { email, password } });
  if (!res.ok()) {
    throw new Error(`Global admin login failed (${res.status()}): ${await res.text()}`);
  }
  const file = path.join(__dirname, '.auth', 'admin.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ctx.storageState({ path: file });
  await ctx.dispose();
};
