/* global describe, test, expect, jest, beforeEach */
// Receipt recovery must never attach an order that is not THIS payment's, in THIS environment. The receipt ("HCP<paymentId>") is only a search
// key: the same receipt can exist in another HumanCare environment that shares the Razorpay account. Before an order found by receipt is
// attached, its notes must carry exactly (as text) this payment's id (hc_payment_id), this invoice's id (hc_invoice_id) AND this
// environment's id (hc_environment = PAYMENTS_ENVIRONMENT_ID). Anything else is flagged for Operations with a specific reason and is never
// attached, never answered with a second order. A Razorpay order id that already belongs to another payment (unique index, Prisma P2002) is
// handled the same way without exposing the database error. Real service and store over the in-memory database; fake Razorpay.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
const service = require('../../src/modules/payments/payment-orders.service');
const kit = require('./payments-test-kit');

const { ENV, SECRET, clock, makeInvoice, makeDb, makeGateway, silentLog, KEY } = kit;
const SECOND = 1000;
const THIS_ENV = 'test'; // kit.ENV.PAYMENTS_ENVIRONMENT_ID

let db; let gateway; let log;
const setup = (payments = [], invoices = [makeInvoice()]) => { db = makeDb({ invoices, payments }); gateway = makeGateway(); log = silentLog(); };
const call = (over = {}) => service.createPaymentOrder({
  userId: 7, invoiceId: '1', idempotencyKey: KEY(1), body: { mode: 'full' }, db, env: ENV, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log, ...over,
});
const sweep = (over = {}) => service.recoverPendingOrders({ db, env: ENV, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log, ...over });
const payments = () => db.state.payments;
const audits = (action) => db.state.audits.filter((a) => (action ? a.action === action : true));
const goodNotes = (over = {}) => ({ hc_payment_id: '1', hc_invoice_id: '1', hc_environment: THIS_ENV, ...over });
const orderFor = (over = {}) => ({ id: 'order_FOUND1', entity: 'order', amount: 150000, currency: 'INR', receipt: 'HCP1', status: 'created', amount_paid: 0, attempts: 0, notes: goodNotes(), ...over });
// A payment whose first create timed out: pending, no order id, and (as time passes) due for recovery.
const timedOut = async () => { gateway.modes = ['timeout']; expect((await call()).outcome).toBe('uncertain'); };

beforeEach(() => { clock.t = Date.parse('2026-11-20T10:00:00.000Z'); setup(); });

describe('1. an order whose three notes all match this payment, invoice and environment', () => {
  test('is attached (recovered), with no discrepancy flag', async () => {
    await timedOut();
    gateway.orders.push(orderFor());
    clock.advance(61 * SECOND);
    const result = await call();
    expect(result.outcome).toBe('ok');
    expect(result.payload.razorpay.orderId).toBe('order_FOUND1');
    expect(payments()[0].razorpayOrderId).toBe('order_FOUND1');
    expect(audits('payment.order_recovered')).toHaveLength(1);
    expect(audits('payment.order_review_required')).toHaveLength(0);
    expect(gateway.creates()).toHaveLength(1); // only the original create
  });

  test('the background sweep attaches it the same way', async () => {
    await timedOut();
    gateway.orders.push(orderFor());
    clock.advance(2 * 60 * SECOND);
    expect(await sweep()).toMatchObject({ checked: 1, attached: 1, uncertain: 0 });
    expect(payments()[0].razorpayOrderId).toBe('order_FOUND1');
    expect(audits('payment.order_review_required')).toHaveLength(0);
  });

  test('an order created by this very service carries all three notes and passes the check (end to end)', async () => {
    gateway.modes = ['lost']; // created at Razorpay, answer lost
    await call();
    clock.advance(61 * SECOND);
    expect((await call()).outcome).toBe('ok');
    expect(audits('payment.order_recovered')).toHaveLength(1);
    expect(gateway.orders[0].notes).toEqual({ hc_payment_id: '1', hc_invoice_id: '1', hc_environment: THIS_ENV });
  });

  test('the environment note comes from PAYMENTS_ENVIRONMENT_ID, not from NODE_ENV', async () => {
    const env = { ...ENV, NODE_ENV: 'production', PAYMENTS_LIVE_MODE: undefined, PAYMENTS_ENVIRONMENT_ID: 'staging' }; // a test key is fine anywhere
    gateway.modes = ['lost'];
    await call({ env });
    expect(gateway.orders[0].notes.hc_environment).toBe('staging');
    clock.advance(61 * SECOND);
    expect((await call({ env })).outcome).toBe('ok'); // recovered in the same environment
  });
});

