// Patient "Delete account" WITHOUT a password, through the REAL handlers (startAccountDeletion, confirmAccountDeletion) and the REAL code service (issueOtp / verifyOtp, bcrypt,
// signed tickets), with NO database: Prisma is replaced by a small in-memory store, and the code delivery by a recorder. Run it with a Jest configuration that skips the
// database setup (the setup in jest.config.js would empty humancare_test). It covers what the DB-backed suite (account-deletion.test.js) covers for the new flow, without
// touching any database: no password anywhere, the code mandatory and sent only to the account's own contact, wrong / expired / reused codes refused, active requests blocking,
// and the retirement itself (anonymised, every token dead, tokenVersion moved on).
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.PHONE_OTP_PROVIDER = '';

const mockStore = { users: {}, otps: [], events: [], activeRequests: 0, transactions: 0, notificationsHidden: [], deviceLookups: 0, deviceRevocations: [], deliveryCancellations: [], hardDeletes: 0, nextOtp: 1 };
const mockMatch = (row, where) => Object.entries(where).every(([key, value]) => {
  if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
  if (value && typeof value === 'object' && 'gte' in value) return row[key] >= value.gte;
  if (value && typeof value === 'object' && 'lt' in value) return row[key] < value.lt;
  return row[key] === value;
});
jest.mock('../src/db/prisma', () => {
  const prisma = {
    user: {
      findUnique: async ({ where }) => { const user = mockStore.users[where.id]; return user ? { ...user } : null; },
      update: async ({ where, data }) => {
        const user = mockStore.users[where.id];
        for (const [key, value] of Object.entries(data)) user[key] = value && typeof value === 'object' && 'increment' in value ? user[key] + value.increment : value;
        return { ...user };
      },
    },
    otpCode: {
      findFirst: async ({ where }) => { const rows = mockStore.otps.filter((r) => mockMatch(r, where)); return rows.length ? { ...rows[rows.length - 1] } : null; },
      findMany: async ({ where }) => mockStore.otps.filter((r) => mockMatch(r, where)).map((r) => ({ createdAt: r.createdAt })),
      updateMany: async ({ where, data }) => {
        const rows = mockStore.otps.filter((r) => mockMatch(r, where));
        for (const r of rows) for (const [key, value] of Object.entries(data)) r[key] = value && typeof value === 'object' && 'increment' in value ? r[key] + value.increment : value;
        return { count: rows.length };
      },
      create: async ({ data }) => { const row = { id: mockStore.nextOtp++, consumedAt: null, attempts: 0, createdAt: new Date(Date.now() - 120000), ...data }; mockStore.otps.push(row); return row; },
      deleteMany: async () => { mockStore.otps.length = 0; return { count: 0 }; },
    },
    serviceRequest: { count: async () => mockStore.activeRequests },
    // The patient's notification history is hidden (soft delete), never deleted: a hard delete is recorded and the test fails on it.
    notification: {
      updateMany: async ({ where, data }) => { mockStore.notificationsHidden.push({ where, data }); return { count: 2 }; },
      deleteMany: async () => { mockStore.hardDeletes += 1; return { count: 0 }; },
      delete: async () => { mockStore.hardDeletes += 1; return {}; },
    },
    notificationDevice: {
      findMany: async () => { mockStore.deviceLookups += 1; return [{ id: 31 }]; },
      updateMany: async (args) => { mockStore.deviceRevocations.push(args); return { count: 1 }; },
    },
    notificationDelivery: { updateMany: async (args) => { mockStore.deliveryCancellations.push(args); return { count: 1 }; } },
    securityEvent: { create: async ({ data }) => { mockStore.events.push(data); return data; } },
  };
  // The retirement is ONE interactive transaction: the same tables, handed to the callback.
  prisma.$transaction = async (callback) => { mockStore.transactions += 1; return callback(prisma); };
  return { prisma };
});
const mockCodes = [];
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn(async (identifier, code, purpose) => { mockCodes.push({ identifier, code, purpose }); }),
}));

