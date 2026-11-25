/* global describe, test, expect, jest, beforeAll, afterAll */
// Hosted Razorpay Standard Checkout, backend foundation: the signed session and return tokens, session creation, single-use redemption, ownership and
// binding, what the page receives, the return redirect, and the rule that NOTHING the browser reports completes a payment. No database and no network:
// Prisma is an in-memory fake that also counts every attempt to write a payment.
// requireAuth looks the patient up once (a retired account is refused at once); these tests have no such account row.
jest.mock('../../src/db/prisma', () => ({ prisma: { user: { findUnique: async () => null } } }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const tokens = require('../../src/modules/payments/checkout-session.token');
const service = require('../../src/modules/payments/checkout-session.service');
const page = require('../../src/modules/payments/checkout-page');
const { invoicesRouter } = require('../../src/modules/payments/payments.routes');
const { checkoutRouter } = require('../../src/modules/payments/checkout.routes');

const JWT_SECRET = 'test-access-secret-for-hosted-checkout';
const API_SECRET = 'FAKE_API_KEY_SECRET_MUST_NEVER_LEAK_1';
const WEBHOOK_SECRET = 'FAKE_WEBHOOK_SECRET_MUST_NEVER_LEAK_2';
const ENV = Object.freeze({
  JWT_ACCESS_SECRET: JWT_SECRET, PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_KEY_ID: 'rzp_test_FAKEKEY123456',
  RAZORPAY_KEY_SECRET: API_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
});
const NOW = new Date('2026-11-20T10:00:00.000Z');
const later = (seconds) => new Date(NOW.getTime() + seconds * 1000);
const ME = 7;
const OTHER = 8;

const invoiceRow = (over = {}) => ({
  id: 1, caseId: 10, source: 'quotation', status: 'issued', amount: '1500.000', currency: 'INR', dueDate: null, quotationId: 5, allowPartialPayment: false,
  quotation: { id: 5, status: 'accepted', supersededAt: null },
  case: { id: 10, status: 'in_progress', closedAt: null, serviceRequest: { id: 50, userId: ME, serviceKey: 'privatecharter' } }, ...over,
});
const paymentRow = (over = {}) => ({
  id: 100, invoiceId: 1, caseId: 10, currency: 'INR', kind: 'payment', amount: '1500.000', status: 'pending', method: 'razorpay', razorpayOrderId: 'order_TESTORDER1',
  externalReference: null, idempotencyKey: 'rzp-order:SECRETKEY', createdAt: NOW, updatedAt: NOW, ...over,
});

function fakeDb({ invoices = [invoiceRow()], payments = [paymentRow()] } = {}) {
  const writes = { payment: 0 };
  const audits = [];
  const count = (name) => jest.fn(async () => { writes.payment += 1; throw new Error(`a payment write was attempted: ${name}`); });
  return {
    writes, audits,
    invoice: { findUnique: jest.fn(async ({ where }) => invoices.find((i) => i.id === where.id) || null) },
    payment: {
      findUnique: jest.fn(async ({ where }) => payments.find((p) => p.id === where.id) || null),
      findMany: jest.fn(async ({ where }) => payments.filter((p) => p.invoiceId === where.invoiceId)),
      create: count('create'), update: count('update'), updateMany: count('updateMany'), upsert: count('upsert'), delete: count('delete'), deleteMany: count('deleteMany'),
    },
    auditLog: {
      create: jest.fn(async ({ data }) => {
        if (data.idempotencyKey && audits.some((a) => a.entityType === data.entityType && a.entityId === data.entityId && a.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        audits.push(JSON.parse(JSON.stringify({ ...data, recordedAt: NOW }))); // recordedAt: what the database's own default would stamp
        return {};
      }),
      findUnique: jest.fn(async ({ where }) => {
        const k = where.entityType_entityId_idempotencyKey;
        const row = audits.find((a) => a.entityType === k.entityType && a.entityId === k.entityId && a.idempotencyKey === k.idempotencyKey);
        return row ? { recordedAt: new Date(row.recordedAt) } : null;
      }),
    },
  };
}
const ids = (over = {}) => ({ userId: ME, invoiceId: 1, paymentId: 100, ...over });
const opts = (over = {}) => ({ env: ENV, now: NOW, ...over });
const session = (db, over = {}) => service.createCheckoutSession({ userId: ME, invoiceId: '1', db, env: ENV, now: () => NOW, ...over });
const tokenOf = (checkoutPath) => checkoutPath.replace('/checkout/', '');
const open = (db, token, over = {}) => service.openCheckout({ token, db, env: ENV, now: () => NOW, ...over });

// ---- tokens -----------------------------------------------------------------------------------------------------------------------------------------
describe('signed tokens', () => {
  test('a token round-trips with exactly the ids it was made for, and carries no secret, no Bearer token and no personal data', () => {
    const { token, jti, expiresAt } = tokens.signToken('s', ids(), opts());
    const verified = tokens.verifyToken('s', token, opts());
    expect(verified).toEqual({ ok: true, claims: { userId: ME, invoiceId: 1, paymentId: 100, jti, expiresAt } });
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['exp', 'inv', 'jti', 'k', 'pay', 'uid', 'v']);
    expect(token).not.toMatch(/FAKE|secret|rzp_|Bearer/i);
  });
  test('lifetimes: a session lasts ten minutes, a return token thirty', () => {
    expect(tokens.signToken('s', ids(), opts()).expiresAt.getTime() - NOW.getTime()).toBe(10 * 60 * 1000);
    expect(tokens.signToken('r', ids(), opts()).expiresAt.getTime() - NOW.getTime()).toBe(30 * 60 * 1000);
  });
  test('expiry is exact: valid one second before, expired at the second', () => {
    const { token } = tokens.signToken('s', ids(), opts());
    expect(tokens.verifyToken('s', token, opts({ now: later(599) })).ok).toBe(true);
    expect(tokens.verifyToken('s', token, opts({ now: later(600) }))).toMatchObject({ ok: false, code: 'expired', claims: { invoiceId: 1 } });
  });
  test('a session token is not a return token and the reverse', () => {
    const s = tokens.signToken('s', ids(), opts()).token;
    const r = tokens.signToken('r', ids(), opts()).token;
    expect(tokens.verifyToken('r', s, opts())).toMatchObject({ ok: false, code: 'wrong_kind' });
    expect(tokens.verifyToken('s', r, opts())).toMatchObject({ ok: false, code: 'wrong_kind' });
  });
  test.each([
    ['empty', ''], ['no dot', 'abcdef'], ['three parts', 'a.b.c'], ['bad characters', 'abc$.def'], ['whitespace', 'abc .def'], ['too long', `${'a'.repeat(600)}.${'b'.repeat(10)}`],
    ['not a string', 12345], ['undefined', undefined], ['null', null], ['an object', { a: 1 }],
  ])('malformed: %s', (_l, value) => { expect(tokens.verifyToken('s', value, opts())).toMatchObject({ ok: false }); });
  test('a tampered payload or signature is refused, and an invalid token reveals no claims', () => {
    const { token } = tokens.signToken('s', ids(), opts());
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), uid: OTHER })).toString('base64url');
    expect(tokens.verifyToken('s', `${forged}.${signature}`, opts())).toEqual({ ok: false, code: 'signature' });
    expect(tokens.verifyToken('s', `${payload}.${signature.slice(0, -2)}AA`, opts())).toEqual({ ok: false, code: 'signature' });
    expect(tokens.verifyToken('s', `${payload}.`, opts())).toMatchObject({ ok: false });
  });
  test('a token signed with another secret is refused', () => {
    const { token } = tokens.signToken('s', ids(), opts({ env: { JWT_ACCESS_SECRET: 'a-different-secret-entirely' } }));
    expect(tokens.verifyToken('s', token, opts())).toEqual({ ok: false, code: 'signature' });
  });
  test('a JWT is never a hosted-checkout token and a hosted-checkout token is never a JWT (different key and format)', () => {
    const asJwt = jwt.sign({ sub: ME, role: 'patient' }, JWT_SECRET, { expiresIn: '5m' });
    expect(tokens.verifyToken('s', asJwt, opts())).toMatchObject({ ok: false });
    const { token } = tokens.signToken('s', ids(), opts());
    expect(() => jwt.verify(token, JWT_SECRET)).toThrow();
  });
  test('with no signing secret configured nothing is signed and nothing is accepted', () => {
    expect(tokens.signToken('s', ids(), opts({ env: {} }))).toBeNull();
    const { token } = tokens.signToken('s', ids(), opts());
    expect(tokens.verifyToken('s', token, opts({ env: { JWT_ACCESS_SECRET: '' } }))).toEqual({ ok: false, code: 'unconfigured' });
  });
  test('arguments are validated', () => {
    expect(() => tokens.signToken('x', ids(), opts())).toThrow(RangeError);
    expect(() => tokens.signToken('s', ids({ invoiceId: 0 }), opts())).toThrow(RangeError);
    expect(() => tokens.signToken('s', ids({ paymentId: '1' }), opts())).toThrow(RangeError);
  });
});

