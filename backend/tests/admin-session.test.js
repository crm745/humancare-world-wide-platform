// Admin dashboard sessions (Step 7.8.2): creation and the concurrent-session limit, database-backed
// validation and middleware, refresh-token rotation and reuse detection, and logout. No database:
// Prisma is the in-memory stand-in.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const kit = require('./admin-login-test-kit');
const {
  createAdminSession,
  validateAdminSession,
  rotateAdminRefreshToken,
  revokeAdminSession,
  AdminSessionError,
  ACTIVITY_WRITE_INTERVAL_MS,
} = require('../src/modules/admin/auth/admin-session.service');
const { requireAdminSession, requireAdminAuth } = require('../src/modules/admin/auth/admin-session.middleware');
const { signAdminAccessToken, verifyAdminAccessToken } = require('../src/modules/admin/auth/admin-token.service');
const { ADMIN_LOCK_POLICY } = require('../src/modules/admin/auth/admin-lock.config');
const { hashToken } = require('../src/common/utils/token-hash');

const { db, fake, NOW, later, seedAdmin, seedPasskey, login } = kit;
const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;

beforeEach(() => {
  fake.reset();
  db.auditClock = NOW;
  kit.setEnv();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  kit.restoreEnv();
});

// A session for `admin` made the way login makes it: inside a transaction that already holds the
// Admin row. Returns the creation result plus an access token for it.
async function makeSession(admin, now = NOW, extra = {}) {
  const created = await fake.prisma.$transaction(async (tx) => {
    await tx.adminUser.updateMany({ where: { id: admin.id }, data: { updatedAt: now } });
    return createAdminSession(tx, { admin, now, ipAddress: '203.0.113.5', userAgent: 'jest', ...extra });
  });
  return { ...created, accessToken: signAdminAccessToken({ adminId: admin.id, role: admin.role, sessionId: created.sessionId }) };
}

const sessionRow = (id) => db.sessions.find((s) => s.id === id);