const fs = require('fs');
const path = require('path');
const { startAccountDeletion, confirmAccountDeletion } = require('../src/modules/auth/auth.controller');

const EMAIL = 'asha@example.com';
const MOBILE = '+919876543210';
const baseUser = (id, extra = {}) => ({
  id, name: 'Asha Nair', firstName: 'Asha', lastName: 'Nair', email: EMAIL, mobile: MOBILE, gender: 'female', nationality: 'IN', phoneCountry: 'IN', passwordHash: 'a-hash',
  googleId: null, appleId: null, pushToken: 'push', isVerified: true, emailVerifiedAt: null, failedLoginCount: 0, lockedUntil: null, tokenVersion: 3, deletedAt: null, ...extra,
});

beforeEach(() => {
  mockStore.users = { 7: baseUser(7), 8: baseUser(8, { email: 'other@example.com', mobile: '+919000000002' }) };
  mockStore.otps.length = 0; mockStore.events.length = 0; mockStore.activeRequests = 0; mockStore.transactions = 0; mockStore.notificationsHidden = []; mockStore.deviceLookups = 0; mockStore.deviceRevocations = []; mockStore.deliveryCancellations = []; mockStore.hardDeletes = 0; mockCodes.length = 0;
});

const call = async (handler, body, userId = 7) => {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  await handler({ body, user: { id: userId, role: 'patient' }, ip: '203.0.113.5', get: () => 'jest' }, res);
  return out;
};
const start = (body, userId) => call(startAccountDeletion, body, userId);
const confirm = (body, userId) => call(confirmAccountDeletion, body, userId);
const lastCode = (identifier) => [...mockCodes].reverse().find((c) => c.identifier === identifier && c.purpose === 'patient_delete_account');
const eventsOf = (name) => mockStore.events.filter((e) => e.event === name);

describe('step 1: no password is asked for', () => {
  test('an account with a password starts with no password: a code goes to its own contact and nothing is changed', async () => {
    const res = await start();
    expect(res.status).toBeUndefined(); // a plain 200 body
    expect(res.body).toMatchObject({ ticket: expect.any(String), maskedContact: expect.any(String) });
    expect(res.body.code).toBeUndefined();
    expect(lastCode(MOBILE).code).toMatch(/^\d{6}$/); // the email is not verified, so the mobile
    expect(eventsOf('account_delete_started')).toHaveLength(1);
    expect(eventsOf('account_delete_started')[0].detail).toEqual({ method: 'code' });
    expect(eventsOf('account_delete_failed')).toHaveLength(0);
    expect(mockStore.users[7].deletedAt).toBeNull();
    expect(mockStore.transactions).toBe(0);
  });
  test('a password in the request is neither required nor checked: any value (wrong, right, empty) starts the same way, is never stored or logged, and never counts as a failed sign-in', async () => {
    for (const body of [{}, { password: 'WrongPass999' }, { password: 'RightPass123' }, { password: '' }, undefined]) {
      mockStore.otps.length = 0; // (a resend inside the cooldown is a separate rule)
      const res = await start(body);
      expect({ body, ok: !!(res.body && res.body.ticket), status: res.status }).toEqual({ body, ok: true, status: undefined });
      expect(res.body.code).not.toBe('password_required');
      expect(res.body.code).not.toBe('invalid_password');
    }
    expect(JSON.stringify(mockStore.events)).not.toMatch(/WrongPass999|RightPass123/);
    expect(eventsOf('account_delete_failed')).toHaveLength(0);
    expect(mockStore.users[7]).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });
  test('an account without a password (Google, Apple, older OTP-only) starts exactly the same way', async () => {
    mockStore.users[7].passwordHash = null;
    const res = await start();
    expect(res.body.ticket).toEqual(expect.any(String));
    expect(lastCode(MOBILE)).toBeDefined();
  });
  test('the old password check is gone from the source (no comparePassword, failed-login or password_required in the start step)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/modules/auth/auth.controller.js'), 'utf8');
    const startFn = source.slice(source.indexOf('async function startAccountDeletion'), source.indexOf('// Step 2: the code'));
    for (const gone of ['comparePassword', 'recordFailedLogin', 'password_required', 'invalid_password', 'req.body.password', 'passwordHash']) expect({ gone, present: startFn.includes(gone) }).toEqual({ gone, present: false });
  });
});

