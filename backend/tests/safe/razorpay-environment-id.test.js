/* global describe, test, expect, jest */
// PAYMENTS_ENVIRONMENT_ID: explicit, validated, never inferred from NODE_ENV; a missing or invalid value makes order creation, recovery and the
// sweeps fail CLOSED; and every order is created with all three identifying notes. Every key, host and id is fake; every request goes through
// an injected fetch.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
const cfg = require('../../src/modules/payments/razorpay-config');
const api = require('../../src/modules/payments/razorpay.api');
const service = require('../../src/modules/payments/payment-orders.service');
const kit = require('./payments-test-kit');

const { makeDb, makeGateway, makeInvoice, silentLog, clock, KEY } = kit;
const TEST_ID = 'rzp_test_FAKETESTKEY99';
const TEST_SECRET = 'FAKE_TEST_SECRET_4444';
const LIVE_ID = 'rzp_live_FAKELIVEKEY99';
const base = (over = {}) => ({ PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_KEY_ID: TEST_ID, RAZORPAY_KEY_SECRET: TEST_SECRET, ...over });
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const order = () => ({ id: 'order_FAKE1', entity: 'order', amount: 150000, currency: 'INR', receipt: 'HCP12', status: 'created', amount_paid: 0, attempts: 0 });
const args = { amountMinor: 150000, currency: 'INR', receipt: 'HCP12', notes: { hc_payment_id: 12, hc_invoice_id: 3, hc_environment: 'test' } };
const failure = async (promise) => { try { await promise; } catch (err) { return err; } throw new Error('expected a rejection'); };

describe('PAYMENTS_ENVIRONMENT_ID: explicit, validated, and never inferred', () => {
  const VALID = ['development', 'test', 'staging', 'production', 'staging-2', 'qa_eu', 'ab', 'a'.repeat(32)];
  const INVALID = ['Test', 'TEST', 'Production', ' test', 'test ', 'te st', 'test;', 'prod/uction', '1test', '-test', '_test', 'a', 'a'.repeat(33), 'test\n', 'tést', 'test.env', 'test:1'];

  test.each(VALID)('%p is a valid environment id', (id) => {
    expect(cfg.environmentIdProblem({ PAYMENTS_ENVIRONMENT_ID: id })).toBeNull();
    expect(cfg.paymentsEnvironmentId({ PAYMENTS_ENVIRONMENT_ID: id })).toBe(id);
    expect(cfg.credentialProblem(base({ PAYMENTS_ENVIRONMENT_ID: id }))).toBeNull();
  });

  test.each(INVALID)('%p is refused as invalid (nothing is trimmed, lower-cased or repaired)', (id) => {
    expect(cfg.environmentIdProblem({ PAYMENTS_ENVIRONMENT_ID: id })).toBe('environment_id_invalid');
    expect(cfg.paymentsEnvironmentId({ PAYMENTS_ENVIRONMENT_ID: id })).toBeNull();
    expect(cfg.credentialProblem(base({ PAYMENTS_ENVIRONMENT_ID: id }))).toBe('environment_id_invalid');
  });

  test('a missing or empty value is reported as missing', () => {
    for (const id of [undefined, null, '']) {
      expect(cfg.environmentIdProblem({ PAYMENTS_ENVIRONMENT_ID: id })).toBe('environment_id_missing');
      expect(cfg.credentialProblem(base({ PAYMENTS_ENVIRONMENT_ID: id }))).toBe('environment_id_missing');
    }
    expect(cfg.environmentIdProblem({})).toBe('environment_id_missing');
  });

  test('a value that is not text is invalid', () => {
    for (const id of [1, true, ['test'], { id: 'test' }]) expect(cfg.environmentIdProblem({ PAYMENTS_ENVIRONMENT_ID: id })).toBe('environment_id_invalid');
  });

  test.each([undefined, 'development', 'test', 'staging', 'production', 'qa'])('it is NEVER inferred from NODE_ENV (%p): without PAYMENTS_ENVIRONMENT_ID the configuration is refused', (nodeEnv) => {
    const env = base({ NODE_ENV: nodeEnv, PAYMENTS_ENVIRONMENT_ID: undefined });
    expect(cfg.paymentsEnvironmentId(env)).toBeNull();
    expect(cfg.credentialProblem(env)).toBe('environment_id_missing');
  });

  test('NODE_ENV never overrides a configured value either', () => {
    expect(cfg.paymentsEnvironmentId(base({ NODE_ENV: 'production', PAYMENTS_ENVIRONMENT_ID: 'staging' }))).toBe('staging');
    expect(cfg.paymentsEnvironmentId(base({ NODE_ENV: 'test', PAYMENTS_ENVIRONMENT_ID: 'production' }))).toBe('production');
  });

  test('a credential problem is reported before an environment problem, and both before the live-mode rule', () => {
    expect(cfg.credentialProblem(base({ RAZORPAY_KEY_ID: undefined, PAYMENTS_ENVIRONMENT_ID: undefined }))).toBe('key_id_invalid');
    expect(cfg.credentialProblem(base({ RAZORPAY_KEY_ID: LIVE_ID, NODE_ENV: 'staging', PAYMENTS_ENVIRONMENT_ID: undefined }))).toBe('environment_id_missing');
    expect(cfg.credentialProblem(base({ RAZORPAY_KEY_ID: LIVE_ID, NODE_ENV: 'staging' }))).toBe('key_mode_mismatch');
  });
});

