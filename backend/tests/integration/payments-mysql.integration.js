/* global describe, it, expect, beforeAll, afterAll, afterEach, jest */
// Razorpay order creation on REAL MySQL (humancare_test): invoice row locking, concurrent reservation, same-key idempotency, guarded Payment
// updates, the recovery claim on updated_at, and unique-constraint / P2002 handling. Nothing about the database is mocked: the application's
// own store and service functions run against humancare_test through SEPARATE Prisma clients (separate MySQL connections) wherever
// concurrency matters. Only Razorpay is faked (an injected fetch; no network). Only synthetic PAYTEST_<runid> records are written, every id
// is registered, and cleanup deletes those exact ids in reverse foreign-key order (see helpers/payments-fixture.js); a before/after snapshot
// proves nothing else changed. Run: see the npm script / command in the report; it needs HUMANCARE_INTEGRATION_RUN=true.
const guard = require('../../src/common/safety/integration-runner-guard');
const store = require('../../src/modules/payments/payment-orders.store');
const service = require('../../src/modules/payments/payment-orders.service');
const kit = require('../safe/payments-test-kit');
const { PaymentsFixture, sleep } = require('./helpers/payments-fixture');

const fx = new PaymentsFixture();
let main; let c1; let c2; let c3; let baseline; let cleanupReport; let afterSnapshot; let remaining; let gateway; let keyCounter = 0;

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const attempt = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const silent = () => ({ error: jest.fn(), warn: jest.fn(), log: jest.fn(), info: jest.fn() });
const nextKey = () => { keyCounter += 1; return `${fx.runId.padEnd(8, 'X')}-key-${String(keyCounter).padStart(6, '0')}`.slice(0, 40); };
const isDeadlock = (err) => Boolean(err) && (err.code === 'P2034' || /deadlock/i.test(String(err.message || '')));
const later = () => new Date(Date.now() + 61 * 1000); // "one minute from now": the recovery window has passed

// The service under test, on a given connection, with this test's fake Razorpay.
const svc = (client, inv, over = {}) => service.createPaymentOrder({
  userId: inv.userId, invoiceId: String(inv.invoiceId), idempotencyKey: nextKey(), body: { mode: 'full' }, db: client, env: kit.ENV, fetchImpl: gateway.fetchImpl, log: silent(), ...over,
});
const sweepOn = (client, over = {}) => service.recoverPendingOrders({ db: client, env: kit.ENV, fetchImpl: gateway.fetchImpl, log: silent(), ...over });
const paymentsOf = (inv) => main.payment.findMany({ where: { invoiceId: inv.invoiceId }, orderBy: { id: 'asc' } });

// True while ANOTHER connection holds the invoice row's lock (read from the server: SKIP LOCKED returns no row for a locked row).
async function lockedBySomeone(db, invoiceId) {
  const rows = await db.$queryRawUnsafe('SELECT id FROM invoices WHERE id = ? FOR UPDATE SKIP LOCKED', invoiceId);
  return rows.length === 0;
}

beforeAll(async () => {
  guard.assertIntegrationEnvironment(process.env); // opt-in, humancare_test URL, ordinary test rules
  main = fx.newClient('main');
  c1 = fx.newClient('c1'); c2 = fx.newClient('c2'); c3 = fx.newClient('c3');
  const live = await guard.verifyLiveIdentity(main); // the server must say humancare_test, as a confined test account
  expect(live.database).toBe('humancare_test');
  baseline = await fx.snapshot(main);
  // The recovery sweep is set-based over EVERY pending Razorpay payment: it must have nothing but our rows to look at.
  expect(baseline.counts.payments).toBe(0);
  expect(await lockedBySomeone(main, 0)).toBe(true); // (no such row) proves SKIP LOCKED is understood by this server
}, 60000);

