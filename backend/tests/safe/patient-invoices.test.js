/* global describe, test, expect, jest, beforeAll, afterAll */
// Patient invoice summary (GET /requests/me/:id) and invoice + payment status (GET /invoices/:invoiceId): ownership, what is and is not returned,
// payable rules, and the real Express routing with real JWT authentication. No database and no network: Prisma is replaced by an in-memory fake.
// requireAuth looks the patient up once (a retired account is refused at once); these tests have no such account row.
jest.mock('../../src/db/prisma', () => ({ prisma: { user: { findUnique: async () => null } } }));

const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const svc = require('../../src/modules/payments/patient-invoices.service');
const { invoicesRouter } = require('../../src/modules/payments/payments.routes');

const ENV_OK = Object.freeze({
  PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_KEY_ID: 'rzp_test_FAKEKEY123456', RAZORPAY_KEY_SECRET: 'FAKE_SECRET_VALUE_9876',
});
const NOW = new Date('2026-11-20T10:00:00.000Z');
const ME = 7;
const OTHER = 8;

const invoiceRow = (over = {}) => ({
  id: 1, caseId: 10, source: 'quotation', status: 'issued', amount: '1500.000', currency: 'INR', dueDate: null, quotationId: 5, allowPartialPayment: false,
  quotation: { id: 5, status: 'accepted', supersededAt: null },
  case: { id: 10, status: 'in_progress', closedAt: null, serviceRequest: { id: 50, userId: ME, serviceKey: 'privatecharter' } },
  ...over,
});
const paymentRow = (over = {}) => ({
  id: 100, invoiceId: 1, caseId: 10, currency: 'INR', kind: 'payment', amount: '1500.000', status: 'pending', method: 'razorpay', razorpayOrderId: 'order_SECRETORDER1',
  externalReference: null, idempotencyKey: 'rzp-order:SECRET-IDEMPOTENCY-KEY', createdAt: new Date('2026-11-20T09:00:00Z'), updatedAt: new Date('2026-11-20T09:00:00Z'), transactedAt: null, ...over,
});

function fakeDb({ invoices = [invoiceRow()], payments = [] } = {}) {
  return {
    invoice: {
      findUnique: jest.fn(async ({ where }) => invoices.find((i) => i.id === where.id) || null),
      findMany: jest.fn(async ({ where }) => invoices
        .filter((i) => i.status !== 'draft' && i.case.serviceRequest.id === where.case.serviceRequest.id && i.case.serviceRequest.userId === where.case.serviceRequest.userId)
        .map((i) => ({ id: i.id }))),
    },
    payment: { findMany: jest.fn(async ({ where }) => payments.filter((p) => p.invoiceId === where.invoiceId)) },
  };
}
const view = (db, over = {}) => svc.getInvoiceForPatient({ userId: ME, invoiceId: '1', db, now: NOW, env: ENV_OK, ...over });

