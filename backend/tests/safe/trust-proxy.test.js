/* global describe, test, expect, jest, afterEach */
// TRUST_PROXY: explicit and strict. The parser, the application's setting, and what req.ip becomes behind a proxy.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass }, uploadPatient: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const express = require('express');
const request = require('supertest');
const { resolveTrustProxy } = require('../../src/common/security/trust-proxy');

const saved = { TRUST_PROXY: process.env.TRUST_PROXY, NODE_ENV: process.env.NODE_ENV, CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS };
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } jest.restoreAllMocks(); });

describe('resolveTrustProxy', () => {
  test.each([[undefined], [''], ['  '], ['false'], ['FALSE'], ['0']])('%p trusts no proxy (the default)', (value) => expect(resolveTrustProxy({ TRUST_PROXY: value })).toBe(false));
  test.each([['1', 1], ['2', 2], [' 3 ', 3], ['10', 10]])('%p trusts that many hops', (value, hops) => expect(resolveTrustProxy({ TRUST_PROXY: value })).toBe(hops));
  test('named proxies and addresses are kept as a list', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: 'loopback' })).toEqual(['loopback']);
    expect(resolveTrustProxy({ TRUST_PROXY: 'loopback, 10.0.0.0/8 ,172.16.0.0/12,uniquelocal' })).toEqual(['loopback', '10.0.0.0/8', '172.16.0.0/12', 'uniquelocal']);
    expect(resolveTrustProxy({ TRUST_PROXY: '192.168.1.1' })).toEqual(['192.168.1.1']);
    expect(resolveTrustProxy({ TRUST_PROXY: '::1' })).toEqual(['::1']);
  });
  test.each([['true'], ['TRUE']])('%p is refused: it would let any client forge X-Forwarded-For', (value) => expect(() => resolveTrustProxy({ TRUST_PROXY: value })).toThrow(/forge/));
  test.each([['11'], ['-1'], ['1.5'], ['yes'], ['999.1.1.1'], ['10.0.0.0/33'], ['loopback,banana'], [',']])('%p is refused', (value) => expect(() => resolveTrustProxy({ TRUST_PROXY: value })).toThrow(/TRUST_PROXY/));
});

describe('req.ip behind a proxy (Express, as configured by the parser)', () => {
  const ipOf = async (setting, forwarded) => {
    const app = express();
    const value = resolveTrustProxy({ TRUST_PROXY: setting });
    if (value !== false) app.set('trust proxy', value);
    app.get('/ip', (req, res) => res.json({ ip: req.ip }));
    return (await request(app).get('/ip').set('X-Forwarded-For', forwarded)).body.ip;
  };
  test('unset: the forwarded header is ignored, so a client cannot choose its own rate-limit key', async () => {
    expect(await ipOf(undefined, '203.0.113.9')).not.toBe('203.0.113.9');
  });
  test('one hop: the address the proxy saw is used', async () => {
    expect(await ipOf('1', '203.0.113.9')).toBe('203.0.113.9');
  });
  test('one hop: a client that adds its own fake address first does not control the key (only the last hop is trusted)', async () => {
    expect(await ipOf('1', '1.2.3.4, 203.0.113.9')).toBe('203.0.113.9');
  });
});

describe('the application', () => {
  const appWith = (env) => {
    for (const k of ['TRUST_PROXY', 'NODE_ENV', 'CORS_ALLOWED_ORIGINS']) delete process.env[k];
    Object.assign(process.env, { NODE_ENV: 'test' }, env);
    let app;
    jest.isolateModules(() => { ({ app } = require('../../src/app')); });
    return app;
  };
  test('no TRUST_PROXY: Express keeps its default (trust nothing)', () => expect(appWith({}).get('trust proxy')).toBeFalsy());
  test('TRUST_PROXY=1: one hop is trusted', () => expect(appWith({ TRUST_PROXY: '1' }).get('trust proxy')).toBe(1));
  test('a bad value stops the application from loading', () => expect(() => appWith({ TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/));
  test('production without it warns at start', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    appWith({ NODE_ENV: 'production' });
    expect(warn.mock.calls.some((c) => /TRUST_PROXY is not set/.test(String(c[0])))).toBe(true);
  });
});
