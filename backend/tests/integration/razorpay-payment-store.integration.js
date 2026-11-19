/* global describe, it, expect, beforeAll, afterAll */
// The Razorpay payment store on REAL MySQL (humancare_test): guarded completion, late capture, duplicate and conflicting captures, overpayment,
// existing-refund settlement with the cumulative cap, invoice-first locking under concurrency (no deadlock), the database CHECKs, and rollback.
// Only synthetic PAYTEST_<runid> rows are written (see helpers/payments-fixture.js); several Prisma clients = several MySQL connections.
const guard = require('../../src/common/safety/integration-runner-guard');
const store = require('../../src/modules/payments/razorpay-payment.store');
const { PaymentsFixture } = require('./helpers/payments-fixture');

const fx = new PaymentsFixture();
let main; let c1; let c2; let c3; let c4; let baseline; let cleanupReport; let afterSnapshot; let remaining;
let seq = 0;
const T = new Date('2026-11-20T10:00:00.000Z');
const nextId = (prefix) => { seq += 1; return `${prefix}${fx.runId}${seq}`; };
const attempt = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

// A synthetic issued invoice (1500 INR by default) and helpers to add payment / refund rows to it.
const invoice = (over) => fx.buildInvoice(main, over);
async function addPayment(inv, over = {}) {
  const row = await main.payment.create({
    data: {
      invoiceId: inv.invoiceId, caseId: inv.caseId, currency: inv.currency, kind: 'payment', status: 'pending', method: 'razorpay', amount: inv.amount,
      razorpayOrderId: nextId('order_'), idempotencyKey: fx.name('PAY'), ...over,
    },
  });
  fx.track('payment', row.id);
  return row;
}
const addCompleted = (inv, over = {}) => addPayment(inv, { status: 'completed', transactedAt: T, externalReference: nextId('pay_'), ...over });
async function addRefund(inv, original, over = {}) {
  const row = await main.payment.create({
    data: {
      invoiceId: inv.invoiceId, caseId: inv.caseId, currency: inv.currency, kind: 'refund', refundOfPaymentId: original.id, refundOfKind: 'payment', status: 'pending',
      method: 'razorpay', amount: '500.000', externalReference: nextId('rfnd_'), idempotencyKey: fx.name('RF'), ...over,
    },
  });
  fx.track('payment', row.id);
  return row;
}
const capture = (row, over = {}) => ({ razorpayOrderId: row.razorpayOrderId, razorpayPaymentId: nextId('pay_'), amountMinor: Math.round(Number(row.amount) * 100), currency: row.currency, transactedAt: T, eventType: 'payment.captured', ...over });
const refundEv = (refund, original, over = {}) => ({ razorpayRefundId: refund.externalReference, razorpayPaymentId: original.externalReference, amountMinor: Math.round(Number(refund.amount) * 100), currency: refund.currency, transactedAt: T, eventType: 'refund.processed', ...over });
const rowOf = (id) => main.payment.findUnique({ where: { id } });
const audits = (caseId, action) => main.$queryRawUnsafe(`SELECT action, reason_code AS reasonCode, entity_id AS entityId FROM audit_logs WHERE case_id = ?${action ? ' AND action = ?' : ''} ORDER BY id`, ...(action ? [caseId, action] : [caseId]));
const reasons = async (caseId) => (await audits(caseId)).map((a) => `${a.action}:${a.reasonCode}`);
const invoiceStatus = async (id) => (await main.invoice.findUnique({ where: { id }, select: { status: true } })).status;

beforeAll(async () => {
  guard.assertIntegrationEnvironment(process.env);
  main = fx.newClient('main');
  c1 = fx.newClient('c1'); c2 = fx.newClient('c2'); c3 = fx.newClient('c3'); c4 = fx.newClient('c4');
  const live = await guard.verifyLiveIdentity(main);
  expect(live.database).toBe('humancare_test');
  baseline = await fx.snapshot(main);
}, 60000);

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
  expect(afterSnapshot.counts).toEqual(baseline.counts);
  expect(afterSnapshot.checksums).toEqual(baseline.checksums);
}, 120000);