describe('session creation', () => {
  it('a successful login creates exactly one session and one refresh token', async () => {
    const admin = seedAdmin();
    const passkey = seedPasskey(admin);
    const result = await login(admin, passkey, { ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0 (test)' });
    expect(db.sessions).toHaveLength(1);
    expect(db.refreshTokens).toHaveLength(1);
    expect(db.sessions[0]).toMatchObject({
      adminId: admin.id,
      lastActivityAt: NOW,
      idleExpiresAt: later(30 * MINUTE),
      absoluteExpiresAt: later(7 * DAY),
      revokedAt: null,
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (test)',
    });
    expect(result.refreshExpiresAt).toEqual(later(7 * DAY));
    expect(result.accessTokenExpiresInSeconds).toBe(900);
    expect(result.admin).toEqual({ id: admin.id, name: admin.name, email: admin.email, role: 'admin' });
  });

  it('uses the approved policy values', () => {
    expect(ADMIN_LOCK_POLICY).toMatchObject({
      sessionIdleTimeoutMs: 30 * 60 * 1000,
      sessionAbsoluteLifetimeMs: 7 * 24 * 3600 * 1000,
      maxConcurrentSessions: 2,
      accessTokenTtlMs: 15 * 60 * 1000,
      refreshTokenReuseGraceMs: 10 * 1000,
    });
  });

  it('signs an access token bound to the session, with the role read from the database', async () => {
    const admin = seedAdmin({ role: 'superadmin' });
    const result = await login(admin, seedPasskey(admin));
    const claims = verifyAdminAccessToken(result.accessToken);
    expect(claims).toMatchObject({ adminId: admin.id, role: 'superadmin', sessionId: db.sessions[0].id });
    const decoded = jwt.decode(result.accessToken);
    expect(decoded.exp - decoded.iat).toBe(900);
  });

  it('stores only the SHA-256 of the refresh token, never the token', async () => {
    const admin = seedAdmin();
    const result = await login(admin, seedPasskey(admin));
    expect(db.refreshTokens[0].tokenHash).toBe(hashToken(result.refreshToken));
    expect(db.refreshTokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.refreshTokens[0].expiresAt).toEqual(later(7 * DAY));
    expect(JSON.stringify(db)).not.toContain(result.refreshToken);
    expect(JSON.stringify(db)).not.toContain(result.accessToken);
    expect(Buffer.from(result.refreshToken, 'base64url')).toHaveLength(32);
  });

  it('truncates an over-long user agent and ignores a blank one', async () => {
    const admin = seedAdmin();
    await makeSession(admin, NOW, { userAgent: 'x'.repeat(400), ipAddress: '   ' });
    expect(db.sessions[0].userAgent).toHaveLength(255);
    expect(db.sessions[0].ipAddress).toBeNull();
  });

  describe('concurrent session limit', () => {
    it('keeps two sessions as they are', async () => {
      const admin = seedAdmin();
      const a = await makeSession(admin, NOW);
      const b = await makeSession(admin, later(60));
      expect(sessionRow(a.sessionId).revokedAt).toBeNull();
      expect(sessionRow(b.sessionId).revokedAt).toBeNull();
    });

    it('a third session revokes the oldest, with its refresh tokens, and audits it', async () => {
      const admin = seedAdmin();
      const a = await makeSession(admin, NOW);
      const b = await makeSession(admin, later(60));
      const c = await makeSession(admin, later(120));
      expect(sessionRow(a.sessionId)).toMatchObject({ revokedAt: later(120), revokedReason: 'session_limit' });
      expect(sessionRow(b.sessionId).revokedAt).toBeNull();
      expect(sessionRow(c.sessionId).revokedAt).toBeNull();
      expect(db.refreshTokens.find((t) => t.sessionId === a.sessionId).revokedAt).toEqual(later(120));
      expect(db.refreshTokens.find((t) => t.sessionId === b.sessionId).revokedAt).toBeNull();
      expect(db.audits.find((x) => x.event === 'admin.session_revoked')).toMatchObject({
        actorType: 'system', actorId: null, detail: { adminId: admin.id, sessionId: a.sessionId, reason: 'session_limit' },
      });
    });

    it('does not count sessions that are already revoked or have run out', async () => {
      const admin = seedAdmin();
      const revoked = await makeSession(admin, NOW);
      sessionRow(revoked.sessionId).revokedAt = later(1);
      const idleExpired = await makeSession(admin, later(2));
      sessionRow(idleExpired.sessionId).idleExpiresAt = later(3);
      const live = await makeSession(admin, later(60 * MINUTE));
      const another = await makeSession(admin, later(61 * MINUTE));
      expect(sessionRow(live.sessionId).revokedAt).toBeNull(); // nothing eligible was evicted
      expect(sessionRow(another.sessionId).revokedAt).toBeNull();
      expect(db.audits.filter((x) => x.event === 'admin.session_revoked')).toHaveLength(0);
    });

    it("does not touch another Admin's sessions", async () => {
      const admin = seedAdmin();
      const other = seedAdmin();
      const theirs = await makeSession(other, NOW);
      await makeSession(admin, NOW);
      await makeSession(admin, later(1));
      await makeSession(admin, later(2));
      expect(sessionRow(theirs.sessionId).revokedAt).toBeNull();
    });

    it('never leaves more than two live sessions, even when logins race', async () => {
      const admin = seedAdmin();
      await Promise.all([1, 2, 3, 4, 5].map((i) => makeSession(admin, later(i))));
      const live = db.sessions.filter((s) => !s.revokedAt);
      expect(live).toHaveLength(2);
      expect(db.sessions).toHaveLength(5);
      expect(live.map((s) => s.createdAt.getTime()).sort()).toEqual([later(4).getTime(), later(5).getTime()]); // the newest two
    });

    it('evicts via real logins too: the third login ends the first', async () => {
      const admin = seedAdmin();
      const passkey = seedPasskey(admin);
      await login(admin, passkey, { now: NOW });
      await login(admin, passkey, { now: later(60) });
      await login(admin, passkey, { now: later(120) });
      expect(db.sessions.filter((s) => !s.revokedAt)).toHaveLength(2);
      expect(db.sessions[0].revokedReason).toBe('session_limit');
    });

    it('rolls the eviction back if the audit write fails', async () => {
      const admin = seedAdmin();
      const a = await makeSession(admin, NOW);
      await makeSession(admin, later(60));
      db.failAudit = true;
      await expect(makeSession(admin, later(120))).rejects.toThrow('audit write failed');
      expect(sessionRow(a.sessionId).revokedAt).toBeNull();
      expect(db.sessions).toHaveLength(2);
    });
  });
});

describe('session validation', () => {
  it('accepts a live session and returns the Admin as the database has it', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    const live = await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(10) });
    expect(live.admin.id).toBe(admin.id);
    expect(live.session.id).toBe(s.sessionId);
  });

  it.each([[0], [-1], [1.5], ['1'], [null], [undefined]])('rejects session id %p', async (sessionId) => {
    const admin = seedAdmin();
    await makeSession(admin);
    expect(await validateAdminSession({ sessionId, adminId: admin.id, now: later(1) })).toBeNull();
  });

  it('rejects an unknown session and a session that belongs to another Admin', async () => {
    const admin = seedAdmin();
    const other = seedAdmin();
    const s = await makeSession(admin);
    expect(await validateAdminSession({ sessionId: 999, adminId: admin.id, now: later(1) })).toBeNull();
    expect(await validateAdminSession({ sessionId: s.sessionId, adminId: other.id, now: later(1) })).toBeNull();
    expect(sessionRow(s.sessionId).revokedAt).toBeNull(); // someone else's probing does not end it
  });

  it('rejects a revoked session', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    sessionRow(s.sessionId).revokedAt = later(1);
    expect(await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(2) })).toBeNull();
  });

  it('ends a session at the 30-minute idle limit (valid just before, gone at the limit)', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    expect(await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(30 * MINUTE - 1) })).not.toBeNull();
    // that call moved the idle clock forward; rewind it to test the limit itself
    sessionRow(s.sessionId).idleExpiresAt = later(30 * MINUTE);
    sessionRow(s.sessionId).lastActivityAt = later(0);
    expect(await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(30 * MINUTE) })).toBeNull();
    expect(sessionRow(s.sessionId)).toMatchObject({ revokedAt: later(30 * MINUTE), revokedReason: 'idle_timeout' });
    expect(db.refreshTokens[0].revokedAt).toEqual(later(30 * MINUTE)); // its refresh tokens die with it
  });

  it('ends a session at the 7-day absolute limit, however active it has been', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    sessionRow(s.sessionId).idleExpiresAt = later(7 * DAY + 5 * MINUTE); // idle clock would still allow it
    expect(await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(7 * DAY) })).toBeNull();
    expect(sessionRow(s.sessionId)).toMatchObject({ revokedReason: 'absolute_timeout' });
  });

  it.each(['disabled', 'pending_passkey', 'invited'])('rejects, and ends the session of, an Admin who is now %s', async (status) => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    admin.status = status;
    expect(await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(1) })).toBeNull();
    expect(sessionRow(s.sessionId)).toMatchObject({ revokedReason: 'admin_inactive' });
  });

  it('rejects an Admin who no longer exists', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    db.admins.length = 0;
    expect(await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(1) })).toBeNull();
  });

  describe('activity updates', () => {
    const activityWrites = () => fake.prisma.adminSession.updateMany.mock.calls.filter(([args]) => args.data && args.data.lastActivityAt);

    beforeEach(() => {
      const real = fake.prisma.adminSession.updateMany;
      fake.prisma.adminSession.updateMany = jest.fn(real);
    });

    it('are throttled to one per minute', async () => {
      const admin = seedAdmin();
      const s = await makeSession(admin);
      const original = fake.prisma.adminSession.updateMany; // the spy installed in beforeEach, after makeSession's own writes
      original.mockClear();
      for (const seconds of [1, 10, 30, 59]) await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(seconds) });
      expect(activityWrites()).toHaveLength(0);
      expect(sessionRow(s.sessionId).lastActivityAt).toEqual(NOW);
      expect(ACTIVITY_WRITE_INTERVAL_MS).toBe(60000);

      await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(61) });
      expect(activityWrites()).toHaveLength(1);
      expect(sessionRow(s.sessionId)).toMatchObject({ lastActivityAt: later(61), idleExpiresAt: later(61 + 30 * MINUTE) });
      await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(90) }); // 29 s later: throttled
      expect(activityWrites()).toHaveLength(1);
    });

    it('can keep a session alive for days but never past the absolute end', async () => {
      const admin = seedAdmin();
      const s = await makeSession(admin);
      const nearEnd = later(7 * DAY - 10 * MINUTE);
      sessionRow(s.sessionId).lastActivityAt = later(7 * DAY - 20 * MINUTE);
      sessionRow(s.sessionId).idleExpiresAt = later(7 * DAY + 10 * MINUTE);
      await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: nearEnd });
      expect(sessionRow(s.sessionId).idleExpiresAt).toEqual(later(7 * DAY)); // capped, not nearEnd + 30 minutes
      expect(sessionRow(s.sessionId).idleExpiresAt <= sessionRow(s.sessionId).absoluteExpiresAt).toBe(true);
    });

    it('do not revive a session that was revoked meanwhile', async () => {
      const admin = seedAdmin();
      const s = await makeSession(admin);
      const realFind = fake.prisma.adminSession.findUnique;
      fake.prisma.adminSession.findUnique = async (args) => {
        const row = await realFind(args);
        sessionRow(s.sessionId).revokedAt = later(30); // revoked right after it was read
        return row;
      };
      try {
        await validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(61) });
      } finally {
        fake.prisma.adminSession.findUnique = realFind;
      }
      expect(sessionRow(s.sessionId).lastActivityAt).toEqual(NOW);
      expect(sessionRow(s.sessionId).revokedAt).toEqual(later(30));
    });
  });
});

