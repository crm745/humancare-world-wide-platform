/* global describe, test, expect, jest, beforeEach, afterEach */
// Per-device sessions for patients and corporate users, over HTTP against the REAL application, with an in-memory stand-in for Prisma (no database, no network): sign-in creates a session per device,
// refresh tokens rotate and a replayed one revokes the session, logout ends one device only, devices can be listed and ended one by one, the server enforces 30 minutes idle and 7 days, a password
// reset or a retired account ends every device, and tokens from before sessions existed are handled (exchanged once; refused in production).
jest.mock('../../src/db/prisma', () => ({ prisma: require('./fake-auth-prisma').createFakePrisma() }));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { prisma } = require('../../src/db/prisma');
const { app } = require('../../src/app');
const S = require('../../src/modules/auth/session.service');
const { startSession } = require('../../src/modules/auth/auth.service');

const REFRESH = 'test-refresh-secret-0123456789';
const ACCESS = 'test-access-secret-0123456789';
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const store = () => prisma.__store;

const patientClaims = (tv = 0) => ({ sub: 7, role: 'patient', tv });
const corporateClaims = () => ({ sub: 3, role: 'corporate', corporateId: 9 });
const signIn = (claims, subjectType, subjectId, userAgent = 'Phone A') => startSession({ claims, subjectType, subjectId, userAgent });
const patientDevice = (userAgent) => signIn(patientClaims(), S.SUBJECTS.PATIENT, 7, userAgent);
const corporateDevice = (userAgent) => signIn(corporateClaims(), S.SUBJECTS.CORPORATE, 3, userAgent);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const list = (token) => request(app).get('/auth/sessions').set(auth(token));
const refresh = (refreshToken) => request(app).post('/auth/refresh').send({ refreshToken });
const rowOf = (sessionId) => store().sessions.find((r) => r.id === sessionId);

beforeEach(() => {
  process.env.JWT_REFRESH_SECRET = REFRESH;
  process.env.JWT_ACCESS_SECRET = ACCESS;
  delete process.env.AUTH_ALLOW_LEGACY_TOKENS;
  store().users = [{ id: 7, tokenVersion: 0, isVerified: true, deletedAt: null }];
  store().corporateUsers = [{ id: 3, corporateId: 9, email: 'corp@example.invalid', mustChangePassword: false }];
  store().sessions = [];
});
afterEach(() => { delete process.env.JWT_REFRESH_SECRET; delete process.env.JWT_ACCESS_SECRET; delete process.env.AUTH_ALLOW_LEGACY_TOKENS; jest.restoreAllMocks(); });

describe('signing in creates a session per device', () => {
  test('each sign-in is its own session; both tokens carry its id; the refresh token carries a random id and expires with the session (7 days)', async () => {
    const a = await patientDevice('Phone A');
    const b = await patientDevice('Phone B');
    expect(store().sessions).toHaveLength(2);
    expect(a.sessionId).not.toBe(b.sessionId);
    const access = jwt.verify(a.token, ACCESS);
    const refreshPayload = jwt.verify(a.refreshToken, REFRESH);
    expect(access).toMatchObject({ sub: 7, role: 'patient', tv: 0, sid: a.sessionId });
    expect(refreshPayload).toMatchObject({ sub: 7, role: 'patient', tv: 0, sid: a.sessionId });
    expect(typeof refreshPayload.jti).toBe('string');
    expect(refreshPayload.jti.length).toBeGreaterThanOrEqual(32);
    expect(refreshPayload.exp - refreshPayload.iat).toBeLessThanOrEqual(7 * 24 * 3600);
    expect(refreshPayload.exp - refreshPayload.iat).toBeGreaterThan(7 * 24 * 3600 - 120);
    expect(access.exp - access.iat).toBe(15 * 60);
    expect(rowOf(a.sessionId).userAgent).toBe('Phone A');
  });
  test('only a HASH of the refresh token id is stored, never the token or the id', async () => {
    const a = await patientDevice();
    const row = rowOf(a.sessionId);
    const { jti } = jwt.verify(a.refreshToken, REFRESH);
    expect(row.refreshHash).toBe(S.sha256(jti));
    expect(JSON.stringify(row)).not.toContain(jti);
    expect(JSON.stringify(row)).not.toContain(a.refreshToken);
    expect(row.refreshHash).toMatch(/^[0-9a-f]{64}$/);
  });
  test('a corporate sign-in is a session of the corporate user (exactly one subject)', async () => {
    const c = await corporateDevice();
    const row = rowOf(c.sessionId);
    expect(row.corporateUserId).toBe(3);
    expect(row.userId).toBeNull();
    await expect(S.createSession({ subjectType: 'admin', subjectId: 1 })).rejects.toThrow();
    await expect(S.createSession({ subjectType: S.SUBJECTS.PATIENT, subjectId: 'x' })).rejects.toThrow();
  });
  test('the refresh-token policy is 7 days (not 30)', () => {
    expect(S.SESSION_LIFETIME_MS).toBe(7 * DAY);
    expect(S.IDLE_MS).toBe(30 * MIN);
  });
});

