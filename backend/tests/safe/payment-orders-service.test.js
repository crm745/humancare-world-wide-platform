/* global describe, test, expect, jest, beforeEach */
// Razorpay order creation (payment-orders.service.js): the real service and store over an in-memory database whose transactions run one at a
// time (like the invoice row lock) and a fake Razorpay behind an injected fetch. No network, no MySQL.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
const service = require('../../src/modules/payments/payment-orders.service');
const kit = require('./payments-test-kit');

const { ENV, SECRET, BASIC, clock, makeInvoice, makeDb, makeGateway, silentLog, KEY } = kit;
const MIN = 60 * 1000;

let db; let gateway; let log;
const setup = (invoiceOver, payments = [], extraInvoices = []) => {
  db = makeDb({ invoices: [makeInvoice(invoiceOver), ...extraInvoices], payments });
  gateway = makeGateway();
  log = silentLog();
};
const call = (over = {}) => service.createPaymentOrder({
  userId: 7, invoiceId: '1', idempotencyKey: KEY(1), body: { mode: 'full' }, db, env: ENV, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log, ...over,
});
const fails = async (promise) => { try { await promise; } catch (err) { return err; } throw new Error('expected a rejection'); };
const code = async (promise) => (await fails(promise)).publicCode;
const payments = () => db.state.payments;
const audits = (action) => db.state.audits.filter((a) => (action ? a.action === action : true));
const seeded = (over = {}) => ({
  id: 1, invoiceId: 1, caseId: 10, currency: 'INR', kind: 'payment', amount: '1500.00', status: 'pending', method: 'razorpay', razorpayOrderId: null,
  externalReference: null, idempotencyKey: `${service.KEY_PREFIX}${KEY(1)}`, createdAt: clock.now(), updatedAt: clock.now(), ...over,
});

beforeEach(() => { clock.t = Date.parse('2026-11-20T10:00:00.000Z'); setup(); });

describe('switch and configuration', () => {
  test('PAYMENTS_ENABLED must be exactly "true": otherwise payments_disabled, with no database access and no gateway call', async () => {
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      const env = { ...ENV, PAYMENTS_ENABLED: value };
      expect(await code(call({ env }))).toBe('payments_disabled');
    }
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
    expect(db.invoice.findUnique).not.toHaveBeenCalled();
    expect(db.txCount).toBe(0);
  });
  test('unusable credentials (including a live key in a test run) fail closed as gateway_unavailable before any reservation', async () => {
    for (const env of [{ ...ENV, RAZORPAY_KEY_SECRET: '' }, { ...ENV, RAZORPAY_KEY_ID: 'rzp_live_FAKEKEY123456' }]) {
      expect(await code(call({ env }))).toBe('gateway_unavailable');
    }
    expect(db.txCount).toBe(0);
    expect(payments()).toHaveLength(0);
  });
});

describe('request validation', () => {
  test('the Idempotency-Key must be 16-64 characters of [A-Za-z0-9_-] with no surrounding whitespace', async () => {
    for (const bad of [undefined, '', 'short', 'a'.repeat(65), 'has space in it 12345', ' leading-key-1234567', 'trailing-key-1234567 ', 'bad/chars/12345678', 'bad.dots.1234567890']) {
      expect(await code(call({ idempotencyKey: bad }))).toBe('idempotency_key_invalid');
    }
    expect(db.txCount).toBe(0);
  });
  test('the body: full is the default; unknown keys (a currency, an invoice amount), a bad mode or a numeric amount are refused', async () => {
    expect((await call({ body: undefined })).created).toBe(true); // no body at all = full
    setup();
    expect(await code(call({ body: { mode: 'full', currency: 'USD' } }))).toBe('request_invalid');
    expect(await code(call({ body: { mode: 'full', invoiceAmount: '1.00' } }))).toBe('request_invalid');
    expect(await code(call({ body: { mode: 'full', amount: '10.00' } }))).toBe('request_invalid');
    expect(await code(call({ body: { mode: 'half' } }))).toBe('request_invalid');
    expect(await code(call({ body: [] }))).toBe('request_invalid');
    expect(await code(call({ body: { mode: 'partial', amount: 250 } }))).toBe('amount_invalid');
    expect(payments()).toHaveLength(0);
  });
  test('a malformed invoice id is "not found"', async () => {
    for (const bad of ['abc', '0', '-1', '1.5', '99999999999', '', undefined]) expect(await code(call({ invoiceId: bad }))).toBe('invoice_not_found');
  });
});

describe('patient authorization', () => {
  test('another patient gets 404, takes no lock and creates nothing', async () => {
    const err = await fails(call({ userId: 8 }));
    expect(err.statusCode).toBe(404);
    expect(err.publicCode).toBe('invoice_not_found');
    expect(db.state.locks).toHaveLength(0);
    expect(payments()).toHaveLength(0);
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });
  test('an unknown invoice and a corporate case (no service request) are 404 too', async () => {
    expect(await code(call({ invoiceId: '999' }))).toBe('invoice_not_found');
    setup({ case: { id: 10, status: 'in_progress', closedAt: null, serviceRequest: null } });
    expect(await code(call())).toBe('invoice_not_found');
  });
});