describe('lookups against the real schema', () => {
  it('finds by order id, by refund id, the original payment, and totals completed payments only', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv, { amount: '1000.000' });
    await addPayment(inv, { amount: '300.000' }); // pending: not counted
    const refund = await addRefund(inv, original, { status: 'completed', transactedAt: T, amount: '200.000' });
    expect((await store.findPaymentByOrderId(main, original.razorpayOrderId)).id).toBe(original.id);
    expect(await store.findPaymentByOrderId(main, 'order_DOESNOTEXIST')).toBeNull();
    expect(await store.findRefundByExternalReference(main, refund.externalReference)).toMatchObject({ outcome: 'found', refund: { id: refund.id } });
    expect((await store.findOriginalPaymentOfRefund(main, refund)).id).toBe(original.id);
    expect(await store.completedTotals(main, inv.invoiceId)).toMatchObject({ paid: 1000000n, refunded: 200000n });
    expect(await store.completedRefundTotalOf(main, original.id)).toBe(200000n);
    expect((await store.calculateInvoiceOverpayment(main, inv.invoiceId)).overpaid).toBe(0n);
  });
});

describe('guarded payment completion', () => {
  it('completes a pending payment: status, gateway id, event time and audit, with the CHECKs satisfied', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const ev = capture(row);
    expect(await store.completePaymentFromCapture(main, ev)).toMatchObject({ outcome: 'completed', paymentId: row.id, flagged: false });
    const after = await rowOf(row.id);
    expect(after).toMatchObject({ status: 'completed', externalReference: ev.razorpayPaymentId });
    expect(after.transactedAt.getTime()).toBe(T.getTime());
    expect(await reasons(inv.caseId)).toEqual(['payment.completed:webhook_capture']);
  });
  it('quarantines a missing or invalid event time: nothing completes, the row stays pending, Operations is flagged', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const payId = nextId('pay_'); // the SAME gateway payment id every time: the flag is once-only however often it is redelivered
    for (const bad of [undefined, null, new Date('x')]) expect((await store.completePaymentFromCapture(main, capture(row, { razorpayPaymentId: payId, transactedAt: bad }))).outcome).toBe('quarantined');
    expect(await rowOf(row.id)).toMatchObject({ status: 'pending', externalReference: null, transactedAt: null });
    expect(await reasons(inv.caseId)).toEqual(['payment.reconciliation_required:invalid_transaction_time']);
  });
  it('refuses a wrong amount or currency and flags it', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    expect((await store.completePaymentFromCapture(main, capture(row, { amountMinor: 100 }))).outcome).toBe('amount_mismatch');
    expect((await store.completePaymentFromCapture(main, capture(row, { currency: 'USD' }))).outcome).toBe('currency_mismatch');
    expect((await rowOf(row.id)).status).toBe('pending');
  });
  it('an unknown order writes nothing at all', async () => {
    const inv = await invoice();
    expect((await store.completePaymentFromCapture(main, { ...capture({ razorpayOrderId: nextId('order_'), amount: '1500', currency: 'INR' }) })).outcome).toBe('unknown_order');
    expect(await audits(inv.caseId)).toEqual([]);
  });
});

describe('late capture (D1)', () => {
  it.each(['failed', 'cancelled'])('completes a %s payment, flags Operations, and leaves the invoice as it was', async (status) => {
    const inv = await invoice();
    const row = await addPayment(inv, { status });
    const ev = capture(row);
    expect(await store.completePaymentFromCapture(main, ev)).toMatchObject({ outcome: 'late_capture', flagged: true });
    expect(await rowOf(row.id)).toMatchObject({ status: 'completed', externalReference: ev.razorpayPaymentId });
    expect(await reasons(inv.caseId)).toEqual(['payment.late_capture_completed:late_capture', 'payment.reconciliation_required:late_capture']);
    expect(await invoiceStatus(inv.invoiceId)).toBe('issued');
    expect((await main.payment.findMany({ where: { invoiceId: inv.invoiceId } })).length).toBe(1); // no second order / payment created
  });
});