// ---- creating a session ----------------------------------------------------------------------------------------------------------------------------
describe('creating a checkout session (authenticated patient)', () => {
  test('returns a relative path and an expiry; the token is bound to this patient, this invoice and the open payment; no order or payment is created', async () => {
    const db = fakeDb();
    const result = await session(db);
    expect(Object.keys(result).sort()).toEqual(['checkoutPath', 'expiresAt']);
    expect(result.checkoutPath).toMatch(/^\/checkout\/[A-Za-z0-9_.-]+$/);
    expect(result.expiresAt).toBe(later(600).toISOString());
    expect(tokens.verifyToken('s', tokenOf(result.checkoutPath), opts()).claims).toMatchObject({ userId: ME, invoiceId: 1, paymentId: 100 });
    expect(db.writes.payment).toBe(0);
    expect(db.auditLog.create).not.toHaveBeenCalled(); // creating a session consumes nothing
  });
  test('another patient\'s invoice, a missing one, a draft and a malformed id are the same 404', async () => {
    const errors = [];
    for (const [db, over] of [[fakeDb(), { userId: OTHER }], [fakeDb(), { invoiceId: '99' }], [fakeDb({ invoices: [invoiceRow({ status: 'draft' })] }), {}], [fakeDb(), { invoiceId: 'x' }]]) {
      const e = await session(db, over).catch((x) => x);
      errors.push(JSON.stringify([e.statusCode, e.publicCode, e.message]));
    }
    expect(new Set(errors).size).toBe(1);
    expect(JSON.parse(errors[0])).toEqual([404, 'invoice_not_found', 'Invoice not found.']);
  });
  test.each([
    ['payments disabled', { env: { ...ENV, PAYMENTS_ENABLED: 'false' } }, {}, 503, 'payments_disabled'],
    ['credentials unusable', { env: { ...ENV, RAZORPAY_KEY_SECRET: undefined } }, {}, 503, 'payments_disabled'],
    ['no signing secret', { env: { ...ENV, JWT_ACCESS_SECRET: undefined } }, {}, 503, 'payments_disabled'],
    ['invoice void', {}, { invoices: [invoiceRow({ status: 'void' })] }, 409, 'invoice_not_payable'],
    ['overdue', {}, { invoices: [invoiceRow({ dueDate: new Date('2026-11-01') })] }, 409, 'invoice_overdue'],
    ['quotation no longer active', {}, { invoices: [invoiceRow({ quotation: { id: 5, status: 'accepted', supersededAt: new Date() } })] }, 409, 'quotation_not_active'],
  ])('refused: %s', async (_l, callOver, dbOver, status, code) => {
    const e = await session(fakeDb(dbOver), callOver).catch((x) => x);
    expect([e.statusCode, e.publicCode]).toEqual([status, code]);
  });
  test.each([
    ['no payment at all', []],
    ['only a completed payment', [paymentRow({ status: 'completed' })]],
    ['a pending row that has no order yet', [paymentRow({ razorpayOrderId: null })]],
    ['a failed row', [paymentRow({ status: 'failed' })]],
    ['a pending refund', [paymentRow({ kind: 'refund' })]],
  ])('no open Razorpay payment (%s) -> 409 no_open_payment, and NO order is created here', async (_l, payments) => {
    const db = fakeDb({ payments });
    const e = await session(db).catch((x) => x);
    expect([e.statusCode, e.publicCode]).toEqual([409, 'no_open_payment']);
    expect(db.writes.payment).toBe(0);
  });
});