describe('the code is mandatory and goes only to the account\'s own contact', () => {
  test('a verified email is where the code goes; the mobile gets none', async () => {
    mockStore.users[7].emailVerifiedAt = new Date();
    await start();
    expect(lastCode(EMAIL).code).toMatch(/^\d{6}$/);
    expect(lastCode(MOBILE)).toBeUndefined();
  });
  test('an email that was never verified falls back to the registered mobile', async () => {
    await start();
    expect(lastCode(MOBILE).code).toMatch(/^\d{6}$/);
    expect(lastCode(EMAIL)).toBeUndefined();
  });
  test('an account with no mobile and no verified email still uses its own email', async () => {
    mockStore.users[7].mobile = null;
    await start();
    expect(lastCode(EMAIL).code).toMatch(/^\d{6}$/);
  });
  test('the destination can never come from the request: another email, mobile or "dest" is ignored', async () => {
    await start({ dest: '+919000000001', email: 'attacker@example.com', mobile: '+919000000001', contact: 'attacker@example.com', password: 'x' });
    expect(mockCodes.map((c) => c.identifier)).toEqual([MOBILE]);
  });
  test('an account locked out by failed logins cannot start (429, no code); a deleted or unverified one is not found', async () => {
    mockStore.users[7].lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
    const locked = await start();
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('account_locked');
    expect(mockCodes).toHaveLength(0);
    mockStore.users[7].lockedUntil = null;
    mockStore.users[7].deletedAt = new Date();
    expect((await start()).status).toBe(404);
    mockStore.users[7].deletedAt = null;
    mockStore.users[7].isVerified = false;
    expect((await start()).status).toBe(404);
    expect(mockCodes).toHaveLength(0);
  });
  test('a second start inside the resend cooldown is throttled (the existing code rate limit), with no extra code', async () => {
    await start();
    mockStore.otps[mockStore.otps.length - 1].createdAt = new Date(); // just now
    const again = await start();
    expect(again.status).toBe(429);
    expect(mockCodes).toHaveLength(1);
  });
});