describe('invoice and quotation eligibility', () => {
  const refused = async (over, expected) => { setup(over); expect(await code(call())).toBe(expected); expect(payments()).toHaveLength(0); expect(gateway.fetchImpl).not.toHaveBeenCalled(); };
  test('a Case that is not a Private Charter Case is refused', () => refused({ case: { id: 10, status: 'in_progress', closedAt: null, serviceRequest: { userId: 7, serviceKey: 'medicalescort' } } }, 'invoice_not_payable'));
  test('a manual (legacy) invoice is refused', () => refused({ source: 'manual', quotationId: null, quotation: null }, 'invoice_not_payable'));
  test.each(['draft', 'void'])('an invoice that is %s is refused', (status) => refused({ status }, 'invoice_not_payable'));
  test.each(['published', 'draft', 'rejected', 'withdrawn', 'superseded', 'confirmed'])('a quotation that is %s is refused', (status) => refused({ quotation: { id: 5, status, supersededAt: null } }, 'quotation_not_active'));
  test('an accepted quotation that has been superseded is refused', () => refused({ quotation: { id: 5, status: 'accepted', supersededAt: new Date('2026-11-19T00:00:00Z') } }, 'quotation_not_active'));
  test('a closed Case is refused', () => refused({ case: { id: 10, status: 'in_progress', closedAt: new Date('2026-11-19T00:00:00Z'), serviceRequest: { userId: 7, serviceKey: 'privatecharter' } } }, 'invoice_not_payable'));
  test('a cancelled Case is refused', () => refused({ case: { id: 10, status: 'cancelled', closedAt: null, serviceRequest: { userId: 7, serviceKey: 'privatecharter' } } }, 'invoice_not_payable'));
  test('a currency not on the order list is refused', () => refused({ currency: 'KWD', amount: '1.250' }, 'currency_unsupported'));
  test('an invoice that is already fully paid has no balance', async () => {
    setup({}, [seeded({ status: 'completed', razorpayOrderId: 'order_PAID1', externalReference: 'pay_1', idempotencyKey: 'other', amount: '1500.00' })]);
    expect(await code(call())).toBe('invoice_not_payable');
  });
});

describe('due date', () => {
  test('a payment order is refused once the due date has passed (UTC day), and accepted on the due day itself', async () => {
    setup({ dueDate: new Date('2026-11-19T00:00:00.000Z') });
    const err = await fails(call());
    expect(err.publicCode).toBe('invoice_overdue');
    expect(payments()).toHaveLength(0);
    setup({ dueDate: new Date('2026-11-20T00:00:00.000Z') });
    expect((await call()).created).toBe(true);
    setup({ dueDate: new Date('2026-12-01T00:00:00.000Z') });
    expect((await call()).created).toBe(true);
    setup({ dueDate: null });
    expect((await call()).created).toBe(true);
  });
});

describe('full payment: the happy path', () => {
  test('reserves a pending row, creates the order on the server amount and attaches the order id', async () => {
    const result = await call({ body: { mode: 'full' } });
    expect(result.outcome).toBe('ok');
    expect(result.created).toBe(true);
    expect(result.payload).toEqual({
      paymentId: 1, invoiceId: 1, status: 'pending', amount: '1500.00', currency: 'INR',
      razorpay: { keyId: kit.KEY_ID, orderId: 'order_FAKE1', amount: 150000, currency: 'INR' },
    });
    expect(payments()).toEqual([expect.objectContaining({
      invoiceId: 1, caseId: 10, kind: 'payment', status: 'pending', method: 'razorpay', currency: 'INR', amount: '1500.00',
      razorpayOrderId: 'order_FAKE1', idempotencyKey: `rzp-order:${KEY(1)}`,
    })]);
    expect(audits().map((a) => a.action)).toEqual(['payment.order_reserved', 'payment.order_created']);
    expect(audits('payment.order_created')[0].afterData).toMatchObject({ paymentId: 1, invoiceId: 1, razorpayOrderId: 'order_FAKE1' });
    expect(audits()[0]).toMatchObject({ entityType: 'payment', entityId: '1', actorType: 'patient', actorId: '7', caseId: 10 });
  });
  test('the gateway request carries the integer smallest-unit amount, the INVOICE currency, receipt HCP<id> and ids only', async () => {
    await call();
    const [create] = gateway.creates();
    expect(create.url).toBe('https://api.razorpay.com/v1/orders');
    expect(create.init.headers.Authorization).toBe(BASIC);
    expect(create.init.redirect).toBe('error');
    expect(JSON.parse(create.init.body)).toEqual({ amount: 150000, currency: 'INR', receipt: 'HCP1', notes: { hc_payment_id: '1', hc_invoice_id: '1', hc_environment: 'test' } });
  });
  test('the amount and currency come from the invoice, whatever else is claimed', async () => {
    setup({ amount: '2499.990', currency: 'USD' });
    const result = await call({ body: { mode: 'full' } });
    expect(result.payload.amount).toBe('2499.99');
    expect(result.payload.currency).toBe('USD');
    expect(JSON.parse(gateway.creates()[0].init.body)).toMatchObject({ amount: 249999, currency: 'USD' });
  });
  test('a completed payment already on the invoice reduces the balance', async () => {
    setup({}, [seeded({ id: 1, status: 'completed', amount: '400.00', razorpayOrderId: null, externalReference: 'UTR1', idempotencyKey: 'manual-1' })]);
    expect((await call()).payload.amount).toBe('1100.00'); // 1500 - 400
  });
  test('pending, failed and cancelled rows are not money received', async () => {
    setup({}, [seeded({ id: 1, status: 'failed', idempotencyKey: 'old-1' }), seeded({ id: 2, status: 'cancelled', idempotencyKey: 'old-2' })]);
    expect((await call()).payload.amount).toBe('1500.00');
  });
});