// ---- redeeming a session ---------------------------------------------------------------------------------------------------------------------------
describe('redeeming a session (the hosted page)', () => {
  test('valid: ready, with ONLY public checkout data, and the session is consumed by one audit row', async () => {
    const db = fakeDb();
    const { token } = tokens.signToken('s', ids(), opts());
    const result = await open(db, token);
    expect(result.outcome).toBe('ready');
    expect(Object.keys(result.config).sort()).toEqual(['amount', 'currency', 'invoiceId', 'keyId', 'orderId', 'returnToken']);
    expect(result.config).toMatchObject({ keyId: 'rzp_test_FAKEKEY123456', orderId: 'order_TESTORDER1', amount: 150000, currency: 'INR', invoiceId: 1 });
    const text = JSON.stringify(result);
    expect(text).not.toContain(API_SECRET);
    expect(text).not.toContain(WEBHOOK_SECRET);
    expect(text).not.toMatch(/SECRETKEY|idempotency|userId|paymentId|Bearer/i);
    expect(tokens.verifyToken('r', result.config.returnToken, opts()).claims).toMatchObject({ userId: ME, invoiceId: 1, paymentId: 100 });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ entityType: 'payment', entityId: '100', action: 'payment.checkout_opened', actorType: 'patient', caseId: 10 });
    expect(db.audits[0].idempotencyKey).toMatch(/^checkout:[0-9a-f]{32}$/);
    expect(db.writes.payment).toBe(0);
  });
  test('REPEATED within moments (Safari sends the same navigation three times): the same page again, ONE audit row, nothing else written', async () => {
    const db = fakeDb();
    const { token } = tokens.signToken('s', ids(), opts());
    const first = await open(db, token);
    expect(first.outcome).toBe('ready');
    for (const seconds of [0.3, 0.7]) {
      const again = await open(db, token, { now: () => later(seconds) });
      expect(again.outcome).toBe('ready');
      expect(again.config).toMatchObject({ keyId: first.config.keyId, orderId: first.config.orderId, amount: 150000, currency: 'INR', invoiceId: 1 });
      expect(Object.keys(again.config).sort()).toEqual(['amount', 'currency', 'invoiceId', 'keyId', 'orderId', 'returnToken']);
    }
    expect(db.audits).toHaveLength(1);
    expect(db.auditLog.create).toHaveBeenCalledTimes(3); // two refused duplicates, none written
    expect(db.writes.payment).toBe(0);
    for (const fn of ['create', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) expect(db.payment[fn]).not.toHaveBeenCalled();
  });
  test('REUSED after the replay window: "used", and nothing further is written', async () => {
    const db = fakeDb();
    const { token } = tokens.signToken('s', ids(), opts());
    expect((await open(db, token)).outcome).toBe('ready');
    const afterWindow = () => later(service.REPLAY_WINDOW_MS / 1000 + 1);
    expect(await open(db, token, { now: afterWindow })).toEqual({ outcome: 'used', invoiceId: 1 });
    expect(await open(db, token, { now: afterWindow })).toEqual({ outcome: 'used', invoiceId: 1 });
    expect(db.audits).toHaveLength(1);
  });
  test('a repeat is still fully re-checked: expired, invalid, ineligible or no-longer-pending is refused, not replayed', async () => {
    const db = fakeDb();
    const { token } = tokens.signToken('s', ids(), opts());
    expect((await open(db, token)).outcome).toBe('ready');
    expect(await open(db, token, { now: () => later(601) })).toMatchObject({ outcome: 'expired' }); // past the token's own ten minutes
    expect(await open(db, token, { env: { ...ENV, JWT_ACCESS_SECRET: 'another-secret' } })).toMatchObject({ outcome: 'invalid' });
    expect(await open(db, token + 'x')).toMatchObject({ outcome: 'invalid' });
    expect(await open(db, 'garbage')).toMatchObject({ outcome: 'invalid' });
    const jti = tokens.verifyToken('s', token, opts()).claims.jti;
    for (const over of [
      { invoices: [invoiceRow({ status: 'void' })] },
      { invoices: [invoiceRow({ case: { id: 10, status: 'cancelled', closedAt: null, serviceRequest: { id: 50, userId: ME, serviceKey: 'privatecharter' } } })] },
      { invoices: [invoiceRow({ case: { id: 10, status: 'in_progress', closedAt: null, serviceRequest: { id: 50, userId: OTHER, serviceKey: 'privatecharter' } } })] },
      { payments: [paymentRow({ status: 'completed' })] },
      { payments: [paymentRow({ status: 'cancelled' })] },
      { payments: [paymentRow({ razorpayOrderId: null })] },
    ]) {
      const other = fakeDb(over);
      // the session was already redeemed (the audit row exists), as after a first page load
      other.audits.push({ entityType: 'payment', entityId: '100', idempotencyKey: `checkout:${jti}`, recordedAt: NOW });
      expect(await open(other, token)).toMatchObject({ outcome: 'unavailable' });
      expect(other.audits).toHaveLength(1);
    }
    expect(db.audits).toHaveLength(1);
  });
  test('REPEATED at the same instant: several simultaneous requests all get the page, but exactly one writes the audit row', async () => {
    const db = fakeDb();
    const { token } = tokens.signToken('s', ids(), opts());
    const results = await Promise.all([1, 2, 3, 4].map(() => open(db, token)));
    expect(results.map((r) => r.outcome)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(db.audits).toHaveLength(1);
  });
  test('two different sessions for the same payment are each valid once', async () => {
    const db = fakeDb();
    const a = tokens.signToken('s', ids(), opts()).token; const b = tokens.signToken('s', ids(), opts()).token;
    expect((await open(db, a)).outcome).toBe('ready');
    expect((await open(db, b)).outcome).toBe('ready');
    expect(db.audits).toHaveLength(2); // one row per session
    expect((await open(db, a, { now: () => later(service.REPLAY_WINDOW_MS / 1000 + 1) })).outcome).toBe('used');
  });
  test('EXPIRED: refused, naming the invoice for the app link, and not consumed', async () => {
    const db = fakeDb();
    const { token } = tokens.signToken('s', ids(), opts());
    expect(await open(db, token, { now: () => later(601) })).toEqual({ outcome: 'expired', invoiceId: 1 });
    expect(db.audits).toHaveLength(0);
  });
  test.each([['missing', undefined], ['empty', ''], ['garbage', 'not-a-token'], ['a JWT', jwt.sign({ sub: ME, role: 'patient' }, JWT_SECRET)], ['a return token', tokens.signToken('r', ids(), opts()).token]])(
    'INVALID: %s', async (_l, token) => {
      const db = fakeDb();
      expect(await open(db, token)).toEqual({ outcome: 'invalid' });
      expect(db.audits).toHaveLength(0);
      expect(db.invoice.findUnique).not.toHaveBeenCalled(); // nothing is even looked up for an invalid token
    },
  );
  test('a tampered token (another patient\'s id swapped in) is invalid', async () => {
    const db = fakeDb();
    const [payload, signature] = tokens.signToken('s', ids(), opts()).token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), uid: OTHER })).toString('base64url');
    expect(await open(db, `${forged}.${signature}`)).toEqual({ outcome: 'invalid' });
  });
  test('ANOTHER PATIENT: a validly signed token for a patient who does not own the invoice opens nothing and is not consumed', async () => {
    const db = fakeDb();
    const { token } = tokens.signToken('s', ids({ userId: OTHER }), opts());
    expect(await open(db, token)).toEqual({ outcome: 'unavailable', invoiceId: 1 });
    expect(db.audits).toHaveLength(0);
  });
  test('ANOTHER INVOICE / PAYMENT: a token whose payment belongs to a different invoice opens nothing and is not consumed', async () => {
    const db = fakeDb({ invoices: [invoiceRow(), invoiceRow({ id: 2, caseId: 11, case: { id: 11, status: 'in_progress', closedAt: null, serviceRequest: { id: 51, userId: ME, serviceKey: 'privatecharter' } } })], payments: [paymentRow(), paymentRow({ id: 200, invoiceId: 2, caseId: 11, razorpayOrderId: 'order_OTHERINVOICE' })] });
    const crossed = tokens.signToken('s', ids({ invoiceId: 1, paymentId: 200 }), opts()).token; // invoice 1 with invoice 2's payment
    expect(await open(db, crossed)).toEqual({ outcome: 'unavailable', invoiceId: 1 });
    const swapped = tokens.signToken('s', ids({ invoiceId: 2, paymentId: 100 }), opts()).token;
    expect(await open(db, swapped)).toEqual({ outcome: 'unavailable', invoiceId: 2 });
    expect(db.audits).toHaveLength(0);
  });
  test.each([
    ['the payment is no longer pending', { payments: [paymentRow({ status: 'completed' })] }],
    ['the payment failed', { payments: [paymentRow({ status: 'failed' })] }],
    ['the payment has no order', { payments: [paymentRow({ razorpayOrderId: null })] }],
    ['the payment is gone', { payments: [] }],
    ['the invoice became void', { invoices: [invoiceRow({ status: 'void' })] }],
    ['the invoice is overdue now', { invoices: [invoiceRow({ dueDate: new Date('2026-11-01') })] }],
  ])('UNAVAILABLE when %s, and not consumed', async (_l, dbOver) => {
    const db = fakeDb(dbOver);
    const { token } = tokens.signToken('s', ids(), opts());
    expect(await open(db, token)).toEqual({ outcome: 'unavailable', invoiceId: 1 });
    expect(db.audits).toHaveLength(0);
  });
  test('UNAVAILABLE when payments are off or the credentials are unusable', async () => {
    const { token } = tokens.signToken('s', ids(), opts());
    expect(await open(fakeDb(), token, { env: { ...ENV, PAYMENTS_ENABLED: 'no' } })).toMatchObject({ outcome: 'unavailable' });
    expect(await open(fakeDb(), token, { env: { ...ENV, RAZORPAY_KEY_ID: 'rzp_live_FAKEKEY123456' } })).toMatchObject({ outcome: 'unavailable' }); // a live key outside production
  });
  test('a database error while consuming is not swallowed as "used"', async () => {
    const db = fakeDb();
    db.auditLog.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(open(db, tokens.signToken('s', ids(), opts()).token)).rejects.toThrow('connection lost');
  });
});

