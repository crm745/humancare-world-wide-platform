// Admin Lock utilities (Step 7.4): Admin audit writer and retention, Admin access tokens,
// SHA-256 token hashing and Admin login tickets. No database: Prisma is replaced by a stand-in.
const mockCreate = jest.fn();
const mockDeleteMany = jest.fn();
jest.mock('../src/db/prisma', () => ({
  prisma: { securityEvent: { create: (...a) => mockCreate(...a), deleteMany: (...a) => mockDeleteMany(...a) } },
}));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { recordAdminAuditEvent } = require('../src/modules/admin/auth/admin-audit.service');
const { purgeOldAdminAuditEvents } = require('../src/modules/admin/auth/admin-audit-retention');
const { isAdminAuditEvent } = require('../src/common/constants/admin-audit.constants');
const { purgeOldSecurityEvents } = require('../src/modules/auth/security-events');
const adminAuditPurgeJob = require('../src/jobs/admin-audit-purge.job');
const { jobs } = require('../src/jobs');
const {
  signAdminAccessToken,
  verifyAdminAccessToken,
  deriveAdminKey,
  ADMIN_TOKEN_ISSUER,
  ADMIN_ACCESS_AUDIENCE,
} = require('../src/modules/admin/auth/admin-token.service');
const {
  signAdminLoginTicket,
  readAdminLoginTicket,
  ADMIN_LOGIN_FLOWS,
  ADMIN_LOGIN_TICKET_TTL_SECONDS,
} = require('../src/modules/admin/auth/admin-login-ticket.service');
const { signAccessToken, signTicket, readTicket } = require('../src/modules/auth/auth.service');
const { hashToken } = require('../src/common/utils/token-hash');

const DAY = 24 * 60 * 60 * 1000;
const savedEnv = { secret: process.env.JWT_ACCESS_SECRET, retention: process.env.SECURITY_LOG_RETENTION_DAYS };

beforeEach(() => {
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-admin-lock-utilities';
  mockCreate.mockReset().mockResolvedValue({ id: 1 });
  mockDeleteMany.mockReset().mockResolvedValue({ count: 0 });
});

