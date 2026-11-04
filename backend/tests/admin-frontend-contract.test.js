// Frontend <-> backend contract (Step 7.9.9). The Admin Portal's browser tests run against a MOCKED
// API, so a path typo in the frontend would pass them. This reads the portal's real API client
// source, extracts every endpoint it calls, and requests each one from the REAL Express app (with
// the in-memory Prisma stand-in): none may be "No route for ..." (the app's 404). The answer is
// otherwise irrelevant here - 401, 403 or 400 all prove a route exists behind the right guards.
// It also checks the CSRF header the client promises for state-changing calls is the one the
// backend requires.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const kit = require('./admin-login-test-kit');
const { setAdminAuthLimiterSkip } = require('../src/modules/admin/auth/admin-auth.limiters');
const { app } = require('../src/app');

const { fake } = kit;
const PORTAL_SRC = path.resolve(__dirname, '..', '..', 'apps', 'admin-portal', 'src');
const read = (file) => fs.readFileSync(path.join(PORTAL_SRC, file), 'utf8');

beforeEach(() => {
  fake.reset();
  kit.setEnv();
  setAdminAuthLimiterSkip(() => true);
});
afterEach(() => {
  setAdminAuthLimiterSkip(null);
  kit.restoreEnv();
});

// "/admin/x/${id}/${kind === 'approve' ? 'approval' : 'rejection'}/options" -> every concrete path.
function expand(template) {
  let paths = [template];
  const ternary = /\$\{[^}]*\?\s*'([^']+)'\s*:\s*'([^']+)'\s*\}/;
  while (paths.some((p) => ternary.test(p))) {
    paths = paths.flatMap((p) => (ternary.test(p) ? [p.replace(ternary, (_m, a) => a), p.replace(ternary, (_m, _a, b) => b)] : [p]));
  }
  return paths.flatMap((p) => (p.includes('${kind}') ? [p.replace('${kind}', 'approve'), p.replace('${kind}', 'reject')] : [p])).map((p) => p.replace(/\$\{[^}]*\}/g, '1'));
}

// Every [METHOD, path] the portal's API client files can call.
function frontendEndpoints() {
  const found = [];
  for (const file of ['features/auth/api.js', 'features/recovery/api.js']) {
    const text = read(file);
    for (const m of text.matchAll(/\b(?:http|publicHttp)\.(get|post|put|patch|delete)\(\s*[`']([^`']+)[`']/g)) {
      expand(m[2]).forEach((p) => found.push([m[1].toUpperCase(), p]));
    }
    for (const m of text.matchAll(/const stepUpPath = \([^)]*\) => `([^`]+)`/g)) {
      expand(m[1]).forEach((p) => found.push(['POST', p]));
    }
  }
  const http = read('services/http.js');
  for (const m of http.matchAll(/axios\.post\(`\$\{API_BASE_URL\}([^`]+)`/g)) found.push(['POST', m[1]]);
  return found;
}

describe('the Admin Portal API client matches the backend', () => {
  const endpoints = frontendEndpoints();

  it('finds the endpoints it is supposed to check', () => {
    const keys = endpoints.map(([method, p]) => `${method} ${p}`);
    for (const expected of [
      'POST /admin/login/password', 'POST /admin/login/passkey', 'POST /admin/logout', 'POST /admin/refresh', 'GET /admin/me',
      'POST /admin/invitations/inspect', 'POST /admin/invitations/accept', 'POST /admin/enrollment/redeem',
      'POST /admin/passkeys/registration/options', 'POST /admin/passkeys/registration/verify',
      'POST /admin/recovery/redeem', 'POST /admin/recovery/passkeys/registration/options', 'POST /admin/recovery/passkeys/registration/verify',
      'GET /admin/recovery/requests', 'POST /admin/recovery/requests/1/approval/options', 'POST /admin/recovery/requests/1/rejection/options',
      'POST /admin/recovery/requests/1/approve', 'POST /admin/recovery/requests/1/reject',
    ]) expect(keys).toContain(expected);
  });

  it.each(endpoints.map(([method, p]) => [`${method} ${p}`, method, p]))('%s exists on the real app', async (_label, method, p) => {
    const res = await request(app)[method.toLowerCase()](p).set('Origin', 'http://localhost:3000').set('X-HC-Admin', '1').send(method === 'GET' ? undefined : {});
    expect(String(res.body && res.body.error)).not.toMatch(/^No route for/);
    expect(res.status).not.toBe(404);
  });

  it('the client sends the CSRF header the backend demands, exactly', () => {
    const http = read('services/http.js');
    expect(http).toMatch(/CSRF_HEADER = 'X-HC-Admin'/);
    expect(http).toMatch(/\[CSRF_HEADER\]: '1'/);
    expect(http).toMatch(/config\.headers\.set\(CSRF_HEADER, '1'\)/);
  });

  it('public (cookie-less) endpoints are exactly the ones the backend treats as public', () => {
    const auth = read('features/auth/api.js');
    const recovery = read('features/recovery/api.js');
    const publicCalls = [...(auth + recovery).matchAll(/publicHttp\.post\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
    expect(publicCalls).toEqual([
      '/admin/enrollment/redeem',
      '/admin/invitations/accept',
      '/admin/invitations/inspect',
      '/admin/passkeys/registration/options',
      '/admin/passkeys/registration/verify',
      '/admin/recovery/passkeys/registration/options',
      '/admin/recovery/passkeys/registration/verify',
      '/admin/recovery/redeem',
    ]);
  });
});
