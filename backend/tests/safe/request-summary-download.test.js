/* global describe, test, expect, jest, beforeEach, afterEach */
// GET /requests/me/:id/summary over HTTP, through the REAL app, routes, authentication and the real PDF generator; the request lookup is a stand-in that, like the real one, returns a request only to
// its owner. What is shown: only a signed-in patient gets a PDF, only for their own request, the answer is a real English PDF whatever the language headers say, and a failure is an ordinary error
// answer (never a half-sent file). No database, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: require('./fake-auth-prisma').createFakePrisma() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/modules/requests/requests.service', () => ({
  getRequestForUser: jest.fn(async (userId, id) => {
    const request = global.__summaryRequests && global.__summaryRequests.get(Number(id));
    if (!request || request.userId !== userId) { const err = new Error('Request not found'); err.statusCode = 404; throw err; }
    return request;
  }),
  createRequest: jest.fn(), findRequestByClientRequestId: jest.fn(), listRequestsForUser: jest.fn(), listDocumentsForUser: jest.fn(),
}));

const request = require('supertest');
const { prisma } = require('../../src/db/prisma');
const { app } = require('../../src/app');
const S = require('../../src/modules/auth/session.service');
const { startSession } = require('../../src/modules/auth/auth.service');
const { pdfLines } = require('../helpers/pdf-text');
const { services, SECRET_TEXTS } = require('./helpers/summary-fixtures');

const all = services();
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const tokenFor = async (id) => (await startSession({ claims: { sub: id, role: 'patient', tv: 0 }, subjectType: S.SUBJECTS.PATIENT, subjectId: id })).token;
const binary = (res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
const get = (id, token, headers = {}, query = '') => request(app).get(`/requests/me/${id}/summary${query}`).set(token ? auth(token) : {}).set(headers).buffer(true).parse(binary);

let ownerToken;
let otherToken;
beforeEach(async () => {
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789';
  prisma.__store.users = [7, 8].map((id) => ({ id, tokenVersion: 0, isVerified: true, deletedAt: null }));
  prisma.__store.corporateUsers = [{ id: 3, corporateId: 9, email: 'c@example.invalid', mustChangePassword: false }];
  prisma.__store.sessions = [];
  global.__summaryRequests = new Map(Object.values(all).map((r, i) => [i + 1, { ...r, id: i + 1, userId: 7 }]));
  ownerToken = await tokenFor(7);
  otherToken = await tokenFor(8);
});
afterEach(() => { delete process.env.JWT_REFRESH_SECRET; delete process.env.JWT_ACCESS_SECRET; delete global.__summaryRequests; });

describe('the download endpoint', () => {
  test('the owner gets a real PDF attachment for each of the eight services, named after the Request ID', async () => {
    const keys = Object.keys(all);
    for (let i = 0; i < keys.length; i += 1) {
      const res = await get(i + 1, ownerToken);
      expect({ service: keys[i], status: res.status }).toEqual({ service: keys[i], status: 200 });
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('attachment; filename="REQ-1042-summary.pdf"');
      expect(res.headers['content-length']).toBe(String(res.body.length));
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const text = pdfLines(res.body);
      expect(text).toContain('Request Summary');
      expect(text).toContain(all[keys[i]].serviceType);
    }
  });
  test('the PDF is English whatever language the app or the request asks for', async () => {
    const baseline = pdfLines((await get(3, ownerToken)).body).filter((l) => !/UTC$/.test(l));
    for (const headers of [{ 'Accept-Language': 'ar' }, { 'Accept-Language': 'hi-IN,hi;q=0.9' }, { 'Accept-Language': 'te' }, { 'X-App-Language': 'GU' }, { 'Accept-Language': 'mr-IN' }]) {
      const res = await get(3, ownerToken, headers, '?lang=ar&language=hi');
      expect(res.status).toBe(200);
      expect(pdfLines(res.body).filter((l) => !/UTC$/.test(l))).toEqual(baseline);
    }
  });
  test('no internal data in what is sent', async () => {
    for (let id = 1; id <= Object.keys(all).length; id += 1) {
      const res = await get(id, ownerToken);
      const text = res.body.toString('latin1') + pdfLines(res.body).join('\n');
      for (const secret of SECRET_TEXTS) expect(text.includes(secret)).toBe(false);
    }
  });
});

describe('who can download', () => {
  test('without a token: 401 and no PDF', async () => {
    const res = await request(app).get('/requests/me/1/summary');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/json/);
  });
  test('another patient\'s request is a 404 (it is never revealed to exist), with no PDF', async () => {
    const res = await request(app).get('/requests/me/1/summary').set(auth(otherToken));
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(JSON.stringify(res.body)).not.toMatch(/Ravi|REQ-1042/);
  });
  test('a request that does not exist, and a malformed id, are 404 and never a PDF', async () => {
    expect((await request(app).get('/requests/me/9999/summary').set(auth(ownerToken))).status).toBe(404);
    expect((await request(app).get('/requests/me/abc/summary').set(auth(ownerToken))).status).toBe(404);
  });
  test('a corporate user is refused (this is the patient app\'s endpoint)', async () => {
    const corporate = (await startSession({ claims: { sub: 3, role: 'corporate', corporateId: 9 }, subjectType: S.SUBJECTS.CORPORATE, subjectId: 3 })).token;
    expect((await request(app).get('/requests/me/1/summary').set(auth(corporate))).status).toBe(403);
  });
  test('a signed-out device (its session ended) gets 401, not a PDF', async () => {
    prisma.__store.sessions.forEach((row) => { row.revokedAt = new Date(); });
    expect((await request(app).get('/requests/me/1/summary').set(auth(ownerToken))).status).toBe(401);
  });
});

describe('failures are ordinary errors', () => {
  test('if the document cannot be built the answer is a JSON error (500, no details), not a half-sent PDF', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.__summaryRequests.set(77, { ...all.ground, id: 77, userId: 7, case: { get documents() { throw new Error('boom: SECRET-INTERNAL-DETAIL'); }, stageEvents: [] } });
    const res = await request(app).get('/requests/me/77/summary').set(auth(ownerToken));
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('SECRET-INTERNAL-DETAIL');
    spy.mockRestore();
  });
  test('a request with missing data still downloads (nothing throws)', async () => {
    global.__summaryRequests.set(78, { id: 78, userId: 7, referenceNumber: 'REQ-78', serviceType: 'Marine Medical Safety', status: 'submitted', createdAt: null });
    const res = await get(78, ownerToken);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="REQ-78-summary.pdf"');
    expect(pdfLines(res.body)).toContain('Not provided');
  });
});