// The same flow for every refusal: the order is never attached, never replaced by a new one (however often the client retries), and
// Operations are told once, with the given reason.
const expectFlaggedNotAttached = async (notes, reason, { raw = false } = {}) => {
  await timedOut();
  const foreign = orderFor({ id: 'order_FOREIGN1', notes });
  if (raw) delete foreign.notes;
  gateway.orders.push(foreign);
  const createsBefore = gateway.creates().length;

  for (let round = 0; round < 3; round += 1) { // the client keeps retrying: the answer never changes
    clock.advance(61 * SECOND);
    const result = await call();
    expect(result.outcome).toBe('uncertain'); // "retry later": never an attach, never a new order
    expect(payments()[0]).toMatchObject({ status: 'pending', razorpayOrderId: null });
  }
  expect(gateway.creates()).toHaveLength(createsBefore); // NEVER another order because of a mismatched lookup
  expect(gateway.orders).toHaveLength(1);
  expect(audits('payment.order_recovered')).toHaveLength(0);
  const flags = audits('payment.order_review_required');
  expect(flags).toHaveLength(1); // flagged for Operations once (the repeated flag is a no-op)
  expect(flags[0]).toMatchObject({ entityType: 'payment', entityId: '1', caseId: 10, reasonCode: reason });
  expect(flags[0].afterData).toMatchObject({ paymentId: 1, invoiceId: 1, razorpayOrderId: 'order_FOREIGN1' });
};

describe('2. an order from a DIFFERENT environment is refused', () => {
  test.each([
    ['production', 'production'], ['staging', 'staging'], ['development', 'development'], ['another test environment', 'test2'],
    ['the right name in the wrong case', 'Test'], ['upper case', 'TEST'],
  ])('hc_environment "%s" (ours is "test"): flagged order_environment_mismatch, not attached, nothing created', (_label, other) =>
    expectFlaggedNotAttached(goodNotes({ hc_environment: other }), 'order_environment_mismatch'));

  test('an exact look-alike from another environment (same payment id, same invoice id, same amount and currency) is still refused', async () => {
    await expectFlaggedNotAttached(goodNotes({ hc_environment: 'production' }), 'order_environment_mismatch');
  });

  test('a different environment AND different ids is reported as the environment problem (the more specific signal)', () =>
    expectFlaggedNotAttached({ hc_payment_id: '7', hc_invoice_id: '3', hc_environment: 'production' }, 'order_environment_mismatch'));

  test('the background sweep refuses it too: not attached, NOT closed as "never created", counted as uncertain', async () => {
    await timedOut();
    gateway.orders.push(orderFor({ id: 'order_FOREIGN1', notes: goodNotes({ hc_environment: 'production' }) }));
    clock.advance(2 * 60 * SECOND);
    expect(await sweep()).toMatchObject({ checked: 1, attached: 0, closed: 0, uncertain: 1, errors: 0 });
    expect(payments()[0]).toMatchObject({ status: 'pending', razorpayOrderId: null });
    expect(audits('payment.order_failed')).toHaveLength(0); // an order with this receipt exists, so "no such order" would be false
    expect(audits('payment.order_review_required')[0].reasonCode).toBe('order_environment_mismatch');
    expect(gateway.creates()).toHaveLength(1);
  });

  test('the identifier of the OTHER environment is never copied into the audit trail or the log', async () => {
    await timedOut();
    gateway.orders.push(orderFor({ id: 'order_FOREIGN1', notes: goodNotes({ hc_environment: 'production-eu-secret' }) }));
    clock.advance(61 * SECOND);
    await call();
    expect(JSON.stringify([db.state.audits, log.error.mock.calls, log.warn.mock.calls])).not.toContain('production-eu-secret');
  });
});

