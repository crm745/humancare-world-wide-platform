/* global describe, test, expect, jest, beforeAll, beforeEach, afterAll */
// POST /invoices/:invoiceId/payment-orders through the REAL application (src/app.js), over HTTP with supertest. Only the outside world is
// replaced: Prisma is an in-memory fake, uploads and the antivirus client are stubs, and Razorpay is a fake behind the global fetch (which the
// safe-test setup blocks; this file swaps in the fake for its own run only). Every console line is captured and checked for secrets.
jest.mock('../../src/db/prisma', () => ({ prisma: require('./payments-test-kit').makeDb() }));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass }, uploadPatient: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { prisma } = require('../../src/db/prisma');
const kit = require('./payments-test-kit');
const { app } = require('../../src/app');

const JWT_SECRET = 'fake-route-jwt-secret-0123456789';
const KEY = kit.KEY(1);
const token = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '5m' });
const PATIENT = token({ sub: 7, role: 'patient' });
const OTHER_PATIENT = token({ sub: 8, role: 'patient' });
const CORPORATE = token({ sub: 3, role: 'corporate', corporateId: 1 });
const ADMIN = token({ sub: 1, role: 'admin' });

const post = ({ id = '1', auth = PATIENT, key = KEY, body = { mode: 'full' } } = {}) => {
  let req = request(app).post(`/invoices/${id}/payment-orders`);
  if (auth) req = req.set('Authorization', `Bearer ${auth}`);
  if (key) req = req.set('Idempotency-Key', key);
  return body === undefined ? req : req.send(body);
};

let captured; let spies; let gateway; let savedFetch; let savedEnv;
beforeAll(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, kit.ENV, { JWT_ACCESS_SECRET: JWT_SECRET });
  savedFetch = global.fetch;
  captured = [];
  spies = ['log', 'info', 'warn', 'error'].map((name) => jest.spyOn(console, name).mockImplementation((...args) => { captured.push(args.map(String).join(' ')); }));
});
afterAll(() => {
  global.fetch = savedFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  spies.forEach((s) => s.mockRestore());
});
beforeEach(() => {
  captured.length = 0;
  kit.clock.t = Date.parse('2026-11-20T10:00:00.000Z');
  // Reset the shared fake database in place (the application holds a reference to it).
  prisma.state.invoices = new Map([[1, kit.makeInvoice()]]);
  prisma.state.payments = [];
  prisma.state.audits = [];
  prisma.state.locks = [];
  prisma.state.nextPaymentId = 1;
  gateway = kit.makeGateway();
  global.fetch = gateway.fetchImpl;
  process.env.PAYMENTS_ENABLED = 'true';
});

const everythingSeen = (res) => JSON.stringify([res.body, res.text, res.headers]) + captured.join('\n') + JSON.stringify(prisma.state.audits);
const LEAKS = new RegExp(`${kit.SECRET}|Basic |mysql://|DO_NOT_LEAK|secret\\.example|at .*\\.js`);

describe('authentication and authorization', () => {
  test('no token is 401; a corporate token is 403; a legacy admin token is 401; nothing is created', async () => {
    expect((await post({ auth: null })).status).toBe(401);
    expect((await post({ auth: CORPORATE })).status).toBe(403);
    expect((await post({ auth: ADMIN })).status).toBe(401);
    expect(prisma.state.payments).toHaveLength(0);
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });
  test('another patient\'s invoice is 404 with a fixed answer', async () => {
    const res = await post({ auth: OTHER_PATIENT });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Invoice not found.', code: 'invoice_not_found' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(prisma.state.payments).toHaveLength(0);
  });
  test('the route exists only as POST /invoices/:invoiceId/payment-orders', async () => {
    expect((await request(app).get('/invoices/1/payment-orders').set('Authorization', `Bearer ${PATIENT}`)).status).toBe(404);
    expect((await post({ id: 'abc' })).status).toBe(404);
  });
});

