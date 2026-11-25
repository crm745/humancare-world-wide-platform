/* global describe, test, expect, jest, beforeEach, afterEach */
// POST /auth/logout ends a patient session on the server (tokenVersion moves on), and /auth/refresh then refuses the old refresh token. No database: Prisma is a fake.
jest.mock('../../src/db/prisma', () => ({ prisma: { user: { updateMany: jest.fn(), findUnique: jest.fn() } } }));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass }, uploadPatient: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { prisma } = require('../../src/db/prisma');
const { app } = require('../../src/app');

const REFRESH = 'test-refresh-secret-0123456789';
const ACCESS = 'test-access-secret-0123456789';
const refreshFor = (claims, options = { expiresIn: '30d' }) => jwt.sign(claims, REFRESH, options);
const logout = (body) => request(app).post('/auth/logout').send(body);

beforeEach(() => { process.env.JWT_REFRESH_SECRET = REFRESH; process.env.JWT_ACCESS_SECRET = ACCESS; prisma.user.updateMany.mockReset().mockResolvedValue({ count: 1 }); prisma.user.findUnique.mockReset(); });
afterEach(() => { delete process.env.JWT_REFRESH_SECRET; delete process.env.JWT_ACCESS_SECRET; });

describe('POST /auth/logout', () => {
  test('a patient refresh token revokes the session: tokenVersion is incremented only if it is still the token version', async () => {
    const res = await logout({ refreshToken: refreshFor({ sub: 7, role: 'patient', tv: 3 }) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Logged out.' });
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: 7, tokenVersion: 3 }, data: { tokenVersion: { increment: 1 } } });
  });
  test('a token issued before tokenVersion existed counts as version 0', async () => {
    await logout({ refreshToken: refreshFor({ sub: 7, role: 'patient' }) });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: 7, tokenVersion: 0 }, data: { tokenVersion: { increment: 1 } } });
  });
  test('signing out twice with the same token revokes once (the second finds the version already moved on)', async () => {
    prisma.user.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const token = refreshFor({ sub: 7, role: 'patient', tv: 3 });
    expect((await logout({ refreshToken: token })).status).toBe(200);
    expect((await logout({ refreshToken: token })).status).toBe(200);
    expect(prisma.user.updateMany.mock.calls[1][0].where).toEqual({ id: 7, tokenVersion: 3 }); // conditional: it cannot sign out a NEWER session
  });
  test.each([
    ['an expired token', () => refreshFor({ sub: 7, role: 'patient', tv: 0 }, { expiresIn: -10 })],
    ['a token signed with another secret', () => jwt.sign({ sub: 7, role: 'patient', tv: 0 }, 'another-secret-entirely', { expiresIn: '30d' })],
    ['garbage', () => 'not.a.jwt'],
    ['an ACCESS token (wrong secret)', () => jwt.sign({ sub: 7, role: 'patient', tv: 0 }, ACCESS, { expiresIn: '15m' })],
  ])('%s answers the same 200 and revokes nothing (it tells nothing about tokens)', async (_name, make) => {
    const res = await logout({ refreshToken: make() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Logged out.' });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
  test.each([['corporate', { sub: 1, role: 'corporate', corporateId: 2 }], ['admin', { sub: 1, role: 'admin' }]])('a %s token has nothing to revoke here', async (_role, claims) => {
    const res = await logout({ refreshToken: refreshFor(claims) });
    expect(res.status).toBe(200);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
  test.each([[{}], [{ refreshToken: '' }], [{ refreshToken: 123 }], [{ refreshToken: { a: 1 } }]])('a missing or non-text refreshToken (%j) is a 400', async (body) => {
    const res = await logout(body);
    expect(res.status).toBe(400);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
  test('it needs no access token (the access token may already have expired)', async () => {
    const res = await request(app).post('/auth/logout').set('Authorization', 'Bearer expired.or.junk').send({ refreshToken: refreshFor({ sub: 7, role: 'patient', tv: 1 }) });
    expect(res.status).toBe(200);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('after the sign-out, /auth/refresh refuses the old refresh token', () => {
  test('the account is now one version ahead: 401 session ended', async () => {
    prisma.user.findUnique.mockResolvedValue({ tokenVersion: 4, isVerified: true, deletedAt: null });
    const res = await request(app).post('/auth/refresh').send({ refreshToken: refreshFor({ sub: 7, role: 'patient', tv: 3 }) });
    expect(res.status).toBe(401);
  });
  test('a session that was not signed out still refreshes (same version)', async () => {
    prisma.user.findUnique.mockResolvedValue({ tokenVersion: 3, isVerified: true, deletedAt: null });
    const res = await request(app).post('/auth/refresh').send({ refreshToken: refreshFor({ sub: 7, role: 'patient', tv: 3 }) });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });
});