describe('3. a MISSING environment note is refused', () => {
  test.each([
    ['no hc_environment key', goodNotes({ hc_environment: undefined })],
    ['hc_environment null', goodNotes({ hc_environment: null })],
    ['hc_environment as a number', goodNotes({ hc_environment: 1 })],
    ['hc_environment as a list', goodNotes({ hc_environment: ['test'] })],
    ['hc_environment as an object', goodNotes({ hc_environment: { id: 'test' } })],
    ['only the payment and invoice notes (an order made before environments existed)', { hc_payment_id: '1', hc_invoice_id: '1' }],
  ])('%s: flagged order_environment_missing, not attached, nothing created', (_label, notes) => {
    const clean = { ...notes }; for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
    return expectFlaggedNotAttached(clean, 'order_environment_missing');
  });
});

describe('4. a MISSING payment or invoice note is refused', () => {
  test.each([
    ['no notes at all', undefined],
    ['null notes', null],
    ['empty notes', {}],
    ['no payment id', { hc_invoice_id: '1', hc_environment: THIS_ENV }],
    ['no invoice id', { hc_payment_id: '1', hc_environment: THIS_ENV }],
    ['only the environment', { hc_environment: THIS_ENV }],
    ['notes as a list', ['1', '1', THIS_ENV]],
    ['the payment id as a number', { hc_payment_id: 1, hc_invoice_id: '1', hc_environment: THIS_ENV }],
    ['the invoice id as a number', { hc_payment_id: '1', hc_invoice_id: 1, hc_environment: THIS_ENV }],
    ['both ids null', { hc_payment_id: null, hc_invoice_id: null, hc_environment: THIS_ENV }],
    ['unrelated notes only', { customer: 'someone' }],
  ])('%s: flagged order_notes_missing, not attached, nothing created', (label, notes) => expectFlaggedNotAttached(notes === undefined ? undefined : notes, 'order_notes_missing', { raw: notes === undefined }));
});

describe('5. PADDED or MALFORMED values are refused', () => {
  test.each([
    ['a padded payment id "1 "', goodNotes({ hc_payment_id: '1 ' }), 'order_notes_mismatch'],
    ['a left-padded payment id " 1"', goodNotes({ hc_payment_id: ' 1' }), 'order_notes_mismatch'],
    ['a zero-padded payment id "01"', goodNotes({ hc_payment_id: '01' }), 'order_notes_mismatch'],
    ['a payment id written "1.0"', goodNotes({ hc_payment_id: '1.0' }), 'order_notes_mismatch'],
    ['a payment id written "1e0"', goodNotes({ hc_payment_id: '1e0' }), 'order_notes_mismatch'],
    ['the receipt in place of the payment id "HCP1"', goodNotes({ hc_payment_id: 'HCP1' }), 'order_notes_mismatch'],
    ['an empty payment id', goodNotes({ hc_payment_id: '' }), 'order_notes_mismatch'],
    ['a padded invoice id "1 "', goodNotes({ hc_invoice_id: '1 ' }), 'order_notes_mismatch'],
    ['a zero-padded invoice id "01"', goodNotes({ hc_invoice_id: '01' }), 'order_notes_mismatch'],
    ['another payment id', goodNotes({ hc_payment_id: '99' }), 'order_notes_mismatch'],
    ['another invoice id', goodNotes({ hc_invoice_id: '2' }), 'order_notes_mismatch'],
    ['a different payment and invoice (a look-alike from this environment)', goodNotes({ hc_payment_id: '7', hc_invoice_id: '3' }), 'order_notes_mismatch'],
    ['a padded environment "test "', goodNotes({ hc_environment: 'test ' }), 'order_environment_mismatch'],
    ['a left-padded environment " test"', goodNotes({ hc_environment: ' test' }), 'order_environment_mismatch'],
    ['an environment with a suffix "test-1"', goodNotes({ hc_environment: 'test-1' }), 'order_environment_mismatch'],
    ['an empty environment', goodNotes({ hc_environment: '' }), 'order_environment_mismatch'],
  ])('%s: refused with %s... not attached, nothing created', (_label, notes, reason) => expectFlaggedNotAttached(notes, reason));
});