describe('a missing or invalid value fails CLOSED: creation and recovery do not proceed', () => {
  const BAD = [['missing', undefined, 'environment_id_missing'], ['empty', '', 'environment_id_missing'], ['invalid', 'Not Valid!', 'environment_id_invalid']];

  test.each(BAD)('%s: order creation reserves nothing and calls nothing; the log has the code only, never the value', async (_label, value, code) => {
    const env = base({ PAYMENTS_ENVIRONMENT_ID: value });
    const db = makeDb({ invoices: [makeInvoice()], payments: [] });
    const gateway = makeGateway();
    const log = silentLog();
    const err = await failure(service.createPaymentOrder({ userId: 7, invoiceId: '1', idempotencyKey: KEY(1), body: { mode: 'full' }, db, env, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log }));
    expect(err).toMatchObject({ publicCode: 'gateway_unavailable', statusCode: 502 });
    expect(log.error.mock.calls).toEqual([[`[payments] the gateway is not configured: ${code}`]]);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('Not Valid!');
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
    expect(db.txCount).toBe(0);
    expect(db.state.payments).toHaveLength(0);
    expect(db.state.audits).toHaveLength(0);
  });

  test.each(BAD)('%s: recovery does not proceed either: a client retry, the recovery sweep and the timeout sweep all stop; the pending row is untouched', async (_label, value) => {
    const db = makeDb({ invoices: [makeInvoice()], payments: [] });
    const gateway = makeGateway();
    const log = silentLog();
    const common = (env) => ({ db, env, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log });
    gateway.modes = ['lost']; // a payment whose order was created at Razorpay but never attached
    await service.createPaymentOrder({ userId: 7, invoiceId: '1', idempotencyKey: KEY(1), body: { mode: 'full' }, ...common(base()) });
    const callsBefore = gateway.calls.length;
    const before = structuredClone(db.state.payments);
    clock.advance(2 * 60 * 1000);

    const badEnv = base({ PAYMENTS_ENVIRONMENT_ID: value });
    const retry = await failure(service.createPaymentOrder({ userId: 7, invoiceId: '1', idempotencyKey: KEY(1), body: { mode: 'full' }, ...common(badEnv) }));
    expect(retry.publicCode).toBe('gateway_unavailable');
    expect(await service.recoverPendingOrders(common(badEnv))).toEqual({ skipped: true });
    expect(await service.closeStaleOrders(common(badEnv))).toEqual({ skipped: true });
    expect(gateway.calls.length).toBe(callsBefore); // not a single lookup or create
    expect(db.state.payments).toEqual(before); // the pending row is exactly as it was: not attached, not closed
  });

  test.each(BAD)('%s: no API function sends a request', async (_label, value) => {
    const env = base({ PAYMENTS_ENVIRONMENT_ID: value });
    const fetchImpl = jest.fn(async () => reply(200, order()));
    expect((await failure(api.createOrder(args, { env, fetchImpl }))).code).toBe('not_configured');
    expect((await api.findOrdersByReceipt('HCP12', { env, fetchImpl })).status).toBe('uncertain');
    expect((await api.fetchOrder('order_FAKE1', { env, fetchImpl })).status).toBe('uncertain');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('configuration is checked on every call, so fixing the value is picked up at once (nothing is cached)', async () => {
    const db = makeDb({ invoices: [makeInvoice()], payments: [] });
    const gateway = makeGateway();
    const common = (env) => ({ userId: 7, invoiceId: '1', idempotencyKey: KEY(1), body: { mode: 'full' }, db, env, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log: silentLog() });
    expect((await failure(service.createPaymentOrder(common(base({ PAYMENTS_ENVIRONMENT_ID: undefined }))))).publicCode).toBe('gateway_unavailable');
    expect((await service.createPaymentOrder(common(base()))).created).toBe(true);
  });
});

describe('every order is created with all three notes', () => {
  const create = (notes) => api.createOrder({ ...args, notes }, { env: base(), fetchImpl: jest.fn(async () => reply(200, order())) });

  test('the environment note is required, text, and a valid environment id; the payment and invoice notes are required too', async () => {
    for (const bad of [
      { hc_payment_id: 12, hc_invoice_id: 3 }, // environment missing
      { hc_payment_id: 12, hc_invoice_id: 3, hc_environment: undefined },
      { hc_payment_id: 12, hc_invoice_id: 3, hc_environment: '' },
      { hc_payment_id: 12, hc_invoice_id: 3, hc_environment: 'Prod' },
      { hc_payment_id: 12, hc_invoice_id: 3, hc_environment: ' test' },
      { hc_payment_id: 12, hc_invoice_id: 3, hc_environment: 5 },
      { hc_invoice_id: 3, hc_environment: 'test' }, // payment id missing
      { hc_payment_id: 12, hc_environment: 'test' }, // invoice id missing
    ]) expect((await failure(create(bad))).code).toBe('notes_invalid');
    expect((await create({ hc_payment_id: 12, hc_invoice_id: 3, hc_environment: 'test' })).orderId).toBe('order_FAKE1');
  });

  test('the request body sent to Razorpay carries exactly the three notes as text, and the receipt is unchanged', async () => {
    const fetchImpl = jest.fn(async () => reply(200, order()));
    await api.createOrder(args, { env: base(), fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.notes).toEqual({ hc_payment_id: '12', hc_invoice_id: '3', hc_environment: 'test' });
    expect(body.receipt).toBe('HCP12');
  });

  test('the service puts PAYMENTS_ENVIRONMENT_ID in the notes of the order it creates', async () => {
    const db = makeDb({ invoices: [makeInvoice()], payments: [] });
    const gateway = makeGateway();
    await service.createPaymentOrder({ userId: 7, invoiceId: '1', idempotencyKey: KEY(1), body: { mode: 'full' }, db, env: base({ PAYMENTS_ENVIRONMENT_ID: 'staging' }), fetchImpl: gateway.fetchImpl, now: () => clock.now(), log: silentLog() });
    expect(JSON.parse(gateway.creates()[0].init.body)).toMatchObject({ receipt: 'HCP1', notes: { hc_payment_id: '1', hc_invoice_id: '1', hc_environment: 'staging' } });
  });
});
