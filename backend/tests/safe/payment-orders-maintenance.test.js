/* global describe, test, expect, jest, beforeEach, afterEach */
// W7: the background recovery / timeout sweeps and the scheduled job (disabled switch, error handling, retry), and a client retry racing the
// background recovery on the SAME payment row. The real service and store run over the in-memory database (transactions serialised like the
// invoice lock) and a fake Razorpay behind an injected fetch. No network, no MySQL (the real-MySQL versions are in tests/integration).
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
const service = require('../../src/modules/payments/payment-orders.service');
const job = require('../../src/jobs/payment-order-recovery.job');
const { createJobRunner } = require('../../src/jobs/job-runner');
const kit = require('./payments-test-kit');

const { ENV, SECRET, clock, makeInvoice, makeDb, makeGateway, silentLog, KEY } = kit;
const MIN = 60 * 1000;
const LEAK = 'LEAKY_DB_DETAIL postgres://user:pa55@host/db 1500.00 rzp_test_';

let db; let gateway; let log;
const setup = (payments = []) => { db = makeDb({ invoices: [makeInvoice()], payments }); gateway = makeGateway(); log = silentLog(); };
const call = (over = {}) => service.createPaymentOrder({
  userId: 7, invoiceId: '1', idempotencyKey: KEY(1), body: { mode: 'full' }, db, env: ENV, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log, ...over,
});
const sweep = (over = {}) => service.recoverPendingOrders({ db, env: ENV, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log, ...over });
const timeout = (over = {}) => service.closeStaleOrders({ db, env: ENV, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log, ...over });
const payments = () => db.state.payments;
const audits = (action) => db.state.audits.filter((a) => (action ? a.action === action : true));
const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const ticks = async (n) => { for (let i = 0; i < n; i += 1) await tick(); };
const seeded = (over = {}) => ({
  id: 1, invoiceId: 1, caseId: 10, currency: 'INR', kind: 'payment', amount: '1500.00', status: 'pending', method: 'razorpay', razorpayOrderId: null,
  externalReference: null, idempotencyKey: `${service.KEY_PREFIX}${KEY(1)}`, createdAt: clock.now(), updatedAt: clock.now(), ...over,
});
// An order as Razorpay returns it, carrying the identifying notes our own create call sets (payment id = the receipt's number, invoice 1).
const order = (id, over = {}) => {
  const base = { id: `order_${id}`, entity: 'order', amount: 150000, currency: 'INR', receipt: `HCP${id === 'T2' ? 2 : 1}`, status: 'created', amount_paid: 0, attempts: 0, ...over };
  return { notes: { hc_payment_id: base.receipt.replace('HCP', ''), hc_invoice_id: '1', hc_environment: 'test' }, ...base };
};
const everythingLogged = () => JSON.stringify([log.error.mock.calls, log.warn.mock.calls, log.log.mock.calls, db.state.audits]);

beforeEach(() => { clock.t = Date.parse('2026-11-20T10:00:00.000Z'); setup(); });

// ---- 1. the disabled switch -----------------------------------------------------------------------------------------------------

