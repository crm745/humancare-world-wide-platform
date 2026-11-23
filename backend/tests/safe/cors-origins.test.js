/* global describe, test, expect, jest, afterEach */
// CORS: an explicit allow-list. The pure rules, and the real application (src/app.js) over HTTP with supertest (no database).
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const request = require('supertest');
const C = require('../../src/common/security/cors-origins');

const ENV_KEYS = ['NODE_ENV', 'CORS_ALLOWED_ORIGINS', 'ADMIN_WEBAUTHN_ORIGIN', 'ADMIN_PORTAL_URL', 'CORPORATE_PORTAL_URL', 'TRUST_PROXY'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } jest.restoreAllMocks(); });

// A fresh copy of the application under an environment.
function appWith(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test' }, env);
  let app;
  jest.isolateModules(() => { ({ app } = require('../../src/app')); });
  return app;
}
const preflight = (app, origin) => request(app).options('/requests/me').set('Origin', origin).set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'authorization');

describe('normalizeOrigin', () => {
  test.each([
    ['https://Admin.Example.com', 'https://admin.example.com'],
    ['https://admin.example.com:443/path?x=1', 'https://admin.example.com'],
    ['http://localhost:3000/', 'http://localhost:3000'],
    [' https://a.example.com ', 'https://a.example.com'],
  ])('%s -> %s', (input, expected) => expect(C.normalizeOrigin(input)).toBe(expected));
  test.each(['*', 'null', '', '   ', 'ftp://x.example.com', 'javascript:alert(1)', 'not a url', undefined, null, 42, 'https://'])('%p is not an origin', (input) => expect(C.normalizeOrigin(input)).toBeNull());
});

describe('the allow-list', () => {
  test('CORS_ALLOWED_ORIGINS and the portal addresses are collected; a bad entry is reported, never allowed', () => {
    const { allowed, invalid } = C.allowedOriginsFrom({ CORS_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com/x , *, ftp://c.example.com', ADMIN_WEBAUTHN_ORIGIN: 'https://admin.example.com', ADMIN_PORTAL_URL: 'https://admin.example.com/login', CORPORATE_PORTAL_URL: 'https://corp.example.com' });
    expect([...allowed].sort()).toEqual(['https://a.example.com', 'https://admin.example.com', 'https://b.example.com', 'https://corp.example.com']);
    expect(invalid).toEqual(['*', 'ftp://c.example.com']);
  });
  test('no origin header is always allowed (the native app); an unlisted origin is not; production has no local exception', () => {
    const production = { allowed: new Set(['https://admin.example.com']), production: true };
    expect(C.isOriginAllowed(undefined, production)).toBe(true);
    expect(C.isOriginAllowed('', production)).toBe(true);
    expect(C.isOriginAllowed('https://admin.example.com', production)).toBe(true);
    expect(C.isOriginAllowed('https://evil.example', production)).toBe(false);
    expect(C.isOriginAllowed('https://admin.example.com.evil.example', production)).toBe(false);
    expect(C.isOriginAllowed('http://admin.example.com', production)).toBe(false); // another scheme is another origin
    expect(C.isOriginAllowed('http://localhost:8082', production)).toBe(false);
    expect(C.isOriginAllowed('null', production)).toBe(false);
  });
  test('outside production the local development origins work', () => {
    const dev = { allowed: new Set(), production: false };
    for (const origin of ['http://localhost:8082', 'http://127.0.0.1:3000', 'http://192.168.1.136:8082', 'http://10.0.0.5:5173', 'http://172.20.1.1:3000']) expect(C.isOriginAllowed(origin, dev)).toBe(true);
    for (const origin of ['https://evil.example', 'http://8.8.8.8:3000', 'http://172.32.0.1', 'http://localhost.evil.example']) expect(C.isOriginAllowed(origin, dev)).toBe(false);
  });
});

describe('over HTTP (the real application)', () => {
  test('production: a listed portal gets its origin and credentials; any other origin gets no CORS headers', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const app = appWith({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://admin.example.com' });
    const ok = await preflight(app, 'https://admin.example.com');
    expect(ok.headers['access-control-allow-origin']).toBe('https://admin.example.com');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await preflight(app, 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    expect(bad.headers['access-control-allow-credentials']).toBeUndefined();
    const local = await preflight(app, 'http://localhost:8082');
    expect(local.headers['access-control-allow-origin']).toBeUndefined();
  });
  test('a normal (non-preflight) call from an unlisted origin carries no CORS headers either; the answer itself is unchanged', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const app = appWith({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://admin.example.com' });
    const res = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  test('a request with no Origin header (the mobile app) works in production', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const app = appWith({ NODE_ENV: 'production' });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
  test('the admin portal configured only by its own variable is allowed', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const app = appWith({ NODE_ENV: 'production', ADMIN_WEBAUTHN_ORIGIN: 'https://portal.example.com' });
    expect((await preflight(app, 'https://portal.example.com')).headers['access-control-allow-origin']).toBe('https://portal.example.com');
  });
  test('development keeps working: localhost and a LAN address (Expo web) are allowed, an outside origin is not', async () => {
    const app = appWith({ NODE_ENV: 'development' });
    expect((await preflight(app, 'http://localhost:8082')).headers['access-control-allow-origin']).toBe('http://localhost:8082');
    expect((await preflight(app, 'http://192.168.1.136:8082')).headers['access-control-allow-origin']).toBe('http://192.168.1.136:8082');
    expect((await preflight(app, 'https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
  });
  test('a wildcard in the list is refused (warned about, not honoured)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const app = appWith({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '*' });
    expect((await preflight(app, 'https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
