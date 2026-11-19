/* global describe, test, expect, jest, beforeAll, beforeEach, afterAll */
// The per-patient rate limiter on POST /invoices/:invoiceId/payment-orders, exercised WITHOUT the NODE_ENV=test bypass: the limiter's `skip`
// reads NODE_ENV on every request, so NODE_ENV is switched to "development" for these tests only (and restored). The REAL application
// (src/app.js) runs over HTTP with supertest; Prisma is an in-memory fake and Razorpay a fake behind the (otherwise blocked) global fetch.
// Each test uses patients nobody else uses, because the limiter's counters live for a minute in memory.
jest.mock('../../src/db/prisma', () => ({ prisma: require('./payments-test-kit').makeDb() }));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { prisma } = require('../../src/db/prisma');
const kit = require('./payments-test-kit');
const { app } = require('../../src/app');

const JWT_SECRET = 'fake-route-jwt-secret-0123456789';
const LIMIT = 10; // payments.routes.js: 10 requests per minute per patient
const token = (sub, role = 'patient') => jwt.sign({ sub, role, ...(role === 'corporate' && { corporateId: 1 }) }, JWT_SECRET, { expiresIn: '5m' });
const key = (n) => kit.KEY(n);

let captured; let spies; let gateway; let savedFetch; let savedEnv;
beforeAll(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, kit.ENV, { JWT_ACCESS_SECRET: JWT_SECRET, NODE_ENV: 'development' }); // NO test bypass
  savedFetch = global.fetch;
  captured = [];
  spies = ['log', 'info', 'warn', 'error'].map((name) => jest.spyOn(console, name).mockImplementation((...args) => { captured.push(args.map(String).join(' ')); }));
});
afterAll(() => {
  global.fetch = savedFetch;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  spies.forEach((s) => s.mockRestore());
});
beforeEach(() => {
  captured.length = 0;
  gateway = kit.makeGateway();
  global.fetch = gateway.fetchImpl;
  process.env.NODE_ENV = 'development';
  prisma.state.payments = [];
  prisma.state.audits = [];
  prisma.state.nextPaymentId = 1;
  prisma.state.invoices = new Map();
});

// Gives a patient their own invoice (id = patient id) so a request can really succeed.
const own = (patientId) => prisma.state.invoices.set(patientId, kit.makeInvoice({ id: patientId, case: { id: 1000 + patientId, status: 'in_progress', closedAt: null, serviceRequest: { userId: patientId, serviceKey: 'privatecharter' } } }));
const create = (patientId, k = key(1), body = { mode: 'full' }) => request(app).post(`/invoices/${patientId}/payment-orders`).set('Authorization', `Bearer ${token(patientId)}`).set('Idempotency-Key', k).send(body);
const seen = (res) => JSON.stringify([res.body, res.text, res.headers]) + captured.join('\n');
const SENSITIVE = new RegExp(`${kit.SECRET}|Basic |mysql://|patient:|rzp_|order_FAKE|HCP\\d|at .*\\.js`);

describe('the limiter is really active (no NODE_ENV=test bypass)', () => {
  test('NODE_ENV is not "test" while these tests run', () => {
    expect(process.env.NODE_ENV).toBe('development');
  });

  test('contrast: with NODE_ENV=test the limiter is skipped, so the same traffic is never throttled', async () => {
    own(501);
    process.env.NODE_ENV = 'test';
    const statuses = [];
    for (let i = 0; i < LIMIT + 3; i += 1) statuses.push((await create(501)).status);
    expect(statuses).not.toContain(429);
  });
});

describe(`requests within the limit (${LIMIT} a minute) succeed`, () => {
  test('all of the first ten requests are served: the first creates the order, the rest replay it', async () => {
    own(601);
    const statuses = [];
    for (let i = 0; i < LIMIT; i += 1) statuses.push((await create(601)).status);
    expect(statuses).toEqual([201, ...Array(LIMIT - 1).fill(200)]);
    expect(prisma.state.payments).toHaveLength(1);
    expect(gateway.creates()).toHaveLength(1);
  });

  test('the response says how much is left, using the standard rate-limit headers', async () => {
    own(602);
    const res = await create(602);
    expect(res.status).toBe(201);
    const headers = Object.keys(res.headers).filter((h) => /ratelimit|retry-after/i.test(h));
    expect(headers.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.headers)).not.toMatch(/patient:|602/);
  });
});