describe('with PAYMENTS_ENABLED not exactly "true" the background work does nothing', () => {
  const OFF = [undefined, '', 'false', 'FALSE', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true '];
  const withPending = () => {
    setup([
      seeded({ id: 1 }), // pending, no order: a recovery candidate
      seeded({ id: 2, razorpayOrderId: 'order_OPEN2', idempotencyKey: 'k2' }), // pending with an order: a timeout candidate
    ]);
    clock.advance(2 * 60 * MIN); // two hours later: both are long overdue for attention
    gateway.orders.push(order('OPEN2', { receipt: 'HCP2' }));
  };
  const nothingHappened = (before) => {
    expect(gateway.fetchImpl).not.toHaveBeenCalled(); // no Razorpay call
    expect(db.txCount).toBe(0); // no transaction
    expect(db.payment.findMany).not.toHaveBeenCalled(); // not even a look at the table
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(db.state.payments).toEqual(before); // nothing closed, attached or changed
    expect(db.state.audits).toEqual([]);
  };

  test.each(OFF)('recoverPendingOrders performs no recovery (switch %p)', async (value) => {
    withPending();
    const before = structuredClone(payments());
    expect(await sweep({ env: { ...ENV, PAYMENTS_ENABLED: value } })).toEqual({ skipped: true });
    nothingHappened(before);
  });

  test.each(OFF)('closeStaleOrders performs no cleanup (switch %p)', async (value) => {
    withPending();
    const before = structuredClone(payments());
    expect(await timeout({ env: { ...ENV, PAYMENTS_ENABLED: value } })).toEqual({ skipped: true });
    nothingHappened(before);
  });

  test('runPaymentOrderMaintenance (what the job runs) skips both', async () => {
    withPending();
    const before = structuredClone(payments());
    const result = await service.runPaymentOrderMaintenance({ db, env: { ...ENV, PAYMENTS_ENABLED: 'no' }, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log });
    expect(result).toEqual({ recovered: { skipped: true }, closed: { skipped: true } });
    nothingHappened(before);
  });

  test('unusable credentials skip as well, even with the switch on (and a live key in a test run)', async () => {
    withPending();
    const before = structuredClone(payments());
    for (const env of [{ ...ENV, RAZORPAY_KEY_SECRET: '' }, { ...ENV, RAZORPAY_KEY_ID: undefined }, { ...ENV, RAZORPAY_KEY_ID: 'rzp_live_FAKEKEY123456' }]) {
      expect(await sweep({ env })).toEqual({ skipped: true });
      expect(await timeout({ env })).toEqual({ skipped: true });
    }
    nothingHappened(before);
  });

  test('sanity: with the switch on and valid test credentials the very same rows ARE handled', async () => {
    withPending();
    gateway.orders.push(order('T1', { receipt: 'HCP1' }));
    expect(await sweep()).toMatchObject({ checked: 1, attached: 1 });
    // Row 1 was only just attached (its updated_at is fresh), so only the old row 2 is a timeout candidate; it is unused at the gateway.
    expect(await timeout()).toMatchObject({ checked: 1, closed: 1 });
    expect(payments().find((p) => p.id === 2).status).toBe('cancelled');
    expect(payments().find((p) => p.id === 1).status).toBe('pending');
    expect(gateway.fetchImpl).toHaveBeenCalled();
  });
});

describe('the scheduled job', () => {
  let savedEnv; let fetchSpy; let savedFetch;
  beforeEach(() => {
    savedEnv = { PAYMENTS_ENABLED: process.env.PAYMENTS_ENABLED, RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET };
    savedFetch = global.fetch;
    fetchSpy = jest.fn(async () => { throw new Error('the network must not be used'); });
    global.fetch = fetchSpy;
    Object.assign(process.env, { RAZORPAY_KEY_ID: kit.KEY_ID, RAZORPAY_KEY_SECRET: SECRET });
  });
  afterEach(() => {
    global.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  test('is a one-minute job, not run at start, and is registered exactly once in the job list', () => {
    expect(job).toMatchObject({ name: 'payment-order-recovery', intervalMs: 60 * 1000, runOnStart: false });
    expect(typeof job.run).toBe('function');
    const { jobs } = require('../../src/jobs');
    expect(jobs.filter((j) => j.name === 'payment-order-recovery')).toHaveLength(1);
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
  });

  test.each([undefined, '', 'false', 'TRUE', '1'])('job.run does no work and makes no Razorpay call when PAYMENTS_ENABLED is %p', async (value) => {
    if (value === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = value;
    // The module's database client is a mock that is an empty object, so any database use would throw: the job must not touch it.
    expect(await job.run()).toEqual({ recovered: { skipped: true }, closed: { skipped: true } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('with the switch on but no credentials it still does no work', async () => {
    process.env.PAYMENTS_ENABLED = 'true';
    delete process.env.RAZORPAY_KEY_SECRET;
    expect(await job.run()).toEqual({ recovered: { skipped: true }, closed: { skipped: true } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---- 2. error handling and retry ------------------------------------------------------------------------------------------------

describe('recovery errors are handled safely and a later run retries', () => {
  const leaky = () => new Error(`${LEAK} ${SECRET}`);

  test('a failure on one row is counted and logged as a short code only; the other rows are still handled', async () => {
    setup([seeded({ id: 1 }), seeded({ id: 2, idempotencyKey: 'k2' })]);
    gateway.orders.push(order('T2', { receipt: 'HCP2' }));
    clock.advance(2 * MIN);
    const real = db.payment.updateMany.getMockImplementation();
    db.payment.updateMany.mockImplementationOnce(async () => { throw Object.assign(leaky(), { name: 'PrismaClientKnownRequestError' }); });
    const counts = await sweep();
    expect(counts).toMatchObject({ checked: 2, errors: 1, attached: 1 });
    expect(payments().find((p) => p.id === 2).razorpayOrderId).toBe('order_T2'); // the healthy row was recovered
    expect(log.error.mock.calls.map((c) => c.join(' '))).toEqual(['[payments] recovery failed: PrismaClientKnownRequestError']);
    expect(everythingLogged()).not.toMatch(/LEAKY_DB_DETAIL|postgres:|pa55|1500\.00|rzp_test_/);
    expect(everythingLogged()).not.toContain(SECRET);
    db.payment.updateMany.mockImplementation(real);
  });

  test('the failed row is neither lost nor closed: it stays pending and the NEXT run recovers it', async () => {
    setup([seeded({ id: 1 })]);
    gateway.orders.push(order('T1', { receipt: 'HCP1' }));
    clock.advance(2 * MIN);
    db.payment.updateMany.mockImplementationOnce(async () => { throw leaky(); });
    expect(await sweep()).toMatchObject({ errors: 1, attached: 0, closed: 0 });
    expect(payments()[0]).toMatchObject({ status: 'pending', razorpayOrderId: null });
    expect(audits('payment.order_failed')).toHaveLength(0); // nothing was closed on the strength of an error
    expect(await sweep()).toMatchObject({ errors: 0, attached: 1 }); // no waiting needed: the failed claim changed nothing
    expect(payments()[0].razorpayOrderId).toBe('order_T1');
    expect(gateway.creates()).toHaveLength(0);
  });

  test('a database failure AFTER the claim (while attaching) leaves the order recoverable and never creates a second one', async () => {
    setup([seeded({ id: 1 })]);
    gateway.orders.push(order('T1', { receipt: 'HCP1' }));
    clock.advance(2 * MIN);
    const real = db.$transaction;
    db.$transaction = jest.fn().mockRejectedValueOnce(leaky()).mockImplementation(real);
    expect(await sweep()).toMatchObject({ checked: 1, errors: 1 });
    expect(payments()[0]).toMatchObject({ status: 'pending', razorpayOrderId: null });
    expect(await sweep()).toMatchObject({ checked: 0 }); // the claim just moved updated_at: one minute must pass first
    clock.advance(61 * 1000);
    expect(await sweep()).toMatchObject({ attached: 1, errors: 0 }); // found again by its receipt
    expect(payments()[0].razorpayOrderId).toBe('order_T1');
    expect(gateway.orders).toHaveLength(1);
    expect(gateway.creates()).toHaveLength(0);
    expect(everythingLogged()).not.toMatch(/LEAKY_DB_DETAIL|pa55|1500\.00/);
  });

  test('an unexpected gateway failure (an error carrying secrets) is "uncertain": nothing is closed or created, nothing is logged, a later run succeeds', async () => {
    setup([seeded({ id: 1 })]);
    gateway.orders.push(order('T1', { receipt: 'HCP1' }));
    clock.advance(2 * MIN);
    const healthy = gateway.fetchImpl.getMockImplementation();
    gateway.fetchImpl.mockImplementationOnce(async () => { throw Object.assign(leaky(), { code: 'ECONNRESET' }); });
    expect(await sweep()).toMatchObject({ checked: 1, uncertain: 1, closed: 0, attached: 0 });
    expect(payments()[0].status).toBe('pending');
    expect(gateway.creates()).toHaveLength(0);
    expect(everythingLogged()).not.toMatch(/LEAKY_DB_DETAIL|pa55|1500\.00/);
    expect(everythingLogged()).not.toContain(SECRET);
    gateway.fetchImpl.mockImplementation(healthy);
    clock.advance(61 * 1000);
    expect(await sweep()).toMatchObject({ attached: 1 });
    expect(payments()[0].razorpayOrderId).toBe('order_T1');
  });

  test('timeout sweep: a failure while closing keeps the order pending, is logged as a code only, and the next run closes it', async () => {
    setup([seeded({ id: 1, razorpayOrderId: 'order_OPEN1' })]);
    gateway.orders.push(order('OPEN1', { receipt: 'HCP1' }));
    clock.advance(31 * MIN);
    const real = db.$transaction;
    db.$transaction = jest.fn().mockRejectedValueOnce(Object.assign(leaky(), { publicCode: 'db_unavailable' })).mockImplementation(real);
    expect(await timeout()).toMatchObject({ checked: 1, errors: 1, closed: 0 });
    expect(payments()[0].status).toBe('pending');
    expect(log.error.mock.calls.map((c) => c.join(' '))).toEqual(['[payments] timeout check failed: db_unavailable']);
    expect(everythingLogged()).not.toMatch(/LEAKY_DB_DETAIL|pa55|1500\.00/);
    expect(await timeout()).toMatchObject({ checked: 1, closed: 1 });
    expect(payments()[0].status).toBe('cancelled');
  });

  test('timeout sweep: an unreachable or failing gateway never closes anything', async () => {
    setup([seeded({ id: 1, razorpayOrderId: 'order_OPEN1' })]);
    clock.advance(31 * MIN);
    gateway.fetchImpl.mockImplementation(async () => { throw leaky(); });
    expect(await timeout()).toMatchObject({ checked: 1, left: 1, closed: 0 });
    expect(payments()[0].status).toBe('pending');
    expect(everythingLogged()).not.toMatch(/LEAKY_DB_DETAIL|pa55/);
  });

  test('a failure of the whole sweep (the listing) propagates to the job runner, and the SCHEDULE survives: the next tick runs again and succeeds', async () => {
    jest.useFakeTimers();
    try {
      setup([seeded({ id: 1 })]);
      gateway.orders.push(order('T1', { receipt: 'HCP1' }));
      clock.t += 2 * MIN;
      let first = true;
      const real = db.payment.findMany.getMockImplementation();
      db.payment.findMany.mockImplementation(async (args) => { if (first) { first = false; throw new Error('listing failed'); } return real(args); });
      const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn(), info: jest.fn() };
      const runner = createJobRunner([{ ...job, run: () => service.runPaymentOrderMaintenance({ db, env: ENV, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log }) }], { logger });
      runner.start();
      await jest.advanceTimersByTimeAsync(60 * 1000); // tick 1: fails
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(payments()[0]).toMatchObject({ status: 'pending', razorpayOrderId: null }); // nothing lost, nothing closed
      await jest.advanceTimersByTimeAsync(60 * 1000); // tick 2: retries
      await runner.stop();
      expect(payments()[0].razorpayOrderId).toBe('order_T1');
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // Formerly a KNOWN GAP (job-runner.js logged `err.message`; a Prisma error message can quote the query and its values). The runner now logs
  // the job name and a short error code only. The per-row failures above were already safe; this is the whole-sweep failure path.
  test('a whole-sweep failure puts no raw error message (credentials, payment data) into the job runner log: only the job name and a short code', async () => {
    jest.useFakeTimers();
    try {
      setup([seeded({ id: 1 })]);
      db.payment.findMany.mockImplementation(async () => { throw new Error(`${LEAK} ${SECRET}`); });
      const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn(), info: jest.fn() };
      const runner = createJobRunner([{ ...job, run: () => service.runPaymentOrderMaintenance({ db, env: ENV, fetchImpl: gateway.fetchImpl, now: () => clock.now(), log }) }], { logger });
      runner.start();
      await jest.advanceTimersByTimeAsync(60 * 1000);
      await runner.stop();
      expect(logger.error.mock.calls).toEqual([['[jobs] "payment-order-recovery" failed: Error']]); // the job name and a short code, nothing else
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/LEAKY_DB_DETAIL|pa55|1500\.00/);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(SECRET);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---- 3. a client retry racing the background recovery ---------------------------------------------------------------------------

describe('a client retry racing the background recovery on the same payment row', () => {
  // Every gateway call yields to the event loop, so the two actors really interleave.
  const interleave = () => { gateway.hooks.onCall = () => tick(); };
  const first = async (mode) => { gateway.modes = [mode]; const r = await call(); expect(r.outcome).toBe('uncertain'); clock.advance(61 * 1000); };

  // Whatever the interleaving, these must hold.
  const invariants = () => {
    expect(payments()).toHaveLength(1); // never a second payment row
    expect(gateway.orders.length).toBeLessThanOrEqual(1); // never a second payable order
    const row = payments()[0];
    if (row.razorpayOrderId) { // attached to the CORRECT row: the order's receipt and notes name this very payment
      const attached = gateway.orders.find((o) => o.id === row.razorpayOrderId);
      expect(attached).toBeDefined();
      expect(attached.receipt).toBe(`HCP${row.id}`);
      expect(attached.notes).toEqual({ hc_payment_id: String(row.id), hc_invoice_id: String(row.invoiceId), hc_environment: 'test' });
      expect(row.status).toBe('pending');
    } else {
      expect(['pending', 'failed']).toContain(row.status);
      if (row.status === 'failed') expect(gateway.orders).toHaveLength(0); // closed only because Razorpay confirmed there was no order
    }
  };
  const replayIsStable = async () => { // idempotency stays intact: the same key never produces another order
    const before = gateway.orders.length;
    const again = await call();
    expect(gateway.orders.length).toBe(before);
    if (again.outcome === 'ok' && again.payload.razorpay) expect(again.payload.razorpay.orderId).toBe(payments()[0].razorpayOrderId);
    return again;
  };

  const DELAYS = [0, 1, 2, 3, 4, 6, 9];

  test.each(DELAYS)('nothing was created at Razorpay (the first call timed out); client and sweep start %i ticks apart, both orders of arrival', async (delay) => {
    for (const clientFirst of [true, false]) {
      setup(); interleave();
      await first('timeout');
      const client = async () => { if (!clientFirst) await ticks(delay); return call(); };
      const background = async () => { if (clientFirst) await ticks(delay); return sweep(); };
      const [clientResult] = await Promise.all([client(), background()]);
      invariants();
      expect(['ok', 'uncertain']).toContain(clientResult.outcome);
      expect(gateway.creates().length).toBeLessThanOrEqual(2); // the first (timed out) + at most one more
      await replayIsStable();
      invariants();
    }
  });

  test.each(DELAYS)('the order DOES exist at Razorpay (the first answer was lost); %i ticks apart, both orders of arrival: it is found, attached once, never duplicated', async (delay) => {
    for (const clientFirst of [true, false]) {
      setup(); interleave();
      await first('lost');
      const client = async () => { if (!clientFirst) await ticks(delay); return call(); };
      const background = async () => { if (clientFirst) await ticks(delay); return sweep(); };
      await Promise.all([client(), background()]);
      invariants();
      expect(gateway.orders).toHaveLength(1);
      expect(gateway.creates()).toHaveLength(1); // only the original create: recovery never creates when the order exists
      expect(payments()[0].razorpayOrderId).toBe('order_FAKE1'); // exactly one actor attached it, to the right row
      const again = await replayIsStable();
      expect(again.outcome).toBe('ok');
      expect(again.payload.razorpay.orderId).toBe('order_FAKE1');
    }
  });

  test('exactly one actor wins the claim: the client gets the order or is told to retry, the sweep reports attached or uncertain, never both attach', async () => {
    setup(); interleave();
    await first('lost');
    const [clientResult, counts] = await Promise.all([call(), sweep()]);
    const clientAttached = clientResult.outcome === 'ok';
    expect(counts.attached + (clientAttached ? 1 : 0)).toBe(1);
    expect(audits('payment.order_recovered')).toHaveLength(1);
    invariants();
  });

  test('ambiguous outcomes stay recoverable: when the lookup keeps failing nothing is closed or created, and a later retry resolves it', async () => {
    setup(); interleave();
    await first('timeout');
    gateway.listMode = 'error';
    const [clientResult, counts] = await Promise.all([call(), sweep()]);
    expect(clientResult.outcome).toBe('uncertain');
    expect(counts).toMatchObject({ closed: 0, attached: 0 });
    expect(payments()[0]).toMatchObject({ status: 'pending', razorpayOrderId: null });
    expect(gateway.creates()).toHaveLength(1);
    expect(audits('payment.order_failed')).toHaveLength(0);
    gateway.listMode = 'ok';
    clock.advance(61 * 1000);
    const resolved = await call();
    expect(resolved.outcome).toBe('ok');
    expect(gateway.orders).toHaveLength(1);
    expect((await replayIsStable()).payload.razorpay.orderId).toBe(resolved.payload.razorpay.orderId);
    invariants();
  });

  test('two background workers at once: one claim wins, the order is attached once', async () => {
    setup(); interleave();
    await first('lost');
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(a.attached + b.attached).toBe(1);
    expect(a.uncertain + b.uncertain).toBe(1);
    expect(gateway.orders).toHaveLength(1);
    invariants();
  });

  test('many actors at once (three client retries and two sweeps): still one order, one row, attached to the right payment', async () => {
    setup(); interleave();
    await first('lost');
    const results = await Promise.all([call(), call(), call(), sweep(), sweep()]);
    expect(gateway.orders).toHaveLength(1);
    expect(gateway.creates()).toHaveLength(1);
    invariants();
    expect(payments()[0].razorpayOrderId).toBe('order_FAKE1');
    const [c1, c2, c3, s1, s2] = results;
    for (const r of [c1, c2, c3]) expect(['ok', 'uncertain']).toContain(r.outcome);
    expect([c1, c2, c3].filter((r) => r.outcome === 'ok').length + s1.attached + s2.attached).toBe(1); // exactly one actor attached it
    expect((await replayIsStable()).outcome).toBe('ok');
  });

  test('a recovery that arrives while the original create is still being answered attaches the same order the original request then confirms', async () => {
    setup();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    gateway.hooks.beforeCreateReply = async () => { await held; }; // the order exists at Razorpay; the original answer is still on its way
    const original = call();
    await ticks(8);
    expect(gateway.orders).toHaveLength(1);
    clock.advance(61 * 1000); // the retry arrives after the recovery window
    const retry = await call();
    expect(retry.outcome).toBe('ok');
    expect(retry.payload.razorpay.orderId).toBe('order_FAKE1');
    release();
    const originalResult = await original;
    expect(originalResult.outcome).toBe('ok');
    expect(originalResult.payload.razorpay.orderId).toBe('order_FAKE1'); // the same order: no orphan, no overwrite
    expect(gateway.orders).toHaveLength(1);
    expect(audits('payment.order_orphaned')).toHaveLength(0);
    invariants();
  });

  test('when the sweep closes a row (Razorpay confirmed no order), the client retry that lost the race is told to retry and a NEW key works; nothing is payable twice', async () => {
    setup(); interleave();
    await first('timeout');
    await Promise.all([sweep(), ticks(0).then(() => call())]); // the sweep claims first
    const row = payments()[0];
    if (row.status === 'failed') {
      expect(gateway.orders).toHaveLength(0);
      const fresh = await call({ idempotencyKey: KEY(2) });
      expect(fresh.created).toBe(true);
      expect(gateway.orders).toHaveLength(1);
      expect(payments()).toHaveLength(2);
      expect(payments().filter((p) => p.status === 'pending' && p.razorpayOrderId)).toHaveLength(1);
    } else {
      invariants();
    }
  });
});
