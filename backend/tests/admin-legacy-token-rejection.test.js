// Legacy Admin tokens (role 'admin', signed with the shared secrets by the password-only login) must
// not work on the shared patient/corporate authentication: requireAuth, /auth/me, /notifications and
// /auth/refresh. Admin routes keep their own middleware. No database: Prisma is the in-memory
// Admin stand-in plus a mocked `user` model, and the notifications service is mocked.
const mockUserFindUnique = jest.fn();
jest.mock('../src/db/prisma', () => {
  const fake = require('./admin-lock-fake-db');
  fake.prisma.user = { findUnique: (...a) => mockUserFindUnique(...a) };
  return fake;
});
const mockListNotifications = jest.fn();
jest.mock('../src/modules/notifications/notifications.service', () => ({
  listNotificationsFor: (...a) => mockListNotifications(...a),
  markRead: jest.fn().mockResolvedValue({ id: 1 }),
  markAllRead: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const kit = require('./admin-login-test-kit');
const { createAdminSession } = require('../src/modules/admin/auth/admin-session.service');
const { signAdminAccessToken } = require('../src/modules/admin/auth/admin-token.service');
const { signAccessToken, signRefreshToken } = require('../src/modules/auth/auth.service');
const { app } = require('../src/app');

const { db, fake, seedAdmin, seedPasskey } = kit;
const ENV_KEYS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ADMIN_PASSKEY_ENFORCEMENT'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  fake.reset();
  kit.setEnv();
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-for-legacy-rejection';
  mockUserFindUnique.mockReset().mockResolvedValue({
    id: 11, name: 'Pat Ient', email: 'pat@example.org', mobile: '+919999999999', isVerified: true, tokenVersion: 0, role: 'patient', createdAt: new Date(), updatedAt: new Date(),
  });
  mockListNotifications.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  kit.restoreEnv();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

const legacyClaims = { sub: 7, role: 'admin', adminRole: 'admin' };
const legacyAccess = (claims = legacyClaims) => signAccessToken(claims);
const legacyRefresh = (claims = legacyClaims) => signRefreshToken(claims);
const patientClaims = { sub: 11, role: 'patient', tv: 0 };
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('a legacy Admin access token on the shared authentication', () => {
  it.each(['admin', 'superadmin'])('is refused with 401 by GET /auth/me (adminRole %s)', async (adminRole) => {
    const res = await request(app).get('/auth/me').set(bearer(legacyAccess({ ...legacyClaims, adminRole })));
    expect(res.status).toBe(401);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it('is refused with 401 when it arrives in the hc_admin_token cookie', async () => {
    const res = await request(app).get('/auth/me').set('Cookie', `hc_admin_token=${legacyAccess()}`);
    expect(res.status).toBe(401);
  });

  it('is refused with 401 by every notification endpoint', async () => {
    const token = legacyAccess();
    for (const [method, path] of [['get', '/notifications'], ['post', '/notifications/1/read'], ['post', '/notifications/read-all']]) {
      const res = await request(app)[method](path).set(bearer(token));
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
    expect(mockListNotifications).not.toHaveBeenCalled();
  });

  it('is refused by the other shared-middleware routes too (role lists no longer matter)', async () => {
    const res = await request(app).get('/documents/1/file').set(bearer(legacyAccess()));
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/refresh', () => {
  it('refuses a legacy Admin refresh token with 401 and issues nothing', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: legacyRefresh() });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
  });

  it('still refreshes a patient: new tokens that work, tokenVersion checked', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: signRefreshToken(patientClaims) });
    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.token, process.env.JWT_ACCESS_SECRET)).toMatchObject({ sub: 11, role: 'patient', tv: 0 });
    expect(mockUserFindUnique).toHaveBeenCalled();

    mockUserFindUnique.mockResolvedValue({ id: 11, isVerified: true, tokenVersion: 3 });
    const stale = await request(app).post('/auth/refresh').send({ refreshToken: signRefreshToken(patientClaims) });
    expect(stale.status).toBe(401);
  });
});

describe('patient authentication is unaffected', () => {
  it('lets a patient access token through to /auth/me and /notifications', async () => {
    const token = signAccessToken(patientClaims);
    const me = await request(app).get('/auth/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: 11 });
    const list = await request(app).get('/notifications').set(bearer(token));
    expect(list.status).toBe(200);
    expect(mockListNotifications).toHaveBeenCalledWith('patient', 11, expect.anything());
  });
});

describe('Admin authentication is unaffected', () => {
  it('a new session token still works on /admin/me, and a legacy token still works there while allowed', async () => {
    const admin = seedAdmin({ role: 'superadmin' });
    const created = await fake.prisma.$transaction((tx) => createAdminSession(tx, { admin, now: new Date(), ipAddress: '203.0.113.5', userAgent: 'jest' }));
    const sessionToken = signAdminAccessToken({ adminId: admin.id, role: admin.role, sessionId: created.sessionId });
    const viaSession = await request(app).get('/admin/me').set(bearer(sessionToken));
    expect(viaSession.status).toBe(200);
    expect(viaSession.body.admin).toMatchObject({ adminRole: 'superadmin' });

    const viaLegacy = await request(app).get('/admin/me').set(bearer(legacyAccess({ sub: admin.id, role: 'admin', adminRole: 'superadmin' })));
    expect(viaLegacy.status).toBe(200); // the separate Admin middleware is untouched
    expect(db.sessions).toHaveLength(1);
  });

  it('refuses a genuine legacy token on /admin/me with 401 when ADMIN_PASSKEY_ENFORCEMENT=true', async () => {
    const admin = seedAdmin();
    const token = legacyAccess({ sub: admin.id, role: 'admin', adminRole: admin.role });
    expect((await request(app).get('/admin/me').set(bearer(token))).status).toBe(200); // control: allowed while enforcement is off

    process.env.ADMIN_PASSKEY_ENFORCEMENT = 'true';
    const res = await request(app).get('/admin/me').set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.admin).toBeUndefined();
  });

  it('refuses a genuine legacy token on /admin/me with 401 when enforcement is off but the Admin has an unrevoked passkey', async () => {
    const admin = seedAdmin();
    const token = legacyAccess({ sub: admin.id, role: 'admin', adminRole: admin.role });
    expect((await request(app).get('/admin/me').set(bearer(token))).status).toBe(200); // control: no passkey yet

    const passkey = seedPasskey(admin);
    const refused = await request(app).get('/admin/me').set(bearer(token));
    expect(refused.status).toBe(401);
    expect(refused.body.admin).toBeUndefined();

    passkey.row.revokedAt = new Date(); // only a revoked passkey left: password-only is allowed again
    expect((await request(app).get('/admin/me').set(bearer(token))).status).toBe(200);
  });
});
