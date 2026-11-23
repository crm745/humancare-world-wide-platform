/* global describe, test, expect, beforeAll, afterAll */
// Per-device sessions against the REAL MySQL schema of humancare_dev (guard.js makes sure of that): the auth_sessions table, its foreign keys, cascade and indexes, and the whole session flow over HTTP
// through the real application. Only synthetic rows (a unique marker in the e-mail address) are created, and only those are deleted. No patient data is read or printed.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { prisma } = require('../../src/db/prisma');
const { app } = require('../../src/app');
const S = require('../../src/modules/auth/session.service');
const { startSession } = require('../../src/modules/auth/auth.service');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const marker = `qa-sessions-${crypto.randomBytes(6).toString('hex')}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const list = (t) => request(app).get('/auth/sessions').set(auth(t));
const refresh = (rt) => request(app).post('/auth/refresh').send({ refreshToken: rt });
const row = (id) => prisma.authSession.findUnique({ where: { id } });

let patient; let other; let corporate; let corporateUser;
const created = { users: [], corporateUsers: [], corporates: [] };
const signPatient = (user = patient, userAgent = 'devdb phone') => startSession({ claims: { sub: user.id, role: 'patient', tv: user.tokenVersion }, subjectType: S.SUBJECTS.PATIENT, subjectId: user.id, userAgent });
const signCorporate = (userAgent = 'devdb laptop') => startSession({ claims: { sub: corporateUser.id, role: 'corporate', corporateId: corporate.id }, subjectType: S.SUBJECTS.CORPORATE, subjectId: corporateUser.id, userAgent });

beforeAll(async () => {
  expect(S.sessionsAvailable()).toBe(true);
  patient = await prisma.user.create({ data: { name: 'QA Session Synthetic', email: `${marker}-a@devdb.invalid`, isVerified: true } });
  other = await prisma.user.create({ data: { name: 'QA Session Synthetic Other', email: `${marker}-b@devdb.invalid`, isVerified: true } });
  corporate = await prisma.corporate.create({ data: { companyName: `${marker} Ltd`, type: 'corporate' } });
  corporateUser = await prisma.corporateUser.create({ data: { corporateId: corporate.id, email: `${marker}-c@devdb.invalid`, passwordHash: 'x' } });
  created.users.push(patient.id, other.id); created.corporates.push(corporate.id); created.corporateUsers.push(corporateUser.id);
});

afterAll(async () => {
  // Only our own synthetic rows; sessions go with their owners (ON DELETE CASCADE, also asserted below).
  await prisma.authSession.deleteMany({ where: { OR: [{ userId: { in: created.users } }, { corporateUserId: { in: created.corporateUsers } }] } });
  await prisma.corporateUser.deleteMany({ where: { id: { in: created.corporateUsers } } });
  await prisma.corporate.deleteMany({ where: { id: { in: created.corporates } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

describe('schema (as built by the migration)', () => {
  test('the table, its foreign keys (cascade) and its indexes exist', async () => {
    const [{ c }] = await prisma.$queryRaw`SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'auth_sessions'`;
    expect(Number(c)).toBe(1);
    const fks = await prisma.$queryRaw`SELECT column_name AS col, referenced_table_name AS ref FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'auth_sessions' AND referenced_table_name IS NOT NULL`;
    expect(fks.map((f) => [f.col, f.ref]).sort()).toEqual([['corporate_user_id', 'corporate_users'], ['user_id', 'users']]);
    const rules = await prisma.$queryRaw`SELECT delete_rule AS r FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND table_name = 'auth_sessions'`;
    expect(rules.map((r) => r.r)).toEqual(['CASCADE', 'CASCADE']);
    const idx = await prisma.$queryRaw`SELECT DISTINCT index_name AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'auth_sessions'`;
    expect(idx.length).toBeGreaterThanOrEqual(4); // primary + the three declared
  });
  test('the stored session holds a 64-hex hash, never the token id', async () => {
    const a = await signPatient();
    const stored = await row(a.sessionId);
    const { jti } = jwt.verify(a.refreshToken, process.env.JWT_REFRESH_SECRET);
    expect(stored.refreshHash).toBe(S.sha256(jti));
    expect(JSON.stringify(stored)).not.toContain(jti);
    expect(stored.absoluteExpiresAt.getTime() - stored.createdAt.getTime()).toBeLessThanOrEqual(7 * DAY + 5000);
  });
  test('a user\'s sessions are deleted with the user (cascade)', async () => {
    const temp = await prisma.user.create({ data: { name: 'QA Cascade', email: `${marker}-cascade@devdb.invalid`, isVerified: true } });
    created.users.push(temp.id);
    const s = await signPatient(temp);
    await prisma.user.delete({ where: { id: temp.id } });
    expect(await row(s.sessionId)).toBeNull();
  });
});

describe('patient devices over HTTP', () => {
  test('two devices; logout of one leaves the other signed in and refreshable; the ended one cannot refresh', async () => {
    const a = await signPatient(patient, 'A');
    const b = await signPatient(patient, 'B');
    expect((await list(a.token)).status).toBe(200);
    expect((await request(app).post('/auth/logout').send({ refreshToken: a.refreshToken })).status).toBe(200);
    expect((await list(a.token)).status).toBe(401);
    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect((await list(b.token)).status).toBe(200);
    expect((await refresh(b.refreshToken)).status).toBe(200);
    expect((await row(a.sessionId)).revokedReason).toBe('logout');
    expect((await row(b.sessionId)).revokedAt).toBeNull();
    expect((await prisma.user.findUnique({ where: { id: patient.id } })).tokenVersion).toBe(patient.tokenVersion);
  });
  test('refresh rotates; a replay after the grace window revokes the session; inside the window it is tolerated', async () => {
    const a = await signPatient();
    const r1 = await refresh(a.refreshToken);
    expect(r1.status).toBe(200);
    expect((await refresh(a.refreshToken)).status).toBe(200); // inside the 60 s grace
    await prisma.authSession.update({ where: { id: a.sessionId }, data: { rotatedAt: new Date(Date.now() - 2 * MIN) } });
    const replay = await refresh(a.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('refresh_reused');
    expect((await row(a.sessionId)).revokedReason).toBe('refresh_reuse');
    expect((await list(r1.body.token)).status).toBe(401); // the thief's and the owner's tokens both stop
  });
  test('two refreshes of the same token at the same instant: neither revokes, at most one rotates', async () => {
    const a = await signPatient();
    const results = await Promise.all([refresh(a.refreshToken), refresh(a.refreshToken)]);
    const codes = results.map((r) => r.status).sort();
    expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
    expect(codes).toContain(200);
    expect((await row(a.sessionId)).revokedAt).toBeNull();
  });
  test('30 minutes idle ends the session (access and refresh); 29 minutes does not', async () => {
    const a = await signPatient();
    await prisma.authSession.update({ where: { id: a.sessionId }, data: { lastActivityAt: new Date(Date.now() - 29 * MIN) } });
    expect((await list(a.token)).status).toBe(200);
    await prisma.authSession.update({ where: { id: a.sessionId }, data: { lastActivityAt: new Date(Date.now() - 31 * MIN) } });
    const res = await list(a.token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('session_idle');
    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect((await row(a.sessionId)).revokedReason).toBe('idle');
  });
  test('after 7 days the session and its refresh token are finished, even if active a second ago', async () => {
    const a = await signPatient();
    await prisma.authSession.update({ where: { id: a.sessionId }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
    expect((await list(a.token)).body.code).toBe('session_expired');
    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect(jwt.decode(a.refreshToken).exp - jwt.decode(a.refreshToken).iat).toBeLessThanOrEqual(7 * 24 * 3600);
  });
  test('list and end devices by id; another account\'s device is a 404 and stays signed in', async () => {
    const a = await signPatient(patient, 'A');
    const b = await signPatient(patient, 'B');
    const o = await signPatient(other, 'Other');
    const res = await list(a.token);
    expect(res.status).toBe(200);
    expect(res.body.sessions.every((s) => !('refreshHash' in s))).toBe(true);
    expect(res.body.sessions.some((s) => s.current)).toBe(true);
    expect((await request(app).delete(`/auth/sessions/${o.sessionId}`).set(auth(a.token))).status).toBe(404);
    expect((await row(o.sessionId)).revokedAt).toBeNull();
    expect((await request(app).delete(`/auth/sessions/${b.sessionId}`).set(auth(a.token))).status).toBe(200);
    expect((await list(b.token)).status).toBe(401);
    const c = await signPatient(patient, 'C');
    const others = await request(app).post('/auth/sessions/revoke-others').set(auth(a.token)).send({});
    expect(others.status).toBe(200);
    expect((await row(c.sessionId)).revokedReason).toBe('others_removed');
    expect((await row(a.sessionId)).revokedAt).toBeNull();
    expect((await row(o.sessionId)).revokedAt).toBeNull();
  });
  test('revokeAllSessions (password reset / retired account) ends every device of that account only', async () => {
    const a = await signPatient(patient, 'A');
    const o = await signPatient(other, 'Other');
    expect(await S.revokeAllSessions({ subjectType: S.SUBJECTS.PATIENT, subjectId: patient.id, reason: S.REASONS.PASSWORD_RESET })).toBeGreaterThanOrEqual(1);
    expect((await list(a.token)).status).toBe(401);
    expect((await list(o.token)).status).toBe(200);
  });
  test('a token for a missing session or another owner is refused', async () => {
    const a = await signPatient();
    const forged = jwt.sign({ sub: patient.id, role: 'patient', tv: 0, sid: crypto.randomUUID() }, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    expect((await list(forged)).body.code).toBe('session_unknown');
    const wrongOwner = jwt.sign({ sub: other.id, role: 'patient', tv: 0, sid: a.sessionId }, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    expect((await list(wrongOwner)).body.code).toBe('session_unknown');
  });
});

describe('corporate sessions over HTTP', () => {
  test('a corporate session is per device, idle-limited, rotating and revocable', async () => {
    const a = await signCorporate('Laptop');
    const b = await signCorporate('Tablet');
    expect((await list(a.token)).status).toBe(200);
    const rotated = await refresh(a.refreshToken);
    expect(rotated.status).toBe(200);
    expect(jwt.decode(rotated.body.token)).toMatchObject({ role: 'corporate', corporateId: corporate.id, sid: a.sessionId });
    expect((await request(app).post('/auth/corporate/logout').send({ refreshToken: rotated.body.refreshToken })).status).toBe(200);
    expect((await list(a.token)).status).toBe(401);
    expect((await refresh(rotated.body.refreshToken)).status).toBe(401);
    expect((await list(b.token)).status).toBe(200); // the other device stays signed in
    await prisma.authSession.update({ where: { id: b.sessionId }, data: { lastActivityAt: new Date(Date.now() - 31 * MIN) } });
    expect((await list(b.token)).body.code).toBe('session_idle');
    const row1 = await row(a.sessionId);
    expect(row1.corporateUserId).toBe(corporateUser.id);
    expect(row1.userId).toBeNull();
  });
  test('the single-subject rule is enforced', async () => {
    await expect(S.createSession({ subjectType: 'nobody', subjectId: 1 })).rejects.toThrow();
  });
});

describe('legacy tokens', () => {
  test('a legacy refresh token is exchanged once for a session; legacy access tokens are refused in production unless allowed', async () => {
    const legacyRefresh = jwt.sign({ sub: patient.id, role: 'patient', tv: (await prisma.user.findUnique({ where: { id: patient.id } })).tokenVersion }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });
    const before = await prisma.authSession.count({ where: { userId: patient.id } });
    const res = await refresh(legacyRefresh);
    expect(res.status).toBe(200);
    expect(await prisma.authSession.count({ where: { userId: patient.id } })).toBe(before + 1);
    expect(jwt.decode(res.body.refreshToken).sid).toBeTruthy();

    const legacyAccess = jwt.sign({ sub: patient.id, role: 'patient', tv: 0 }, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const refused = await list(legacyAccess);
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('session_upgrade_required');
    } finally { process.env.NODE_ENV = prev; }
  });
});

describe('housekeeping', () => {
  test('purgeEndedSessions removes only long-ended sessions, and none of the other rows of this run are touched', async () => {
    const old = await signPatient(patient, 'old');
    const live = await signPatient(patient, 'live');
    await prisma.authSession.update({ where: { id: old.sessionId }, data: { revokedAt: new Date(Date.now() - 40 * DAY) } });
    await S.purgeEndedSessions();
    expect(await row(old.sessionId)).toBeNull();
    expect(await row(live.sessionId)).not.toBeNull();
  });
});