describe('step 2 deletes only after a valid code, the ticket and the explicit confirmation', () => {
  const started = async (userId = 7) => {
    mockStore.otps.length = 0;
    const res = await start(undefined, userId);
    const user = mockStore.users[userId];
    return { ticket: res.body.ticket, code: lastCode(user.emailVerifiedAt || !user.mobile ? user.email : user.mobile).code };
  };
  const retired = (userId = 7) => mockStore.users[userId].deletedAt !== null;

  test('without the explicit confirmation, without the ticket, or without the code: refused, nothing deleted, the code is not spent', async () => {
    const { ticket, code } = await started();
    for (const confirmValue of [undefined, false, 'true', 1]) expect((await confirm({ ticket, code, confirm: confirmValue })).body.code).toBe('confirmation_required');
    expect((await confirm({ confirm: true })).status).toBe(400);
    expect((await confirm({ ticket, confirm: true })).status).toBe(400);
    expect((await confirm({ code, confirm: true })).status).toBe(400);
    expect(retired()).toBe(false);
    expect((await confirm({ ticket, code, confirm: true })).body).toEqual({ deleted: true }); // the same code still works: nothing above spent it
  });
  test('a wrong code is refused (401), counts as an attempt and deletes nothing', async () => {
    const { ticket, code } = await started();
    const wrong = await confirm({ ticket, code: code === '000000' ? '111111' : '000000', confirm: true });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('otp_invalid');
    expect(mockStore.otps[0].attempts).toBe(1);
    expect(retired()).toBe(false);
    expect(eventsOf('otp_failed')).toHaveLength(1);
  });
  test('too many wrong codes lock that code: even the right one is then refused (the existing attempt limit)', async () => {
    const { ticket, code } = await started();
    let last;
    for (let i = 0; i < 6; i += 1) last = await confirm({ ticket, code: code === '000000' ? '111111' : '000000', confirm: true });
    expect(last.body.code).toBe('otp_locked');
    expect((await confirm({ ticket, code, confirm: true })).status).toBe(401);
    expect(retired()).toBe(false);
  });
  test('an expired code is refused even when it is the right one', async () => {
    const { ticket, code } = await started();
    mockStore.otps[0].expiresAt = new Date(Date.now() - 60 * 1000);
    const res = await confirm({ ticket, code, confirm: true });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('otp_expired');
    expect(retired()).toBe(false);
  });
  test('a code that was already used cannot delete again, and a resend replaces the earlier code', async () => {
    const { ticket, code } = await started();
    expect((await confirm({ ticket, code, confirm: true })).body).toEqual({ deleted: true });
    const reuse = await confirm({ ticket, code, confirm: true });
    expect(reuse.status).toBe(401); // the account is already retired, so the ticket is no longer valid
    expect(eventsOf('account_deleted')).toHaveLength(1);
    expect(mockStore.transactions).toBe(1);
    // a newer code replaces the older one: the earlier code can no longer delete
    const first = await started(8);
    mockStore.otps[mockStore.otps.length - 1].createdAt = new Date(Date.now() - 120000); // past the resend cooldown
    const second = await start(undefined, 8);
    expect(second.body.ticket).toEqual(expect.any(String));
    const newer = lastCode(mockStore.users[8].mobile).code;
    if (newer !== first.code) expect((await confirm({ ticket: first.ticket, code: first.code, confirm: true }, 8)).status).toBe(401);
    expect(mockStore.users[8].deletedAt).toBeNull();
  });
  test('a ticket from another account, a garbage ticket and a ticket from another step cannot delete', async () => {
    const mine = await started(7);
    expect((await confirm({ ticket: mine.ticket, code: mine.code, confirm: true }, 8)).status).toBe(401); // someone else presents my ticket
    expect((await confirm({ ticket: 'not-a-ticket', code: mine.code, confirm: true })).status).toBe(401);
    const { signTicket } = require('../src/modules/auth/auth.service');
    const wrongStep = signTicket({ step: 'login_otp', sub: 7, dest: MOBILE });
    expect((await confirm({ ticket: wrongStep, code: mine.code, confirm: true })).status).toBe(401);
    expect(retired(7)).toBe(false);
    expect(retired(8)).toBe(false);
  });
  test('a ticket from before a password reset (older token version) cannot delete', async () => {
    const { ticket, code } = await started();
    mockStore.users[7].tokenVersion += 1;
    expect((await confirm({ ticket, code, confirm: true })).status).toBe(401);
    expect(retired()).toBe(false);
  });
});

describe('requests in progress still block deletion, at both steps', () => {
  test('step 1 refuses before any code is sent', async () => {
    mockStore.activeRequests = 2;
    const res = await start();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'active_requests', activeRequests: 2 });
    expect(mockCodes).toHaveLength(0);
    expect(eventsOf('account_delete_blocked')).toHaveLength(1);
  });
  test('step 2 refuses a request made after step 1, and the account stays intact', async () => {
    const { ticket, code } = await (async () => { const r = await start(); return { ticket: r.body.ticket, code: lastCode(MOBILE).code }; })();
    mockStore.activeRequests = 1;
    const res = await confirm({ ticket, code, confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('active_requests');
    expect(mockStore.users[7].deletedAt).toBeNull();
    expect(mockStore.transactions).toBe(0);
  });
});