// ---- the return ------------------------------------------------------------------------------------------------------------------------------------
describe('the return to the app', () => {
  const ret = () => tokens.signToken('r', ids(), opts()).token;
  test('Razorpay\'s POST: a well-formed payment id is "submitted", anything else is "failed"; no other field is ever read', () => {
    expect(service.classifyReturn('POST', { body: { razorpay_payment_id: 'pay_ABC123', razorpay_order_id: 'order_X', razorpay_signature: 'f'.repeat(64) } })).toBe('submitted');
    expect(service.classifyReturn('POST', { body: { 'error[code]': 'BAD_REQUEST_ERROR', 'error[description]': 'secret text' } })).toBe('failed');
    expect(service.classifyReturn('POST', { body: { razorpay_payment_id: 'not-a-payment-id' } })).toBe('failed');
    expect(service.classifyReturn('POST', { body: { razorpay_payment_id: ['pay_A', 'pay_B'] } })).toBe('failed');
    expect(service.classifyReturn('POST', {})).toBe('failed');
  });
  test('the page\'s GET: only allow-listed words, anything else is "returned"', () => {
    for (const w of ['cancelled', 'failed', 'unavailable', 'submitted', 'expired', 'returned']) expect(service.classifyReturn('GET', { query: { result: w } })).toBe(w);
    for (const w of ['evil', 'completed', 'paid', 'success', '<script>', '', ['cancelled', 'x']]) expect(service.classifyReturn('GET', { query: { result: w } })).toBe('returned');
    expect(service.classifyReturn('GET', {})).toBe('returned');
  });
  test('the app link is always the fixed scheme and path; the invoice comes from the VERIFIED token; a bad word cannot be injected', () => {
    expect(service.returnLocation({ ret: ret(), result: 'submitted', env: ENV, now: () => NOW })).toBe('humancare://payment-return?invoice=1&result=submitted');
    expect(service.returnLocation({ ret: ret(), result: 'evil&x=1', env: ENV, now: () => NOW })).toBe('humancare://payment-return?invoice=1&result=returned');
    expect(service.returnLocation({ ret: ret(), result: undefined, env: ENV, now: () => NOW })).toBe('humancare://payment-return?invoice=1&result=returned');
  });
  test('a tampered, wrong-kind or garbage return token goes back with NO invoice and "unavailable"; an expired one says "expired"', () => {
    const [p, s] = ret().split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), inv: 999 })).toString('base64url');
    for (const bad of [`${forged}.${s}`, tokens.signToken('s', ids(), opts()).token, 'garbage', undefined]) {
      expect(service.returnLocation({ ret: bad, result: 'submitted', env: ENV, now: () => NOW })).toBe('humancare://payment-return?result=unavailable');
    }
    expect(service.returnLocation({ ret: ret(), result: 'submitted', env: ENV, now: () => later(1801) })).toBe('humancare://payment-return?invoice=1&result=expired');
  });
});