describe('the invoice view', () => {
  test('a payable invoice: exact amounts, no balance paid, payable true, no reason, no open payment', async () => {
    expect(await view(fakeDb())).toEqual({
      id: 1, invoiceNumber: null, status: 'issued', amount: '1500.00', currency: 'INR', issueDate: null, dueDate: null, quotationVersion: null, allowPartialPayment: false, paid: '0.00', balance: '1500.00',
      payable: true, payableReason: null, hasOpenPayment: false, payments: [],
    });
  });
  test('paid and balance come from COMPLETED payments only; pending, failed and cancelled rows do not count; a refund never reopens the balance', async () => {
    const db = fakeDb({
      payments: [
        paymentRow({ id: 100, status: 'completed', amount: '1000.000', transactedAt: new Date('2026-11-20T09:30:00Z'), externalReference: 'pay_SECRETPAY' }),
        paymentRow({ id: 101, status: 'failed', amount: '500.000', razorpayOrderId: 'order_X2' }),
        paymentRow({ id: 102, status: 'cancelled', amount: '500.000', razorpayOrderId: 'order_X3' }),
        paymentRow({ id: 103, kind: 'refund', status: 'completed', amount: '400.000', razorpayOrderId: null, transactedAt: new Date('2026-11-20T09:40:00Z') }),
      ],
    });
    const v = await view(db);
    expect(v).toMatchObject({ paid: '1000.00', balance: '500.00', payable: true, hasOpenPayment: false });
  });
  test('fully paid: balance 0, not payable, reason fully_paid; an overpayment is still a zero balance', async () => {
    const full = await view(fakeDb({ payments: [paymentRow({ status: 'completed', transactedAt: NOW, externalReference: 'pay_A' })] }));
    expect(full).toMatchObject({ paid: '1500.00', balance: '0.00', payable: false, payableReason: 'fully_paid' });
    const over = await view(fakeDb({ payments: [paymentRow({ id: 1, status: 'completed', transactedAt: NOW }), paymentRow({ id: 2, status: 'completed', transactedAt: NOW, razorpayOrderId: 'order_B' })] }));
    expect(over).toMatchObject({ paid: '3000.00', balance: '0.00', payable: false, payableReason: 'fully_paid' });
  });
  test('an open (pending) payment is reported so the app resumes instead of starting a second one', async () => {
    const v = await view(fakeDb({ payments: [paymentRow()] }));
    expect(v).toMatchObject({ hasOpenPayment: true, payable: true });
    expect(v.payments).toEqual([{ id: 100, kind: 'payment', status: 'pending', amount: '1500.00', currency: 'INR', transactedAt: null, createdAt: '2026-11-20T09:00:00.000Z' }]);
  });
  test.each([
    ['payments disabled', { PAYMENTS_ENABLED: 'false' }, {}, 'payments_disabled'],
    ['credentials unusable', { RAZORPAY_KEY_SECRET: undefined }, {}, 'payments_disabled'],
    ['invoice void', {}, { status: 'void' }, 'invoice_not_payable'],
    ['overdue', {}, { dueDate: new Date('2026-11-01') }, 'invoice_overdue'],
    ['quotation superseded', {}, { quotation: { id: 5, status: 'accepted', supersededAt: new Date() } }, 'quotation_not_active'],
    ['case closed', {}, { case: { id: 10, status: 'closed', closedAt: new Date(), serviceRequest: { id: 50, userId: ME, serviceKey: 'privatecharter' } } }, 'invoice_not_payable'],
    ['unsupported currency', {}, { currency: 'KWD' }, 'currency_unsupported'],
  ])('not payable: %s -> %s', async (_l, envOver, invOver, reason) => {
    const v = await view(fakeDb({ invoices: [invoiceRow(invOver)] }), { env: { ...ENV_OK, ...envOver } });
    expect(v).toMatchObject({ payable: false, payableReason: reason });
  });
  test('NOTHING internal is returned: no gateway id, idempotency key, receipt, reference, secret, case or request', async () => {
    const db = fakeDb({ payments: [paymentRow({ status: 'completed', transactedAt: NOW, externalReference: 'pay_SECRETPAY' }), paymentRow({ id: 103, kind: 'refund', status: 'pending', externalReference: 'rfnd_SECRETREFUND', razorpayOrderId: null })] });
    const text = JSON.stringify(await view(db));
    expect(text).not.toMatch(/SECRET|order_|pay_|rfnd_|rzp|idempotency|receipt|razorpay|caseId|requestId|userId|serviceKey|FAKE/i);
  });
  test('the payment query selects ONLY the view fields: gateway ids, the idempotency key and the method are never read', async () => {
    const db = fakeDb({ payments: [paymentRow()] });
    await view(db);
    expect(Object.keys(db.payment.findMany.mock.calls[0][0].select).sort()).toEqual(['amount', 'createdAt', 'currency', 'id', 'kind', 'status', 'transactedAt']);
  });
  test('exact thousandths: an amount that a two-decimal currency cannot hold is shown exactly, never rounded', () => {
    const v = svc.invoiceView(invoiceRow({ amount: '1500.001' }), [], { now: NOW, env: ENV_OK });
    expect(v).toMatchObject({ amount: '1500.001', balance: '1500.001' });
  });
  test('the due date is a plain date', async () => {
    expect((await view(fakeDb({ invoices: [invoiceRow({ dueDate: new Date('2026-12-31T00:00:00Z') })] }))).dueDate).toBe('2026-12-31');
  });
});