describe('a session is checked on every request', () => {
  test('a live session works', async () => {
    const a = await patientDevice();
    const res = await list(a.token);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
  });
  test('idle for 30 minutes: refused with a code, the session is ended, and refresh is refused too', async () => {
    const a = await patientDevice();
    rowOf(a.sessionId).lastActivityAt = new Date(Date.now() - 31 * MIN);
    const res = await list(a.token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('session_idle');
    expect(rowOf(a.sessionId)).toMatchObject({ revokedReason: 'idle' });
    expect(rowOf(a.sessionId).revokedAt).toBeInstanceOf(Date);
    expect((await refresh(a.refreshToken)).status).toBe(401);
  });
  test('29 minutes idle is still fine, and the request counts as activity (written at most once a minute)', async () => {
    const a = await patientDevice();
    const before = new Date(Date.now() - 29 * MIN);
    rowOf(a.sessionId).lastActivityAt = before;
    expect((await list(a.token)).status).toBe(200);
    expect(rowOf(a.sessionId).lastActivityAt.getTime()).toBeGreaterThan(before.getTime() + 28 * MIN);
    const stamped = rowOf(a.sessionId).lastActivityAt;
    await list(a.token);
    expect(rowOf(a.sessionId).lastActivityAt).toBe(stamped); // within the minute: not written again
  });
  test('older than 7 days: refused even if it was used a second ago', async () => {
    const a = await patientDevice();
    rowOf(a.sessionId).absoluteExpiresAt = new Date(Date.now() - 1000);
    const res = await list(a.token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('session_expired');
  });
  test('a revoked session is refused at once (not when the 15-minute access token runs out)', async () => {
    const a = await patientDevice();
    rowOf(a.sessionId).revokedAt = new Date();
    const res = await list(a.token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('session_revoked');
  });
  test('a token for a session that does not exist, or that belongs to someone else, is refused', async () => {
    const a = await patientDevice();
    const forged = jwt.sign({ sub: 7, role: 'patient', tv: 0, sid: '11111111-1111-4111-8111-111111111111' }, ACCESS, { expiresIn: '15m' });
    expect((await list(forged)).body.code).toBe('session_unknown');
    const wrongOwner = jwt.sign({ sub: 8, role: 'patient', tv: 0, sid: a.sessionId }, ACCESS, { expiresIn: '15m' });
    expect((await list(wrongOwner)).body.code).toBe('session_unknown');
    const wrongRole = jwt.sign({ sub: 7, role: 'corporate', corporateId: 1, sid: a.sessionId }, ACCESS, { expiresIn: '15m' });
    expect((await list(wrongRole)).body.code).toBe('session_unknown');
    const notAnId = jwt.sign({ sub: 7, role: 'patient', tv: 0, sid: 'abc' }, ACCESS, { expiresIn: '15m' });
    expect((await list(notAnId)).status).toBe(401);
  });
  test('a corporate session is checked the same way', async () => {
    const c = await corporateDevice();
    expect((await list(c.token)).status).toBe(200);
    rowOf(c.sessionId).lastActivityAt = new Date(Date.now() - 31 * MIN);
    expect((await list(c.token)).body.code).toBe('session_idle');
  });
});

describe('refresh tokens rotate', () => {
  test('a refresh returns a NEW pair for the same session; the new refresh token has a new id and works; the old one is the "previous" one', async () => {
    const a = await patientDevice();
    const first = jwt.verify(a.refreshToken, REFRESH);
    const res = await refresh(a.refreshToken);
    expect(res.status).toBe(200);
    const next = jwt.verify(res.body.refreshToken, REFRESH);
    expect(next.sid).toBe(a.sessionId);
    expect(next.jti).not.toBe(first.jti);
    expect(jwt.verify(res.body.token, ACCESS).sid).toBe(a.sessionId);
    const row = rowOf(a.sessionId);
    expect(row.refreshHash).toBe(S.sha256(next.jti));
    expect(row.previousHash).toBe(S.sha256(first.jti));
    expect((await refresh(res.body.refreshToken)).status).toBe(200); // the new one keeps working
  });
  test('the previous token still works inside the 60-second grace window (a lost answer must not log the person out)', async () => {
    const a = await patientDevice();
    expect((await refresh(a.refreshToken)).status).toBe(200);
    expect((await refresh(a.refreshToken)).status).toBe(200); // the answer was lost: the client tries the old one again
    expect(rowOf(a.sessionId).revokedAt).toBeNull();
  });
  test('an old token replayed AFTER the window revokes the whole session (someone has a copy)', async () => {
    const a = await patientDevice();
    const stolen = a.refreshToken;
    expect((await refresh(stolen)).status).toBe(200);
    rowOf(a.sessionId).rotatedAt = new Date(Date.now() - 2 * MIN);
    const res = await refresh(stolen);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('refresh_reused');
    expect(rowOf(a.sessionId)).toMatchObject({ revokedReason: 'refresh_reuse' });
    const current = rowOf(a.sessionId);
    expect(current.revokedAt).toBeInstanceOf(Date);
  });
  test('a token two rotations old is a reuse at once', async () => {
    const a = await patientDevice();
    const r1 = await refresh(a.refreshToken);
    const r2 = await refresh(r1.body.refreshToken);
    expect(r2.status).toBe(200);
    const res = await refresh(a.refreshToken); // two rotations back
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('refresh_reused');
  });
  test('a refresh that loses a race with another refresh of the same token is a 409, and revokes nothing', async () => {
    const a = await patientDevice();
    const original = prisma.authSession.updateMany.getMockImplementation();
    let raced = false;
    prisma.authSession.updateMany.mockImplementation(async (args) => {
      if (!raced && args.data && args.data.refreshHash) { raced = true; rowOf(a.sessionId).refreshHash = 'f'.repeat(64); } // another request rotated it between our read and our write
      return original(args);
    });
    const res = await refresh(a.refreshToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('refresh_conflict');
    expect(rowOf(a.sessionId).revokedAt).toBeNull();
  });
  test('refresh is refused when the session is revoked, idle or expired, and the token cannot outlive its session', async () => {
    const a = await patientDevice();
    expect(jwt.verify(a.refreshToken, REFRESH).exp * 1000).toBeLessThanOrEqual(rowOf(a.sessionId).absoluteExpiresAt.getTime() + 1000);
    rowOf(a.sessionId).absoluteExpiresAt = new Date(Date.now() - 1000);
    expect((await refresh(a.refreshToken)).body.code).toBe('session_expired');
    const b = await patientDevice();
    rowOf(b.sessionId).revokedAt = new Date();
    expect((await refresh(b.refreshToken)).body.code).toBe('session_revoked');
    const c = await patientDevice();
    rowOf(c.sessionId).lastActivityAt = new Date(Date.now() - 40 * MIN);
    expect((await refresh(c.refreshToken)).body.code).toBe('session_idle');
  });
  test('the patient checks still apply: a password reset (tokenVersion) or a retired account refuses the refresh', async () => {
    const a = await patientDevice();
    store().users[0].tokenVersion = 1;
    expect((await refresh(a.refreshToken)).status).toBe(401);
    store().users[0].tokenVersion = 0;
    store().users[0].deletedAt = new Date();
    expect((await refresh(a.refreshToken)).status).toBe(401);
  });
  test('a corporate refresh rotates too, and keeps the first-login restriction decided by the database', async () => {
    const c = await corporateDevice();
    store().corporateUsers[0].mustChangePassword = true;
    const res = await refresh(c.refreshToken);
    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.token, ACCESS)).toMatchObject({ role: 'corporate', corporateId: 9, pwc: true, sid: c.sessionId });
  });
});

describe('logout ends ONE device', () => {
  test('logging out with a refresh token ends that session and no other; its tokens stop working at once', async () => {
    const a = await patientDevice('Phone A');
    const b = await patientDevice('Phone B');
    const res = await request(app).post('/auth/logout').send({ refreshToken: a.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Logged out.' });
    expect(rowOf(a.sessionId)).toMatchObject({ revokedReason: 'logout' });
    expect(rowOf(b.sessionId).revokedAt).toBeNull();
    expect((await list(a.token)).status).toBe(401); // the access token of the ended device is refused at once
    expect((await refresh(a.refreshToken)).status).toBe(401); // and so is its refresh token: no further refresh
    expect((await list(b.token)).status).toBe(200); // the other device is untouched
    expect((await refresh(b.refreshToken)).status).toBe(200);
    expect(store().users[0].tokenVersion).toBe(0); // no global sign-out
  });
  test('the Bearer access token alone can sign the device out (no refresh token at hand)', async () => {
    const a = await patientDevice();
    const res = await request(app).post('/auth/logout').set(auth(a.token)).send({});
    expect(res.status).toBe(200);
    expect(rowOf(a.sessionId).revokedAt).toBeInstanceOf(Date);
  });
  test('logging out twice, with an expired token, a forged one or another account\'s revokes nothing more and answers the same', async () => {
    const a = await patientDevice();
    const b = await patientDevice();
    await request(app).post('/auth/logout').send({ refreshToken: a.refreshToken });
    const again = await request(app).post('/auth/logout').send({ refreshToken: a.refreshToken });
    expect(again.status).toBe(200);
    const forged = jwt.sign({ sub: 7, role: 'patient', tv: 0, sid: b.sessionId, jti: 'x' }, 'another-secret', { expiresIn: '7d' });
    expect((await request(app).post('/auth/logout').send({ refreshToken: forged })).status).toBe(200);
    expect(rowOf(b.sessionId).revokedAt).toBeNull();
    const expired = jwt.sign({ sub: 7, role: 'patient', tv: 0, sid: b.sessionId, jti: 'x' }, REFRESH, { expiresIn: -10 });
    expect((await request(app).post('/auth/logout').send({ refreshToken: expired })).status).toBe(200);
    expect(rowOf(b.sessionId).revokedAt).toBeNull();
    const asOther = jwt.sign({ sub: 8, role: 'patient', tv: 0, sid: b.sessionId, jti: 'x' }, REFRESH, { expiresIn: '7d' });
    expect((await request(app).post('/auth/logout').send({ refreshToken: asOther })).status).toBe(200);
    expect(rowOf(b.sessionId).revokedAt).toBeNull(); // 8 cannot end 7's session by naming its id
  });
  test('no token at all is a 400 on the patient endpoint; the corporate endpoint stays always-200', async () => {
    expect((await request(app).post('/auth/logout').send({})).status).toBe(400);
    expect((await request(app).post('/auth/corporate/logout').send({})).status).toBe(200);
  });
  test('corporate logout ends the corporate session; patient and corporate sessions do not mix', async () => {
    const c = await corporateDevice();
    const p = await patientDevice();
    expect((await request(app).post('/auth/corporate/logout').send({ refreshToken: c.refreshToken })).status).toBe(200);
    expect(rowOf(c.sessionId).revokedReason).toBe('logout');
    expect(rowOf(p.sessionId).revokedAt).toBeNull();
    expect((await refresh(c.refreshToken)).status).toBe(401);
  });
  test('a token from before sessions existed falls back to the old sign-out (tokenVersion moves on)', async () => {
    const legacy = jwt.sign({ sub: 7, role: 'patient', tv: 0 }, REFRESH, { expiresIn: '30d' });
    expect((await request(app).post('/auth/logout').send({ refreshToken: legacy })).status).toBe(200);
    expect(store().users[0].tokenVersion).toBe(1);
  });
});

describe('the list of signed-in devices', () => {
  test('lists this account\'s live devices, newest activity first, marks the caller\'s, and never shows another account\'s', async () => {
    const a = await patientDevice('Phone A');
    const b = await patientDevice('Phone B');
    await signIn({ sub: 8, role: 'patient', tv: 0 }, S.SUBJECTS.PATIENT, 8, 'Somebody else');
    rowOf(a.sessionId).lastActivityAt = new Date(Date.now() - 5 * MIN);
    const res = await list(b.token);
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s) => [s.device, s.current])).toEqual([['Phone B', true], ['Phone A', false]]);
    expect(Object.keys(res.body.sessions[0]).sort()).toEqual(['createdAt', 'current', 'device', 'expiresAt', 'id', 'lastActivityAt']); // nothing secret: no hashes
  });
  test('ended, idle and expired sessions are not listed', async () => {
    const a = await patientDevice('A');
    const gone = await patientDevice('revoked');
    const idle = await patientDevice('idle');
    const old = await patientDevice('old');
    rowOf(gone.sessionId).revokedAt = new Date();
    rowOf(idle.sessionId).lastActivityAt = new Date(Date.now() - 45 * MIN);
    rowOf(old.sessionId).absoluteExpiresAt = new Date(Date.now() - 1000);
    expect((await list(a.token)).body.sessions.map((s) => s.device)).toEqual(['A']);
  });
  test('signing out one device by id ends only it; its own tokens stop at once; another account\'s id is a 404 like an unknown one', async () => {
    const a = await patientDevice('A');
    const b = await patientDevice('B');
    const other = await signIn({ sub: 8, role: 'patient', tv: 0 }, S.SUBJECTS.PATIENT, 8, 'Other');
    const res = await request(app).delete(`/auth/sessions/${b.sessionId}`).set(auth(a.token));
    expect(res.status).toBe(200);
    expect(res.body.current).toBe(false);
    expect(rowOf(b.sessionId)).toMatchObject({ revokedReason: 'device_removed' });
    expect((await list(b.token)).status).toBe(401);
    expect((await list(a.token)).status).toBe(200);
    expect((await request(app).delete(`/auth/sessions/${other.sessionId}`).set(auth(a.token))).status).toBe(404);
    expect(rowOf(other.sessionId).revokedAt).toBeNull();
    expect((await request(app).delete('/auth/sessions/11111111-1111-4111-8111-111111111111').set(auth(a.token))).status).toBe(404);
    expect((await request(app).delete('/auth/sessions/not-an-id').set(auth(a.token))).status).toBe(404);
    expect((await request(app).delete(`/auth/sessions/${b.sessionId}`).set(auth(a.token))).status).toBe(404); // already ended
  });
  test('signing out the current device by id says so', async () => {
    const a = await patientDevice();
    const res = await request(app).delete(`/auth/sessions/${a.sessionId}`).set(auth(a.token));
    expect(res.status).toBe(200);
    expect(res.body.current).toBe(true);
  });
  test('"sign out all the others" keeps the caller\'s session', async () => {
    const a = await patientDevice('A');
    const b = await patientDevice('B');
    const c = await patientDevice('C');
    const res = await request(app).post('/auth/sessions/revoke-others').set(auth(a.token)).send({});
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(2);
    expect(rowOf(a.sessionId).revokedAt).toBeNull();
    expect(rowOf(b.sessionId).revokedReason).toBe('others_removed');
    expect(rowOf(c.sessionId).revokedReason).toBe('others_removed');
  });
  test('the endpoints need a signed-in patient or corporate user', async () => {
    expect((await request(app).get('/auth/sessions')).status).toBe(401);
    expect((await request(app).delete('/auth/sessions/11111111-1111-4111-8111-111111111111')).status).toBe(401);
    expect((await request(app).post('/auth/sessions/revoke-others').send({})).status).toBe(401);
  });
  test('a corporate user manages their own devices only', async () => {
    const c1 = await corporateDevice('Laptop');
    const c2 = await corporateDevice('Tablet');
    const p = await patientDevice('Phone');
    expect((await list(c1.token)).body.sessions.map((s) => s.device).sort()).toEqual(['Laptop', 'Tablet']);
    expect((await request(app).delete(`/auth/sessions/${p.sessionId}`).set(auth(c1.token))).status).toBe(404);
    expect((await request(app).delete(`/auth/sessions/${c2.sessionId}`).set(auth(c1.token))).status).toBe(200);
  });
});

describe('ending every device', () => {
  test('revokeAllSessions ends every live session of the account (and only that account)', async () => {
    const a = await patientDevice();
    const b = await patientDevice();
    const other = await signIn({ sub: 8, role: 'patient', tv: 0 }, S.SUBJECTS.PATIENT, 8);
    const count = await S.revokeAllSessions({ subjectType: S.SUBJECTS.PATIENT, subjectId: 7, reason: S.REASONS.PASSWORD_RESET });
    expect(count).toBe(2);
    expect(rowOf(a.sessionId).revokedReason).toBe('password_reset');
    expect(rowOf(b.sessionId).revokedReason).toBe('password_reset');
    expect(rowOf(other.sessionId).revokedAt).toBeNull();
    expect(await S.revokeAllSessions({ subjectType: S.SUBJECTS.PATIENT, subjectId: 7, reason: 'again' })).toBe(0); // nothing live left; reasons already recorded stay
    expect(rowOf(a.sessionId).revokedReason).toBe('password_reset');
  });
  test('the password reset and the account retirement code paths call it (source check)', () => {
    const controller = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'modules', 'auth', 'auth.controller.js'), 'utf8');
    expect(controller).toContain('sessions.revokeAllSessions({ subjectType: sessions.SUBJECTS.PATIENT, subjectId: step.sub, reason: sessions.REASONS.PASSWORD_RESET })');
    expect(controller).toContain('sessions.revokeAllSessions({ subjectType: sessions.SUBJECTS.PATIENT, subjectId: user.id, reason: sessions.REASONS.ACCOUNT_RETIRED })');
    expect(controller).toContain('sessions.revokeAllSessions({ subjectType: sessions.SUBJECTS.CORPORATE, subjectId: corporateUser.id, reason: sessions.REASONS.PASSWORD_RESET })');
    expect(controller).toContain('reason: sessions.REASONS.PASSWORD_CHANGED, exceptSessionId: current');
  });
});