// Approved rule: refunds do NOT reopen an invoice's balance. Only completed payment rows count as paid.
describe('refunds never reopen the invoice balance', () => {
  const paid = (over = {}) => seeded({ id: 1, status: 'completed', amount: '400.00', razorpayOrderId: null, externalReference: 'UTR1', idempotencyKey: 'manual-1', ...over });
  const refund = (over = {}) => seeded({ id: 2, status: 'completed', kind: 'refund', amount: '100.00', razorpayOrderId: null, externalReference: 'rfnd_1', idempotencyKey: 'manual-2', ...over });

  test('netPaid counts completed payments only: a completed refund does not reduce what has been paid', () => {
    expect(service.netPaid([paid()])).toBe(400000n);
    expect(service.netPaid([paid(), refund()])).toBe(400000n);
    expect(service.netPaid([paid(), refund({ amount: '400.00' })])).toBe(400000n); // even a full refund of that payment
    expect(service.netPaid([refund()])).toBe(0n);
  });

  test('a new full order is for the balance after payments, whatever has been refunded', async () => {
    setup({}, [paid(), refund()]);
    expect((await call()).payload.amount).toBe('1100.00'); // 1500 - 400; the 100 refunded is NOT added back
    setup({}, [paid(), refund({ amount: '400.00' })]);
    expect((await call()).payload.amount).toBe('1100.00');
  });

  test('a fully paid invoice stays closed even when it was fully refunded', async () => {
    setup({}, [paid({ amount: '1500.00' }), refund({ amount: '1500.00' })]);
    expect(await code(call())).toBe('invoice_not_payable');
    expect(payments()).toHaveLength(2); // nothing was added
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });

  test('refunds in any status other than completed change nothing either', async () => {
    setup({}, [paid(), refund({ status: 'pending' }), refund({ id: 3, status: 'failed', idempotencyKey: 'manual-3' })]);
    expect((await call()).payload.amount).toBe('1100.00');
  });

  test('the idempotency replay uses the same balance: a full replay is NOT a conflict after a refund', async () => {
    setup({}, [paid(), refund()]);
    const first = await call();
    expect(first.payload.amount).toBe('1100.00');
    const again = await call();
    expect(again.created).toBe(false);
    expect(again.payload).toEqual(first.payload);
    expect(gateway.creates()).toHaveLength(1);
  });

  test('an authorized partial amount is limited by the same balance (refunds ignored)', async () => {
    setup({ allowPartialPayment: true }, [paid(), refund()]);
    expect(await code(call({ body: { mode: 'partial', amount: '1100.00' } }))).toBe('amount_invalid'); // the whole balance is "full"
    expect(await code(call({ body: { mode: 'partial', amount: '1200.00' } }))).toBe('amount_invalid'); // 1100 + the refund would have been allowed before
    expect((await call({ idempotencyKey: KEY(2), body: { mode: 'partial', amount: '1099.99' } })).payload.amount).toBe('1099.99');
  });
});

describe('partial payment', () => {
  test('requires explicit authorization on the invoice', async () => {
    expect(await code(call({ body: { mode: 'partial', amount: '250.00' } }))).toBe('partial_not_authorized');
    expect(payments()).toHaveLength(0);
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });
  test('an authorized partial payment creates an order for exactly that amount', async () => {
    setup({ allowPartialPayment: true });
    const result = await call({ body: { mode: 'partial', amount: '250.00' } });
    expect(result.payload.amount).toBe('250.00');
    expect(result.payload.razorpay.amount).toBe(25000);
    expect(JSON.parse(gateway.creates()[0].init.body).amount).toBe(25000);
    expect(audits('payment.order_reserved')[0].afterData.mode).toBe('partial');
  });
  test('decimal strings without a fraction are fine; the balance is the ceiling', async () => {
    setup({ allowPartialPayment: true });
    expect((await call({ body: { mode: 'partial', amount: '250' } })).payload.amount).toBe('250.00');
  });
  test.each(['0', '0.00', '-5.00', '1500.00', '1500.01', '99999.00', '250.005', '1e2', '', 'abc', ' 250', '1,000'])('the partial amount %p is refused', async (amount) => {
    setup({ allowPartialPayment: true });
    expect(await code(call({ body: { mode: 'partial', amount } }))).toBe('amount_invalid');
    expect(payments()).toHaveLength(0);
  });
  test('the ceiling is the REMAINING balance after earlier payments', async () => {
    setup({ allowPartialPayment: true }, [seeded({ id: 1, status: 'completed', amount: '1300.00', externalReference: 'pay_1', razorpayOrderId: 'order_OLD1', idempotencyKey: 'old-1' })]);
    expect(await code(call({ body: { mode: 'partial', amount: '200.00' } }))).toBe('amount_invalid'); // 200 is the whole balance: that is "full"
    expect((await call({ idempotencyKey: KEY(2), body: { mode: 'partial', amount: '199.99' } })).payload.amount).toBe('199.99');
  });
  test('the last part is paid with mode "full"', async () => {
    setup({ allowPartialPayment: true }, [seeded({ id: 1, status: 'completed', amount: '1300.00', externalReference: 'pay_1', razorpayOrderId: 'order_OLD1', idempotencyKey: 'old-1' })]);
    expect((await call({ body: { mode: 'full' } })).payload.amount).toBe('200.00');
  });
});