afterEach(async () => {
  // Leave no pending payment behind for the next test's sweeps: only this run's own rows, by exact id.
  await fx.registerDiscovered(main);
  for (const id of new Set(fx.ids.payment)) await main.$executeRawUnsafe("UPDATE payments SET status = 'cancelled' WHERE id = ? AND status = 'pending'", id);
});

afterAll(async () => {
  try {
    cleanupReport = await fx.cleanup(main);
    remaining = await fx.remaining(main);
    afterSnapshot = await fx.snapshot(main);
  } finally {
    await fx.disconnectAll();
  }
  expect(cleanupReport.failures).toEqual([]);
  expect(Object.values(remaining).every((n) => n === 0)).toBe(true);
  expect(afterSnapshot.counts).toEqual(baseline.counts); // nothing that existed before was added or removed
  expect(afterSnapshot.checksums).toEqual(baseline.checksums); // and nothing was modified
}, 120000);

let gatewayCounter = 0;
// Fake order ids are unique to this run AND this gateway: payments.razorpay_order_id is unique across the whole table.
const fresh = () => { gatewayCounter += 1; gateway = kit.makeGateway({ orderPrefix: `PT${fx.runId}G${gatewayCounter}x` }); };
const oid = (s) => `order_${fx.runId}${s}`;

describe('invoice row locking', () => {
  it('a held invoice lock blocks a second order reservation until it is released; a stranger takes no lock', async () => {
    fresh();
    const inv = await fx.buildInvoice(main);
    const gate = deferred(); const held = deferred();
    const holder = c1.$transaction(async (tx) => { await store.lockInvoice(tx, inv.invoiceId); held.resolve(); await gate.promise; return 'released'; }, { timeout: 30000, maxWait: 10000 });
    await held.promise;
    expect(await lockedBySomeone(main, inv.invoiceId)).toBe(true); // the server confirms the row is locked by the other connection

    const started = Date.now();
    const stranger = await attempt(svc(c3, inv, { userId: inv.userId + 987654 })); // not the owner: refused BEFORE any lock is requested
    expect(stranger.ok).toBe(false);
    expect(stranger.error.publicCode).toBe('invoice_not_found');
    expect(Date.now() - started).toBeLessThan(1500);

    let settled = false;
    const blocked = svc(c2, inv).then((r) => { settled = true; return r; });
    await sleep(1500);
    expect(settled).toBe(false); // the owner's request is waiting on the invoice lock
    expect(gateway.creates()).toHaveLength(0); // and Razorpay has not been contacted
    expect(await paymentsOf(inv)).toHaveLength(0);

    gate.resolve();
    expect(await holder).toBe('released');
    const result = await blocked;
    expect(result.created).toBe(true);
    expect(result.payload.razorpay.orderId).toBe(gateway.orders[0].id);
    expect(await lockedBySomeone(main, inv.invoiceId)).toBe(false); // every lock is gone
  }, 60000);

  it('no transaction is held open across the Razorpay call: another connection can lock the invoice while the gateway is being called', async () => {
    fresh();
    const inv = await fx.buildInvoice(main);
    let lockedDuringGateway = null;
    gateway.hooks.onCall = async ({ method }) => { if (method === 'POST') lockedDuringGateway = await lockedBySomeone(main, inv.invoiceId); };
    const result = await svc(c1, inv);
    expect(result.created).toBe(true);
    expect(lockedDuringGateway).toBe(false); // phase B holds no lock
  });
});