describe('tokens from before sessions existed', () => {
  const legacyRefresh = (claims = patientClaims()) => jwt.sign(claims, REFRESH, { expiresIn: '30d' });
  const legacyAccess = (claims = patientClaims()) => jwt.sign(claims, ACCESS, { expiresIn: '15m' });
  test('a legacy refresh token is exchanged ONCE for a session (all the old checks apply); the new pair is session-bound and rotating', async () => {
    const res = await refresh(legacyRefresh());
    expect(res.status).toBe(200);
    expect(store().sessions).toHaveLength(1);
    const payload = jwt.verify(res.body.refreshToken, REFRESH);
    expect(payload.sid).toBe(store().sessions[0].id);
    expect((await refresh(res.body.refreshToken)).status).toBe(200);
    expect(store().sessions).toHaveLength(1); // the second refresh rotated; it did not create another session
  });
  test('a legacy refresh token of a retired account or after a password reset is still refused', async () => {
    store().users[0].tokenVersion = 2;
    expect((await refresh(legacyRefresh())).status).toBe(401);
    expect(store().sessions).toHaveLength(0);
  });
  test('outside production a legacy access token still works (the existing tests and a half-upgraded setup)', async () => {
    expect((await list(legacyAccess())).status).toBe(200);
  });
  test('in production it is refused with a code that tells the app to refresh, and AUTH_ALLOW_LEGACY_TOKENS can change that either way', async () => {
    process.env.NODE_ENV = 'production';
    try {
      expect(S.legacyAccessTokensAllowed(process.env)).toBe(false);
      const res = await list(legacyAccess());
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('session_upgrade_required');
      process.env.AUTH_ALLOW_LEGACY_TOKENS = 'true';
      expect((await list(legacyAccess())).status).toBe(200);
    } finally { process.env.NODE_ENV = 'test'; delete process.env.AUTH_ALLOW_LEGACY_TOKENS; }
    process.env.AUTH_ALLOW_LEGACY_TOKENS = 'false';
    expect((await list(legacyAccess())).status).toBe(401); // refused outside production when asked to
  });
  test('an admin token is never accepted here (unchanged)', async () => {
    const admin = jwt.sign({ sub: 1, role: 'admin' }, ACCESS, { expiresIn: '15m' });
    expect((await list(admin)).status).toBe(401);
  });
});