describe('refusals never loosen: amount, multiple orders, repair', () => {
  test('matching notes with the wrong AMOUNT is still refused (the existing check is kept)', async () => {
    await timedOut();
    gateway.orders.push(orderFor({ id: 'order_WRONGAMT', amount: 1 }));
    clock.advance(61 * SECOND);
    expect((await call()).outcome).toBe('uncertain');
    expect(audits('payment.order_review_required')[0].reasonCode).toBe('order_mismatch');
    expect(payments()[0].razorpayOrderId).toBeNull();
  });

  test('the identity check comes before the amount check: a foreign order with a wrong amount is reported as an environment problem', async () => {
    await timedOut();
    gateway.orders.push(orderFor({ id: 'order_FOREIGN2', amount: 1, notes: goodNotes({ hc_environment: 'production' }) }));
    clock.advance(61 * SECOND);
    await call();
    expect(audits('payment.order_review_required')[0].reasonCode).toBe('order_environment_mismatch');
  });

  test('two orders with the receipt, even if one of them matches all three notes: manual review, nothing attached, nothing created', async () => {
    await timedOut();
    gateway.orders.push(orderFor({ id: 'order_MINE1' }), orderFor({ id: 'order_FOREIGN3', notes: goodNotes({ hc_environment: 'production' }) }));
    clock.advance(61 * SECOND);
    expect((await call()).outcome).toBe('uncertain');
    expect(payments()[0].razorpayOrderId).toBeNull();
    expect(audits('payment.order_review_required')[0].reasonCode).toBe('multiple_orders');
    expect(gateway.creates()).toHaveLength(1);
  });

  test('after Operations repair the order (its notes now match) the next retry attaches it', async () => {
    await timedOut();
    const foreign = orderFor({ id: 'order_FIXED1', notes: goodNotes({ hc_environment: 'production' }) });
    gateway.orders.push(foreign);
    clock.advance(61 * SECOND);
    expect((await call()).outcome).toBe('uncertain');
    foreign.notes = goodNotes();
    clock.advance(61 * SECOND);
    expect((await call()).outcome).toBe('ok');
    expect(payments()[0].razorpayOrderId).toBe('order_FIXED1');
  });

  test('the discrepancy is reported without any secret, note content or database detail', async () => {
    await timedOut();
    gateway.orders.push(orderFor({ id: 'order_FOREIGN1', notes: goodNotes({ hc_payment_id: '7', customer: 'Asha Rao +971501234567' }) }));
    clock.advance(61 * SECOND);
    await call();
    expect(JSON.stringify([db.state.audits, log.error.mock.calls, log.warn.mock.calls])).not.toMatch(new RegExp(`${SECRET}|Asha|971501234567|Basic `));
  });

  test('the one-minute recovery spacing is preserved: a retry inside the window does not even look the order up', async () => {
    await timedOut();
    gateway.orders.push(orderFor({ id: 'order_FOREIGN1', notes: goodNotes({ hc_environment: 'production' }) }));
    clock.advance(61 * SECOND);
    await call(); // flagged; the claim moved updated_at
    const lookups = gateway.calls.filter((c) => c.url.includes('receipt=')).length;
    clock.advance(30 * SECOND);
    expect((await call()).outcome).toBe('uncertain');
    expect(gateway.calls.filter((c) => c.url.includes('receipt=')).length).toBe(lookups); // no new lookup inside the window
    clock.advance(31 * SECOND);
    await call();
    expect(gateway.calls.filter((c) => c.url.includes('receipt=')).length).toBe(lookups + 1);
  });
});