describe('ownership', () => {
  test('another patient\'s invoice, a missing invoice, a draft and a malformed id all give the SAME 404', async () => {
    const errors = [];
    for (const [db, args] of [
      [fakeDb(), { userId: OTHER }],
      [fakeDb(), { invoiceId: '999' }],
      [fakeDb({ invoices: [invoiceRow({ status: 'draft' })] }), {}],
      [fakeDb(), { invoiceId: '1; DROP TABLE' }],
      [fakeDb(), { invoiceId: '0' }],
    ]) {
      const err = await view(db, args).catch((e) => e);
      errors.push({ status: err.statusCode, code: err.publicCode, message: err.message });
    }
    expect(new Set(errors.map((e) => JSON.stringify(e))).size).toBe(1);
    expect(errors[0]).toMatchObject({ status: 404, code: 'invoice_not_found' });
  });
  test('a Case that belongs to no patient (no service request, e.g. a Corporate Case) is not found', async () => {
    const db = fakeDb({ invoices: [invoiceRow({ case: { id: 10, status: 'in_progress', closedAt: null, serviceRequest: null } })] });
    await expect(view(db)).rejects.toMatchObject({ statusCode: 404 });
  });
  test('the list for a request is filtered by BOTH the request and the patient in the query, and another patient gets an empty list', async () => {
    const db = fakeDb({ invoices: [invoiceRow({ id: 1 }), invoiceRow({ id: 2, status: 'void' }), invoiceRow({ id: 3, status: 'draft' })] });
    const mine = await svc.listInvoicesForRequest({ userId: ME, requestId: 50, db, now: NOW, env: ENV_OK });
    expect(mine.map((i) => i.id)).toEqual([1, 2]); // the draft is not the patient's to see
    expect(db.invoice.findMany.mock.calls[0][0].where).toEqual({ status: { not: 'draft' }, case: { serviceRequest: { id: 50, userId: ME } } });
    expect(await svc.listInvoicesForRequest({ userId: OTHER, requestId: 50, db, now: NOW, env: ENV_OK })).toEqual([]);
    expect(await svc.listInvoicesForRequest({ userId: ME, requestId: 51, db, now: NOW, env: ENV_OK })).toEqual([]);
  });
});