describe('idempotency', () => {
  test('the same key and the same request return the same order and never call the gateway twice', async () => {
    const first = await call();
    const second = await call();
    expect(second.created).toBe(false);
    expect(second.payload).toEqual(first.payload);
    expect(payments()).toHaveLength(1);
    expect(gateway.creates()).toHaveLength(1);
  });
  test('the stored key has the rzp-order: prefix', async () => {
    await call();
    expect(payments()[0].idempotencyKey).toBe(`rzp-order:${KEY(1)}`);
  });
  test('the same key with a different mode or amount is a conflict', async () => {
    setup({ allowPartialPayment: true });
    await call({ body: { mode: 'partial', amount: '250.00' } });
    expect(await code(call({ body: { mode: 'full' } }))).toBe('idempotency_conflict');
    expect(await code(call({ body: { mode: 'partial', amount: '300.00' } }))).toBe('idempotency_conflict');
    expect((await call({ body: { mode: 'partial', amount: '250.00' } })).created).toBe(false);
    expect(payments()).toHaveLength(1);
  });
  test('a full request replayed as partial is a conflict', async () => {
    setup({ allowPartialPayment: true });
    await call({ body: { mode: 'full' } });
    expect(await code(call({ body: { mode: 'partial', amount: '1000.00' } }))).toBe('idempotency_conflict');
  });
  test('replaying a closed payment returns its status and never a new order', async () => {
    gateway.modes = ['refuse'];
    expect(await code(call())).toBe('gateway_unavailable');
    const again = await call();
    expect(again.created).toBe(false);
    expect(again.payload).toMatchObject({ paymentId: 1, status: 'failed' });
    expect(again.payload.razorpay).toBeUndefined();
    expect(gateway.creates()).toHaveLength(1);
  });
  describe('replaying an open order re-checks that the invoice is still payable', () => {
    // The order exists (it has an id); only the world around it changes. Nothing may be returned or changed.
    const openOrder = async () => { await call(); return structuredClone({ rows: payments(), audits: audits(), calls: gateway.calls.length }); };
    const expectUntouched = (before) => {
      expect(payments()).toEqual(before.rows); // the row and its Razorpay order id are exactly as they were
      expect(audits()).toEqual(before.audits); // no audit row was added or removed
      expect(gateway.calls.length).toBe(before.calls); // and Razorpay was not contacted
    };

    test('the invoice became void: the same key no longer returns checkout details', async () => {
      const before = await openOrder();
      db.state.invoices.get(1).status = 'void';
      const err = await fails(call());
      expect(err.publicCode).toBe('invoice_not_payable');
      expect(err.statusCode).toBe(409);
      expectUntouched(before);
      expect(payments()[0]).toMatchObject({ status: 'pending', razorpayOrderId: 'order_FAKE1' });
    });

    test('the due date has passed: invoice_overdue, nothing returned or changed', async () => {
      setup({ dueDate: new Date('2026-11-21T00:00:00.000Z') });
      const before = await openOrder();
      clock.advance(2 * 24 * 60 * 60 * 1000); // two days later (UTC day after the due day)
      expect(await code(call())).toBe('invoice_overdue');
      expectUntouched(before);
    });

    test('on the due day itself the replay still works', async () => {
      setup({ dueDate: new Date('2026-11-21T00:00:00.000Z') });
      const first = await call();
      clock.advance(24 * 60 * 60 * 1000 + 60 * 1000); // 21 Nov, still the due day
      const again = await call();
      expect(again.created).toBe(false);
      expect(again.payload).toEqual(first.payload);
    });

    test('the quotation was superseded: quotation_not_active, nothing returned or changed', async () => {
      const before = await openOrder();
      db.state.invoices.get(1).quotation.supersededAt = new Date('2026-11-20T11:00:00.000Z');
      expect(await code(call())).toBe('quotation_not_active');
      expectUntouched(before);
    });

    test.each(['published', 'rejected', 'withdrawn', 'draft'])('the quotation is no longer accepted (%s): quotation_not_active', async (status) => {
      const before = await openOrder();
      db.state.invoices.get(1).quotation.status = status;
      expect(await code(call())).toBe('quotation_not_active');
      expectUntouched(before);
    });

    test('the Case was closed or the invoice is no longer issued: refused, nothing changed', async () => {
      let before = await openOrder();
      db.state.invoices.get(1).case.closedAt = new Date('2026-11-20T11:00:00.000Z');
      expect(await code(call())).toBe('invoice_not_payable');
      expectUntouched(before);
      setup();
      before = await openOrder();
      db.state.invoices.get(1).status = 'draft';
      expect(await code(call())).toBe('invoice_not_payable');
      expectUntouched(before);
    });

    test('the answer carries no checkout details and no gateway data', async () => {
      await openOrder();
      db.state.invoices.get(1).status = 'void';
      const err = await fails(call());
      expect(JSON.stringify({ message: err.message, code: err.publicCode })).not.toMatch(/order_FAKE|rzp_|keyId|razorpay/i);
    });

    test('a valid replay is unchanged: same order, 200 semantics, no second gateway call', async () => {
      const first = await call();
      const second = await call();
      expect(second.created).toBe(false);
      expect(second.payload).toEqual(first.payload);
      expect(second.payload.razorpay.orderId).toBe('order_FAKE1');
      expect(gateway.creates()).toHaveLength(1);
    });

    test('a CLOSED payment still answers with its status only, even after the invoice was voided (nothing to check out)', async () => {
      gateway.modes = ['refuse'];
      await fails(call());
      db.state.invoices.get(1).status = 'void';
      const again = await call();
      expect(again.payload).toMatchObject({ status: 'failed' });
      expect(again.payload.razorpay).toBeUndefined();
    });

    test('the idempotency checks still come first: a changed request is a conflict, not an eligibility error', async () => {
      await openOrder();
      db.state.invoices.get(1).status = 'void';
      expect(await code(call({ body: { mode: 'partial', amount: '100.00' } }))).toBe('idempotency_conflict');
    });
  });

  test('a replay by another patient is 404 and reveals nothing', async () => {
    await call();
    expect(await code(call({ userId: 8 }))).toBe('invoice_not_found');
  });
  test('the key is scoped to the invoice: the same key on another invoice makes a separate payment', async () => {
    setup({}, [], [makeInvoice({ id: 2 })]);
    await call();
    expect((await call({ invoiceId: '2' })).created).toBe(true);
    expect(payments()).toHaveLength(2);
  });
});