describe('duplicate and conflicting captures under concurrency', () => {
  it('four connections deliver the SAME capture at once: exactly one completes, the rest are duplicates, one row, one completion audit', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const ev = capture(row);
    const results = await Promise.all([c1, c2, c3, c4].map((c) => attempt(store.completePaymentFromCapture(c, ev))));
    expect(results.every((r) => r.ok)).toBe(true);
    const outcomes = results.map((r) => r.value.outcome).sort();
    expect(outcomes).toEqual(['completed', 'duplicate_capture', 'duplicate_capture', 'duplicate_capture']);
    expect(await rowOf(row.id)).toMatchObject({ status: 'completed', externalReference: ev.razorpayPaymentId });
    expect((await audits(inv.caseId, 'payment.completed')).length).toBe(1);
  });
  it('two DIFFERENT gateway payment ids race on one order: one wins, the other never overwrites it and is flagged', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const a = capture(row); const b = capture(row);
    const results = await Promise.all([attempt(store.completePaymentFromCapture(c1, a)), attempt(store.completePaymentFromCapture(c2, b))]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.value.outcome).sort()).toEqual(['completed', 'different_payment_id']);
    const winner = results.find((r) => r.value.outcome === 'completed') === results[0] ? a : b;
    expect((await rowOf(row.id)).externalReference).toBe(winner.razorpayPaymentId);
    expect((await audits(inv.caseId, 'payment.reconciliation_required')).map((x) => x.reasonCode)).toEqual(['different_payment_id']);
  });
  it('a different id after completion is flagged and the evidence is untouched', async () => {
    const inv = await invoice();
    const row = await addCompleted(inv);
    expect((await store.completePaymentFromCapture(main, capture(row))).outcome).toBe('different_payment_id');
    expect(await rowOf(row.id)).toMatchObject({ externalReference: row.externalReference, status: 'completed' });
  });
});

describe('overpayment', () => {
  it('two payments of the full amount captured at once on one invoice: both are kept, exactly one overpayment is flagged', async () => {
    const inv = await invoice();
    const a = await addPayment(inv); const b = await addPayment(inv);
    const results = await Promise.all([attempt(store.completePaymentFromCapture(c1, capture(a))), attempt(store.completePaymentFromCapture(c2, capture(b)))]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await rowOf(a.id)).status).toBe('completed');
    expect((await rowOf(b.id)).status).toBe('completed');
    expect((await audits(inv.caseId, 'payment.reconciliation_required')).map((x) => x.reasonCode)).toEqual(['overpayment']);
    expect(results.filter((r) => r.value.overpaid === '1500.00').length).toBe(1);
    expect((await store.calculateInvoiceOverpayment(main, inv.invoiceId)).overpaid).toBe(1500000n);
  });
});

describe('refunds on existing rows', () => {
  it('completes an eligible refund; the invoice and the original are unchanged and the balance is not reopened', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv);
    const refund = await addRefund(inv, original);
    expect(await store.completeRefund(main, refundEv(refund, original))).toMatchObject({ outcome: 'completed', refundId: refund.id });
    expect(await rowOf(refund.id)).toMatchObject({ status: 'completed' });
    expect((await rowOf(original.id)).status).toBe('completed');
    expect(await invoiceStatus(inv.invoiceId)).toBe('issued');
    expect((await store.completedTotals(main, inv.invoiceId)).paid).toBe(1500000n);
  });
  it('marks a refund failed; repeating either result is a no-op; the opposite is a flagged conflict', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv);
    const refund = await addRefund(inv, original);
    expect((await store.failRefund(main, refundEv(refund, original, { eventType: 'refund.failed' }))).outcome).toBe('failed');
    expect((await store.failRefund(main, refundEv(refund, original, { eventType: 'refund.failed' }))).outcome).toBe('already_failed');
    expect((await store.completeRefund(main, refundEv(refund, original))).outcome).toBe('state_conflict');
    expect((await rowOf(refund.id)).status).toBe('failed');
  });
  it('cumulative refunds never exceed the payment, even when two refunds complete at the same instant', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv);
    const r1 = await addRefund(inv, original, { amount: '1000.000' });
    const r2 = await addRefund(inv, original, { amount: '600.000' });
    const results = await Promise.all([attempt(store.completeRefund(c1, refundEv(r1, original))), attempt(store.completeRefund(c2, refundEv(r2, original)))]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.value.outcome).sort()).toEqual(['completed', 'refund_exceeds_payment']);
    expect(await store.completedRefundTotalOf(main, original.id)).toBeLessThanOrEqual(1500000n);
    expect((await audits(inv.caseId, 'payment.reconciliation_required')).map((x) => x.reasonCode)).toEqual(['refund_exceeds_payment']);
  });
  it('an unknown refund of a known payment is flagged; a refund of an unknown payment writes nothing; no refund row is ever created', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv);
    const before = (await main.payment.findMany({ where: { invoiceId: inv.invoiceId } })).length;
    const ev = { razorpayRefundId: nextId('rfnd_'), razorpayPaymentId: original.externalReference, amountMinor: 50000, currency: 'INR', transactedAt: T, eventType: 'refund.processed' };
    expect(await store.completeRefund(main, ev)).toMatchObject({ outcome: 'unknown_refund', flagged: true, paymentId: original.id });
    expect(await reasons(inv.caseId)).toEqual(['payment.reconciliation_required:unknown_refund']);
    expect((await store.completeRefund(main, { ...ev, razorpayRefundId: nextId('rfnd_'), razorpayPaymentId: nextId('pay_') })).outcome).toBe('unknown_refund');
    expect((await audits(inv.caseId)).length).toBe(1);
    expect((await main.payment.findMany({ where: { invoiceId: inv.invoiceId } })).length).toBe(before);
  });
});