function fakeResponse() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

const runMiddleware = async (middleware, headers, now = later(10)) => {
  const req = { headers };
  const res = fakeResponse();
  const next = jest.fn();
  await middleware(['admin'], { now: () => now })(req, res, next);
  return { req, res, next };
};
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const legacyToken = (admin, claims = {}) => jwt.sign({ sub: admin.id, role: 'admin', adminRole: admin.role, ...claims }, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });

describe('requireAdminSession', () => {
  it('lets a live session through and shapes req.user like the existing controllers expect', async () => {
    const admin = seedAdmin({ role: 'superadmin' });
    const s = await makeSession(admin);
    const { req, next, res } = await runMiddleware(requireAdminSession, bearer(s.accessToken));
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBe(200);
    expect(req.user).toEqual({ id: admin.id, role: 'admin', corporateId: null, adminRole: 'superadmin', sessionId: s.sessionId });
  });

  it('reads the token from the cookie when there is no Authorization header, the header winning if both', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    const viaCookie = await runMiddleware(requireAdminSession, { cookie: `other=1; hc_admin_token=${encodeURIComponent(s.accessToken)}` });
    expect(viaCookie.next).toHaveBeenCalledWith();
    const both = await runMiddleware(requireAdminSession, { ...bearer('garbage'), cookie: `hc_admin_token=${s.accessToken}` });
    expect(both.res.statusCode).toBe(401);
  });

  it('takes the role from the database, not from the token', async () => {
    const admin = seedAdmin({ role: 'admin' });
    const s = await makeSession(admin);
    const forged = signAdminAccessToken({ adminId: admin.id, role: 'superadmin', sessionId: s.sessionId }); // claims superadmin
    expect((await runMiddleware(requireAdminSession, bearer(forged))).req.user.adminRole).toBe('admin');
    admin.role = 'superadmin'; // promoted since the token was issued
    expect((await runMiddleware(requireAdminSession, bearer(s.accessToken))).req.user.adminRole).toBe('superadmin');
    admin.role = 'admin'; // demoted: effective on the very next request
    expect((await runMiddleware(requireAdminSession, bearer(s.accessToken))).req.user.adminRole).toBe('admin');
  });

  it('rejects a disabled Admin immediately, even with a valid, unexpired token', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    admin.status = 'disabled';
    const { res, next } = await runMiddleware(requireAdminSession, bearer(s.accessToken));
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(sessionRow(s.sessionId).revokedReason).toBe('admin_inactive');
  });

  it('rejects revoked, idle-expired and absolute-expired sessions with the same response', async () => {
    const admin = seedAdmin();
    const revoked = await makeSession(admin, NOW);
    sessionRow(revoked.sessionId).revokedAt = later(1);
    const idle = await makeSession(admin, later(2));
    const absolute = await makeSession(admin, later(3));
    const bodies = new Set();
    for (const [token, when] of [[revoked.accessToken, later(10)], [idle.accessToken, later(2 + 31 * MINUTE)], [absolute.accessToken, later(3 + 7 * DAY)]]) {
      const { res } = await runMiddleware(requireAdminSession, bearer(token), when);
      expect(res.statusCode).toBe(401);
      bodies.add(JSON.stringify(res.body));
    }
    expect(bodies.size).toBe(1);
  });

  it("rejects a token whose session id belongs to another Admin's session", async () => {
    const admin = seedAdmin();
    const other = seedAdmin();
    const theirs = await makeSession(other);
    const token = signAdminAccessToken({ adminId: admin.id, role: 'admin', sessionId: theirs.sessionId });
    expect((await runMiddleware(requireAdminSession, bearer(token))).res.statusCode).toBe(401);
  });

  it.each([
    ['no token', {}],
    ['garbage', bearer('not.a.jwt')],
    ['an empty bearer', { authorization: 'Bearer ' }],
    ['a basic-auth header', { authorization: 'Basic abc' }],
    ['a malformed cookie', { cookie: 'hc_admin_token=%E0%A4%A' }],
  ])('rejects %s', async (_name, headers) => {
    const { res, next } = await runMiddleware(requireAdminSession, headers);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('never accepts a legacy token, an enrollment ticket or a login ticket', async () => {
    const admin = seedAdmin();
    const { signAdminLoginTicket } = require('../src/modules/admin/auth/admin-login-ticket.service');
    const { signAdminEnrollmentTicket } = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
    for (const token of [
      legacyToken(admin),
      signAdminLoginTicket({ adminId: admin.id, flow: 'passkey_login' }),
      signAdminEnrollmentTicket({ adminId: admin.id, invitationId: 1, passwordChangedAt: kit.PCA }),
    ]) {
      expect((await runMiddleware(requireAdminSession, bearer(token))).res.statusCode).toBe(401);
    }
  });

  it('refuses a role the route does not allow', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    const req = { headers: bearer(s.accessToken) };
    const res = fakeResponse();
    const next = jest.fn();
    await requireAdminSession(['patient'], { now: () => later(10) })(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes unexpected failures on as errors instead of answering', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    const req = { headers: bearer(s.accessToken) };
    const next = jest.fn();
    const boom = { adminSession: { findUnique: async () => { throw new Error('db down'); } } };
    await requireAdminSession(['admin'], { now: () => later(10), db: boom })(req, fakeResponse(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
  });
});

describe('requireAdminAuth (transition middleware)', () => {
  it('accepts a new session token exactly like requireAdminSession', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    const { req, next } = await runMiddleware(requireAdminAuth, bearer(s.accessToken));
    expect(next).toHaveBeenCalledWith();
    expect(req.user.sessionId).toBe(s.sessionId);
  });

  it('accepts a legacy token for an active Admin without a passkey while enforcement is off, role from the database', async () => {
    const admin = seedAdmin({ role: 'admin' });
    const { req, next } = await runMiddleware(requireAdminAuth, bearer(legacyToken(admin, { adminRole: 'superadmin' })));
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({ id: admin.id, role: 'admin', corporateId: null, adminRole: 'admin' }); // not the token's claim
  });

  it('never lets an enrolled Admin regain password-only access: a legacy token is refused once a live passkey exists', async () => {
    const admin = seedAdmin();
    const token = legacyToken(admin); // issued before the passkey was registered
    expect((await runMiddleware(requireAdminAuth, bearer(token))).next).toHaveBeenCalledWith();
    const passkey = seedPasskey(admin);
    expect((await runMiddleware(requireAdminAuth, bearer(token))).res.statusCode).toBe(401);
    passkey.row.revokedAt = NOW; // only revoked passkeys left: password-only is allowed again, as for the legacy login
    expect((await runMiddleware(requireAdminAuth, bearer(token))).next).toHaveBeenCalledWith();
  });

  it('refuses every legacy token once enforcement is on, but still accepts session tokens', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    process.env.ADMIN_PASSKEY_ENFORCEMENT = 'true';
    expect((await runMiddleware(requireAdminAuth, bearer(legacyToken(admin)))).res.statusCode).toBe(401);
    expect((await runMiddleware(requireAdminAuth, bearer(s.accessToken))).next).toHaveBeenCalledWith();
  });

  it.each(['disabled', 'pending_passkey', 'invited'])('refuses a legacy token for an Admin who is now %s', async (status) => {
    const admin = seedAdmin({ status });
    expect((await runMiddleware(requireAdminAuth, bearer(legacyToken(admin)))).res.statusCode).toBe(401);
  });

  it('refuses legacy tokens that are expired, forged, for another role or for a missing Admin', async () => {
    const admin = seedAdmin();
    const expired = jwt.sign({ sub: admin.id, role: 'admin' }, process.env.JWT_ACCESS_SECRET, { expiresIn: -10 });
    const forged = jwt.sign({ sub: admin.id, role: 'admin' }, 'some-other-secret', { expiresIn: '15m' });
    const patient = legacyToken(admin, { role: 'patient' });
    const ghost = legacyToken({ id: 4040, role: 'admin' });
    const nonNumeric = legacyToken(admin, { sub: 'abc' });
    for (const token of [expired, forged, patient, ghost, nonNumeric]) {
      expect((await runMiddleware(requireAdminAuth, bearer(token))).res.statusCode).toBe(401);
    }
  });

  it('does not let a revoked session token fall back to legacy handling', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    sessionRow(s.sessionId).revokedAt = later(1);
    expect((await runMiddleware(requireAdminAuth, bearer(s.accessToken))).res.statusCode).toBe(401);
  });
});