describe('7. an ambiguous lookup stays recoverable, without duplicate orders', () => {
  test('when the receipt lookup keeps failing nothing is attached, closed or created; once it works the order is found and attached', async () => {
    gateway.modes = ['lost']; // the order exists at Razorpay, with all three notes
    await call();
    gateway.listMode = 'error';
    for (let i = 0; i < 3; i += 1) { clock.advance(61 * SECOND); expect((await call()).outcome).toBe('uncertain'); }
    expect(payments()[0]).toMatchObject({ status: 'pending', razorpayOrderId: null });
    expect(gateway.creates()).toHaveLength(1);
    expect(audits('payment.order_failed')).toHaveLength(0);
    gateway.listMode = 'ok';
    clock.advance(61 * SECOND);
    const resolved = await call();
    expect(resolved.outcome).toBe('ok');
    expect(resolved.payload.razorpay.orderId).toBe(gateway.orders[0].id);
    expect(gateway.creates()).toHaveLength(1); // and still no second order
    expect(gateway.orders).toHaveLength(1);
  });

  test('a refused (mismatched) order followed by a failing lookup never leads to a replacement order', async () => {
    await timedOut();
    gateway.orders.push(orderFor({ id: 'order_FOREIGN1', notes: goodNotes({ hc_environment: 'production' }) }));
    clock.advance(61 * SECOND);
    await call();
    gateway.listMode = 'error';
    clock.advance(61 * SECOND);
    expect((await call()).outcome).toBe('uncertain');
    gateway.listMode = 'ok';
    clock.advance(61 * SECOND);
    expect((await call()).outcome).toBe('uncertain'); // still the foreign order: still refused
    expect(gateway.creates()).toHaveLength(1);
    expect(payments()[0].razorpayOrderId).toBeNull();
  });

  test('only a confirmed "no such order" ever leads to a new one, and that new order carries all three notes', async () => {
    await timedOut(); // nothing was created
    clock.advance(61 * SECOND);
    const result = await call();
    expect(result.outcome).toBe('ok');
    expect(gateway.creates()).toHaveLength(2);
    expect(gateway.orders[0].notes).toEqual({ hc_payment_id: '1', hc_invoice_id: '1', hc_environment: THIS_ENV });
  });

  test('a client retry racing the sweep on a foreign order: neither attaches, neither creates', async () => {
    await timedOut();
    gateway.orders.push(orderFor({ id: 'order_FOREIGN1', notes: goodNotes({ hc_environment: 'production' }) }));
    clock.advance(61 * SECOND);
    const [clientResult, counts] = await Promise.all([call(), sweep()]);
    expect(clientResult.outcome).toBe('uncertain');
    expect(counts).toMatchObject({ attached: 0, closed: 0 });
    expect(gateway.creates()).toHaveLength(1);
    expect(payments()[0].razorpayOrderId).toBeNull();
  });
});

describe('8. the receipt format is unchanged', () => {
  test('the order is created with receipt HCP<paymentId>, and recovery looks it up by exactly that receipt', async () => {
    gateway.modes = ['lost'];
    await call();
    const [create] = gateway.creates();
    expect(JSON.parse(create.init.body).receipt).toBe('HCP1');
    expect(JSON.parse(create.init.body).receipt).toBe(service.receiptOf(payments()[0].id));
    clock.advance(61 * SECOND);
    await call();
    const lookup = gateway.calls.find((c) => c.url.includes('receipt='));
    expect(lookup.url).toBe('https://api.razorpay.com/v1/orders?receipt=HCP1&count=10');
  });

  test('the receipt is exactly "HCP" and the decimal payment id, for any payment id', () => {
    for (const id of [1, 9, 10, 123456, 2147483647]) expect(service.receiptOf(id)).toBe(`HCP${id}`);
  });

  test('the environment is NOT in the receipt: it lives in the notes only', async () => {
    await call();
    expect(JSON.parse(gateway.creates()[0].init.body).receipt).not.toMatch(/test|staging|production/i);
  });
});