describe('invoice-first locking under concurrency', () => {
  it('captures and refund completions on ONE invoice, started together on four connections, finish without a deadlock or lock timeout', async () => {
    for (let round = 0; round < 3; round += 1) {
      const inv = await invoice({ amount: '3000.000' });
      const base = await addCompleted(inv, { amount: '1500.000' });
      const refund = await addRefund(inv, base);
      const p1 = await addPayment(inv, { amount: '700.000' });
      const p2 = await addPayment(inv, { amount: '800.000' });
      const results = await Promise.all([
        attempt(store.completeRefund(c1, refundEv(refund, base))),
        attempt(store.completePaymentFromCapture(c2, capture(p1))),
        attempt(store.completePaymentFromCapture(c3, capture(p2))),
        attempt(store.completeRefund(c4, refundEv(refund, base))),
      ]);
      expect(results.map((r) => (r.ok ? 'ok' : String(r.error.message).slice(0, 80)))).toEqual(['ok', 'ok', 'ok', 'ok']);
      expect((await rowOf(p1.id)).status).toBe('completed');
      expect((await rowOf(p2.id)).status).toBe('completed');
      expect((await rowOf(refund.id)).status).toBe('completed');
    }
  });
});

describe('rollback and database errors on the real database', () => {
  // A client whose transactions fail the audit write, so the change that came before it must roll back.
  const failingAudit = (client) => new Proxy(client, {
    get(target, prop) {
      if (prop === '$transaction') {
        return (fn, opts) => target.$transaction((tx) => fn(new Proxy(tx, {
          get(t, p) { if (p === 'auditLog') return { create: async () => { throw new Error('injected audit failure'); } }; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; },
        })), opts);
      }
      const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  it('a failing audit write rolls the payment update back: the row is still pending and a normal run then succeeds', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const ev = capture(row);
    expect((await attempt(store.completePaymentFromCapture(failingAudit(c1), ev))).ok).toBe(false);
    expect(await rowOf(row.id)).toMatchObject({ status: 'pending', externalReference: null, transactedAt: null });
    expect(await audits(inv.caseId)).toEqual([]);
    expect((await store.completePaymentFromCapture(c2, ev)).outcome).toBe('completed');
  });
  it('a failing audit write rolls a refund completion back', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv);
    const refund = await addRefund(inv, original);
    expect((await attempt(store.completeRefund(failingAudit(c1), refundEv(refund, original)))).ok).toBe(false);
    expect(await rowOf(refund.id)).toMatchObject({ status: 'pending', transactedAt: null });
  });
  it('joins the caller\'s transaction: a throw after the store call undoes the completion', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const result = await attempt(c1.$transaction(async (tx) => {
      expect((await store.completePaymentFromCapture(tx, capture(row))).outcome).toBe('completed');
      throw new Error('processor failed after the store call');
    }));
    expect(result.ok).toBe(false);
    expect((await rowOf(row.id)).status).toBe('pending');
    expect(await audits(inv.caseId)).toEqual([]);
  });
  it('the database CHECKs still hold: a completed Razorpay payment cannot lose its gateway id or time', async () => {
    const inv = await invoice();
    const row = await addCompleted(inv);
    expect((await attempt(main.payment.update({ where: { id: row.id }, data: { externalReference: null } }))).ok).toBe(false);
    expect((await attempt(main.payment.update({ where: { id: row.id }, data: { transactedAt: null } }))).ok).toBe(false);
  });
});