describe('logout', () => {
  it('revokes the session and all its refresh tokens, and audits it', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    const rotated = await rotateAdminRefreshToken({ refreshToken: s.refreshToken, now: later(100) });
    expect(rotated.status).toBe('rotated');
    expect(await revokeAdminSession({ sessionId: s.sessionId, adminId: admin.id, ipAddress: '203.0.113.7', now: later(200) })).toEqual({ revoked: true });
    expect(sessionRow(s.sessionId)).toMatchObject({ revokedAt: later(200), revokedReason: 'logout', revokedBy: admin.id });
    expect(db.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true);
    expect(db.audits.at(-1)).toMatchObject({ event: 'admin_logout', actorType: 'admin', actorId: admin.id, ipAddress: '203.0.113.7', detail: { sessionId: s.sessionId } });
    expect(JSON.stringify(db.audits)).not.toContain(s.refreshToken);
  });

  it('leaves the old tokens useless: the access token fails and the refresh token cannot rotate', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    await revokeAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(5) });
    expect((await runMiddleware(requireAdminSession, bearer(s.accessToken), later(6))).res.statusCode).toBe(401);
    await expect(rotateAdminRefreshToken({ refreshToken: s.refreshToken, now: later(6) })).rejects.toBeInstanceOf(AdminSessionError);
  });

  it("does not touch the Admin's other session", async () => {
    const admin = seedAdmin();
    const a = await makeSession(admin);
    const b = await makeSession(admin, later(1));
    await revokeAdminSession({ sessionId: a.sessionId, adminId: admin.id, now: later(5) });
    expect(sessionRow(b.sessionId).revokedAt).toBeNull();
    expect((await runMiddleware(requireAdminSession, bearer(b.accessToken), later(6))).next).toHaveBeenCalledWith();
  });

  it("cannot revoke another Admin's session, and is idempotent", async () => {
    const admin = seedAdmin();
    const other = seedAdmin();
    const s = await makeSession(admin);
    expect(await revokeAdminSession({ sessionId: s.sessionId, adminId: other.id, now: later(5) })).toEqual({ revoked: false });
    expect(sessionRow(s.sessionId).revokedAt).toBeNull();
    expect(await revokeAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(5) })).toEqual({ revoked: true });
    expect(await revokeAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(6) })).toEqual({ revoked: false });
    expect(sessionRow(s.sessionId).revokedAt).toEqual(later(5)); // not re-stamped
    expect(db.audits.filter((a) => a.event === 'admin_logout')).toHaveLength(1);
  });

  it('is rolled back, leaving the session alive, when the audit write fails', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    db.failAudit = true;
    await expect(revokeAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: later(5) })).rejects.toThrow('audit write failed');
    expect(sessionRow(s.sessionId).revokedAt).toBeNull();
    expect(db.refreshTokens[0].revokedAt).toBeNull();
  });

  it('returns revoked:false for unusable ids', async () => {
    for (const [sessionId, adminId] of [[0, 1], [1, 0], ['1', 1], [null, null]]) {
      expect(await revokeAdminSession({ sessionId, adminId, now: NOW })).toEqual({ revoked: false });
    }
  });
});

