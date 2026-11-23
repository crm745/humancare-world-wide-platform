/* global describe, test, expect, jest, beforeEach, afterEach */
// Per-patient rate limits on POST /requests and the document upload (POST /requests/me/:id/documents), over HTTP against the REAL app, routes, authentication and limiters. The request controller is
// replaced by counting stubs (what the controller does is covered by its own suites): what is tested here is WHO is counted, WHEN, and what a refused call costs. No database, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: require('./fake-auth-prisma').createFakePrisma() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  const counting = () => (_req, _res, next) => { global.__multerRuns = (global.__multerRuns || 0) + 1; next(); };
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: counting, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/modules/requests/requests.controller', () => {
  const answer = (name, status) => (req, res) => { global.__controllerCalls = global.__controllerCalls || {}; global.__controllerCalls[name] = (global.__controllerCalls[name] || 0) + 1; res.status(status).json({ ok: true, by: req.user.id }); };
  return {
    submitRequest: answer('submit', 201), listMyRequests: answer('list', 200), getMyRequestById: answer('get', 200), getMyRequestByClientRequestId: answer('check', 200),
    listMyDocuments: answer('docs', 200), uploadRequestDocument: answer('upload', 201), downloadRequestSummary: answer('summary', 200),
  };
});

const request = require('supertest');
const { prisma } = require('../../src/db/prisma');
const { app } = require('../../src/app');
const S = require('../../src/modules/auth/session.service');
const { startSession } = require('../../src/modules/auth/auth.service');
const { requestSubmitLimiters, requestUploadLimiters } = require('../../src/common/middleware/rate-limit.middleware');

const SECRET_REFRESH = 'test-refresh-secret-0123456789';
const SECRET_ACCESS = 'test-access-secret-0123456789';
const calls = (name) => (global.__controllerCalls || {})[name] || 0;
const patientToken = async (id) => (await startSession({ claims: { sub: id, role: 'patient', tv: 0 }, subjectType: S.SUBJECTS.PATIENT, subjectId: id, userAgent: 'test' })).token;
const corporateToken = async () => (await startSession({ claims: { sub: 3, role: 'corporate', corporateId: 9 }, subjectType: S.SUBJECTS.CORPORATE, subjectId: 3 })).token;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const submit = (t, body = { serviceKey: 'ground' }) => request(app).post('/requests').set(auth(t)).send(body);
const upload = (t, id = 1) => request(app).post(`/requests/me/${id}/documents`).set(auth(t)).send({});
const repeat = async (n, fn) => { const out = []; for (let i = 0; i < n; i += 1) out.push((await fn(i)).status); return out; };
const resetAll = async () => { for (const l of [...requestSubmitLimiters, ...requestUploadLimiters]) for (const k of ['patient:7', 'patient:8', 'patient:9']) await l.resetKey(k); };

let a; let b;
beforeEach(async () => {
  process.env.JWT_REFRESH_SECRET = SECRET_REFRESH;
  process.env.JWT_ACCESS_SECRET = SECRET_ACCESS;
  process.env.RATE_LIMIT_ENFORCE_IN_TEST = 'true';
  global.__controllerCalls = {}; global.__multerRuns = 0;
  prisma.__store.users = [7, 8, 9].map((id) => ({ id, tokenVersion: 0, isVerified: true, deletedAt: null }));
  prisma.__store.corporateUsers = [{ id: 3, corporateId: 9, email: 'c@example.invalid', mustChangePassword: false }];
  prisma.__store.sessions = [];
  await resetAll();
  a = await patientToken(7);
  b = await patientToken(8);
});
afterEach(() => { delete process.env.RATE_LIMIT_ENFORCE_IN_TEST; delete process.env.JWT_REFRESH_SECRET; delete process.env.JWT_ACCESS_SECRET; });

describe('POST /requests', () => {
  test('normal use is never limited: 20 submissions in a burst all go through', async () => {
    expect(new Set(await repeat(20, () => submit(a)))).toEqual(new Set([201]));
    expect(calls('submit')).toBe(20);
  });
  test('the 21st in 15 minutes is refused with 429, a code, a message and Retry-After, and the controller never runs', async () => {
    await repeat(20, () => submit(a));
    const res = await submit(a);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.body.error).toMatch(/too quickly/i);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(calls('submit')).toBe(20);
  });
  test('retries with the same clientRequestId are ordinary calls inside the budget (a few retries never hit the limit)', async () => {
    const body = { serviceKey: 'ground', clientRequestId: '11111111-1111-4111-8111-111111111111' };
    expect(await repeat(5, () => submit(a, body))).toEqual([201, 201, 201, 201, 201]);
  });
  test('the daily cap is 100: after the burst window resets, the 101st in 24 hours is refused with its own message', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(new Set(await repeat(20, () => submit(a)))).toEqual(new Set([201]));
      await requestSubmitLimiters[0].resetKey('patient:7'); // the 15-minute window passes
    }
    const res = await submit(a);
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/daily limit/i);
    expect(calls('submit')).toBe(100);
  });
  test('the limit is per patient: one patient\'s traffic never uses another\'s budget', async () => {
    await repeat(25, () => submit(a));
    expect((await submit(a)).status).toBe(429);
    expect(await repeat(20, () => submit(b))).toEqual(Array(20).fill(201));
    expect((await submit(b)).status).toBe(429);
    const c = await patientToken(9);
    expect((await submit(c)).status).toBe(201);
  });
  test('it cannot be avoided by changing the client address or spoofed forwarding headers', async () => {
    await repeat(20, () => submit(a));
    const res = await request(app).post('/requests').set(auth(a)).set('X-Forwarded-For', '203.0.113.9').set('X-Real-IP', '203.0.113.10').send({ serviceKey: 'ground' });
    expect(res.status).toBe(429);
  });
  test('a patient who logs in again on another device shares the account\'s budget (keyed by account, not by token)', async () => {
    await repeat(20, () => submit(a));
    const second = await patientToken(7);
    expect((await submit(second)).status).toBe(429);
  });
});