afterEach(() => {
  jest.restoreAllMocks();
  if (savedEnv.secret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = savedEnv.secret;
  if (savedEnv.retention === undefined) delete process.env.SECURITY_LOG_RETENTION_DAYS; else process.env.SECURITY_LOG_RETENTION_DAYS = savedEnv.retention;
});

function adminTokenWith(claims, options = {}) {
  return jwt.sign(claims, deriveAdminKey('humancare/admin-lock/access-token/v1'), {
    algorithm: 'HS256',
    issuer: ADMIN_TOKEN_ISSUER,
    audience: ADMIN_ACCESS_AUDIENCE,
    expiresIn: 60,
    ...options,
  });
}

describe('recordAdminAuditEvent', () => {
  it('writes through the global Prisma client with the actor and request details', async () => {
    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: 7,
      event: 'admin_login_failed',
      identifier: 'a***@example.org',
      ipAddress: '203.0.113.9',
      userAgent: 'jest',
      detail: { reason: 'wrong_password', attempt: 2 },
    });
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        event: 'admin_login_failed',
        actorType: 'admin',
        actorId: 7,
        identifier: 'a***@example.org',
        ipAddress: '203.0.113.9',
        userAgent: 'jest',
        detail: { reason: 'wrong_password', attempt: 2 },
      },
    });
  });

  it('uses a supplied transaction client instead of the global one', async () => {
    const tx = { securityEvent: { create: jest.fn().mockResolvedValue({ id: 2 }) } };
    await recordAdminAuditEvent({ actorType: 'system', event: 'admin.account_locked', db: tx });
    expect(tx.securityEvent.create).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('takes ip and user agent from a request when not given explicitly', async () => {
    const req = { ip: '198.51.100.4', get: () => 'Mozilla/5.0' };
    await recordAdminAuditEvent({ actorType: 'operator', actorId: 3, event: 'admin_disabled', req });
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({ ipAddress: '198.51.100.4', userAgent: 'Mozilla/5.0' });
  });

  it('propagates database errors instead of swallowing them', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));
    await expect(recordAdminAuditEvent({ actorType: 'admin', actorId: 1, event: 'admin_login_succeeded' })).rejects.toThrow('db down');
    const tx = { securityEvent: { create: jest.fn().mockRejectedValue(new Error('tx failed')) } };
    await expect(recordAdminAuditEvent({ actorType: 'admin', actorId: 1, event: 'x_event', db: tx })).rejects.toThrow('tx failed');
  });

  it.each([
    ['unknown actorType', { actorType: 'patient', event: 'admin_login_failed' }],
    ['missing event', { actorType: 'admin' }],
    ['badly formed event', { actorType: 'admin', event: 'Bad Event!' }],
    ['non-integer actorId', { actorType: 'admin', actorId: '7', event: 'admin_login_failed' }],
    ['system actor with an id', { actorType: 'system', actorId: 1, event: 'admin.account_locked' }],
    ['system event without the admin. prefix', { actorType: 'system', event: 'account_locked' }],
    ['system event with a lookalike prefix', { actorType: 'system', event: 'admin_account_locked' }],
    ['array detail', { actorType: 'admin', event: 'admin_login_failed', detail: [] }],
    ['secret-like detail key', { actorType: 'admin', event: 'admin_login_failed', detail: { nested: { refreshToken: 'x' } } }],
    ['credential id in detail', { actorType: 'admin', event: 'admin_login_failed', detail: { credentialId: 'x' } }],
  ])('rejects %s without writing', async (_name, input) => {
    await expect(recordAdminAuditEvent(input)).rejects.toThrow();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('allows explicitly safe metadata such as tokenVersion, and ordinary text', async () => {
    const detail = {
      tokenVersion: 4,
      previousTokenVersion: 3,
      passkeyCount: 2,
      credentialCount: 1,
      sessionCount: 0,
      reason: 'wrong_password',
      flow: 'passkey_login',
      sessionId: 12,
      ticketId: '3f2b8c1e-9d4a-4b7e-8a61-2c5d7e9f0a1b', // a UUID is an id, not a secret
      note: 'Disabled after the staff member left the company',
      nested: { attempt: 3, ok: false },
    };
    await recordAdminAuditEvent({ actorType: 'admin', actorId: 1, event: 'passkey_registered', detail });
    expect(mockCreate.mock.calls[0][0].data.detail).toEqual(detail);
  });

  it.each([
    ['a token field', { token: 'x' }],
    ['an accessToken field', { accessToken: 'x' }],
    ['a refreshToken field', { nested: { refreshToken: 'x' } }],
    ['a tokenHash field', { tokenHash: 'x' }],
    ['a password field', { password: 'x' }],
    ['a privateKey field', { privateKey: 'x' }],
    ['a publicKey field', { publicKey: 'x' }],
    ['a credentialId field', { credentialId: 'x' }],
    ['an unlisted credential field', { credential: 'x' }],
    ['an authorization field', { authorization: 'x' }],
    ['a non-numeric tokenVersion', { tokenVersion: 'abc' }],
    ['a negative tokenVersion', { tokenVersion: -1 }],
    ['a tokenVersion that smuggles a string', { tokenVersion: '4' }],
  ])('rejects %s', async (_name, detail) => {
    await expect(recordAdminAuditEvent({ actorType: 'admin', actorId: 1, event: 'x_event', detail })).rejects.toThrow();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['a bearer header', 'Bearer abc.def.ghi'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'],
    ['a SHA-256 hex digest', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['an opaque url-safe random token', crypto.randomBytes(32).toString('base64url')],
    ['a PEM private key', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'],
  ])('rejects %s as a value under an innocent key, at any depth', async (_name, value) => {
    await expect(recordAdminAuditEvent({ actorType: 'admin', actorId: 1, event: 'x_event', detail: { note: value } })).rejects.toThrow();
    await expect(recordAdminAuditEvent({ actorType: 'admin', actorId: 1, event: 'x_event', detail: { a: [{ b: value }] } })).rejects.toThrow();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not echo a rejected secret value in the error', async () => {
    const value = crypto.randomBytes(32).toString('base64url');
    const error = await recordAdminAuditEvent({ actorType: 'admin', actorId: 1, event: 'x_event', detail: { note: value } }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(value);
  });
});

describe('audit retention', () => {
  const NOW = Date.UTC(2027, 0, 1);

  // A tiny evaluator for exactly the Prisma where-operators the purges use, so the real
  // where-clauses are run against sample rows instead of only compared as text.
  function matches(row, where) {
    return Object.entries(where).every(([key, cond]) => {
      if (key === 'AND') return cond.every((c) => matches(row, c));
      if (key === 'OR') return cond.some((c) => matches(row, c));
      const value = row[key];
      if (cond === null || typeof cond !== 'object' || cond instanceof Date) return value === cond;
      return Object.entries(cond).every(([op, arg]) => {
        if (op === 'in') return arg.includes(value);
        if (op === 'notIn') return value !== null && !arg.includes(value); // SQL: NULL NOT IN (...) is not true
        if (op === 'startsWith') return typeof value === 'string' && value.startsWith(arg);
        if (op === 'not') return !matches({ [key]: value }, { [key]: arg });
        if (op === 'lt') return value < arg;
        throw new Error(`unsupported operator ${op}`);
      });
    });
  }

  const OLD = new Date(NOW - 400 * DAY);
  const RECENT = new Date(NOW - 10 * DAY);
  const rows = [
    ['patient login', { actorType: null, event: 'login_failed' }, 'shared'],
    ['patient row with a lookalike event name', { actorType: null, event: 'admin.account_locked' }, 'shared'],
    ['corporate registrant', { actorType: 'registrant', event: 'registration_submitted' }, 'shared'],
    ['corporate-review admin', { actorType: 'admin', event: 'registration_approved' }, 'admin'],
    ['admin login', { actorType: 'admin', event: 'admin_login_failed' }, 'admin'],
    ['operator action', { actorType: 'operator', event: 'admin_provisioned' }, 'admin'],
    ['Admin Lock system event', { actorType: 'system', event: 'admin.account_locked' }, 'admin'],
    ['other system event', { actorType: 'system', event: 'bitrix_retry_failed' }, 'shared'],
    ['system event with a lookalike prefix', { actorType: 'system', event: 'admin_account_locked' }, 'shared'],
  ];

  async function whereOf(purge) {
    mockDeleteMany.mockClear();
    await purge();
    return mockDeleteMany.mock.calls[0][0].where;
  }

  it('classifies each event under exactly one retention policy, old or recent', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const sharedWhere = await whereOf(() => purgeOldSecurityEvents());
    const adminWhere = await whereOf(() => purgeOldAdminAuditEvents(NOW));
    for (const [name, base, owner] of rows) {
      const old = { ...base, createdAt: OLD };
      expect({ name, shared: matches(old, sharedWhere), admin: matches(old, adminWhere) })
        .toEqual({ name, shared: owner === 'shared', admin: owner === 'admin' });
      expect(isAdminAuditEvent(base)).toBe(owner === 'admin');
      const recent = { ...base, createdAt: RECENT };
      expect(matches(recent, sharedWhere)).toBe(false);
      expect(matches(recent, adminWhere)).toBe(false);
    }
  });

  it('shared purge honours SECURITY_LOG_RETENTION_DAYS, Admin purge ignores it', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    process.env.SECURITY_LOG_RETENTION_DAYS = '200';
    const at = (days) => ({ actorType: null, event: 'login_failed', createdAt: new Date(NOW - days * DAY) });
    const adminAt = (days) => ({ actorType: 'admin', event: 'admin_login_failed', createdAt: new Date(NOW - days * DAY) });
    const sharedWhere = await whereOf(() => purgeOldSecurityEvents());
    const adminWhere = await whereOf(() => purgeOldAdminAuditEvents(NOW));
    expect(matches(at(201), sharedWhere)).toBe(true);
    expect(matches(at(199), sharedWhere)).toBe(false);
    expect(matches(adminAt(300), adminWhere)).toBe(false); // 300 days: past 200, inside 365
    expect(matches(adminAt(366), adminWhere)).toBe(true);
    delete process.env.SECURITY_LOG_RETENTION_DAYS;
    expect(matches(at(366), await whereOf(() => purgeOldSecurityEvents()))).toBe(true);
    expect(matches(at(364), await whereOf(() => purgeOldSecurityEvents()))).toBe(false);
  });

  it('Admin purge reports how many rows it deleted', async () => {
    mockDeleteMany.mockResolvedValue({ count: 4 });
    expect(await purgeOldAdminAuditEvents(NOW)).toBe(4);
  });

  it('registers the Admin purge as a daily job that runs on start', async () => {
    expect(jobs).toContain(adminAuditPurgeJob);
    expect(adminAuditPurgeJob).toMatchObject({ name: 'admin-audit-purge', intervalMs: DAY, runOnStart: true });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await adminAuditPurgeJob.run();
    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('Admin access tokens', () => {
  it('signs and verifies, returning the subject, role, session and token version', () => {
    const token = signAdminAccessToken({ adminId: 12, role: 'superadmin', sessionId: 99, tokenVersion: 3 });
    expect(verifyAdminAccessToken(token)).toEqual({ adminId: 12, role: 'superadmin', sessionId: 99, tokenVersion: 3 });
  });

  it('omits the token version when not provided', () => {
    expect(verifyAdminAccessToken(signAdminAccessToken({ adminId: 1, role: 'admin', sessionId: 5 }))).toEqual({
      adminId: 1, role: 'admin', sessionId: 5, tokenVersion: null,
    });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -3],
    ['fractional', 1.5],
    ['empty string', ''],
    ['numeric string', '12'],
    ['text', 'sess-1'],
    ['NaN', NaN],
    ['an object', {}],
  ])('refuses to sign without a valid session id (%s)', (_name, sessionId) => {
    expect(() => signAdminAccessToken({ adminId: 1, role: 'admin', sessionId })).toThrow('sessionId');
  });

  it.each([
    ['missing', {}],
    ['empty string', { sid: '' }],
    ['text', { sid: 'sess-1' }],
    ['numeric string', { sid: '12' }],
    ['zero', { sid: 0 }],
    ['negative', { sid: -1 }],
    ['fractional', { sid: 1.5 }],
    ['null', { sid: null }],
    ['an array', { sid: [1] }],
  ])('rejects a validly signed token whose session id is %s', (_name, sid) => {
    expect(verifyAdminAccessToken(adminTokenWith({ role: 'admin', ...sid }, { subject: '1' }))).toBeNull();
  });

  it('accepts the same hand-built token once the session id is valid (control)', () => {
    expect(verifyAdminAccessToken(adminTokenWith({ role: 'admin', sid: 4 }, { subject: '1' }))).toMatchObject({ sessionId: 4 });
  });

  it('expires after 15 minutes', () => {
    const token = signAdminAccessToken({ adminId: 1, role: 'admin', sessionId: 1 });
    const { exp, iat } = jwt.decode(token);
    expect(exp - iat).toBe(15 * 60);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 14 * 60 * 1000);
    expect(verifyAdminAccessToken(token)).not.toBeNull();
    Date.now.mockReturnValue(now + 16 * 60 * 1000);
    expect(verifyAdminAccessToken(token)).toBeNull();
  });

  it('rejects the wrong audience, the wrong issuer and a non-HS256 algorithm', () => {
    expect(verifyAdminAccessToken(adminTokenWith({ role: 'admin', sid: 1 }, { subject: '1', audience: 'someone-else' }))).toBeNull();
    expect(verifyAdminAccessToken(adminTokenWith({ role: 'admin', sid: 1 }, { subject: '1', issuer: 'someone-else' }))).toBeNull();
    expect(verifyAdminAccessToken(adminTokenWith({ role: 'admin', sid: 1 }, { subject: '1', algorithm: 'HS512' }))).toBeNull();
    expect(verifyAdminAccessToken(adminTokenWith({ role: 'admin', sid: 1 }, { subject: '1' }))).not.toBeNull();
  });

  it('rejects tokens missing or mangling required claims', () => {
    expect(verifyAdminAccessToken(adminTokenWith({ role: 'admin' }))).toBeNull(); // no sub
    expect(verifyAdminAccessToken(adminTokenWith({ sid: 1 }, { subject: '1' }))).toBeNull(); // no role
    expect(verifyAdminAccessToken(adminTokenWith({ role: 'patient', sid: 1 }, { subject: '1' }))).toBeNull(); // bad role
    expect(verifyAdminAccessToken(adminTokenWith({ role: 'admin', sid: 1 }, { subject: 'abc' }))).toBeNull(); // bad sub
    expect(verifyAdminAccessToken(adminTokenWith({ role: 'admin', sid: 1, tv: -1 }, { subject: '1' }))).toBeNull(); // bad tv
    const noExp = jwt.sign({ role: 'admin', sid: 1 }, deriveAdminKey('humancare/admin-lock/access-token/v1'), {
      algorithm: 'HS256', subject: '1', issuer: ADMIN_TOKEN_ISSUER, audience: ADMIN_ACCESS_AUDIENCE,
    });
    expect(verifyAdminAccessToken(noExp)).toBeNull(); // never expires
  });

  it('rejects garbage and tampered tokens', () => {
    const token = signAdminAccessToken({ adminId: 1, role: 'admin', sessionId: 1 });
    expect(verifyAdminAccessToken('')).toBeNull();
    expect(verifyAdminAccessToken(undefined)).toBeNull();
    expect(verifyAdminAccessToken('not.a.jwt')).toBeNull();
    expect(verifyAdminAccessToken(`${token.slice(0, -2)}xx`)).toBeNull();
  });

  it('is domain-separated from the shared access-token key', () => {
    const adminToken = signAdminAccessToken({ adminId: 1, role: 'admin', sessionId: 1 });
    // The shared verifier (requireAuth) uses the raw secret and so cannot read an Admin token...
    expect(() => jwt.verify(adminToken, process.env.JWT_ACCESS_SECRET)).toThrow();
    // ...and a shared access token (even one with Admin-looking claims) is not an Admin token.
    expect(verifyAdminAccessToken(signAccessToken({ sub: 1, role: 'admin', adminRole: 'superadmin' }))).toBeNull();
    // A token forged with the raw secret and the Admin audience/issuer is also refused.
    const forged = jwt.sign({ role: 'admin', sid: 1 }, process.env.JWT_ACCESS_SECRET, {
      subject: '1', issuer: ADMIN_TOKEN_ISSUER, audience: ADMIN_ACCESS_AUDIENCE, expiresIn: 60,
    });
    expect(verifyAdminAccessToken(forged)).toBeNull();
  });

  it('derives different keys per label and never uses the raw secret', () => {
    const a = deriveAdminKey('label-a');
    expect(a.equals(deriveAdminKey('label-a'))).toBe(true);
    expect(a.equals(deriveAdminKey('label-b'))).toBe(false);
    expect(a.equals(Buffer.from(process.env.JWT_ACCESS_SECRET))).toBe(false);
  });

  it('fails loudly, not as an invalid token, when the secret is missing', () => {
    delete process.env.JWT_ACCESS_SECRET;
    expect(() => signAdminAccessToken({ adminId: 1, role: 'admin', sessionId: 1 })).toThrow('JWT_ACCESS_SECRET is not set');
    expect(() => verifyAdminAccessToken('a.b.c')).toThrow('JWT_ACCESS_SECRET is not set');
  });

  it('refuses to sign with bad input', () => {
    expect(() => signAdminAccessToken({ adminId: 0, role: 'admin', sessionId: 1 })).toThrow();
    expect(() => signAdminAccessToken({ adminId: 1, role: 'patient', sessionId: 1 })).toThrow();
    expect(() => signAdminAccessToken({ adminId: 1, role: 'admin', sessionId: 1, tokenVersion: -1 })).toThrow();
  });
});

describe('hashToken', () => {
  it('returns the lowercase hex SHA-256, deterministically', () => {
    const expected = crypto.createHash('sha256').update('abc').digest('hex');
    expect(hashToken('abc')).toBe(expected);
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it.each([[''], ['   '], [' padded '], [null], [undefined], [123], [{}], [Buffer.from('x')], ['x'.repeat(4097)]])(
    'rejects invalid input %p',
    (input) => {
      expect(() => hashToken(input)).toThrow(TypeError);
    },
  );

  it('does not put the input token in its error message', () => {
    try { hashToken(` ${'s3cret'} `); } catch (err) { expect(err.message).not.toContain('s3cret'); }
  });
});

describe('Admin login tickets', () => {
  it('lasts exactly 120 seconds and reads back for the matching flow', () => {
    const ticket = signAdminLoginTicket({ adminId: 5, flow: ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN });
    const { exp, iat } = jwt.decode(ticket);
    expect(ADMIN_LOGIN_TICKET_TTL_SECONDS).toBe(120);
    expect(exp - iat).toBe(120);
    const read = readAdminLoginTicket(ticket, ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN);
    expect(read).toMatchObject({ adminId: 5, flow: 'passkey_login' });
    expect(read.ticketId).toEqual(expect.any(String));
    expect(read.expiresAt).toEqual(new Date(exp * 1000));
  });

  it('is rejected once the 120 seconds have passed', () => {
    const ticket = signAdminLoginTicket({ adminId: 5, flow: ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN });
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 119 * 1000);
    expect(readAdminLoginTicket(ticket, ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN)).not.toBeNull();
    Date.now.mockReturnValue(now + 121 * 1000);
    expect(readAdminLoginTicket(ticket, ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN)).toBeNull();
  });

  it('gives every ticket a unique id', () => {
    const a = readAdminLoginTicket(signAdminLoginTicket({ adminId: 5, flow: 'passkey_login' }), 'passkey_login');
    const b = readAdminLoginTicket(signAdminLoginTicket({ adminId: 5, flow: 'passkey_login' }), 'passkey_login');
    expect(a.ticketId).not.toBe(b.ticketId);
  });

  it('refuses a ticket for a different flow', () => {
    const ticket = signAdminLoginTicket({ adminId: 5, flow: ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN });
    expect(readAdminLoginTicket(ticket, ADMIN_LOGIN_FLOWS.PASSKEY_UNLOCK)).toBeNull();
  });

  it('refuses tickets and tokens meant for other purposes, in both directions', () => {
    const adminTicket = signAdminLoginTicket({ adminId: 5, flow: ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN });
    expect(readTicket(adminTicket, ['passkey_login'])).toBeNull(); // shared reader
    expect(readAdminLoginTicket(signTicket({ step: 'passkey_login', sub: 5 }), 'passkey_login')).toBeNull();
    expect(readAdminLoginTicket(signAdminAccessToken({ adminId: 5, role: 'admin', sessionId: 1 }), 'passkey_login')).toBeNull();
    expect(verifyAdminAccessToken(adminTicket)).toBeNull();
  });

  it('refuses bad claims, tampering and unknown input', () => {
    const key = deriveAdminKey('humancare/admin-lock/login-ticket/v1');
    const make = (claims, options = {}) => jwt.sign(claims, key, {
      algorithm: 'HS256', issuer: ADMIN_TOKEN_ISSUER, audience: 'humancare-admin-login-ticket', expiresIn: 120, ...options,
    });
    expect(readAdminLoginTicket(make({ flow: 'passkey_login' }, { jwtid: 'x' }), 'passkey_login')).toBeNull(); // no sub
    expect(readAdminLoginTicket(make({}, { subject: '5', jwtid: 'x' }), 'passkey_login')).toBeNull(); // no flow
    expect(readAdminLoginTicket(make({ flow: 'passkey_login' }, { subject: '5' }), 'passkey_login')).toBeNull(); // no jti
    expect(readAdminLoginTicket(make({ flow: 'passkey_login' }, { subject: '5', jwtid: 'x', expiresIn: 900 }), 'passkey_login')).toBeNull(); // wrong lifetime
    expect(readAdminLoginTicket(make({ flow: 'passkey_login' }, { subject: '5', jwtid: 'x', audience: 'other' }), 'passkey_login')).toBeNull();
    expect(readAdminLoginTicket(make({ flow: 'passkey_login' }, { subject: '5', jwtid: 'x' }), 'passkey_login')).not.toBeNull();
    const good = signAdminLoginTicket({ adminId: 5, flow: 'passkey_login' });
    expect(readAdminLoginTicket(`${good.slice(0, -2)}xx`, 'passkey_login')).toBeNull();
    expect(readAdminLoginTicket('', 'passkey_login')).toBeNull();
    expect(() => readAdminLoginTicket(good, 'not_a_flow')).toThrow();
    expect(() => signAdminLoginTicket({ adminId: 5, flow: 'not_a_flow' })).toThrow();
    expect(() => signAdminLoginTicket({ adminId: -1, flow: 'passkey_login' })).toThrow();
  });
});