describe('one open order per invoice', () => {
  test('a second request with a different key is refused while an order is open', async () => {
    await call();
    expect(await code(call({ idempotencyKey: KEY(2) }))).toBe('open_order_exists');
    expect(gateway.creates()).toHaveLength(1);
  });
  test('once the order is closed, a new one may be created', async () => {
    await call();
    payments()[0].status = 'cancelled';
    expect((await call({ idempotencyKey: KEY(2) })).created).toBe(true);
    expect(gateway.creates()).toHaveLength(2);
  });
  test('concurrent requests with different keys: exactly one order is created, the other is refused', async () => {
    const results = await Promise.allSettled([call({ idempotencyKey: KEY(1) }), call({ idempotencyKey: KEY(2) })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.publicCode)).toEqual(['open_order_exists']);
    expect(gateway.creates()).toHaveLength(1);
    expect(payments()).toHaveLength(1);
  });
  test('five concurrent requests: still one order', async () => {
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => call({ idempotencyKey: KEY(n) })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(gateway.creates()).toHaveLength(1);
  });
  test('concurrent requests with the SAME key: one order; the other either replays it or is told to retry', async () => {
    const results = await Promise.all([call(), call()]);
    expect(gateway.creates()).toHaveLength(1);
    expect(payments()).toHaveLength(1);
    for (const r of results) expect(['ok', 'uncertain']).toContain(r.outcome);
  });
});

describe('transaction and locking discipline', () => {
  test('no database transaction is open while Razorpay is being called', async () => {
    gateway.hooks.onCall = () => gateway.observed.push(db.inTx);
    await call();
    expect(gateway.observed.length).toBeGreaterThan(0);
    expect(gateway.observed.every((open) => open === false)).toBe(true);
  });
  test('the invoice row is locked first in every transaction; the payment row only after it (and only in the attach phase)', async () => {
    await call();
    const byTx = {};
    for (const l of db.state.locks) (byTx[l.tx] = byTx[l.tx] || []).push(l.table);
    expect(Object.values(byTx)).toEqual([['invoices'], ['invoices', 'payments']]);
    expect(db.state.locks.every((l) => l.inTx)).toBe(true);
  });
  test('the order id is attached with a guarded update: only a pending row with no order id, never overwriting', async () => {
    await call();
    const attach = db.payment.updateMany.mock.calls.find(([arg]) => arg.data.razorpayOrderId);
    expect(attach[0].where).toEqual({ id: 1, status: 'pending', razorpayOrderId: null });
  });
});