describe('refresh-token rotation', () => {
  const rotate = (token, now, extra = {}) => rotateAdminRefreshToken({ refreshToken: token, now, ...extra });
  const expectInvalid = async (promise) => {
    const error = await promise.then(() => null, (e) => e);
    expect(error).toBeInstanceOf(AdminSessionError);
    expect(error).toMatchObject({ code: 'invalid_session', message: 'Your session is not valid. Please sign in again.' });
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
  };

  it('exchanges an unused token for new tokens, chaining them with replacedById', async () => {
    const admin = seedAdmin({ role: 'superadmin' });
    const s = await makeSession(admin);
    const result = await rotate(s.refreshToken, later(5 * MINUTE));
    expect(result).toMatchObject({ status: 'rotated', accessTokenExpiresInSeconds: 900, refreshExpiresAt: later(7 * DAY) });
    expect(result.refreshToken).not.toBe(s.refreshToken);
    expect(verifyAdminAccessToken(result.accessToken)).toMatchObject({ adminId: admin.id, role: 'superadmin', sessionId: s.sessionId });

    const [old, fresh] = db.refreshTokens;
    expect(old).toMatchObject({ usedAt: later(5 * MINUTE), replacedById: fresh.id, revokedAt: null });
    expect(fresh).toMatchObject({ sessionId: s.sessionId, usedAt: null, expiresAt: later(7 * DAY) });
    expect(fresh.tokenHash).toBe(hashToken(result.refreshToken));
    expect(JSON.stringify(db)).not.toContain(result.refreshToken); // only the hash is stored
    expect(sessionRow(s.sessionId)).toMatchObject({ lastActivityAt: later(5 * MINUTE), idleExpiresAt: later(35 * MINUTE) });
  });

  it('takes the role from the database at refresh time', async () => {
    const admin = seedAdmin({ role: 'admin' });
    const s = await makeSession(admin);
    admin.role = 'superadmin';
    const result = await rotate(s.refreshToken, later(60));
    expect(verifyAdminAccessToken(result.accessToken).role).toBe('superadmin');
  });

  it('can be chained: the new token rotates again', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    const first = await rotate(s.refreshToken, later(60));
    const second = await rotate(first.refreshToken, later(120));
    expect(second.status).toBe('rotated');
    expect(db.refreshTokens).toHaveLength(3);
  });

  describe('reuse of an already-exchanged token', () => {
    it('within the 10-second grace returns a retry and revokes nothing', async () => {
      const admin = seedAdmin();
      const s = await makeSession(admin);
      await rotate(s.refreshToken, later(60));
      const before = JSON.stringify(db.refreshTokens);
      expect(await rotate(s.refreshToken, later(65))).toEqual({ status: 'retry' });
      expect(await rotate(s.refreshToken, later(70))).toEqual({ status: 'retry' }); // exactly 10 s
      expect(sessionRow(s.sessionId).revokedAt).toBeNull();
      expect(JSON.stringify(db.refreshTokens)).toBe(before);
      expect(db.audits.filter((a) => a.event === 'admin.refresh_reuse_detected')).toHaveLength(0);
    });

    it('after the grace revokes the session and every token in the family, and audits it', async () => {
      const admin = seedAdmin();
      const s = await makeSession(admin);
      const first = await rotate(s.refreshToken, later(60));
      await expectInvalid(rotate(s.refreshToken, new Date(later(60).getTime() + 10001)));
      expect(sessionRow(s.sessionId)).toMatchObject({ revokedReason: 'refresh_reuse' });
      expect(sessionRow(s.sessionId).revokedAt).not.toBeNull();
      expect(db.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true); // including the successor
      expect(db.audits.find((a) => a.event === 'admin.refresh_reuse_detected')).toMatchObject({
        actorType: 'system', detail: { adminId: admin.id, sessionId: s.sessionId },
      });
      // the legitimate holder of the newest token is cut off as well
      await expectInvalid(rotate(first.refreshToken, later(120)));
      expect((await runMiddleware(requireAdminSession, bearer(first.accessToken), later(120))).res.statusCode).toBe(401);
    });

    it('is not undone when the refusal is thrown: the revocation is committed', async () => {
      const admin = seedAdmin();
      const s = await makeSession(admin);
      await rotate(s.refreshToken, later(60));
      await rotate(s.refreshToken, later(100)).catch(() => {});
      expect(sessionRow(s.sessionId).revokedAt).toEqual(later(100));
    });

    it('fails loudly, leaving the session intact, if the audit of the reuse cannot be written', async () => {
      const admin = seedAdmin();
      const s = await makeSession(admin);
      await rotate(s.refreshToken, later(60));
      db.failAudit = true;
      await expect(rotate(s.refreshToken, later(100))).rejects.toThrow('audit write failed');
      expect(sessionRow(s.sessionId).revokedAt).toBeNull(); // rolled back with the audit
      expect(db.refreshTokens).toHaveLength(2); // and no new token was issued
    });
  });

  it('simultaneous use of one token: one rotation wins, the rest are told to retry, nothing is revoked', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    const results = await Promise.all([1, 2, 3, 4].map(() => rotate(s.refreshToken, later(60))));
    expect(results.filter((r) => r.status === 'rotated')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'retry')).toHaveLength(3);
    expect(db.refreshTokens).toHaveLength(2);
    expect(sessionRow(s.sessionId).revokedAt).toBeNull();
  });

  describe('refusals (all the same error)', () => {
    it.each([[undefined], [null], [''], ['short'], ['A'.repeat(43) + '!'], [12345], [{}]])('malformed token %p', async (token) => {
      await expectInvalid(rotate(token, later(1)));
    });

    it('an unknown token', async () => {
      const admin = seedAdmin();
      await makeSession(admin);
      await expectInvalid(rotate(crypto.randomBytes(32).toString('base64url'), later(1)));
    });

    it('a revoked session', async () => {
      const s = await makeSession(seedAdmin());
      sessionRow(s.sessionId).revokedAt = later(1);
      await expectInvalid(rotate(s.refreshToken, later(2)));
    });

    it('a revoked token', async () => {
      const s = await makeSession(seedAdmin());
      db.refreshTokens[0].revokedAt = later(1);
      await expectInvalid(rotate(s.refreshToken, later(2)));
      expect(sessionRow(s.sessionId).revokedAt).toBeNull();
    });

    it('an expired token row', async () => {
      const s = await makeSession(seedAdmin());
      db.refreshTokens[0].expiresAt = later(5);
      await expectInvalid(rotate(s.refreshToken, later(5)));
    });

    it('an idle-expired session, which is ended', async () => {
      const s = await makeSession(seedAdmin());
      await expectInvalid(rotate(s.refreshToken, later(30 * MINUTE)));
      expect(sessionRow(s.sessionId).revokedReason).toBe('idle_timeout');
      expect(db.refreshTokens[0].revokedAt).not.toBeNull();
    });

    it('an absolute-expired session, which is ended', async () => {
      const s = await makeSession(seedAdmin());
      sessionRow(s.sessionId).idleExpiresAt = later(8 * DAY);
      await expectInvalid(rotate(s.refreshToken, later(7 * DAY)));
      expect(sessionRow(s.sessionId).revokedReason).toBe('absolute_timeout');
    });

    it.each(['disabled', 'pending_passkey', 'invited'])('an Admin who is now %s, whose session is ended', async (status) => {
      const admin = seedAdmin();
      const s = await makeSession(admin);
      admin.status = status;
      await expectInvalid(rotate(s.refreshToken, later(60)));
      expect(sessionRow(s.sessionId).revokedReason).toBe('admin_inactive');
      expect(db.refreshTokens).toHaveLength(1); // no new token for an inactive Admin
    });

    it('has the same shape whatever the cause', async () => {
      const admin = seedAdmin();
      const live = await makeSession(admin);
      const revoked = await makeSession(admin, later(1));
      sessionRow(revoked.sessionId).revokedAt = later(2);
      const shapes = new Set();
      for (const token of [crypto.randomBytes(32).toString('base64url'), 'junk', revoked.refreshToken, live.refreshToken]) {
        const error = await rotate(token, token === live.refreshToken ? later(31 * MINUTE) : later(3)).then(() => null, (e) => e);
        shapes.add(JSON.stringify({ name: error.name, code: error.code, message: error.message, keys: Object.keys(error).sort() }));
      }
      expect(shapes.size).toBe(1);
    });
  });

  it('does not keep the old tokens usable beyond the session: the absolute end bounds every token', async () => {
    const admin = seedAdmin();
    const s = await makeSession(admin);
    const r = await rotate(s.refreshToken, later(60));
    expect(db.refreshTokens.at(-1).expiresAt).toEqual(sessionRow(s.sessionId).absoluteExpiresAt);
    expect(r.refreshExpiresAt).toEqual(later(7 * DAY));
  });

  it('keeps raw refresh tokens out of logs and audit rows', async () => {
    const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const admin = seedAdmin();
    const s = await makeSession(admin);
    const first = await rotate(s.refreshToken, later(60));
    await rotate(s.refreshToken, later(100)).catch(() => {}); // reuse -> revoke + audit
    const everywhere = JSON.stringify(db.audits) + spies.flatMap((x) => x.mock.calls).flat().map(String).join('\n');
    for (const secret of [s.refreshToken, first.refreshToken, first.accessToken, s.accessToken, hashToken(s.refreshToken)]) {
      expect(everywhere).not.toContain(secret);
    }
  });

  it('requires a root Prisma client', async () => {
    await expect(rotateAdminRefreshToken({ refreshToken: 'x'.repeat(43), db: { adminRefreshToken: {} } })).rejects.toThrow(TypeError);
    await expect(revokeAdminSession({ sessionId: 1, adminId: 1, db: { adminSession: {} } })).rejects.toThrow(TypeError);
  });
});
