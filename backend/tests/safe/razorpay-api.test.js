/* global describe, test, expect, jest */
// The Razorpay Orders client (razorpay.api.js): every call goes through an injected fetch; nothing reaches the network. Every key, host and
// id is fake.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
const api = require('../../src/modules/payments/razorpay.api');
const cfg = require('../../src/modules/payments/razorpay-config');
const { SECRET, KEY_ID, ENV, BASIC, reply } = require('./payments-test-kit');

const ORDER = { id: 'order_FAKE1', entity: 'order', amount: 150000, currency: 'INR', receipt: 'HCP12', status: 'created', amount_paid: 0, attempts: 0 };
const args = { amountMinor: 150000, currency: 'INR', receipt: 'HCP12', notes: { hc_payment_id: 12, hc_invoice_id: 3, hc_environment: 'test' } };
const failure = async (promise) => { try { await promise; } catch (err) { return err; } throw new Error('expected a rejection'); };

describe('configuration', () => {
  test('payments are ON only for exactly PAYMENTS_ENABLED=true', () => {
    expect(cfg.isPaymentsEnabled({ PAYMENTS_ENABLED: 'true' })).toBe(true);
    for (const v of [undefined, '', 'TRUE', 'True', '1', 'yes', ' true', 'true ', 'on']) expect(cfg.isPaymentsEnabled({ PAYMENTS_ENABLED: v })).toBe(false);
  });
  test('credential problems are short codes; a live key is refused in a test run', () => {
    expect(cfg.credentialProblem(ENV)).toBeNull();
    expect(cfg.credentialProblem({ ...ENV, RAZORPAY_KEY_ID: undefined })).toBe('key_id_invalid');
    expect(cfg.credentialProblem({ ...ENV, RAZORPAY_KEY_ID: 'rzp_test_ ' })).toBe('key_id_invalid');
    expect(cfg.credentialProblem({ ...ENV, RAZORPAY_KEY_SECRET: 'short' })).toBe('key_secret_invalid');
    expect(cfg.credentialProblem({ ...ENV, RAZORPAY_KEY_ID: 'rzp_live_FAKEKEY123456' })).toBe('key_mode_mismatch');
    // Live keys need an EXPLICIT production configuration: NODE_ENV=production AND PAYMENTS_LIVE_MODE=true (see razorpay-credentials.test.js).
    expect(cfg.credentialProblem({ ...ENV, NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_FAKEKEY123456' })).toBe('key_mode_mismatch');
    expect(cfg.credentialProblem({ ...ENV, NODE_ENV: 'production', PAYMENTS_LIVE_MODE: 'true', RAZORPAY_KEY_ID: 'rzp_live_FAKEKEY123456' })).toBeNull();
  });
  test('only the public key id can be read back, never the secret', () => {
    expect(cfg.publicKeyId(ENV)).toBe(KEY_ID);
    expect(cfg.publicKeyId({ ...ENV, RAZORPAY_KEY_SECRET: undefined })).toBeNull();
  });
});

describe('createOrder: the request', () => {
  test('is a POST to the fixed Razorpay host with Basic auth, no redirects, a timeout signal and only HumanCare ids in the notes', async () => {
    const fetchImpl = jest.fn(async () => reply(200, ORDER));
    const order = await api.createOrder(args, { env: ENV, fetchImpl });
    expect(order).toEqual({ orderId: 'order_FAKE1', status: 'created', amountMinor: 150000, currency: 'INR', amountPaidMinor: 0, attempts: 0, notes: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.razorpay.com/v1/orders');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(BASIC);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
    expect(JSON.parse(init.body)).toEqual({ amount: 150000, currency: 'INR', receipt: 'HCP12', notes: { hc_payment_id: '12', hc_invoice_id: '3', hc_environment: 'test' } });
    expect(init.body).not.toContain(SECRET);
  });
  test('refuses unsafe input before anything is sent', async () => {
    const fetchImpl = jest.fn();
    for (const bad of [{ amountMinor: 1.5 }, { amountMinor: 0 }, { amountMinor: '150000' }, { currency: 'inr' }, { receipt: 'abc' }, { receipt: 'HCP0' }, { notes: { name: 5 } }, { notes: { hc_payment_id: 'Asha Rao' } }]) {
      const err = await failure(api.createOrder({ ...args, ...bad }, { env: ENV, fetchImpl }));
      expect(err).toBeInstanceOf(api.RazorpayCallError);
      expect(err.outcome).toBe('definitive');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('does nothing while the switch is off or the credentials are unusable', async () => {
    const fetchImpl = jest.fn();
    expect((await failure(api.createOrder(args, { env: { ...ENV, PAYMENTS_ENABLED: 'false' }, fetchImpl }))).code).toBe('switch_off');
    expect((await failure(api.createOrder(args, { env: { ...ENV, RAZORPAY_KEY_SECRET: '' }, fetchImpl }))).code).toBe('not_configured');
    expect((await failure(api.createOrder(args, { env: { ...ENV, RAZORPAY_KEY_ID: 'rzp_live_FAKEKEY123456' }, fetchImpl }))).code).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createOrder: outcomes are classified', () => {
  const run = (response) => failure(api.createOrder(args, { env: ENV, fetchImpl: jest.fn(async () => response) }));
  test('a 4xx, 401, 404 or 429 is DEFINITIVE (no order was created); the description is never kept', async () => {
    const refused = await run(reply(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'DO_NOT_LEAK https://secret.example/x' } }));
    expect(refused.outcome).toBe('definitive');
    expect(refused.message).toContain('BAD_REQUEST_ERROR');
    expect(refused.message).not.toMatch(/DO_NOT_LEAK|secret\.example|https?:/);
    expect((await run(reply(401, {}))).code).toBe('gateway_auth');
    expect((await run(reply(429, {}))).outcome).toBe('definitive');
    expect((await run(reply(404, {}))).outcome).toBe('definitive');
  });
  test('a 5xx, an unreadable body and an order that is not the one asked for are AMBIGUOUS', async () => {
    expect((await run(reply(502, {}))).outcome).toBe('ambiguous');
    expect((await run(reply(408, {}))).outcome).toBe('ambiguous');
    expect((await run({ status: 200, ok: true, text: async () => 'not json' })).outcome).toBe('ambiguous');
    for (const wrong of [{ amount: 1 }, { currency: 'USD' }, { receipt: 'HCP99' }, { id: 'pay_123' }, { id: undefined }]) {
      const err = await run(reply(200, { ...ORDER, ...wrong }));
      expect(err.outcome).toBe('ambiguous');
      expect(err.code).toBe('order_mismatch');
    }
  });
  test('a timeout (the whole call, including a stalled body) is ambiguous', async () => {
    const hang = jest.fn((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))));
    const err = await failure(api.createOrder(args, { env: ENV, fetchImpl: hang, timeoutMs: 20 }));
    expect(err.outcome).toBe('ambiguous');
    expect(err.code).toBe('timeout');
  });
  test('a connection that never left this machine is definitive; a lost connection and a rejected redirect are ambiguous', async () => {
    const down = (code) => failure(api.createOrder(args, { env: ENV, fetchImpl: jest.fn(async () => { throw Object.assign(new Error('x'), { code }); }) }));
    expect((await down('ENOTFOUND')).outcome).toBe('definitive');
    expect((await down('ECONNRESET')).outcome).toBe('ambiguous');
    const redirected = await failure(api.createOrder(args, { env: ENV, fetchImpl: jest.fn(async () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); }) }));
    expect(redirected.code).toBe('redirect_rejected');
    expect(redirected.outcome).toBe('ambiguous');
  });
  test('no error ever carries the secret, the authorization header or a URL', async () => {
    const errors = [await run(reply(400, { error: { code: 'X', description: SECRET } })), await run(reply(502, {})), await run(reply(401, {}))];
    for (const err of errors) expect(`${err.message} ${err.stack}`).not.toMatch(new RegExp(`${SECRET}|Basic |${KEY_ID}|https?://`));
  });
});

describe('no accidental network access', () => {
  test('without an injected fetch the (blocked) global fetch is used and the failure is only a classified code', async () => {
    const err = await failure(api.createOrder(args, { env: ENV }));
    expect(err).toBeInstanceOf(api.RazorpayCallError);
    expect(err.outcome).toBe('ambiguous');
    expect(err.message).not.toMatch(/blocked/i); // the underlying message is not copied
  });
});

describe('findOrdersByReceipt', () => {
  const find = (response, receipt = 'HCP12') => api.findOrdersByReceipt(receipt, { env: ENV, fetchImpl: jest.fn(async () => response) });
  test('asks for the exact receipt with a bounded page', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { entity: 'collection', count: 0, items: [] }));
    await api.findOrdersByReceipt('HCP12', { env: ENV, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.razorpay.com/v1/orders?receipt=HCP12&count=10');
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
  });
  test('single, multiple and none', async () => {
    expect((await find(reply(200, { items: [ORDER] }))).status).toBe('single');
    expect((await find(reply(200, { items: [ORDER, { ...ORDER, id: 'order_FAKE2' }] }))).status).toBe('multiple');
    expect((await find(reply(200, { items: [] }))).status).toBe('none');
  });
  test('anything doubtful is "uncertain", never "none"', async () => {
    expect((await find(reply(500, {}))).status).toBe('uncertain');
    expect((await find(reply(200, {}))).status).toBe('uncertain');
    expect((await find(reply(200, { items: [{ ...ORDER, receipt: 'HCP99' }] }))).status).toBe('uncertain'); // the filter was not honoured
    expect((await find(reply(200, { items: Array.from({ length: 10 }, (_, i) => ({ ...ORDER, id: `order_FAKE${i}` })) }))).status).toBe('uncertain'); // truncated
    expect((await find(reply(200, { items: [] }), 'abc')).status).toBe('uncertain');
  });
});

describe('fetchOrder', () => {
  const get = (response, id = 'order_FAKE1') => api.fetchOrder(id, { env: ENV, fetchImpl: jest.fn(async () => response) });
  test('reads the status and counters of the order', async () => {
    const result = await get(reply(200, { ...ORDER, status: 'attempted', attempts: 2, amount_paid: 0 }));
    expect(result.status).toBe('ok');
    expect(result.order).toMatchObject({ orderId: 'order_FAKE1', status: 'attempted', attempts: 2, amountPaidMinor: 0 });
  });
  test('not found, an unreachable gateway and a different order are told apart', async () => {
    expect((await get(reply(404, {}))).status).toBe('not_found');
    expect((await get(reply(500, {}))).status).toBe('uncertain');
    expect((await get(reply(200, { ...ORDER, id: 'order_OTHER' }))).status).toBe('uncertain');
    expect((await get(reply(200, ORDER), 'not-an-order-id')).status).toBe('uncertain');
  });
});