describe('gateway outcomes', () => {
  test('a DEFINITIVE refusal marks the local row failed, audits it and frees the invoice', async () => {
    gateway.modes = ['refuse'];
    const err = await fails(call());
    expect(err.publicCode).toBe('gateway_unavailable');
    expect(err.statusCode).toBe(502);
    expect(payments()).toEqual([expect.objectContaining({ status: 'failed', razorpayOrderId: null })]);
    expect(audits('payment.order_failed')[0]).toMatchObject({ reasonCode: 'gateway_error', actorType: 'patient' });
    expect((await call({ idempotencyKey: KEY(2) })).created).toBe(true); // a new attempt is possible
  });
  test('an AMBIGUOUS outcome keeps the row pending without an order id and answers "uncertain"', async () => {
    gateway.modes = ['timeout'];
    const result = await call();
    expect(result).toMatchObject({ outcome: 'uncertain', paymentId: 1, invoiceId: 1 });
    expect(payments()).toEqual([expect.objectContaining({ status: 'pending', razorpayOrderId: null })]);
    expect(audits('payment.order_uncertain')).toHaveLength(1);
  });
  test('after an ambiguous outcome nothing else is created: another key is refused as an open order', async () => {
    gateway.modes = ['timeout'];
    await call();
    expect(await code(call({ idempotencyKey: KEY(2) }))).toBe('open_order_exists');
    expect(gateway.creates()).toHaveLength(1);
  });
  test('an unexpected error while calling the gateway is treated as ambiguous, never as a failure', async () => {
    gateway.fetchImpl.mockImplementationOnce(async () => { throw new Error('boom'); });
    expect((await call()).outcome).toBe('uncertain');
    expect(payments()[0].status).toBe('pending');
  });
});

describe('recovery by receipt (client retry)', () => {
  test('a retry within the first minute does not touch the gateway', async () => {
    gateway.modes = ['timeout'];
    await call();
    const callsBefore = gateway.calls.length;
    clock.advance(30 * 1000);
    expect((await call()).outcome).toBe('uncertain');
    expect(gateway.calls.length).toBe(callsBefore);
  });
  test('after a minute the order is FOUND by its receipt and attached, without creating a second one', async () => {
    gateway.modes = ['lost']; // the order was created, the answer was lost
    expect((await call()).outcome).toBe('uncertain');
    clock.advance(61 * 1000);
    const result = await call();
    expect(result.outcome).toBe('ok');
    expect(result.payload.razorpay.orderId).toBe('order_FAKE1');
    expect(gateway.creates()).toHaveLength(1);
    expect(payments()[0].razorpayOrderId).toBe('order_FAKE1');
    expect(audits('payment.order_recovered')).toHaveLength(1);
    expect(gateway.calls.some((c) => c.url.includes('receipt=HCP1'))).toBe(true);
  });
  test('after a minute, when Razorpay confirms there is no such order, it is created once', async () => {
    gateway.modes = ['timeout']; // nothing was created
    await call();
    clock.advance(61 * 1000);
    const result = await call();
    expect(result.outcome).toBe('ok');
    expect(gateway.creates()).toHaveLength(2);
    expect(gateway.orders).toHaveLength(1);
    expect(payments()[0].razorpayOrderId).toBe('order_FAKE1');
  });
  test('two simultaneous retries: only one wins the claim, so at most one order is created', async () => {
    gateway.modes = ['timeout'];
    await call();
    clock.advance(61 * 1000);
    const results = await Promise.all([call(), call()]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['ok', 'uncertain']);
    expect(gateway.orders).toHaveLength(1);
  });
  test('the lookup failing is "uncertain": nothing is created', async () => {
    gateway.modes = ['timeout'];
    await call();
    clock.advance(61 * 1000);
    gateway.listMode = 'error';
    expect((await call()).outcome).toBe('uncertain');
    expect(gateway.creates()).toHaveLength(1);
  });
  test('two orders with the same receipt need a person: flagged, nothing attached or created', async () => {
    gateway.modes = ['timeout'];
    await call();
    gateway.orders.push({ id: 'order_DUP1', entity: 'order', amount: 150000, currency: 'INR', receipt: 'HCP1', status: 'created', amount_paid: 0, attempts: 0 },
      { id: 'order_DUP2', entity: 'order', amount: 150000, currency: 'INR', receipt: 'HCP1', status: 'created', amount_paid: 0, attempts: 0 });
    clock.advance(61 * 1000);
    expect((await call()).outcome).toBe('uncertain');
    expect(audits('payment.order_review_required')).toHaveLength(1);
    expect(payments()[0].razorpayOrderId).toBeNull();
    expect(gateway.creates()).toHaveLength(1);
  });
  test('an order found with a different amount is flagged, not attached', async () => {
    gateway.modes = ['timeout'];
    await call();
    gateway.orders.push({ id: 'order_WRONG1', entity: 'order', notes: { hc_payment_id: '1', hc_invoice_id: '1', hc_environment: 'test' }, amount: 1, currency: 'INR', receipt: 'HCP1', status: 'created', amount_paid: 0, attempts: 0 });
    clock.advance(61 * 1000);
    expect((await call()).outcome).toBe('uncertain');
    expect(audits('payment.order_review_required')[0].reasonCode).toBe('order_mismatch');
    expect(payments()[0].razorpayOrderId).toBeNull();
  });
  test('a recovery retry re-checks the invoice: if it became void, nothing is created and the row is cancelled', async () => {
    gateway.modes = ['timeout'];
    await call();
    db.state.invoices.get(1).status = 'void';
    clock.advance(61 * 1000);
    expect(await code(call())).toBe('invoice_not_payable');
    expect(payments()[0].status).toBe('cancelled');
    expect(gateway.creates()).toHaveLength(1);
  });
});