describe('when the sessions table is not available (the Prisma client was not regenerated)', () => {
  test('development keeps working on legacy tokens; production refuses to start', async () => {
    const saved = prisma.authSession;
    delete prisma.authSession;
    try {
      expect(S.sessionsAvailable()).toBe(false);
      const pair = await startSession({ claims: patientClaims(), subjectType: S.SUBJECTS.PATIENT, subjectId: 7 });
      expect(pair.sessionId).toBeNull();
      expect(jwt.verify(pair.refreshToken, REFRESH).sid).toBeUndefined();
      expect(() => S.assertSessionsReady({ NODE_ENV: 'production' })).toThrow(/prisma generate/);
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(S.assertSessionsReady({ NODE_ENV: 'development' })).toBe(false);
      // a session-bound token cannot be honoured without the table: refused, not trusted
      const bound = jwt.sign({ sub: 7, role: 'patient', tv: 0, sid: '11111111-1111-4111-8111-111111111111' }, ACCESS, { expiresIn: '15m' });
      expect((await list(bound)).status).toBe(401);
    } finally { prisma.authSession = saved; }
  });
});

describe('housekeeping', () => {
  test('purgeEndedSessions removes sessions that ended or expired more than 30 days ago, and only those', async () => {
    const live = await patientDevice('live');
    const longGone = await patientDevice('long gone');
    const recentlyEnded = await patientDevice('recent');
    const expiredLong = await patientDevice('expired');
    rowOf(longGone.sessionId).revokedAt = new Date(Date.now() - 40 * DAY);
    rowOf(recentlyEnded.sessionId).revokedAt = new Date(Date.now() - 2 * DAY);
    rowOf(expiredLong.sessionId).absoluteExpiresAt = new Date(Date.now() - 45 * DAY);
    expect(await S.purgeEndedSessions()).toBe(2);
    expect(store().sessions.map((r) => r.userAgent).sort()).toEqual(['live', 'recent']);
    expect(rowOf(live.sessionId)).toBeTruthy();
  });
});