// ---- the page --------------------------------------------------------------------------------------------------------------------------------------
describe('the hosted page', () => {
  const config = { keyId: 'rzp_test_FAKEKEY123456', orderId: 'order_TESTORDER1', amount: 150000, currency: 'INR', invoiceId: 1, returnToken: 'abc.def' };
  test('contains only the public data, as a non-executed JSON block, and the nonce on both scripts', () => {
    const html = page.renderCheckoutPage(config, 'NONCE123');
    const block = /<script type="application\/json" id="hc-config">([^<]*)<\/script>/.exec(html);
    expect(JSON.parse(block[1])).toEqual(config);
    expect((html.match(/nonce="NONCE123"/g) || []).length).toBe(2);
    expect(html).toContain('src="https://checkout.razorpay.com/v1/checkout.js"');
    expect(html).not.toMatch(/FAKE_API|FAKE_WEBHOOK|secret|Bearer|signature/i);
    expect(html).not.toMatch(/ on(click|load|error)=/i); // no inline event handlers
  });
  test('a hostile value cannot close the data block or start markup', () => {
    const html = page.renderCheckoutPage({ ...config, orderId: '</script><img src=x onerror=alert(1)>& ' }, 'N');
    const block = /<script type="application\/json" id="hc-config">([\s\S]*?)<\/script>/.exec(html)[1];
    expect(block).not.toMatch(new RegExp('[<>&\u2028]'));
    expect(JSON.parse(block).orderId).toBe('</script><img src=x onerror=alert(1)>& ');
  });
  test('the script is static: no template placeholder, never touches a secret, and the order is opened with the SERVER values (key, order, amount, currency)', () => {
    expect(page.PAGE_SCRIPT).not.toMatch(/\$\{|`/);
    expect(page.PAGE_SCRIPT).toMatch(/key: cfg\.keyId[\s\S]*order_id: cfg\.orderId[\s\S]*amount: cfg\.amount[\s\S]*currency: cfg\.currency/);
    expect(page.PAGE_SCRIPT).toContain('redirect: true');
    expect(page.PAGE_SCRIPT).toContain("replaceState(null, '', '/checkout/closed')"); // the session token leaves the address bar
    expect(page.PAGE_SCRIPT).not.toMatch(/localStorage|sessionStorage|document\.cookie|fetch\(|XMLHttpRequest|eval\(|Function\(/);
  });
  test('the browser can only leave through the controlled return route, with allow-listed words', () => {
    expect(page.PAGE_SCRIPT).toMatch(/\/checkout\/return\//);
    expect([...page.PAGE_SCRIPT.matchAll(/leave\('([a-z]+)'\)/g)].map((m) => m[1]).sort()).toEqual(['cancelled', 'cancelled']);
    expect(page.PAGE_SCRIPT).not.toMatch(/humancare:\/\/|window\.location\.(href|assign) *=/);
  });
  test('headers: never cached, no referrer, no framing, a CSP bound to the nonce that allows only Razorpay\'s hosts', () => {
    const h = page.securityHeaders('NONCE123');
    expect(h).toMatchObject({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
    const csp = h['Content-Security-Policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-NONCE123' https://checkout.razorpay.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline|script-src[^;]*\*|unsafe-eval/);
    expect(page.nonce()).not.toBe(page.nonce());
  });
  test('the message page escapes everything it prints', () => {
    const html = page.renderMessagePage({ title: '<b>x</b>', message: 'a & "b"', appLink: 'humancare://payment-return?invoice=1&result=expired' });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('href="humancare://payment-return?invoice=1&amp;result=expired"');
  });
});

// ---- the HTTP routes -------------------------------------------------------------------------------------------------------------------------------
describe('the routes (real Express routing and JWT authentication)', () => {
  let server; let base; let db; const saved = {};
  const keys = Object.keys(ENV);
  const patientJwt = (sub = ME, role = 'patient') => jwt.sign({ sub, role }, JWT_SECRET, { expiresIn: '5m' });

  beforeAll(async () => {
    for (const k of keys) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    db = fakeDb();
    Object.assign(require('../../src/db/prisma').prisma, db);
    const app = express();
    app.use('/invoices', invoicesRouter);
    app.use('/checkout', checkoutRouter);
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => { const status = err.statusCode || 500; res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message, ...(status !== 500 && err.publicCode && { code: err.publicCode }) }); });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  const call = (method, url, { token, form, headers = {} } = {}) => new Promise((resolve, reject) => {
    const body = form === undefined ? undefined : new URLSearchParams(form).toString();
    const req = http.request(`${base}${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const newSession = (t) => call('POST', '/invoices/1/checkout-sessions', { token: t, headers: { 'Content-Length': '0' } }); // t is explicit: undefined means NO token

  test('POST /invoices/:id/checkout-sessions: 401 without a token, 403 for another role, 401 for a legacy admin token', async () => {
    expect((await newSession(undefined)).status).toBe(401);
    expect((await newSession(patientJwt(ME, 'corporate'))).status).toBe(403);
    expect((await newSession(patientJwt(ME, 'admin'))).status).toBe(401);
  });
  test('the owner gets 201 { checkoutPath, expiresAt } (no-store); another patient gets the same 404 as for a missing invoice', async () => {
    const ok = await newSession(patientJwt());
    expect(ok.status).toBe(201);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(Object.keys(ok.json()).sort()).toEqual(['checkoutPath', 'expiresAt']);
    const other = await newSession(patientJwt(OTHER));
    const missing = await call('POST', '/invoices/999/checkout-sessions', { token: patientJwt(OTHER), headers: { 'Content-Length': '0' } });
    expect(other.status).toBe(404);
    expect(other.json()).toEqual(missing.json());
  });
  test('the page: 200 HTML with the CSP and no-referrer headers once, then 410 "already used"; the page holds no secret and no Bearer token', async () => {
    const { checkoutPath } = (await newSession(patientJwt())).json();
    const first = await call('GET', checkoutPath);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/^text\/html/);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['referrer-policy']).toBe('no-referrer');
    const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(first.headers['content-security-policy'])[1];
    expect(first.text).toContain(`nonce="${nonce}"`);
    expect(first.text).toContain('rzp_test_FAKEKEY123456');
    expect(first.text).toContain('order_TESTORDER1');
    expect(first.text).not.toContain(API_SECRET);
    expect(first.text).not.toContain(WEBHOOK_SECRET);
    expect(first.text).not.toContain(JWT_SECRET);
    expect(first.text).not.toMatch(/Bearer/);
    expect(first.text).not.toContain(patientJwt()); // (the page is never given the patient's login token)
    const second = await call('GET', checkoutPath);
    expect(second.status).toBe(410);
    expect(second.text).toContain('already used');
    expect(second.text).not.toContain('rzp_test_');
    expect(second.text).toContain('humancare://payment-return?invoice=1&amp;result=unavailable');
  });
  test('only a genuine document GET redeems the token: HEAD, prefetch, prerender and non-document fetches never consume it', async () => {
    const consumed = () => db.audits.filter((a) => a.action === 'payment.checkout_opened').length; // rows actually written (a refused duplicate writes none)
    const { checkoutPath } = (await newSession(patientJwt())).json();
    const before = consumed();
    const excluded = [
      ['HEAD', {}],
      ['GET', { Purpose: 'prefetch' }],
      ['GET', { 'Sec-Purpose': 'prefetch' }],
      ['GET', { 'Sec-Purpose': 'prefetch;prerender' }],
      ['GET', { 'Sec-Purpose': 'prerender' }],
      ['GET', { 'Sec-Fetch-Dest': 'empty' }],
      ['GET', { 'Sec-Fetch-Dest': 'image' }],
      ['GET', { 'Sec-Fetch-Dest': 'iframe' }],
      ['GET', { 'Sec-Fetch-Dest': 'script' }],
    ];
    for (const [method, headers] of excluded) {
      const r = await call(method, checkoutPath, { headers });
      expect(r.status).toBe(204);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.text).toBe('');
      expect(r.text).not.toMatch(/rzp_|order_|already used/);
    }
    expect(consumed()).toBe(before); // nothing was redeemed
    const real = await call('GET', checkoutPath, { headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' } });
    expect(real.status).toBe(200); // the token was still unused
    expect(real.text).toContain('order_TESTORDER1');
    expect(consumed()).toBe(before + 1);
    const again = await call('GET', checkoutPath, { headers: { 'Sec-Fetch-Dest': 'document' } });
    expect(again.status).toBe(410); // single use is intact for genuine navigations
    expect(again.text).toContain('already used');
    expect(consumed()).toBe(before + 1);
  });
  test('Safari-style repeats over real HTTP: three document GETs of one token all return the page; one audit row; later it is "already used"', async () => {
    const rows = () => db.audits.filter((a) => a.action === 'payment.checkout_opened');
    const before = rows().length;
    const { checkoutPath } = (await newSession(patientJwt())).json();
    const doc = { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'User-Agent': 'Safari' };
    const first = await call('GET', checkoutPath, { headers: { ...doc, Referer: 'http://localhost:8082/request-details?id=208' } });
    expect(first.status).toBe(200);
    expect(rows()).toHaveLength(before + 1);
    rows()[before].recordedAt = new Date(); // the route reads the real clock; the fake database stamps a fixed time otherwise
    const second = await call('GET', checkoutPath, { headers: doc });
    const third = await call('GET', checkoutPath, { headers: doc });
    for (const r of [second, third]) {
      expect(r.status).toBe(200);
      expect(r.text).toContain('order_TESTORDER1');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.text).not.toContain(API_SECRET);
    }
    expect(rows()).toHaveLength(before + 1); // no extra audit row
    rows()[before].recordedAt = new Date(Date.now() - 60 * 1000); // the first redemption was a minute ago
    const late = await call('GET', checkoutPath, { headers: doc });
    expect(late.status).toBe(410);
    expect(late.text).toContain('already used');
    expect(rows()).toHaveLength(before + 1);
    expect(db.writes.payment).toBe(0);
  });
  test('a GET with no fetch-metadata headers (an older browser) is still a navigation; a document navigation with Purpose absent redeems once', async () => {
    const { checkoutPath } = (await newSession(patientJwt())).json();
    expect((await call('GET', checkoutPath)).status).toBe(200);
    expect((await call('GET', checkoutPath)).status).toBe(410);
  });
  test('a missing, garbage or tampered token is a 400 page that reveals nothing; "closed" (the address after the page loads) is just invalid', async () => {
    for (const p of ['/checkout/garbage', '/checkout/closed', '/checkout/a.b', `/checkout/${'x'.repeat(600)}`]) {
      const r = await call('GET', p);
      expect(r.status).toBe(400);
      expect(r.text).not.toMatch(/rzp_|order_/);
    }
  });
  test('the return: Razorpay\'s POST with a payment id is a 303 to the app with "submitted"; an error post is "failed"; the page\'s GET is "cancelled"', async () => {
    const ret = tokens.signToken('r', ids(), opts({ now: new Date() })).token;
    const ok = await call('POST', `/checkout/return/${ret}`, { form: { razorpay_payment_id: 'pay_ABC123', razorpay_order_id: 'order_TESTORDER1', razorpay_signature: 'a'.repeat(64) } });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('humancare://payment-return?invoice=1&result=submitted');
    expect(ok.text).not.toMatch(/pay_ABC123|a{64}/); // nothing from the body is echoed
    const bad = await call('POST', `/checkout/return/${ret}`, { form: { 'error[code]': 'BAD_REQUEST_ERROR', 'error[description]': 'private detail' } });
    expect(bad.headers.location).toBe('humancare://payment-return?invoice=1&result=failed');
    expect(bad.text).not.toMatch(/private detail/);
    const cancelled = await call('GET', `/checkout/return/${ret}?result=cancelled`);
    expect(cancelled.headers.location).toBe('humancare://payment-return?invoice=1&result=cancelled');
    const forged = await call('GET', `/checkout/return/garbage?result=submitted`);
    expect(forged.headers.location).toBe('humancare://payment-return?result=unavailable');
    expect(cancelled.headers['referrer-policy']).toBe('no-referrer');
  });
  test('NOTHING in the browser flow completes a payment: after sessions, pages, success, failure and cancel returns, no payment was written and it is still pending', async () => {
    const { checkoutPath } = (await newSession(patientJwt())).json();
    await call('GET', checkoutPath);
    const ret = tokens.signToken('r', ids(), opts({ now: new Date() })).token;
    await call('POST', `/checkout/return/${ret}`, { form: { razorpay_payment_id: 'pay_ABC123', razorpay_order_id: 'order_TESTORDER1', razorpay_signature: 'a'.repeat(64) } });
    await call('GET', `/checkout/return/${ret}?result=submitted`);
    await call('GET', `/checkout/return/${ret}?result=cancelled`);
    expect(db.writes.payment).toBe(0);
    for (const fn of ['create', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) expect(db.payment[fn]).not.toHaveBeenCalled();
    const stored = await db.payment.findUnique({ where: { id: 100 } });
    expect(stored).toMatchObject({ status: 'pending', externalReference: null });
  });
});

describe('static checks of the hosted checkout source', () => {
  const files = ['checkout-session.token.js', 'checkout-session.service.js', 'checkout-page.js', 'checkout.controller.js', 'checkout.routes.js'];
  const code = (f) => fs.readFileSync(path.join(__dirname, '../../src/modules/payments', f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  test('no network, no Razorpay API, no logging, no payment writes, no secret other than the derived signing key, no order creation', () => {
    for (const f of files) {
      const c = code(f);
      expect(c).not.toMatch(/fetch\(|require\('https?'\)|razorpay\.api|createOrder|console\.|logger\./);
      expect(c).not.toMatch(/payment\.(create|update|updateMany|upsert|delete|deleteMany)|\$executeRaw|\$queryRaw|insertPendingPayment|attachOrderId|closePending/);
      expect(c).not.toMatch(/RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|getWebhookSecret/);
    }
  });
  test('it does not touch the webhook receiver, inbox, processor or worker', () => {
    for (const f of files) expect(code(f)).not.toMatch(/razorpay-webhook|integration_inbox|integrationInbox|processor|completePaymentFromCapture/);
    for (const f of ['razorpay-webhook.processor.js', 'razorpay-webhook.worker.js', 'razorpay-payment.store.js', 'razorpay-webhook.controller.js']) {
      expect(code(f)).not.toMatch(/checkout-session|checkout-page|checkout\.controller/);
    }
  });
  test('the redirect target is built from a fixed constant, never from request data', () => {
    const raw = fs.readFileSync(path.join(__dirname, '../../src/modules/payments/checkout-session.service.js'), 'utf8');
    expect(raw).toContain("const APP_RETURN = 'humancare://payment-return'");
    expect(code('checkout.controller.js')).not.toMatch(/req\.(query|body|params)[^;]*Location|res\.redirect/);
  });
});