describe('the invoice changes while Razorpay is being called (attach phase)', () => {
  test('the local row is cancelled and the external order flagged for reconciliation', async () => {
    gateway.hooks.beforeCreateReply = () => { db.state.invoices.get(1).status = 'void'; };
    expect(await code(call())).toBe('invoice_not_payable');
    expect(payments()).toEqual([expect.objectContaining({ status: 'cancelled', razorpayOrderId: null })]);
    const flagged = audits('payment.order_orphaned')[0];
    expect(flagged.afterData.razorpayOrderId).toBe('order_FAKE1');
    expect(flagged.reasonCode).toBe('invoice_not_payable');
  });
  test('a quotation superseded meanwhile is reported as such', async () => {
    gateway.hooks.beforeCreateReply = () => { db.state.invoices.get(1).quotation.supersededAt = new Date(); };
    expect(await code(call())).toBe('quotation_not_active');
    expect(payments()[0].status).toBe('cancelled');
    expect(audits('payment.order_orphaned')).toHaveLength(1);
  });
  test('an order id that is already attached is never overwritten: the existing order wins and the new one is flagged', async () => {
    gateway.hooks.beforeCreateReply = () => { payments()[0].razorpayOrderId = 'order_EXISTING1'; };
    const result = await call();
    expect(result.payload.razorpay.orderId).toBe('order_EXISTING1');
    expect(payments()[0].razorpayOrderId).toBe('order_EXISTING1');
    expect(audits('payment.order_orphaned')[0].afterData.razorpayOrderId).toBe('order_FAKE1');
  });
  test('a row that is no longer pending is not given an order id', async () => {
    gateway.hooks.beforeCreateReply = () => { payments()[0].status = 'cancelled'; };
    expect(await code(call())).toBe('invoice_not_payable');
    expect(payments()[0].razorpayOrderId).toBeNull();
    expect(audits('payment.order_orphaned')).toHaveLength(1);
  });
});

describe('background recovery sweep', () => {
  const sweep = () => service.recoverPendingOrders({ db, env: ENV, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log });
  test('does nothing while payments are off or the credentials are unusable', async () => {
    setup({}, [seeded()]);
    clock.advance(5 * MIN);
    expect(await service.recoverPendingOrders({ db, env: { ...ENV, PAYMENTS_ENABLED: 'no' }, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log })).toEqual({ skipped: true });
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });
  test('rows younger than a minute are left alone', async () => {
    setup({}, [seeded()]);
    clock.advance(30 * 1000);
    expect(await sweep()).toMatchObject({ checked: 0 });
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });
  test('a pending row older than a minute whose order exists at Razorpay gets it attached', async () => {
    setup({}, [seeded()]);
    gateway.orders.push({ id: 'order_SWEEP1', entity: 'order', notes: { hc_payment_id: '1', hc_invoice_id: '1', hc_environment: 'test' }, amount: 150000, currency: 'INR', receipt: 'HCP1', status: 'created', amount_paid: 0, attempts: 0 });
    clock.advance(2 * MIN);
    expect(await sweep()).toMatchObject({ checked: 1, attached: 1 });
    expect(payments()[0].razorpayOrderId).toBe('order_SWEEP1');
    expect(audits('payment.order_recovered')[0].actorType).toBe('system');
    expect(gateway.creates()).toHaveLength(0);
  });
  test('when Razorpay confirms there is no order, the row is closed as failed and NO order is created', async () => {
    setup({}, [seeded()]);
    clock.advance(2 * MIN);
    expect(await sweep()).toMatchObject({ checked: 1, closed: 1 });
    expect(payments()[0].status).toBe('failed');
    expect(audits('payment.order_failed')[0].reasonCode).toBe('order_never_created');
    expect(gateway.creates()).toHaveLength(0);
  });
  test('an unreachable gateway leaves the row untouched', async () => {
    setup({}, [seeded()]);
    gateway.listMode = 'error';
    clock.advance(2 * MIN);
    expect(await sweep()).toMatchObject({ checked: 1, uncertain: 1 });
    expect(payments()[0].status).toBe('pending');
  });
});