describe('concurrent order reservation', () => {
  it('eight simultaneous requests with different keys on three connections: exactly one order, the rest open_order_exists, no deadlock', async () => {
    fresh();
    const inv = await fx.buildInvoice(main);
    const clients = [c1, c2, c3];
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => attempt(svc(clients[i % 3], inv))));
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses.map((r) => r.error.publicCode)).toEqual(Array(7).fill('open_order_exists'));
    expect(losses.some((r) => isDeadlock(r.error))).toBe(false);
    const rows = await paymentsOf(inv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'payment', status: 'pending', method: 'razorpay', razorpayOrderId: gateway.orders[0].id });
    expect(gateway.creates()).toHaveLength(1);
    const reserved = await main.$queryRawUnsafe("SELECT COUNT(*) AS n FROM audit_logs WHERE case_id = ? AND action = 'payment.order_reserved'", inv.caseId);
    expect(Number(reserved[0].n)).toBe(1);
  }, 60000);

  it('different keys one after the other: the second is refused while the first order is open', async () => {
    fresh();
    const inv = await fx.buildInvoice(main);
    expect((await svc(c1, inv)).created).toBe(true);
    const second = await attempt(svc(c2, inv));
    expect(second.ok).toBe(false);
    expect(second.error.publicCode).toBe('open_order_exists');
    expect(await paymentsOf(inv)).toHaveLength(1);
    expect(gateway.creates()).toHaveLength(1);
  });

  it('mixed load (creates and recovery sweeps at once) never deadlocks and never makes a second order', async () => {
    for (let round = 0; round < 3; round += 1) {
      fresh();
      const inv = await fx.buildInvoice(main);
      // The sweeps run on the REAL clock: a row created a moment ago is not yet a recovery candidate, exactly as in production. They still
      // take their reads and compete for the same connections and rows while the creates hold the invoice lock.
      const actors = [
        attempt(svc(c1, inv)), attempt(svc(c2, inv)), attempt(svc(c3, inv)), attempt(svc(c1, inv)),
        attempt(sweepOn(c2)), attempt(sweepOn(c3)),
      ];
      const results = await Promise.all(actors);
      expect(results.filter((r) => !r.ok && isDeadlock(r.error))).toEqual([]);
      expect(results.filter((r) => !r.ok && r.error.publicCode !== 'open_order_exists')).toEqual([]);
      expect(gateway.orders.length).toBeLessThanOrEqual(1);
      expect(await paymentsOf(inv)).toHaveLength(1);
    }
  }, 90000);
});

describe('same-key idempotency', () => {
  it('six simultaneous requests with the SAME key: one row, one Razorpay order, every answer names that same order', async () => {
    fresh();
    const inv = await fx.buildInvoice(main);
    const key = nextKey();
    const clients = [c1, c2, c3];
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => attempt(svc(clients[i % 3], inv, { idempotencyKey: key }))));
    expect(results.filter((r) => !r.ok)).toEqual([]); // a replay is never an error
    expect(gateway.creates()).toHaveLength(1);
    const rows = await paymentsOf(inv);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(`rzp-order:${key}`);
    for (const r of results.map((x) => x.value)) {
      expect(['ok', 'uncertain']).toContain(r.outcome);
      if (r.outcome === 'ok') expect(r.payload.razorpay.orderId).toBe(rows[0].razorpayOrderId);
    }
    const replay = await svc(c1, inv, { idempotencyKey: key });
    expect(replay.created).toBe(false);
    expect(replay.payload.razorpay.orderId).toBe(rows[0].razorpayOrderId);
    expect(gateway.creates()).toHaveLength(1);
  }, 60000);

  it('the same key with a different request is a conflict, on real data', async () => {
    fresh();
    const inv = await fx.buildInvoice(main, { allowPartial: true });
    const key = nextKey();
    await svc(c1, inv, { idempotencyKey: key, body: { mode: 'partial', amount: '250.00' } });
    const conflict = await attempt(svc(c2, inv, { idempotencyKey: key, body: { mode: 'full' } }));
    expect(conflict.ok).toBe(false);
    expect(conflict.error.publicCode).toBe('idempotency_conflict');
    expect(await paymentsOf(inv)).toHaveLength(1);
  });
});

