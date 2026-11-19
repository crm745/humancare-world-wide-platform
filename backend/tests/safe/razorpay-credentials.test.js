/* global describe, test, expect, jest */
// Strict Razorpay credential rules (razorpay-config.js): live ("rzp_live_") keys only in an explicitly configured production environment
// (NODE_ENV exactly "production" AND PAYMENTS_LIVE_MODE exactly "true"), PAYMENTS_ENABLED exactly "true", and no API call, log line, audit
// row or response can ever carry a credential. Every key, host and id is fake; every request goes through an injected fetch.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
const cfg = require('../../src/modules/payments/razorpay-config');
const api = require('../../src/modules/payments/razorpay.api');
const service = require('../../src/modules/payments/payment-orders.service');
const kit = require('./payments-test-kit');

const { makeDb, makeGateway, makeInvoice, silentLog, clock, KEY } = kit;
const LIVE_ID = 'rzp_live_FAKELIVEKEY99';
const LIVE_SECRET = 'FAKE_LIVE_SECRET_5555';
const TEST_ID = 'rzp_test_FAKETESTKEY99';
const TEST_SECRET = 'FAKE_TEST_SECRET_4444';
const base = (over = {}) => ({ PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_KEY_ID: TEST_ID, RAZORPAY_KEY_SECRET: TEST_SECRET, ...over });
const live = (over = {}) => base({ RAZORPAY_KEY_ID: LIVE_ID, RAZORPAY_KEY_SECRET: LIVE_SECRET, ...over });
const order = (receipt = 'HCP12') => ({ id: 'order_FAKE1', entity: 'order', amount: 150000, currency: 'INR', receipt, status: 'created', amount_paid: 0, attempts: 0, notes: { hc_payment_id: '12', hc_invoice_id: '3' } });
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const args = { amountMinor: 150000, currency: 'INR', receipt: 'HCP12', notes: { hc_payment_id: 12, hc_invoice_id: 3, hc_environment: 'test' } };
const failure = async (promise) => { try { await promise; } catch (err) { return err; } throw new Error('expected a rejection'); };

describe('live credentials are refused in every non-production environment', () => {
  const NON_PRODUCTION = [
    ['development', 'development'], ['test', 'test'], ['staging', 'staging'], ['an unset NODE_ENV', undefined], ['an empty NODE_ENV', ''],
    ['a misspelled "prod"', 'prod'], ['"Production" (wrong case)', 'Production'], ['"production " (trailing space)', 'production '], ['"qa"', 'qa'],
  ];

  test.each(NON_PRODUCTION)('%s: a live key is refused, even with the live flag set', (_label, nodeEnv) => {
    for (const flag of [undefined, 'true', 'TRUE', 'false', '1']) {
      expect(cfg.credentialProblem(live({ NODE_ENV: nodeEnv, PAYMENTS_LIVE_MODE: flag }))).toBe('key_mode_mismatch');
      expect(cfg.liveModeAllowed(live({ NODE_ENV: nodeEnv, PAYMENTS_LIVE_MODE: flag }))).toBe(false);
      expect(cfg.publicKeyId(live({ NODE_ENV: nodeEnv, PAYMENTS_LIVE_MODE: flag }))).toBeNull(); // not even the public id is handed out
    }
  });

  test.each(NON_PRODUCTION)('%s: Test Mode keys work', (_label, nodeEnv) => {
    expect(cfg.credentialProblem(base({ NODE_ENV: nodeEnv }))).toBeNull();
    expect(cfg.publicKeyId(base({ NODE_ENV: nodeEnv }))).toBe(TEST_ID);
  });

  test('a production NODE_ENV alone is not enough: the explicit live flag is also required', () => {
    for (const flag of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
      expect(cfg.credentialProblem(live({ NODE_ENV: 'production', PAYMENTS_LIVE_MODE: flag }))).toBe('key_mode_mismatch');
    }
  });

  test('explicitly configured production (NODE_ENV="production" and PAYMENTS_LIVE_MODE="true") is the ONLY place live keys are accepted', () => {
    expect(cfg.credentialProblem(live({ NODE_ENV: 'production', PAYMENTS_LIVE_MODE: 'true' }))).toBeNull();
    expect(cfg.liveModeAllowed(live({ NODE_ENV: 'production', PAYMENTS_LIVE_MODE: 'true' }))).toBe(true);
    expect(cfg.publicKeyId(live({ NODE_ENV: 'production', PAYMENTS_LIVE_MODE: 'true' }))).toBe(LIVE_ID);
    // Test Mode keys are still fine there; the rule only guards the live ones.
    expect(cfg.credentialProblem(base({ NODE_ENV: 'production', PAYMENTS_LIVE_MODE: 'true' }))).toBeNull();
  });

  test('the live flag cannot be abused to turn a non-production environment into production', () => {
    expect(cfg.liveModeAllowed({ NODE_ENV: 'staging', PAYMENTS_LIVE_MODE: 'true' })).toBe(false);
    expect(cfg.liveModeAllowed({ PAYMENTS_LIVE_MODE: 'true' })).toBe(false);
    expect(cfg.liveModeAllowed({ NODE_ENV: 'production' })).toBe(false);
  });
});

