/* global describe, test, expect, jest, beforeEach */
// Razorpay payment reconciliation (scripts/lib/reconcile-razorpay-payment.js and razorpay.api.fetchPayment). No network, no database: Razorpay, the inbox
// and the processor are injected fakes. Every key, id and host is fake.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
const api = require('../../src/modules/payments/razorpay.api');
const lib = require('../../scripts/lib/reconcile-razorpay-payment');
const { classifyEvent } = require('../../src/modules/payments/razorpay-webhook.events');
const { SECRET, ENV: KIT_ENV, BASIC, reply } = require('./payments-test-kit');

const PAY = 'pay_FAKEPAYMENT1';
const ORDER = 'order_FAKEORDER1';
const ENV = { ...KIT_ENV, NODE_ENV: 'development', DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev' };

const remotePayment = (over = {}) => ({
  paymentId: PAY, orderId: ORDER, amountMinor: 10000, currency: 'INR', status: 'captured', captured: true, amountRefundedMinor: 0, createdAtSeconds: 1795500000, method: 'upi', ...over,
});
const remoteOrder = (over = {}) => ({
  orderId: ORDER, status: 'paid', amountMinor: 10000, currency: 'INR', amountPaidMinor: 10000, attempts: 1, notes: { hc_payment_id: '1', hc_invoice_id: '1', hc_environment: 'test' }, ...over,
});
const invoiceRow = (over = {}) => ({
  id: 1, caseId: 206, invoiceNumber: 'INV-CASE-1206-V1', source: 'quotation', status: 'issued', amount: '100.000', currency: 'INR',
  case: { id: 206, status: 'in_progress', closedAt: null, serviceRequest: { userId: 7, serviceKey: 'privatecharter' } }, ...over,
});
const paymentRow = (over = {}) => ({ id: 1, invoiceId: 1, caseId: 206, currency: 'INR', kind: 'payment', amount: '100.000', status: 'pending', externalReference: null, razorpayOrderId: ORDER, ...over });

function setup({ payment = paymentRow(), invoice = invoiceRow(), remote = remotePayment(), order = remoteOrder(), inbox = null, gatewayUsed = 'none', databaseName = 'humancare_dev', processed } = {}) {
  const writes = [];
  const state = { payment: payment ? { ...payment } : null, inbox };
  const db = {
    writes,
    $queryRaw: jest.fn(async () => [{ db: databaseName }]),
    payment: { findUnique: jest.fn(async () => (state.payment ? { ...state.payment } : null)), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    invoice: { update: jest.fn(), updateMany: jest.fn() },
    integrationInbox: {
      findUnique: jest.fn(async () => state.inbox),
      create: jest.fn(),
    },
  };
  const deps = {
    loadInvoice: jest.fn(async () => invoice),
    findPaymentByGatewayPaymentId: jest.fn(async () => ({ outcome: gatewayUsed, payment: null })),
    fetchPayment: jest.fn(async () => (remote && remote.status === 'not_found' ? remote : { status: 'ok', payment: remote })),
    fetchOrder: jest.fn(async () => ({ status: 'ok', order })),
    storeEvent: jest.fn(async (_db, event) => { writes.push(['storeEvent', event]); state.inbox = state.inbox || { id: 77, status: 'received' }; return { stored: true }; }),
    claim: jest.fn(async (_db, { id }) => ({ id, workerId: 'w', attempts: 1, externalEventId: `reconcile:${PAY}`, eventType: 'payment.captured', payload: {} })),
    processClaim: jest.fn(async (_db, claim) => {
      writes.push(['processClaim', claim.id]);
      state.payment = { ...state.payment, status: 'completed', externalReference: PAY };
      return processed || { status: 'processed', code: null, outcome: 'completed' };
    }),
  };
  return { db, deps, state, writes, run: (options = {}) => lib.reconcile({ razorpayPaymentId: PAY, internalPaymentId: 1, apply: false, ...options }, { db, env: ENV, deps }) };
}

const noDirectWrites = (db) => {
  for (const fn of [db.payment.update, db.payment.updateMany, db.payment.create, db.invoice.update, db.invoice.updateMany, db.integrationInbox.create]) expect(fn).not.toHaveBeenCalled();
};

describe('arguments and environment', () => {
  test('parses the ids and defaults to a dry run', () => {
    expect(lib.parseArgs(['--payment-id', PAY, '--internal-payment-id', '1'])).toEqual({ apply: false, razorpayPaymentId: PAY, internalPaymentId: 1 });
    expect(lib.parseArgs(['--payment-id', PAY, '--internal-payment-id', '1', '--apply', '--order-id', ORDER, '--invoice-id', '1']))
      .toEqual({ apply: true, razorpayPaymentId: PAY, internalPaymentId: 1, expectedOrderId: ORDER, expectedInvoiceId: 1 });
  });
  test('refuses malformed, unknown and repeated arguments', () => {
    const code = (argv) => { try { lib.parseArgs(argv); } catch (e) { return e.code; } return null; };
    expect(code(['--payment-id', 'nope', '--internal-payment-id', '1'])).toBe('payment_id_invalid');
    expect(code(['--payment-id', PAY, '--internal-payment-id', '0'])).toBe('internal_payment_id_invalid');
    expect(code(['--payment-id', PAY])).toBe('internal_payment_id_invalid');
    expect(code(['--payment-id', PAY, '--internal-payment-id', '1', '--force'])).toBe('unknown_argument');
    expect(code(['--payment-id', PAY, '--payment-id', PAY, '--internal-payment-id', '1'])).toBe('argument_repeated');
    expect(code(['--payment-id', PAY, '--internal-payment-id', '1', '--apply', '--apply'])).toBe('argument_repeated');
  });
  test('only the local development database is accepted', () => {
    expect(lib.environmentProblem(ENV)).toBeNull();
    expect(lib.environmentProblem({ ...ENV, DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' })).toBe('database_not_humancare_dev');
    expect(lib.environmentProblem({ ...ENV, DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' })).toBe('database_host_not_local');
    expect(lib.environmentProblem({ ...ENV, NODE_ENV: 'test' })).toBe('node_env_not_development');
    expect(lib.environmentProblem({ ...ENV, NODE_ENV: 'production' })).toBe('node_env_not_development');
    expect(lib.environmentProblem({ ...ENV, DATABASE_URL: undefined })).toBe('database_url_invalid');
  });
  test('the server must also confirm humancare_dev, and payments must be configured', async () => {
    const wrong = setup({ databaseName: 'humancare_test' });
    expect((await wrong.run()).code).toBe('database_not_humancare_dev');
    expect(wrong.deps.fetchPayment).not.toHaveBeenCalled();
    const s = setup();
    const result = await lib.reconcile({ razorpayPaymentId: PAY, internalPaymentId: 1, apply: false }, { db: s.db, env: { ...ENV, PAYMENTS_ENABLED: 'false' }, deps: s.deps });
    expect(result.code).toBe('payments_disabled');
  });
});

describe('dry run', () => {
  test('a verified captured payment passes every check and writes nothing', async () => {
    const s = setup();
    const result = await s.run();
    expect(result.status).toBe('dry_run');
    expect(result.passed).toEqual(expect.arrayContaining(['payment_pending_without_reference', 'gateway_payment_captured_and_matches', 'order_matches_and_notes_verified', 'event_classified']));
    expect(result.summary).toMatchObject({ internalPaymentId: 1, invoiceId: 1, razorpayPaymentId: PAY, razorpayOrderId: ORDER, amountMinor: 10000, currency: 'INR', externalEventId: `reconcile:${PAY}`, orderNotesVerified: true });
    expect(s.deps.storeEvent).not.toHaveBeenCalled();
    expect(s.deps.claim).not.toHaveBeenCalled();
    expect(s.deps.processClaim).not.toHaveBeenCalled();
    noDirectWrites(s.db);
    expect(s.state.payment.status).toBe('pending');
  });
  test('order notes that are not available are reported, not invented', async () => {
    const s = setup({ order: remoteOrder({ notes: null }) });
    const result = await s.run();
    expect(result.status).toBe('dry_run');
    expect(result.summary.orderNotesVerified).toBe(false);
  });
});

describe('refusals (nothing is written; Razorpay is never asked before the local checks pass)', () => {
  const refused = async (setupArgs, runArgs, code) => {
    const s = setup(setupArgs);
    const result = await s.run({ apply: true, ...runArgs });
    expect(result).toMatchObject({ status: 'refused', code });
    expect(s.deps.storeEvent).not.toHaveBeenCalled();
    expect(s.deps.processClaim).not.toHaveBeenCalled();
    noDirectWrites(s.db);
    return s;
  };

  test('incorrect Razorpay payment id', async () => { await refused({ remote: remotePayment({ paymentId: 'pay_SOMEONEELSE' }) }, {}, 'payment_id_mismatch'); });
  test('incorrect order id (gateway)', async () => { await refused({ remote: remotePayment({ orderId: 'order_OTHERORDER' }) }, {}, 'order_id_mismatch'); });
  test('incorrect order id (expected on the command line)', async () => {
    const s = await refused({}, { expectedOrderId: 'order_OTHERORDER' }, 'order_id_mismatch');
    expect(s.deps.fetchPayment).not.toHaveBeenCalled();
  });
  test('incorrect invoice id (expected on the command line)', async () => { await refused({}, { expectedInvoiceId: 2 }, 'invoice_id_mismatch'); });
  test('amount mismatch with the payment, the invoice and the order', async () => {
    await refused({ remote: remotePayment({ amountMinor: 10001 }) }, {}, 'amount_mismatch');
    await refused({ invoice: invoiceRow({ amount: '150.000' }) }, {}, 'amount_mismatch');
    await refused({ order: remoteOrder({ amountMinor: 20000 }) }, {}, 'order_amount_mismatch');
  });
  test('currency mismatch', async () => {
    await refused({ remote: remotePayment({ currency: 'USD' }) }, {}, 'currency_mismatch');
    await refused({ invoice: invoiceRow({ currency: 'USD' }) }, {}, 'currency_mismatch');
  });
  test('uncaptured, authorized-only or refunded payment', async () => {
    await refused({ remote: remotePayment({ status: 'authorized', captured: false }) }, {}, 'payment_not_captured');
    await refused({ remote: remotePayment({ status: 'captured', captured: false }) }, {}, 'payment_not_captured');
    await refused({ remote: remotePayment({ amountRefundedMinor: 10000 }) }, {}, 'payment_refunded');
  });
  test('wrong invoice ownership or an invoice that cannot take the payment', async () => {
    await refused({ invoice: invoiceRow({ caseId: 999 }) }, {}, 'invoice_ownership_mismatch');
    await refused({ invoice: invoiceRow({ id: 2 }) }, {}, 'invoice_ownership_mismatch');
    await refused({ invoice: invoiceRow({ status: 'void' }) }, {}, 'invoice_not_issued');
    await refused({ invoice: invoiceRow({ case: { id: 206, serviceRequest: { serviceKey: 'other' } } }) }, {}, 'invoice_not_payable');
  });
  test('order notes naming another payment, invoice or environment', async () => {
    await refused({ order: remoteOrder({ notes: { hc_payment_id: '2', hc_invoice_id: '1', hc_environment: 'test' } }) }, {}, 'order_notes_mismatch');
    await refused({ order: remoteOrder({ notes: { hc_payment_id: '1', hc_invoice_id: '9', hc_environment: 'test' } }) }, {}, 'order_notes_mismatch');
    await refused({ order: remoteOrder({ notes: { hc_payment_id: '1', hc_invoice_id: '1', hc_environment: 'production' } }) }, {}, 'order_environment_mismatch');
    await refused({ order: remoteOrder({ notes: {} }) }, {}, 'order_notes_mismatch');
  });
  test('payment already completed (by this gateway payment or another)', async () => {
    await refused({ payment: paymentRow({ status: 'completed', externalReference: PAY }) }, {}, 'already_completed_same_payment');
    await refused({ payment: paymentRow({ status: 'completed', externalReference: 'pay_OTHER' }) }, {}, 'payment_already_completed');
    await refused({ payment: paymentRow({ status: 'failed' }) }, {}, 'payment_not_pending');
  });
  test('existing payment reference conflict', async () => {
    await refused({ payment: paymentRow({ externalReference: 'pay_OTHER' }) }, {}, 'payment_reference_present');
    await refused({ gatewayUsed: 'found' }, {}, 'gateway_payment_id_already_used');
    await refused({ gatewayUsed: 'ambiguous' }, {}, 'gateway_payment_id_already_used');
  });
  test('unknown payment, refund row, row without an order, unreachable gateway', async () => {
    await refused({ payment: null }, {}, 'payment_not_found');
    await refused({ payment: paymentRow({ kind: 'refund' }) }, {}, 'not_a_payment_row');
    await refused({ payment: paymentRow({ razorpayOrderId: null }) }, {}, 'payment_has_no_order');
    const s = setup();
    s.deps.fetchPayment.mockResolvedValue({ status: 'uncertain', reason: 'timeout' });
    expect(await s.run({ apply: true })).toMatchObject({ status: 'refused', code: 'gateway_payment_uncertain' });
    expect(s.deps.storeEvent).not.toHaveBeenCalled();
  });
});

describe('apply', () => {
  test('stores one verified event under a deterministic id, claims and processes only that row', async () => {
    const s = setup();
    const result = await s.run({ apply: true });
    expect(result.status).toBe('applied');
    expect(result.paymentAfter).toEqual({ status: 'completed', externalReference: PAY });
    expect(s.deps.storeEvent).toHaveBeenCalledTimes(1);
    const stored = s.deps.storeEvent.mock.calls[0][1];
    expect(stored).toMatchObject({ externalEventId: `reconcile:${PAY}`, eventType: 'payment.captured', entityType: 'order', entityId: ORDER, status: 'received', lastError: null });
    // exactly what the processor reads: payload.event === eventType and payload.payment { id, orderId, amount, currency, status }
    expect(stored.payload).toMatchObject({ event: 'payment.captured', eventIdSource: 'reconciliation', payment: { id: PAY, orderId: ORDER, amount: 10000, currency: 'INR', status: 'captured' } });
    expect(stored.occurredAt).toEqual(new Date(1795500000 * 1000));
    expect(s.deps.claim).toHaveBeenCalledTimes(1);
    expect(s.deps.claim.mock.calls[0][1]).toMatchObject({ id: 77 });
    expect(s.deps.processClaim).toHaveBeenCalledTimes(1);
    expect(s.deps.processClaim.mock.calls[0][1].id).toBe(77);
    noDirectWrites(s.db); // payment and invoice are changed ONLY by the processor
  });
  test('the stored event is accepted by the real classifier exactly as built (no field is invented)', () => {
    const facts = { id: PAY, order_id: ORDER, amount: 10000, currency: 'INR', status: 'captured' };
    const event = classifyEvent({ event: 'payment.captured', created_at: 1795500000, payload: { payment: { entity: facts } } }, { bodySha256: 'a'.repeat(64), eventIdSource: 'reconciliation' });
    expect(event.status).toBe('received');
    expect(event.payload.payment).toEqual({ id: PAY, orderId: ORDER, amount: 10000, currency: 'INR', status: 'captured' });
  });
  test('a repeated run after success is refused (duplicate reconciliation) and processes nothing', async () => {
    const s = setup();
    expect((await s.run({ apply: true })).status).toBe('applied');
    s.deps.storeEvent.mockClear(); s.deps.processClaim.mockClear(); s.deps.claim.mockClear();
    const again = await s.run({ apply: true });
    expect(again).toMatchObject({ status: 'refused', code: 'already_completed_same_payment' });
    expect(s.deps.storeEvent).not.toHaveBeenCalled();
    expect(s.deps.processClaim).not.toHaveBeenCalled();
  });
  test('an event stored by an interrupted earlier run is picked up, not stored twice', async () => {
    const s = setup({ inbox: { id: 55, status: 'received' } });
    const result = await s.run({ apply: true });
    expect(result.status).toBe('applied');
    expect(s.deps.claim.mock.calls[0][1]).toMatchObject({ id: 55 });
    expect(s.deps.storeEvent).toHaveBeenCalledTimes(1); // the store itself treats a duplicate id as a no-op (unique key)
  });
  test('an inbox row already finished or leased is never processed again', async () => {
    const done = setup({ inbox: { id: 55, status: 'processed' } });
    expect(await done.run({ apply: true })).toMatchObject({ status: 'not_applied', code: 'inbox_row_processed' });
    expect(done.deps.processClaim).not.toHaveBeenCalled();
    const leased = setup({ inbox: { id: 56, status: 'received' } });
    leased.deps.claim.mockResolvedValue(null);
    expect(await leased.run({ apply: true })).toMatchObject({ status: 'not_applied', code: 'inbox_row_not_claimable' });
    expect(leased.deps.processClaim).not.toHaveBeenCalled();
  });
  test('a processor outcome other than completed is reported as not applied', async () => {
    const s = setup({ processed: { status: 'processed', code: 'flagged_for_operations', outcome: 'amount_mismatch' } });
    expect(await s.run({ apply: true })).toMatchObject({ status: 'not_applied', outcome: 'amount_mismatch' });
  });
});

describe('fetchPayment (razorpay.api)', () => {
  const RAW = { id: PAY, entity: 'payment', amount: 10000, currency: 'INR', status: 'captured', captured: true, order_id: ORDER, method: 'upi', amount_refunded: 0, created_at: 1795500000, email: 'x@y.z', vpa: 'a@upi' };
  test('is a GET to the fixed host with Basic auth, no redirects, and keeps only the compared fields', async () => {
    const fetchImpl = jest.fn(async () => reply(200, RAW));
    const result = await api.fetchPayment(PAY, { env: KIT_ENV, fetchImpl });
    expect(result).toEqual({ status: 'ok', payment: { paymentId: PAY, orderId: ORDER, amountMinor: 10000, currency: 'INR', status: 'captured', captured: true, amountRefundedMinor: 0, createdAtSeconds: 1795500000, method: 'upi' } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.razorpay.com/v1/payments/${PAY}`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(BASIC);
    expect(init.redirect).toBe('error');
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('x@y.z');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  test('rejects a malformed id before any call, and an answer for another payment or of the wrong shape', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { ...RAW, id: 'pay_OTHERPAYMENT' }));
    expect(await api.fetchPayment('../orders', { env: KIT_ENV, fetchImpl })).toEqual({ status: 'uncertain', reason: 'payment_id_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await api.fetchPayment(PAY, { env: KIT_ENV, fetchImpl })).toEqual({ status: 'uncertain', reason: 'unexpected_payment' });
    for (const bad of [{ ...RAW, entity: 'order' }, { ...RAW, order_id: 'x' }, { ...RAW, amount: 1.5 }, { ...RAW, captured: 'yes' }, { ...RAW, currency: 'inr' }, [1]]) {
      const f = jest.fn(async () => reply(200, bad));
      expect((await api.fetchPayment(PAY, { env: KIT_ENV, fetchImpl: f })).status).toBe('uncertain');
    }
  });
  test('gateway problems are classified and never thrown or leaked', async () => {
    expect(await api.fetchPayment(PAY, { env: KIT_ENV, fetchImpl: async () => reply(404, { error: { description: 'DO_NOT_LEAK' } }) })).toEqual({ status: 'not_found' });
    const server = await api.fetchPayment(PAY, { env: KIT_ENV, fetchImpl: async () => reply(502, { error: { description: 'DO_NOT_LEAK' } }) });
    expect(server.status).toBe('uncertain');
    expect(JSON.stringify(server)).not.toContain('DO_NOT_LEAK');
    expect((await api.fetchPayment(PAY, { env: { ...KIT_ENV, PAYMENTS_ENABLED: 'false' }, fetchImpl: jest.fn() })).status).toBe('uncertain');
  });
});

describe('fetchOrderPayments (razorpay.api)', () => {
  const item = (id, over = {}) => ({ id, entity: 'payment', amount: 10000, currency: 'INR', status: 'failed', captured: false, order_id: ORDER, method: 'upi', amount_refunded: 0, created_at: 1795500000, email: 'x@y.z', ...over });
  test('is a GET of the order payments, returns only the compared fields and every attempt', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { entity: 'collection', count: 2, items: [item('pay_A1'), item('pay_B2', { status: 'captured', captured: true })] }));
    const result = await api.fetchOrderPayments(ORDER, { env: KIT_ENV, fetchImpl });
    expect(result.status).toBe('ok');
    expect(result.payments.map((p) => [p.paymentId, p.status, p.captured])).toEqual([['pay_A1', 'failed', false], ['pay_B2', 'captured', true]]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.razorpay.com/v1/orders/${ORDER}/payments`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(BASIC);
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(result)).not.toContain('x@y.z');
  });
  test('refuses a bad id before any call, a payment of another order, a bad shape; never a partial list', async () => {
    const fetchImpl = jest.fn();
    expect(await api.fetchOrderPayments('../x', { env: KIT_ENV, fetchImpl })).toEqual({ status: 'uncertain', reason: 'order_id_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const other = async () => reply(200, { items: [item('pay_A1'), item('pay_B2', { order_id: 'order_OTHER' })] });
    expect((await api.fetchOrderPayments(ORDER, { env: KIT_ENV, fetchImpl: other })).reason).toBe('unexpected_payment');
    expect((await api.fetchOrderPayments(ORDER, { env: KIT_ENV, fetchImpl: async () => reply(200, { items: 'no' }) })).reason).toBe('unexpected_shape');
    expect((await api.fetchOrderPayments(ORDER, { env: KIT_ENV, fetchImpl: async () => reply(404, {}) })).status).toBe('not_found');
  });
});