describe('requests beyond the limit are rejected', () => {
  test('the 11th request in the window is 429 with a fixed body, and nothing is created or sent to Razorpay', async () => {
    own(701);
    for (let i = 0; i < LIMIT; i += 1) expect((await create(701)).status).toBeLessThan(300);
    const creates = gateway.creates().length;
    const rows = prisma.state.payments.length;
    const res = await create(701, key(2)); // a NEW key: not a replay
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Too many payment attempts. Please wait a minute.', code: 'rate_limited' });
    expect(gateway.creates().length).toBe(creates);
    expect(prisma.state.payments.length).toBe(rows);
    expect(res.headers['retry-after'] || res.headers['ratelimit']).toBeDefined(); // tells the client when to come back
  });

  test('every further request in the window stays rejected', async () => {
    own(702);
    for (let i = 0; i < LIMIT; i += 1) await create(702);
    for (let i = 0; i < 3; i += 1) expect((await create(702)).status).toBe(429);
  });

  test('failed requests count too: ten invalid requests use up the budget, so the next valid one is throttled', async () => {
    own(703);
    for (let i = 0; i < LIMIT; i += 1) expect((await create(703, 'too-short')).status).toBe(400); // idempotency_key_invalid
    expect((await create(703)).status).toBe(429);
    expect(prisma.state.payments).toHaveLength(0);
  });
});

describe('patients are limited independently', () => {
  test('one patient using up their limit does not consume another patient\'s', async () => {
    own(801); own(802);
    for (let i = 0; i < LIMIT; i += 1) await create(801);
    expect((await create(801, key(2))).status).toBe(429); // patient 801 is throttled...
    const other = await create(802); // ...patient 802, from the very same address, is not
    expect(other.status).toBe(201);
    expect(other.body.paymentId).toBeDefined();
  });

  test('the limit is per patient, not per IP address: two patients on one connection each get the full allowance', async () => {
    own(803); own(804);
    for (let i = 0; i < LIMIT; i += 1) expect((await create(803)).status).toBeLessThan(300);
    for (let i = 0; i < LIMIT; i += 1) expect((await create(804)).status).toBeLessThan(300);
    expect((await create(803, key(3))).status).toBe(429);
    expect((await create(804, key(3))).status).toBe(429);
  });

  test('requests that never reach the limiter (no token, wrong role) are not counted against anybody and are not throttled', async () => {
    own(805);
    for (let i = 0; i < LIMIT + 5; i += 1) {
      expect((await request(app).post('/invoices/805/payment-orders').set('Idempotency-Key', key(1)).send({})).status).toBe(401);
      expect((await request(app).post('/invoices/805/payment-orders').set('Authorization', `Bearer ${token(805, 'corporate')}`).set('Idempotency-Key', key(1)).send({})).status).toBe(403);
    }
    expect((await create(805)).status).toBe(201); // the patient's own budget is untouched
  });

  test('a patient hitting someone else\'s invoice still counts against their OWN limit (and is told 404 until throttled)', async () => {
    own(806); own(807);
    const statuses = [];
    for (let i = 0; i < LIMIT + 1; i += 1) statuses.push((await request(app).post('/invoices/807/payment-orders').set('Authorization', `Bearer ${token(806)}`).set('Idempotency-Key', key(i + 1)).send({})).status);
    expect(statuses.slice(0, LIMIT).every((s) => s === 404)).toBe(true);
    expect(statuses[LIMIT]).toBe(429);
    expect((await create(807)).status).toBe(201); // the owner is unaffected
  });
});

describe('the rate-limit response exposes nothing sensitive', () => {
  test('the throttled answer, its headers and the log contain no secret, key, order id, patient id key or stack trace', async () => {
    own(901);
    const bodies = [];
    for (let i = 0; i < LIMIT; i += 1) bodies.push(await create(901));
    const throttled = await create(901, key(9));
    expect(throttled.status).toBe(429);
    expect(seen(throttled)).not.toMatch(SENSITIVE);
    expect(Object.keys(throttled.body).sort()).toEqual(['code', 'error']);
    expect(captured.join('\n')).not.toMatch(SENSITIVE);
  });

  test('the throttled answer is identical for different patients (it reveals nothing about who or how many)', async () => {
    own(902); own(903);
    for (let i = 0; i < LIMIT; i += 1) { await create(902); await create(903); }
    const a = await create(902, key(9));
    const b = await create(903, key(9));
    expect(a.status).toBe(429);
    expect(b.status).toBe(429);
    expect(a.body).toEqual(b.body);
  });
});
