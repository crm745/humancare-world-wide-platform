// Legacy password-only Admin login (POST /admin/login) after the Admin Lock status/passkey guard.
// No database: Prisma is a mock, so these tests run under the isolated Jest configuration.
const mockFindUnique = jest.fn();
const mockPasskeyCount = jest.fn();
jest.mock('../src/db/prisma', () => ({
  prisma: {
    adminUser: { findUnique: (...a) => mockFindUnique(...a) },
    adminPasskey: { count: (...a) => mockPasskeyCount(...a) },
  },
}));

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { loginAdmin } = require('../src/modules/admin/admin.service');
const { app } = require('../src/app');

const PASSWORD = 'CorrectPass@123';
const HASH = bcrypt.hashSync(PASSWORD, 4);
const ENV_KEYS = ['ADMIN_PASSKEY_ENFORCEMENT', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function adminRow(overrides = {}) {
  return {
    id: 7,
    name: 'Asha Rao',
    email: 'asha@example.org',
    role: 'admin',
    passwordHash: HASH,
    status: 'active',
    corporateReview: false,
    failedLoginCount: 3,
    lockedUntil: new Date('2030-01-01T00:00:00Z'),
    tokenVersion: 9,
    emailVerifiedAt: new Date(),
    passwordChangedAt: new Date(),
    lastLoginAt: new Date(),
    disabledAt: null,
    disabledReason: null,
    disabledBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  process.env.JWT_ACCESS_SECRET = 'test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  delete process.env.ADMIN_PASSKEY_ENFORCEMENT;
  mockFindUnique.mockReset().mockResolvedValue(adminRow());
  mockPasskeyCount.mockReset().mockResolvedValue(0);
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('loginAdmin', () => {
  it('lets an active admin without a passkey sign in while enforcement is off', async () => {
    const result = await loginAdmin('asha@example.org', PASSWORD);
    expect(result).not.toBeNull();
    const claims = jwt.verify(result.token, process.env.JWT_ACCESS_SECRET);
    expect(claims).toMatchObject({ sub: 7, role: 'admin', adminRole: 'admin' }); // token shape unchanged
    expect(mockPasskeyCount).toHaveBeenCalledWith({ where: { adminId: 7, revokedAt: null } });
  });

  it('works for a superadmin, keeping the adminRole claim', async () => {
    mockFindUnique.mockResolvedValue(adminRow({ role: 'superadmin' }));
    const result = await loginAdmin('asha@example.org', PASSWORD);
    expect(jwt.verify(result.token, process.env.JWT_ACCESS_SECRET)).toMatchObject({ role: 'admin', adminRole: 'superadmin' });
  });

  it('rejects a wrong password', async () => {
    expect(await loginAdmin('asha@example.org', 'WrongPass@123')).toBeNull();
  });

  it('rejects an unknown email', async () => {
    mockFindUnique.mockResolvedValue(null);
    expect(await loginAdmin('nobody@example.org', PASSWORD)).toBeNull();
  });

  it('rejects a null password hash without throwing, even for the dummy placeholder password', async () => {
    mockFindUnique.mockResolvedValue(adminRow({ passwordHash: null }));
    await expect(loginAdmin('asha@example.org', PASSWORD)).resolves.toBeNull();
    await expect(loginAdmin('asha@example.org', 'no-account-placeholder')).resolves.toBeNull();
    mockFindUnique.mockResolvedValue(null);
    await expect(loginAdmin('nobody@example.org', 'no-account-placeholder')).resolves.toBeNull();
  });

  it('still compares against a hash when the account is missing or has none (uniform work)', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    mockFindUnique.mockResolvedValue(adminRow({ passwordHash: null }));
    await loginAdmin('asha@example.org', PASSWORD);
    mockFindUnique.mockResolvedValue(null);
    await loginAdmin('nobody@example.org', PASSWORD);
    expect(compare).toHaveBeenCalledTimes(2);
    compare.mockRestore();
  });

  it.each(['invited', 'pending_passkey', 'disabled', 'locked', 'something_new', null, undefined, ''])(
    'rejects status %p even with the correct password',
    async (status) => {
      mockFindUnique.mockResolvedValue(adminRow({ status }));
      expect(await loginAdmin('asha@example.org', PASSWORD)).toBeNull();
      expect(mockPasskeyCount).not.toHaveBeenCalled();
    },
  );

  it('rejects an active admin who has an unrevoked passkey', async () => {
    mockPasskeyCount.mockResolvedValue(1);
    expect(await loginAdmin('asha@example.org', PASSWORD)).toBeNull();
  });

  it('allows an active admin whose only passkeys are revoked (the query ignores revoked ones)', async () => {
    // The query asks only for revokedAt: null, so a database holding only revoked passkeys counts 0.
    mockPasskeyCount.mockImplementation(async ({ where }) => {
      const passkeys = [{ adminId: 7, revokedAt: new Date() }, { adminId: 7, revokedAt: new Date() }];
      return passkeys.filter((p) => p.adminId === where.adminId && p.revokedAt === where.revokedAt).length;
    });
    expect(await loginAdmin('asha@example.org', PASSWORD)).not.toBeNull();
  });

  it('rejects everyone when enforcement is on, passkey or not, without even counting passkeys', async () => {
    process.env.ADMIN_PASSKEY_ENFORCEMENT = 'true';
    expect(await loginAdmin('asha@example.org', PASSWORD)).toBeNull(); // no passkey
    mockPasskeyCount.mockResolvedValue(2);
    expect(await loginAdmin('asha@example.org', PASSWORD)).toBeNull(); // with passkeys
    mockFindUnique.mockResolvedValue(adminRow({ role: 'superadmin' }));
    expect(await loginAdmin('asha@example.org', PASSWORD)).toBeNull(); // superadmin too
  });

  it.each(['false', 'FALSE', '', '1', 'yes'])('treats ADMIN_PASSKEY_ENFORCEMENT=%p as off', async (value) => {
    process.env.ADMIN_PASSKEY_ENFORCEMENT = value;
    expect(await loginAdmin('asha@example.org', PASSWORD)).not.toBeNull();
  });

  it('returns only an explicit allowlist of admin fields', async () => {
    const result = await loginAdmin('asha@example.org', PASSWORD);
    expect(Object.keys(result).sort()).toEqual(['admin', 'refreshToken', 'token']);
    expect(result.admin).toEqual({ id: 7, name: 'Asha Rao', email: 'asha@example.org', role: 'admin' });
    const text = JSON.stringify(result.admin);
    for (const secret of ['passwordHash', 'failedLoginCount', 'lockedUntil', 'tokenVersion', 'status', 'disabled', 'emailVerifiedAt', HASH]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('POST /admin/login', () => {
  const login = (email, password) => request(app).post('/admin/login').send({ email, password });

  it('succeeds for an eligible admin with the existing response shape', async () => {
    const res = await login('asha@example.org', PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.admin).toEqual({ id: 7, name: 'Asha Rao', email: 'asha@example.org', role: 'admin' });
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.headers['set-cookie'].join(';')).toContain('hc_admin_token=');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|failedLoginCount|lockedUntil|tokenVersion/);
  });

  it('gives every refusal the same generic 401, with no cookie', async () => {
    const cases = [
      ['wrong password', adminRow(), 'WrongPass@123', 0],
      ['unknown email', null, PASSWORD, 0],
      ['null hash', adminRow({ passwordHash: null }), PASSWORD, 0],
      ['invited', adminRow({ status: 'invited', passwordHash: null }), PASSWORD, 0],
      ['pending_passkey', adminRow({ status: 'pending_passkey' }), PASSWORD, 0],
      ['disabled', adminRow({ status: 'disabled' }), PASSWORD, 0],
      ['has a passkey', adminRow(), PASSWORD, 1],
    ];
    const bodies = new Set();
    for (const [, row, password, passkeys] of cases) {
      mockFindUnique.mockResolvedValue(row);
      mockPasskeyCount.mockResolvedValue(passkeys);
      const res = await login('asha@example.org', password);
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      bodies.add(JSON.stringify(res.body));
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: 'Invalid credentials' })]);

    process.env.ADMIN_PASSKEY_ENFORCEMENT = 'true';
    mockFindUnique.mockResolvedValue(adminRow());
    const enforced = await login('asha@example.org', PASSWORD);
    expect(enforced.status).toBe(401);
    expect(JSON.stringify(enforced.body)).toBe(JSON.stringify({ error: 'Invalid credentials' }));
  });
});