describe('creating an order', () => {
  test('201 with only the allowed fields, no-store, and the order stored on the payment', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      paymentId: 1, invoiceId: 1, status: 'pending', amount: '1500.00', currency: 'INR',
      razorpay: { keyId: kit.KEY_ID, orderId: 'order_FAKE1', amount: 150000, currency: 'INR' },
    });
    expect(prisma.state.payments[0].razorpayOrderId).toBe('order_FAKE1');
    expect(everythingSeen(res)).not.toMatch(LEAKS);
  });
  test('the same Idempotency-Key replays with 200 and the same body', async () => {
    const first = await post();
    const second = await post();
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(gateway.creates()).toHaveLength(1);
  });
  test('a client-supplied currency or invoice amount is refused, never used', async () => {
    const res = await post({ body: { mode: 'full', currency: 'USD', amount: '1.00' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('request_invalid');
    expect(prisma.state.payments).toHaveLength(0);
  });
  test('a numeric partial amount is refused (decimal strings only)', async () => {
    prisma.state.invoices.get(1).allowPartialPayment = true;
    const res = await post({ body: { mode: 'partial', amount: 250 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('amount_invalid');
    expect((await post({ body: { mode: 'partial', amount: '250.00' } })).status).toBe(201);
  });
  test('a missing or malformed Idempotency-Key is 400', async () => {
    for (const key of [null, 'short', 'has space in the key 1234']) {
      const res = await post({ key });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('idempotency_key_invalid');
    }
  });
  test('an open order makes the next request 409 open_order_exists', async () => {
    await post();
    const res = await post({ key: kit.KEY(2) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('open_order_exists');
  });
});

// A request body that Express did not PARSE (a content type other than JSON) must never be read as an empty request, which means
// "full payment". An intentionally empty request still does.
describe('request bodies', () => {
  const raw = (contentType, payload, key = KEY) => {
    let req = request(app).post('/invoices/1/payment-orders').set('Authorization', `Bearer ${PATIENT}`).set('Idempotency-Key', key);
    if (contentType) req = req.set('Content-Type', contentType);
    return payload === undefined ? req : req.send(payload);
  };
  const nothingHappened = () => {
    expect(prisma.state.payments).toHaveLength(0);
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  };

  test('1. an intentionally EMPTY request (no body at all) means full payment', async () => {
    const res = await raw(undefined, undefined);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: '1500.00', currency: 'INR', status: 'pending' }); // the whole balance
    expect(prisma.state.payments[0].amount).toBe('1500.00');
  });

  test('1b. an empty JSON request ({}) is also full payment, and so is an explicit empty body with a JSON content type', async () => {
    expect((await raw('application/json', {})).body).toMatchObject({ amount: '1500.00' });
    prisma.state.payments = [];
    expect((await raw('application/json', '', kit.KEY(2))).status).toBe(201);
  });

  test('2. a valid JSON full-payment request', async () => {
    const res = await raw('application/json', { mode: 'full' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: '1500.00', razorpay: { amount: 150000, currency: 'INR' } });
  });

  test('3. a valid JSON partial-payment request', async () => {
    prisma.state.invoices.get(1).allowPartialPayment = true;
    const res = await raw('application/json', { mode: 'partial', amount: '250.00' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: '250.00', razorpay: { amount: 25000 } });
    expect(prisma.state.payments[0].amount).toBe('250.00');
  });

  test('4. a NON-EMPTY body that Express did not parse is rejected, never read as a full payment', async () => {
    prisma.state.invoices.get(1).allowPartialPayment = true;
    for (const [type, payload] of [
      ['text/plain', '{"mode":"partial","amount":"250.00"}'], // JSON sent with the wrong content type
      ['application/x-www-form-urlencoded', 'mode=partial&amount=250.00'],
      ['application/xml', '<mode>partial</mode>'],
    ]) {
      const res = await raw(type, payload);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'The request is not valid.', code: 'request_invalid' });
      expect(res.headers['cache-control']).toBe('no-store');
      nothingHappened();
    }
  });

  test('4b. a body sent with no content type at all is rejected the same way', async () => {
    const res = await raw('', '{"mode":"partial","amount":"250.00"}').unset('Content-Type');
    expect([400]).toContain(res.status);
    expect(res.body.code).toBe('request_invalid');
    nothingHappened();
  });

  test('5. invalid JSON is rejected with a fixed answer that never echoes the body', async () => {
    const res = await raw('application/json', '{"mode": "partial", "amount": "SENTINEL_BODY_TEXT"');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body) + res.text).not.toMatch(/SENTINEL_BODY_TEXT|"mode"|Unexpected|position/i);
    expect(captured.join('\n')).not.toMatch(/SENTINEL_BODY_TEXT/);
    nothingHappened();
  });

  test('5b. a JSON value that is not an object is not a payment request', async () => {
    for (const payload of ['[]', '[{"mode":"full"}]']) {
      const res = await raw('application/json', payload);
      expect(res.status).toBe(400);
      nothingHappened();
    }
  });
});