describe('the 30-minute unused-order timeout', () => {
  const withOrder = (over = {}) => seeded({ razorpayOrderId: 'order_OPEN1', ...over });
  const timeout = () => service.closeStaleOrders({ db, env: ENV, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log });
  const order = (over = {}) => ({ id: 'order_OPEN1', entity: 'order', amount: 150000, currency: 'INR', receipt: 'HCP1', status: 'created', amount_paid: 0, attempts: 0, ...over });

  test('an order younger than 30 minutes is not even looked at', async () => {
    setup({}, [withOrder()]);
    gateway.orders.push(order());
    clock.advance(29 * MIN);
    expect(await timeout()).toMatchObject({ checked: 0 });
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
    expect(payments()[0].status).toBe('pending');
  });
  test('an old order is closed only AFTER Razorpay says it was never attempted or paid', async () => {
    setup({}, [withOrder()]);
    gateway.orders.push(order());
    clock.advance(31 * MIN);
    expect(await timeout()).toMatchObject({ checked: 1, closed: 1 });
    expect(gateway.calls.map((c) => c.method)).toEqual(['GET']); // the gateway was asked; nothing was cancelled there
    expect(payments()[0].status).toBe('cancelled');
    expect(audits('payment.order_timeout')[0].reasonCode).toBe('unused_order_timeout');
    expect(payments()).toHaveLength(1); // the row is kept
  });
  test('local age alone never closes: an unreachable gateway or an unknown order leaves it pending', async () => {
    setup({}, [withOrder()]);
    gateway.orders.push(order());
    gateway.getMode = 'error';
    clock.advance(31 * MIN);
    expect(await timeout()).toMatchObject({ checked: 1, left: 1, closed: 0 });
    expect(payments()[0].status).toBe('pending');
    setup({}, [withOrder()]); // Razorpay does not know the order
    clock.advance(31 * MIN);
    expect(await timeout()).toMatchObject({ closed: 0, left: 1 });
    expect(payments()[0].status).toBe('pending');
  });
  test('an attempted order may have a customer mid-payment: it is left alone', async () => {
    setup({}, [withOrder()]);
    gateway.orders.push(order({ status: 'attempted', attempts: 1 }));
    clock.advance(31 * MIN);
    expect(await timeout()).toMatchObject({ checked: 1, left: 1, closed: 0 });
    expect(payments()[0].status).toBe('pending');
  });
  test('a PAID order is never closed: it is flagged for the webhook / reconciliation, once', async () => {
    setup({}, [withOrder()]);
    gateway.orders.push(order({ status: 'paid', amount_paid: 150000, attempts: 1 }));
    clock.advance(31 * MIN);
    expect(await timeout()).toMatchObject({ flagged: 1, closed: 0 });
    expect(await timeout()).toMatchObject({ flagged: 1 });
    expect(payments()[0].status).toBe('pending');
    expect(audits('payment.order_paid_unreconciled')).toHaveLength(1); // the repeated flag is a no-op
    expect(audits('payment.order_paid_unreconciled')[0].afterData.razorpayOrderId).toBe('order_OPEN1');
  });
  test('closing never deletes evidence: a payment arriving later finds the row and its audit trail', async () => {
    setup({}, [withOrder()]);
    gateway.orders.push(order());
    clock.advance(31 * MIN);
    await timeout();
    expect(payments()[0]).toMatchObject({ id: 1, razorpayOrderId: 'order_OPEN1', status: 'cancelled' });
    expect(audits().length).toBeGreaterThan(0);
  });
  test('the sweep only closes a row that is still pending when the lock is taken', async () => {
    setup({}, [withOrder()]);
    gateway.orders.push(order());
    gateway.hooks.onCall = () => { payments()[0].status = 'completed'; }; // a webhook completes it between the lookup and the close
    clock.advance(31 * MIN);
    expect(await timeout()).toMatchObject({ closed: 1 }); // the attempt is counted...
    expect(payments()[0].status).toBe('completed'); // ...but the completed row is not overwritten
    expect(audits('payment.order_timeout')).toHaveLength(0);
  });
});

describe('secrets never leak', () => {
  test('nothing the service logs, audits, returns or throws contains the secret, the Authorization header or a gateway description', async () => {
    gateway.modes = ['refuse'];
    const refused = await fails(call());
    setup();
    gateway.modes = ['timeout'];
    const uncertain = await call({ idempotencyKey: KEY(3) });
    setup();
    const ok = await call({ idempotencyKey: KEY(4) });
    const everything = JSON.stringify([refused.message, refused.publicCode, uncertain, ok, db.state.audits, db.state.payments, log.error.mock.calls, log.warn.mock.calls]);
    expect(everything).not.toMatch(new RegExp(`${SECRET}|Basic |DO_NOT_LEAK|secret\\.example|${Buffer.from(`${kit.KEY_ID}:${SECRET}`).toString('base64')}`));
    expect(everything).not.toContain('Authorization');
    expect(JSON.stringify(ok.payload)).not.toMatch(/secret|receipt|HCP|notes|Authorization/i);
  });
  test('the response carries only the allowed fields', async () => {
    const { payload } = await call();
    expect(Object.keys(payload).sort()).toEqual(['amount', 'currency', 'invoiceId', 'paymentId', 'razorpay', 'status']);
    expect(Object.keys(payload.razorpay).sort()).toEqual(['amount', 'currency', 'keyId', 'orderId']);
  });
});

describe('no accidental network use', () => {
  test('every test above reaches the gateway only through the injected fetch (the global one is blocked by the safe-test setup)', async () => {
    await call();
    expect(gateway.fetchImpl).toHaveBeenCalled();
    await expect(global.fetch('https://api.razorpay.com/v1/orders')).rejects.toThrow(/blocked/i);
  });
});