describe('9. a duplicate Razorpay order id (unique index, Prisma P2002) is still handled safely', () => {
  const holder = (over = {}) => ({
    id: 5, invoiceId: 2, caseId: 11, currency: 'INR', kind: 'payment', amount: '1500.00', status: 'pending', method: 'razorpay', razorpayOrderId: 'order_TAKEN1',
    externalReference: null, idempotencyKey: 'rzp-order:other-key-0000001', createdAt: new Date('2026-11-20T09:00:00Z'), updatedAt: new Date('2026-11-20T09:00:00Z'), ...over,
  });
  // The seeded holder row takes payment id 5, so the payment under test is id 6: its receipt is HCP6 and its notes name payment 6 / invoice 1.
  const mine = (over = {}) => orderFor({ receipt: 'HCP6', notes: goodNotes({ hc_payment_id: '6' }), ...over });
  const otherInvoice = () => makeInvoice({ id: 2, caseId: 11, case: { id: 11, status: 'in_progress', closedAt: null, serviceRequest: { userId: 8, serviceKey: 'privatecharter' } } });

  test('recovery: the fully matching order is NOT attached when its id is already on another payment; "retry later", never a raw error; Operations are told', async () => {
    setup([holder()], [makeInvoice(), otherInvoice()]);
    await timedOut();
    gateway.orders.push(mine({ id: 'order_TAKEN1' }));
    clock.advance(61 * SECOND);
    const result = await call(); // resolves: no exception reaches the caller
    expect(result.outcome).toBe('uncertain');
    expect(payments().find((p) => p.invoiceId === 1).razorpayOrderId).toBeNull();
    expect(payments().find((p) => p.id === 5).razorpayOrderId).toBe('order_TAKEN1'); // the other payment is untouched
    const flags = audits('payment.order_review_required');
    expect(flags).toHaveLength(1);
    expect(flags[0].reasonCode).toBe('order_id_already_attached');
    expect(flags[0].afterData.razorpayOrderId).toBe('order_TAKEN1');
    expect(audits('payment.order_recovered')).toHaveLength(0);
    expect(gateway.creates()).toHaveLength(1); // no new order was created to "work around" it
  });

  test('the sweep handles it quietly: counted as uncertain, not as an error, and the row is not closed', async () => {
    setup([holder()], [makeInvoice(), otherInvoice()]);
    await timedOut();
    gateway.orders.push(mine({ id: 'order_TAKEN1' }));
    clock.advance(2 * 60 * SECOND);
    const loggedBefore = log.error.mock.calls.length; // (the setup's own timed-out create logged one line)
    const counts = await sweep();
    expect(counts).toMatchObject({ checked: 1, attached: 0, closed: 0, uncertain: 1, errors: 0 });
    expect(log.error.mock.calls.length).toBe(loggedBefore);
    expect(audits('payment.order_failed')).toHaveLength(0);
  });

  test('our own create returning an order id already in use is handled the same way: uncertain, flagged, nothing attached, no raw error', async () => {
    setup([holder({ razorpayOrderId: 'order_FAKE1' })], [makeInvoice(), otherInvoice()]); // the fake gateway's first id is order_FAKE1
    const result = await call();
    expect(result.outcome).toBe('uncertain');
    expect(payments().find((p) => p.invoiceId === 1).razorpayOrderId).toBeNull();
    expect(audits('payment.order_review_required')[0].reasonCode).toBe('order_id_already_attached');
    expect(gateway.creates()).toHaveLength(1);
  });

  test('no database detail, constraint name or secret reaches the caller, the log or the audit rows', async () => {
    setup([holder()], [makeInvoice(), otherInvoice()]);
    await timedOut();
    gateway.orders.push(mine({ id: 'order_TAKEN1' }));
    clock.advance(61 * SECOND);
    const result = await call();
    const seen = JSON.stringify([result, log.error.mock.calls, log.warn.mock.calls, db.state.audits]);
    expect(seen).not.toMatch(/Unique constraint|P2002|razorpay_order_id_key|payments_|prisma|SELECT|UPDATE/i);
    expect(seen).not.toContain(SECRET);
  });

  test('repeated retries keep answering "retry later" and still never create a second order', async () => {
    setup([holder()], [makeInvoice(), otherInvoice()]);
    await timedOut();
    gateway.orders.push(mine({ id: 'order_TAKEN1' }));
    for (let i = 0; i < 3; i += 1) { clock.advance(61 * SECOND); expect((await call()).outcome).toBe('uncertain'); }
    expect(gateway.creates()).toHaveLength(1);
    expect(audits('payment.order_review_required')).toHaveLength(1); // flagged once
  });

  test('a duplicate is only when the id is on ANOTHER row: re-attaching the same order to the same row is a harmless no-op', async () => {
    await timedOut();
    gateway.orders.push(orderFor());
    clock.advance(61 * SECOND);
    await call();
    expect(payments()[0].razorpayOrderId).toBe('order_FOUND1');
    expect((await call()).created).toBe(false); // a replay of the attached order
    expect(audits('payment.order_review_required')).toHaveLength(0);
  });

  test('an order that fails the environment check is refused BEFORE the duplicate check is ever reached', async () => {
    setup([holder()], [makeInvoice(), otherInvoice()]);
    await timedOut();
    gateway.orders.push(mine({ id: 'order_TAKEN1', notes: goodNotes({ hc_payment_id: '6', hc_environment: 'production' }) }));
    clock.advance(61 * SECOND);
    await call();
    expect(audits('payment.order_review_required')[0].reasonCode).toBe('order_environment_mismatch');
    expect(db.payment.updateMany.mock.calls.some(([arg]) => arg.data && arg.data.razorpayOrderId === 'order_TAKEN1')).toBe(false); // no attach was even attempted
  });
});