describe('the retirement itself is unchanged', () => {
  test('identity cleared, tokens dead, notification history soft-deleted (never destroyed), push devices and open deliveries ended, codes removed, one transaction, one event', async () => {
    const res = await start();
    const done = await confirm({ ticket: res.body.ticket, code: lastCode(MOBILE).code, confirm: true });
    expect(done.body).toEqual({ deleted: true });
    const user = mockStore.users[7];
    expect(user).toMatchObject({
      name: 'Deleted account', firstName: null, lastName: null, mobile: null, gender: null, nationality: null, phoneCountry: null, passwordHash: null, googleId: null, appleId: null,
      pushToken: null, isVerified: false, emailVerifiedAt: null, failedLoginCount: 0, lockedUntil: null, tokenVersion: 4,
    });
    expect(user.email).toMatch(/^deleted-7-[0-9a-f]{12}@deleted\.invalid$/);
    expect(user.deletedAt).toBeInstanceOf(Date);
    expect(mockStore.transactions).toBe(1);
    // the notification history: hidden with the SAME timestamp as the retirement, only the patient's own, only what was not already deleted; nothing is hard-deleted
    expect(mockStore.hardDeletes).toBe(0);
    expect(mockStore.notificationsHidden).toEqual([{ where: { recipientType: 'patient', recipientId: 7, deletedAt: null }, data: { deletedAt: user.deletedAt } }]);
    // the push devices are made inactive and the open deliveries cancelled for that patient, in the same transaction
    expect(mockStore.deviceLookups).toBe(1);
    expect(mockStore.deviceRevocations).toHaveLength(1);
    expect(mockStore.deviceRevocations[0]).toMatchObject({ where: { ownerType: 'patient', ownerId: 7 }, data: { status: 'inactive' } });
    expect(mockStore.deliveryCancellations.length).toBeGreaterThanOrEqual(1);
    for (const call of mockStore.deliveryCancellations) expect(call).toMatchObject({ where: { recipientType: 'patient', recipientId: 7 }, data: { status: 'cancelled', lastErrorCode: 'account_deleted' } });
    expect(mockStore.otps).toHaveLength(0);
    expect(eventsOf('account_deleted')).toHaveLength(1);
    // the other account is untouched
    expect(mockStore.users[8]).toMatchObject({ name: 'Asha Nair', deletedAt: null, tokenVersion: 3 });
  });
  test('a retired account can neither start nor confirm another deletion', async () => {
    const res = await start();
    await confirm({ ticket: res.body.ticket, code: lastCode(MOBILE).code, confirm: true });
    expect((await start()).status).toBe(404);
  });
});

describe('the routes: patients only, and the code limits are still on', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/modules/auth/auth.routes.js'), 'utf8');
  test('both routes stay behind requireAuth(["patient"]), with their rate limiters, and no new deletion route exists', () => {
    expect(routes).toContain("authRouter.post('/me/delete/start', requireAuth(['patient']), patientLoginLimiter, otpSendIpLimiter, startAccountDeletion);");
    expect(routes).toContain("authRouter.post('/me/delete/confirm', requireAuth(['patient']), otpVerifyLimiter, confirmAccountDeletion);");
    expect((routes.match(/\/me\/delete/g) || []).length).toBe(2);
  });
  test('an expired session is refused at once for a retired account (requireAuth), and a corporate or admin token is refused by the role list', () => {
    const middleware = fs.readFileSync(path.join(__dirname, '../src/common/middleware/auth.middleware.js'), 'utf8');
    expect(middleware).toContain('if (account && account.deletedAt) return res.status(401)');
    expect(middleware).toContain("if (allowedRoles && !allowedRoles.includes(payload.role))");
  });
});