describe('a replayed order is re-checked over HTTP', () => {
  test('after the invoice is voided the same key returns 409 and no checkout details; the order is untouched', async () => {
    const first = await post();
    expect(first.status).toBe(201);
    prisma.state.invoices.get(1).status = 'void';
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'This invoice cannot be paid online right now.', code: 'invoice_not_payable' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toMatch(/order_FAKE|rzp_/);
    expect(prisma.state.payments[0]).toMatchObject({ status: 'pending', razorpayOrderId: 'order_FAKE1' });
    expect(gateway.creates()).toHaveLength(1);
  });
  test('after the quotation is superseded the same key returns 409 quotation_not_active', async () => {
    await post();
    prisma.state.invoices.get(1).quotation.supersededAt = new Date();
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('quotation_not_active');
  });
});

describe('payments off, errors and the gateway', () => {
  test('PAYMENTS_ENABLED other than "true" is 503 payments_disabled and nothing happens', async () => {
    process.env.PAYMENTS_ENABLED = 'TRUE';
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('payments_disabled');
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
    expect(prisma.state.payments).toHaveLength(0);
  });
  test('an ineligible invoice is a fixed 409', async () => {
    prisma.state.invoices.get(1).quotation.status = 'published';
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'The quotation for this invoice is no longer active.', code: 'quotation_not_active' });
  });
  test('a definitive refusal is a fixed 502 with no gateway text in the answer or the log', async () => {
    gateway.modes = ['refuse'];
    const res = await post();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'The payment service is unavailable. Please try again.', code: 'gateway_unavailable' });
    expect(everythingSeen(res)).not.toMatch(LEAKS);
  });
  test('an ambiguous outcome is 202 gateway_uncertain with the payment id to retry', async () => {
    gateway.modes = ['timeout'];
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ code: 'gateway_uncertain', paymentId: 1, invoiceId: 1 });
    expect(res.body.razorpay).toBeUndefined();
    expect(prisma.state.payments[0]).toMatchObject({ status: 'pending', razorpayOrderId: null });
  });
  test('an unexpected internal error is a generic 500 and the log holds only a short code', async () => {
    prisma.invoice.findUnique.mockRejectedValueOnce(Object.assign(new Error(`database exploded: ${kit.SECRET} mysql://u:p@h/db`), { name: 'PrismaClientKnownRequestError', code: 'P2025' }));
    const res = await post();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(everythingSeen(res)).not.toMatch(LEAKS);
  });
});

describe('secrets', () => {
  test('across a successful, a refused and an uncertain request nothing sent or logged contains the secret or the authorization header', async () => {
    const seen = [];
    seen.push(everythingSeen(await post()));
    prisma.state.payments = [];
    gateway.modes = ['refuse'];
    seen.push(everythingSeen(await post({ key: kit.KEY(2) })));
    prisma.state.payments = [];
    gateway.modes = ['timeout'];
    seen.push(everythingSeen(await post({ key: kit.KEY(3) })));
    expect(seen.join('\n')).not.toMatch(LEAKS);
  });
});