describe('PAYMENTS_ENABLED must be exactly "true"', () => {
  test.each([undefined, '', 'false', 'FALSE', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true '])('%p switches payments off', async (value) => {
    const fetchImpl = jest.fn();
    expect(cfg.isPaymentsEnabled({ PAYMENTS_ENABLED: value })).toBe(false);
    const err = await failure(api.createOrder(args, { env: base({ PAYMENTS_ENABLED: value }), fetchImpl }));
    expect(err.code).toBe('switch_off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('only the exact text "true" switches them on', () => {
    expect(cfg.isPaymentsEnabled({ PAYMENTS_ENABLED: 'true' })).toBe(true);
  });
});

describe('invalid credentials can never trigger a Razorpay API call', () => {
  const INVALID = [
    ['no key id', base({ RAZORPAY_KEY_ID: undefined })],
    ['an empty key id', base({ RAZORPAY_KEY_ID: '' })],
    ['a malformed key id', base({ RAZORPAY_KEY_ID: 'key_123456789' })],
    ['a key id with a trailing space', base({ RAZORPAY_KEY_ID: `${TEST_ID} ` })],
    ['no secret', base({ RAZORPAY_KEY_SECRET: undefined })],
    ['a too-short secret', base({ RAZORPAY_KEY_SECRET: 'short' })],
    ['a secret with surrounding whitespace', base({ RAZORPAY_KEY_SECRET: ` ${TEST_SECRET}` })],
    ['no environment id', base({ PAYMENTS_ENVIRONMENT_ID: undefined })],
    ['an empty environment id', base({ PAYMENTS_ENVIRONMENT_ID: '' })],
    ['an invalid environment id (upper case)', base({ PAYMENTS_ENVIRONMENT_ID: 'Production' })],
    ['an environment id with padding', base({ PAYMENTS_ENVIRONMENT_ID: 'test ' })],
    ['a live key in development', live({ NODE_ENV: 'development' })],
    ['a live key in test', live({ NODE_ENV: 'test' })],
    ['a live key in staging', live({ NODE_ENV: 'staging' })],
    ['a live key in production WITHOUT the live flag', live({ NODE_ENV: 'production' })],
    ['a live key with the flag but no production NODE_ENV', live({ NODE_ENV: 'staging', PAYMENTS_LIVE_MODE: 'true' })],
  ];

  test.each(INVALID)('%s: none of the API functions sends a request', async (_label, env) => {
    const fetchImpl = jest.fn(async () => reply(200, order()));
    expect((await failure(api.createOrder(args, { env, fetchImpl }))).outcome).toBe('definitive'); // refused as "nothing was created"
    expect((await api.findOrdersByReceipt('HCP12', { env, fetchImpl })).status).toBe('uncertain');
    expect((await api.fetchOrder('order_FAKE1', { env, fetchImpl })).status).toBe('uncertain');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(INVALID)('%s: the service reserves nothing, calls nothing and the sweeps skip', async (_label, env) => {
    const db = makeDb({ invoices: [makeInvoice()], payments: [] });
    const gateway = makeGateway();
    const log = silentLog();
    const common = { db, env, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log };
    const err = await failure(service.createPaymentOrder({ userId: 7, invoiceId: '1', idempotencyKey: KEY(1), body: { mode: 'full' }, ...common }));
    expect(err.publicCode).toBe('gateway_unavailable');
    expect(await service.recoverPendingOrders(common)).toEqual({ skipped: true });
    expect(await service.closeStaleOrders(common)).toEqual({ skipped: true });
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
    expect(db.txCount).toBe(0); // no reservation, no transaction
    expect(db.state.payments).toHaveLength(0);
    expect(db.state.audits).toHaveLength(0);
  });
});

describe('explicitly configured production', () => {
  const PROD = live({ NODE_ENV: 'production', PAYMENTS_LIVE_MODE: 'true' });

  test('a live key is used for a request that goes to the fixed Razorpay host (through the injected fetch)', async () => {
    const fetchImpl = jest.fn(async () => reply(200, order()));
    const created = await api.createOrder(args, { env: PROD, fetchImpl });
    expect(created.orderId).toBe('order_FAKE1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.razorpay.com/v1/orders');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from(`${LIVE_ID}:${LIVE_SECRET}`).toString('base64')}`);
  });
});

describe('credentials never appear in responses, logs or audit records', () => {
  const secretsRegex = new RegExp(`${LIVE_SECRET}|${TEST_SECRET}|${LIVE_ID}|${TEST_ID}|Basic |${Buffer.from(`${LIVE_ID}:${LIVE_SECRET}`).toString('base64')}|${Buffer.from(`${TEST_ID}:${TEST_SECRET}`).toString('base64')}`);

  const run = async (env, gatewayMode) => {
    const db = makeDb({ invoices: [makeInvoice()], payments: [] });
    const gateway = makeGateway();
    if (gatewayMode) gateway.modes = [gatewayMode];
    const log = silentLog();
    let outcome;
    try {
      outcome = await service.createPaymentOrder({ userId: 7, invoiceId: '1', idempotencyKey: KEY(1), body: { mode: 'full' }, db, env, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log });
    } catch (err) {
      outcome = { error: { message: err.message, publicCode: err.publicCode, statusCode: err.statusCode, stack: err.stack } };
    }
    const sweeps = [await service.recoverPendingOrders({ db, env, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log }), await service.closeStaleOrders({ db, env, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log })];
    return { outcome, sweeps, logs: [log.error.mock.calls, log.warn.mock.calls, log.log.mock.calls, log.info.mock.calls], audits: db.state.audits, payments: db.state.payments, calls: gateway.calls.map((c) => ({ url: c.url, method: c.method })) };
  };

  test('a rejected live key: a fixed error, a log line with a CODE only, nothing written', async () => {
    const seen = await run(live({ NODE_ENV: 'staging' }));
    expect(seen.outcome.error).toMatchObject({ publicCode: 'gateway_unavailable', statusCode: 502 });
    expect(seen.logs[0]).toEqual([['[payments] the gateway is not configured: key_mode_mismatch']]);
    expect(JSON.stringify(seen)).not.toMatch(secretsRegex);
  });

  test('a successful Test Mode request: the response carries only the public key id; logs, audit rows and stored payments carry no credential', async () => {
    const seen = await run(base({ NODE_ENV: 'development' }));
    expect(seen.outcome.payload.razorpay.keyId).toBe(TEST_ID); // the PUBLIC id is the only credential-like value, and only in the response
    const { payload, ...rest } = seen.outcome;
    expect(JSON.stringify([rest, seen.logs, seen.audits, seen.payments])).not.toMatch(secretsRegex);
    expect(JSON.stringify(payload)).not.toContain(TEST_SECRET);
    expect(Object.keys(payload.razorpay).sort()).toEqual(['amount', 'currency', 'keyId', 'orderId']);
  });

  test('a refused and an ambiguous gateway outcome leak nothing either', async () => {
    for (const mode of ['refuse', 'timeout']) {
      const seen = await run(base({ NODE_ENV: 'development' }), mode);
      expect(JSON.stringify([seen.outcome, seen.logs, seen.audits, seen.payments])).not.toMatch(secretsRegex);
      expect(JSON.stringify([seen.outcome, seen.logs, seen.audits])).not.toMatch(/DO_NOT_LEAK|secret\.example/);
    }
  });
});