describe('the routes (real Express routing and JWT authentication)', () => {
  let server; let base; const savedEnv = {};
  const keys = ['JWT_ACCESS_SECRET', ...Object.keys(ENV_OK)];
  let db;
  const token = (claims) => jwt.sign(claims, 'test-access-secret-xyz', { expiresIn: '5m' });

  beforeAll(async () => {
    for (const k of keys) savedEnv[k] = process.env[k];
    process.env.JWT_ACCESS_SECRET = 'test-access-secret-xyz';
    Object.assign(process.env, ENV_OK);
    db = fakeDb({ payments: [paymentRow({ status: 'completed', transactedAt: NOW, externalReference: 'pay_SECRETPAY' })] });
    Object.assign(require('../../src/db/prisma').prisma, db); // the service's default client
    const app = express();
    app.use('/invoices', invoicesRouter);
    // The same shape as the global handler in app.js.
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => { const status = err.statusCode || 500; res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message, ...(status !== 500 && err.publicCode && { code: err.publicCode }) }); });
    // Node's fetch is blocked by the safe-test setup; a plain http client is used instead.
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const k of keys) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  });

  const http = require('http');
  const request = (url, t) => new Promise((resolve, reject) => {
    const req = http.get(`${base}${url}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
  });

  test('no token is 401, a non-patient role is 403, a legacy admin token is 401', async () => {
    expect((await request('/invoices/1')).status).toBe(401);
    expect((await request('/invoices/1', token({ sub: 7, role: 'corporate' }))).status).toBe(403);
    expect((await request('/invoices/1', token({ sub: 7, role: 'admin' }))).status).toBe(401);
  });
  test('the owner gets { invoice } with the completed payment, Cache-Control no-store, and no internal data', async () => {
    const res = await request('/invoices/1', token({ sub: ME, role: 'patient' }));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body)).toEqual(['invoice']);
    expect(res.body.invoice).toMatchObject({ id: 1, status: 'issued', paid: '1500.00', balance: '0.00', payable: false, payableReason: 'fully_paid' });
    expect(res.body.invoice.payments).toEqual([{ id: 100, kind: 'payment', status: 'completed', amount: '1500.00', currency: 'INR', transactedAt: NOW.toISOString(), createdAt: '2026-11-20T09:00:00.000Z' }]);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|order_|pay_|idempotency/i);
  });
  test('another patient and a missing invoice get the identical 404 body', async () => {
    const other = await request('/invoices/1', token({ sub: OTHER, role: 'patient' }));
    const missing = await request('/invoices/999', token({ sub: ME, role: 'patient' }));
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: 'Invoice not found.', code: 'invoice_not_found' });
    expect(missing.body).toEqual(other.body);
  });
  test('the POST order route is still there and still patient-only', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/invoices/1/payment-orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', reject); req.end('{}');
    });
    expect(res).toBe(401);
  });
});

describe('request details carries the invoice summary', () => {
  test('GET /requests/me/:id returns the request plus invoices (an empty list when there is none), computed for the signed-in patient only', async () => {
    jest.resetModules();
    jest.doMock('../../src/modules/requests/requests.service', () => ({
      createRequest: jest.fn(), listRequestsForUser: jest.fn(), listDocumentsForUser: jest.fn(),
      getRequestForUser: jest.fn(async () => ({ id: 50, serviceKey: 'privatecharter', referenceNumber: 'HC-1' })),
    }));
    const listInvoicesForRequest = jest.fn(async () => [{ id: 1, status: 'issued', payable: true }]);
    jest.doMock('../../src/modules/payments/patient-invoices.service', () => ({ listInvoicesForRequest }));
    const isInvoicePending = jest.fn(async () => null);
    jest.doMock('../../src/modules/quotations/quotation-invoice.service', () => ({ isInvoicePending }));
    const controller = require('../../src/modules/requests/requests.controller');
    const res = { json: jest.fn() };
    await controller.getMyRequestById({ user: { id: '7' }, params: { id: '50' } }, res, jest.fn());
    expect(listInvoicesForRequest).toHaveBeenCalledWith({ userId: 7, requestId: 50 });
    expect(res.json).toHaveBeenCalledWith({ request: { id: 50, serviceKey: 'privatecharter', referenceNumber: 'HC-1', invoices: [{ id: 1, status: 'issued', payable: true }], invoicePending: false } });
    listInvoicesForRequest.mockResolvedValueOnce([]);
    await controller.getMyRequestById({ user: { id: '7' }, params: { id: '50' } }, res, jest.fn());
    expect(res.json.mock.calls[1][0].request.invoices).toEqual([]);
    isInvoicePending.mockResolvedValueOnce({ quotationId: 9 }); // accepted, invoice not created yet: the app shows a pending state
    await controller.getMyRequestById({ user: { id: '7' }, params: { id: '50' } }, res, jest.fn());
    expect(isInvoicePending).toHaveBeenCalledWith({ userId: 7, requestId: 50 });
    expect(res.json.mock.calls[2][0].request).toMatchObject({ invoicePending: true, invoicePendingQuotationId: 9 });
    jest.dontMock('../../src/modules/requests/requests.service');
    jest.dontMock('../../src/modules/payments/patient-invoices.service');
    jest.dontMock('../../src/modules/quotations/quotation-invoice.service');
  });
  test('static: the invoice service never writes, locks, calls the gateway or logs', () => {
    const code = fs.readFileSync(path.join(__dirname, '../../src/modules/payments/patient-invoices.service.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\.create\(|\.update|\.delete|upsert|\$executeRaw|\$queryRaw|FOR UPDATE|fetch\(|console\.|razorpay\.api|createOrder/);
  });
});