describe('authentication comes first', () => {
  test('unauthenticated calls are 401, never counted: a flood of them does not spend anyone\'s budget', async () => {
    const statuses = await repeat(40, () => request(app).post('/requests').send({ serviceKey: 'ground' }));
    expect(new Set(statuses)).toEqual(new Set([401]));
    expect(await repeat(20, () => submit(a))).toEqual(Array(20).fill(201));
    const uploads = await repeat(70, () => request(app).post('/requests/me/1/documents').send({}));
    expect(new Set(uploads)).toEqual(new Set([401]));
    expect(global.__multerRuns).toBe(0);
  });
  test('a bad or forged token is 401, and a corporate token is refused (403) without counting against any patient', async () => {
    expect((await submit('not-a-token')).status).toBe(401);
    const corp = await corporateToken();
    expect((await submit(corp)).status).toBe(403);
    expect(calls('submit')).toBe(0);
    expect(await repeat(20, () => submit(a))).toEqual(Array(20).fill(201));
  });
  test('an ended session cannot be used to spend or probe the limits', async () => {
    const ended = await startSession({ claims: { sub: 7, role: 'patient', tv: 0 }, subjectType: S.SUBJECTS.PATIENT, subjectId: 7 });
    prisma.__store.sessions.find((r) => r.id === ended.sessionId).revokedAt = new Date();
    expect((await submit(ended.token)).status).toBe(401);
    expect((await upload(ended.token)).status).toBe(401);
  });
});

describe('document uploads', () => {
  test('legitimate multi-file use goes through: 30 files for one request, then more for another, with retries', async () => {
    expect(new Set(await repeat(30, () => upload(a, 1)))).toEqual(new Set([201]));
    expect(new Set(await repeat(15, () => upload(a, 2)))).toEqual(new Set([201]));
    expect(new Set(await repeat(10, () => upload(a, 1)))).toEqual(new Set([201])); // retries
    expect(calls('upload')).toBe(55);
  });
  test('the 61st upload in 15 minutes is refused with 429 BEFORE multer runs (no file is written for a refused caller)', async () => {
    await repeat(60, () => upload(a));
    expect(global.__multerRuns).toBe(60);
    const res = await upload(a);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.body.error).toMatch(/uploading files too quickly/i);
    expect(res.headers['retry-after']).toBeDefined();
    expect(global.__multerRuns).toBe(60);
    expect(calls('upload')).toBe(60);
  });
  test('the daily cap is 300', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(new Set(await repeat(60, () => upload(a)))).toEqual(new Set([201]));
      await requestUploadLimiters[0].resetKey('patient:7');
    }
    const res = await upload(a);
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/daily limit/i);
    expect(calls('upload')).toBe(300);
  });
  test('uploads are per patient and independent of the submit budget', async () => {
    await repeat(60, () => upload(a));
    expect((await upload(a)).status).toBe(429);
    expect((await upload(b)).status).toBe(201); // another patient
    expect((await submit(a)).status).toBe(201); // the same patient can still submit
    await repeat(20, () => submit(b));
    expect((await upload(b)).status).toBe(201); // and uploads are not spent by submissions
  });
});

describe('reads are not limited', () => {
  test('lists, status checks and details stay available to a patient who used up both write budgets', async () => {
    await repeat(25, () => submit(a));
    await repeat(65, () => upload(a));
    for (const path of ['/requests/me', '/requests/me/documents', '/requests/me/5', '/requests/me/by-client-request/11111111-1111-4111-8111-111111111111', '/requests/me/5/summary']) {
      const statuses = await repeat(30, () => request(app).get(path).set(auth(a)));
      expect(new Set(statuses)).toEqual(new Set([200]));
    }
  });
});

describe('configuration', () => {
  test('the tests of every other suite are not throttled: without RATE_LIMIT_ENFORCE_IN_TEST the limiters skip under NODE_ENV=test', async () => {
    delete process.env.RATE_LIMIT_ENFORCE_IN_TEST;
    expect(new Set(await repeat(30, () => submit(a)))).toEqual(new Set([201]));
  });
  test('the limiters are two windows each (burst and daily) and key by patient, never by address alone', () => {
    expect(requestSubmitLimiters).toHaveLength(2);
    expect(requestUploadLimiters).toHaveLength(2);
  });
});