describe('guarded Payment updates (real MySQL)', () => {
  const newPending = async (inv) => {
    const row = await store.insertPendingPayment(main, { invoiceId: inv.invoiceId, caseId: inv.caseId, currency: inv.currency, amount: '1500.00', idempotencyKey: `rzp-order:${nextKey()}` });
    fx.track('payment', row.id);
    return row;
  };
  const orderIdOf = async (id) => (await main.payment.findUnique({ where: { id } })).razorpayOrderId;

  it('the order id is set ONCE: a second attach on another connection is refused and the first value stays', async () => {
    const inv = await fx.buildInvoice(main);
    const row = await newPending(inv);
    expect(await store.attachOrderId(main, row.id, oid('PAYTEST1'))).toBe(true);
    expect(await store.attachOrderId(c1, row.id, oid('PAYTEST2'))).toBe(false);
    expect(await orderIdOf(row.id)).toBe(oid('PAYTEST1'));
  });

  it('two simultaneous attaches of different orders: exactly one wins, the other is refused', async () => {
    const inv = await fx.buildInvoice(main);
    const row = await newPending(inv);
    const [a, b] = await Promise.all([store.attachOrderId(c1, row.id, oid('RACEA')), store.attachOrderId(c2, row.id, oid('RACEB'))]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await orderIdOf(row.id)).toBe(a ? oid('RACEA') : oid('RACEB'));
  });

  it('only a pending row can be closed, and only once; a closed row never gets an order id', async () => {
    const inv = await fx.buildInvoice(main);
    const row = await newPending(inv);
    expect(await store.closePending(c1, row.id, 'failed')).toBe(true);
    expect(await store.closePending(c2, row.id, 'cancelled')).toBe(false);
    expect(await store.attachOrderId(main, row.id, oid('PAYTEST3'))).toBe(false);
    const stored = await main.payment.findUnique({ where: { id: row.id } });
    expect(stored).toMatchObject({ status: 'failed', razorpayOrderId: null });
  });

  it('a completed row is never closed or given an order id by these guarded updates', async () => {
    const inv = await fx.buildInvoice(main);
    const row = await newPending(inv);
    await main.$executeRawUnsafe("UPDATE payments SET status = 'completed', transacted_at = NOW(3) WHERE id = ?", row.id); // a synthetic row of this run
    expect(await store.closePending(main, row.id, 'cancelled')).toBe(false);
    expect(await store.attachOrderId(main, row.id, oid('PAYTEST4'))).toBe(false);
    expect((await main.payment.findUnique({ where: { id: row.id } })).status).toBe('completed');
  });

  it('attaching an order refreshes updated_at (the @updatedAt behaviour the timeout relies on)', async () => {
    const inv = await fx.buildInvoice(main);
    const row = await newPending(inv);
    const before = (await main.payment.findUnique({ where: { id: row.id } })).updatedAt;
    await sleep(20);
    await store.attachOrderId(main, row.id, oid('PAYTEST5'));
    const after = (await main.payment.findUnique({ where: { id: row.id } })).updatedAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe('the recovery claim on updated_at (real MySQL)', () => {
  it('three connections claim the same row at once: exactly one gets it, and a stale claim is refused afterwards', async () => {
    const inv = await fx.buildInvoice(main);
    const row = await store.insertPendingPayment(main, { invoiceId: inv.invoiceId, caseId: inv.caseId, currency: inv.currency, amount: '1500.00', idempotencyKey: `rzp-order:${nextKey()}` });
    fx.track('payment', row.id);
    const read = (await main.payment.findUnique({ where: { id: row.id }, select: { updatedAt: true } })).updatedAt; // a JS Date read back from DATETIME(3)
    const claimAt = [new Date(Date.now() + 5000), new Date(Date.now() + 6000), new Date(Date.now() + 7000)];
    const claim = (client, at) => client.payment.updateMany({ where: { id: row.id, status: 'pending', razorpayOrderId: null, updatedAt: read }, data: { updatedAt: at } });
    const counts = (await Promise.all([claim(c1, claimAt[0]), claim(c2, claimAt[1]), claim(c3, claimAt[2])])).map((r) => r.count);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1); // millisecond equality works, and only one connection can win
    const winner = claimAt[counts.indexOf(1)];
    expect((await main.payment.findUnique({ where: { id: row.id } })).updatedAt.getTime()).toBe(winner.getTime()); // exactly what the winner wrote
    expect((await claim(main, new Date(Date.now() + 9000))).count).toBe(0); // the old value no longer matches
  });

  it('a claim never touches a row that already has an order or is no longer pending', async () => {
    const inv = await fx.buildInvoice(main);
    const row = await store.insertPendingPayment(main, { invoiceId: inv.invoiceId, caseId: inv.caseId, currency: inv.currency, amount: '1500.00', idempotencyKey: `rzp-order:${nextKey()}` });
    fx.track('payment', row.id);
    await store.attachOrderId(main, row.id, oid('CLAIM1'));
    const current = (await main.payment.findUnique({ where: { id: row.id } })).updatedAt;
    expect((await main.payment.updateMany({ where: { id: row.id, status: 'pending', razorpayOrderId: null, updatedAt: current }, data: { updatedAt: new Date() } })).count).toBe(0);
  });

  it('a client retry on two connections and the background sweep race for ONE unattached order: only one order exists and it is attached once', async () => {
    fresh();
    const inv = await fx.buildInvoice(main);
    gateway.modes = ['lost']; // Razorpay created the order but the answer was lost
    const first = await svc(c1, inv);
    expect(first.outcome).toBe('uncertain');
    const [row] = await paymentsOf(inv);
    expect(row).toMatchObject({ status: 'pending', razorpayOrderId: null });

    const [r2, r3, swept] = await Promise.all([svc(c2, inv, { idempotencyKey: `${row.idempotencyKey}`.replace('rzp-order:', ''), now: later }), svc(c3, inv, { idempotencyKey: row.idempotencyKey.replace('rzp-order:', ''), now: later }), sweepOn(c1, { now: later })]);
    expect(gateway.orders).toHaveLength(1);
    expect(gateway.creates()).toHaveLength(1); // recovery found it by receipt; nobody created another
    const [after] = await paymentsOf(inv);
    expect(after.razorpayOrderId).toBe(gateway.orders[0].id);
    expect(gateway.orders[0].receipt).toBe(`HCP${after.id}`);
    expect([r2, r3].filter((r) => r.outcome === 'ok').length + swept.attached).toBe(1); // exactly one actor won the claim
    const recovered = await main.$queryRawUnsafe("SELECT COUNT(*) AS n FROM audit_logs WHERE case_id = ? AND action = 'payment.order_recovered'", inv.caseId);
    expect(Number(recovered[0].n)).toBe(1);
  }, 60000);

  it('when Razorpay has no such order, a retry and the sweep never both act: at most one more order, or the row is closed, never both', async () => {
    fresh();
    const inv = await fx.buildInvoice(main);
    gateway.modes = ['timeout']; // nothing was created
    expect((await svc(c1, inv)).outcome).toBe('uncertain');
    const [row] = await paymentsOf(inv);
    const key = row.idempotencyKey.replace('rzp-order:', '');
    await Promise.all([attempt(svc(c2, inv, { idempotencyKey: key, now: later })), attempt(sweepOn(c3, { now: later }))]);
    const [after] = await paymentsOf(inv);
    expect(gateway.orders.length).toBeLessThanOrEqual(1);
    if (after.status === 'failed') expect(gateway.orders).toHaveLength(0);
    if (after.razorpayOrderId) expect(after.razorpayOrderId).toBe(gateway.orders[0].id);
    expect(await paymentsOf(inv)).toHaveLength(1);
  }, 60000);
});

describe('unique constraints and P2002 (real MySQL)', () => {
  const duplicate = async (inv, key) => {
    const base = { invoiceId: inv.invoiceId, caseId: inv.caseId, currency: inv.currency, amount: '1500.00', idempotencyKey: key };
    const first = await store.insertPendingPayment(main, base);
    fx.track('payment', first.id);
    return attempt(store.insertPendingPayment(c1, base));
  };

  it('a second payment with the same (invoice, idempotency key) is refused with Prisma error P2002 naming that index', async () => {
    const inv = await fx.buildInvoice(main);
    const result = await duplicate(inv, `rzp-order:${nextKey()}`);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('P2002');
    expect(String(result.error.meta && result.error.meta.target)).toMatch(/idempotency_key/);
    expect(await paymentsOf(inv)).toHaveLength(1);
  });

  it('the same key on ANOTHER invoice is fine (the key is unique per invoice)', async () => {
    const a = await fx.buildInvoice(main);
    const b = await fx.buildInvoice(main);
    const key = `rzp-order:${nextKey()}`;
    const rowA = await store.insertPendingPayment(main, { invoiceId: a.invoiceId, caseId: a.caseId, currency: a.currency, amount: '1500.00', idempotencyKey: key });
    const rowB = await store.insertPendingPayment(main, { invoiceId: b.invoiceId, caseId: b.caseId, currency: b.currency, amount: '1500.00', idempotencyKey: key });
    fx.track('payment', rowA.id); fx.track('payment', rowB.id);
    expect(rowA.id).not.toBe(rowB.id);
  });

  it('one Razorpay order id can belong to only one payment row (P2002), even across invoices; many NULL order ids are fine', async () => {
    const a = await fx.buildInvoice(main);
    const b = await fx.buildInvoice(main);
    const mk = async (inv) => { const r = await store.insertPendingPayment(main, { invoiceId: inv.invoiceId, caseId: inv.caseId, currency: inv.currency, amount: '1500.00', idempotencyKey: `rzp-order:${nextKey()}` }); fx.track('payment', r.id); return r; };
    const rows = [await mk(a), await mk(b), await mk(a)]; // three rows, all with a NULL order id: no conflict
    expect(await store.attachOrderId(main, rows[0].id, oid('UNIQ1'))).toBe(true);
    const clash = await attempt(store.attachOrderId(c1, rows[1].id, oid('UNIQ1')));
    expect(clash.ok).toBe(false);
    expect(clash.error.code).toBe('P2002');
    expect(String(clash.error.meta && clash.error.meta.target)).toMatch(/razorpay_order_id/);
    expect((await main.payment.findUnique({ where: { id: rows[1].id } })).razorpayOrderId).toBeNull();
  });

  it('the database CHECKs hold on real MySQL: a malformed order id, a refund with an order id and a completed order row without a payment id are refused', async () => {
    const inv = await fx.buildInvoice(main);
    const row = await store.insertPendingPayment(main, { invoiceId: inv.invoiceId, caseId: inv.caseId, currency: inv.currency, amount: '1500.00', idempotencyKey: `rzp-order:${nextKey()}` });
    fx.track('payment', row.id);
    const bad = (sql, ...p) => attempt(main.$executeRawUnsafe(sql, ...p));
    expect((await bad("UPDATE payments SET razorpay_order_id = 'pay_NOTANORDER' WHERE id = ?", row.id)).ok).toBe(false);
    expect((await bad("UPDATE payments SET razorpay_order_id = ?, status = 'completed', transacted_at = NOW(3) WHERE id = ?", oid('OK1'), row.id)).ok).toBe(false); // no external_reference
    expect((await bad("UPDATE payments SET razorpay_order_id = ?, status = 'completed', transacted_at = NOW(3), external_reference = 'pay_X1' WHERE id = ?", oid('OK2'), row.id)).ok).toBe(true);
  });

  it('the service treats a REAL Prisma P2002 from the insert as "another request got there first" and retries the reservation', async () => {
    fresh();
    const inv = await fx.buildInvoice(main);
    // A genuine P2002 error object, produced by MySQL through Prisma.
    const k = `rzp-order:${nextKey()}`;
    const seed = await duplicate(await fx.buildInvoice(main), k);
    expect(seed.error.code).toBe('P2002');
    let thrown = false;
    const wrapTx = (tx) => new Proxy(tx, {
      get(target, prop) {
        if (prop === 'payment') {
          return new Proxy(target.payment, {
            get(delegate, name) {
              if (name === 'create') return async (args) => { if (!thrown) { thrown = true; throw seed.error; } return delegate.create(args); };
              const v = delegate[name]; return typeof v === 'function' ? v.bind(delegate) : v;
            },
          });
        }
        const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const wrapped = new Proxy(c2, {
      get(target, prop) {
        if (prop === '$transaction') return (fn, opts) => target.$transaction((tx) => fn(wrapTx(tx)), opts);
        const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const result = await svc(wrapped, inv);
    expect(thrown).toBe(true); // the first insert really failed with the real P2002
    expect(result.outcome).toBe('ok'); // and the service retried instead of failing
    expect(result.created).toBe(true);
    expect(await paymentsOf(inv)).toHaveLength(1);
    expect(gateway.creates()).toHaveLength(1);
  });
});

describe('order identity and duplicate order ids on real MySQL', () => {
  it('an order id that already belongs to another payment: the real unique index refuses the attach inside the service transaction; the service answers "retry later" and flags it', async () => {
    const a = await fx.buildInvoice(main);
    const b = await fx.buildInvoice(main);
    const taken = oid('DUPX1');
    const rowA = await store.insertPendingPayment(main, { invoiceId: a.invoiceId, caseId: a.caseId, currency: a.currency, amount: '1500.00', idempotencyKey: `rzp-order:${nextKey()}` });
    fx.track('payment', rowA.id);
    expect(await store.attachOrderId(main, rowA.id, taken)).toBe(true);

    // This gateway's FIRST order id is exactly the id payment A already holds, so the service's attach for payment B hits the real unique index.
    gateway = kit.makeGateway({ orderPrefix: `${fx.runId}DUPX` });
    expect(`order_${fx.runId}DUPX1`).toBe(taken);
    const result = await svc(c1, b); // resolves: the P2002 is handled inside the service and never reaches the caller
    expect(result.outcome).toBe('uncertain');
    const [rowB] = await paymentsOf(b);
    expect(rowB).toMatchObject({ status: 'pending', razorpayOrderId: null }); // nothing attached
    expect((await main.payment.findUnique({ where: { id: rowA.id } })).razorpayOrderId).toBe(taken); // the other payment is untouched
    const flagged = await main.$queryRawUnsafe("SELECT COUNT(*) AS n FROM audit_logs WHERE case_id = ? AND action = 'payment.order_review_required' AND reason_code = 'order_id_already_attached'", b.caseId);
    expect(Number(flagged[0].n)).toBe(1); // reported for reconciliation
    expect(gateway.creates()).toHaveLength(1); // and no second order was created to work around it
    expect(JSON.stringify(result)).not.toMatch(/Unique constraint|P2002|razorpay_order_id_key|prisma/i);
  });

  it('an order found by receipt that carries someone else\'s notes is not attached, and nothing new is created', async () => {
    fresh();
    const inv = await fx.buildInvoice(main);
    gateway.modes = ['timeout']; // nothing was created at Razorpay
    expect((await svc(c1, inv)).outcome).toBe('uncertain');
    const [row] = await paymentsOf(inv);
    const key = row.idempotencyKey.replace('rzp-order:', '');
    // A look-alike with this payment's receipt, from "another environment": same amount and currency, other ids in the notes.
    gateway.orders.push({ id: oid('FOREIGN1'), entity: 'order', amount: 150000, currency: 'INR', receipt: `HCP${row.id}`, status: 'created', amount_paid: 0, attempts: 0, notes: { hc_payment_id: String(row.id + 1000), hc_invoice_id: String(inv.invoiceId + 1000), hc_environment: 'test' } });
    const retry = await svc(c2, inv, { idempotencyKey: key, now: later });
    expect(retry.outcome).toBe('uncertain');
    const [after] = await paymentsOf(inv);
    expect(after).toMatchObject({ status: 'pending', razorpayOrderId: null });
    expect(gateway.creates()).toHaveLength(1);
    const flagged = await main.$queryRawUnsafe("SELECT COUNT(*) AS n FROM audit_logs WHERE case_id = ? AND action = 'payment.order_review_required' AND reason_code = 'order_notes_mismatch'", inv.caseId);
    expect(Number(flagged[0].n)).toBe(1);
  });

  // Same payment id, same invoice id, same amount and currency, same receipt: only the ENVIRONMENT differs (or is missing). These are exactly the
  // look-alikes another HumanCare environment sharing the Razorpay account would produce.
  it.each([
    ['another environment', { hc_environment: 'production' }, 'order_environment_mismatch'],
    ['a padded environment', { hc_environment: 'test ' }, 'order_environment_mismatch'],
    ['no environment note', { hc_environment: undefined }, 'order_environment_missing'],
  ])('an order with this payment id and invoice id but %s is never attached, never replaced, and is flagged (real MySQL)', async (_label, override, reason) => {
    fresh();
    const inv = await fx.buildInvoice(main);
    gateway.modes = ['timeout']; // nothing was created at Razorpay
    expect((await svc(c1, inv)).outcome).toBe('uncertain');
    const [row] = await paymentsOf(inv);
    const notes = { hc_payment_id: String(row.id), hc_invoice_id: String(inv.invoiceId), hc_environment: 'test', ...override };
    if (override.hc_environment === undefined) delete notes.hc_environment;
    gateway.orders.push({ id: oid('ENVX1'), entity: 'order', amount: 150000, currency: 'INR', receipt: `HCP${row.id}`, status: 'created', amount_paid: 0, attempts: 0, notes });
    const key = row.idempotencyKey.replace('rzp-order:', '');
    for (let round = 0; round < 2; round += 1) {
      const retry = await svc(c2, inv, { idempotencyKey: key, now: () => new Date(Date.now() + (61 + round * 61) * 1000) });
      expect(retry.outcome).toBe('uncertain');
    }
    const sweepResult = await sweepOn(c3, { now: () => new Date(Date.now() + 400 * 1000) });
    expect(sweepResult).toMatchObject({ attached: 0, closed: 0 });
    const [after] = await paymentsOf(inv);
    expect(after).toMatchObject({ status: 'pending', razorpayOrderId: null });
    expect(gateway.creates()).toHaveLength(1); // never a replacement order
    const flagged = await main.$queryRawUnsafe('SELECT COUNT(*) AS n FROM audit_logs WHERE case_id = ? AND action = ? AND reason_code = ?', inv.caseId, 'payment.order_review_required', reason);
    expect(Number(flagged[0].n)).toBe(1); // flagged once for Operations with the specific reason
  });

  it('an order whose notes match this payment and invoice IS attached (real MySQL)', async () => {
    fresh();
    const inv = await fx.buildInvoice(main);
    gateway.modes = ['lost']; // created at Razorpay with our notes, answer lost
    expect((await svc(c1, inv)).outcome).toBe('uncertain');
    const [row] = await paymentsOf(inv);
    const retry = await svc(c2, inv, { idempotencyKey: row.idempotencyKey.replace('rzp-order:', ''), now: later });
    expect(retry.outcome).toBe('ok');
    expect((await paymentsOf(inv))[0].razorpayOrderId).toBe(gateway.orders[0].id);
    expect(gateway.orders[0].notes).toEqual({ hc_payment_id: String(row.id), hc_invoice_id: String(inv.invoiceId), hc_environment: 'test' });
  });
});
