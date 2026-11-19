/* global describe, it, expect, beforeAll, afterAll */
// The Razorpay event processor END TO END on REAL MySQL (humancare_test): inbox rows are built exactly as the receiver builds them (classifyEvent +
// storeEvent), claimed with the real inbox store, and applied through the real payment store in one transaction with the fenced inbox result.
// Covers all five events, duplicates, late capture, overpayment, missing time, refund ordering, unknown orders/refunds, environment, stale-worker fencing,
// concurrency, rollback and atomicity. Only synthetic PAYTEST_<runid> rows are written (see helpers/payments-fixture.js).
const guard = require('../../src/common/safety/integration-runner-guard');
const inbox = require('../../src/modules/payments/razorpay-webhook.inbox.store');
const processor = require('../../src/modules/payments/razorpay-webhook.processor');
const { classifyEvent } = require('../../src/modules/payments/razorpay-webhook.events');
const { PaymentsFixture } = require('./helpers/payments-fixture');

const fx = new PaymentsFixture();
let main; let c1; let c2; let c3; let c4; let baseline; let cleanupReport; let afterSnapshot; let remaining;
let seq = 0;
const ENV = { PAYMENTS_ENVIRONMENT_ID: 'test' };
const CREATED_AT = 1795000000; // 2026-11-17T09:46:40Z, a credible event time
const nextId = (prefix) => { seq += 1; return `${prefix}${fx.runId}${seq}`; };
const attempt = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const wname = (label) => `PT${fx.runId}-${label}-${(seq += 1)}`;

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
const addCompleted = (inv, over = {}) => addPayment(inv, { status: 'completed', transactedAt: new Date(CREATED_AT * 1000), externalReference: nextId('pay_'), ...over });
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
const minor = (row) => Math.round(Number(row.amount) * 100);

// ---- envelopes as Razorpay sends them, and the inbox rows the receiver would store ---------------------------------------------------------------------
const env = (event, key, entity, createdAt = CREATED_AT) => ({ event, ...(createdAt !== undefined && { created_at: createdAt }), payload: { [key]: { entity } } });
const captured = (row, over = {}, createdAt) => env('payment.captured', 'payment', { id: nextId('pay_'), order_id: row.razorpayOrderId, amount: minor(row), currency: row.currency, status: 'captured', ...over }, createdAt);
const failedEv = (row, over = {}) => env('payment.failed', 'payment', { id: nextId('pay_'), order_id: row.razorpayOrderId, amount: minor(row), currency: row.currency, status: 'failed', ...over });
const refundEv = (event, refund, original, over = {}) => env(event, 'refund', { id: refund.externalReference, payment_id: original.externalReference, amount: minor(refund), currency: refund.currency, status: event === 'refund.processed' ? 'processed' : 'failed', ...over });
const orderPaid = (row, over = {}) => env('order.paid', 'order', { id: row.razorpayOrderId, amount_paid: minor(row), ...over });

async function store(envelope) {
  const c = classifyEvent(envelope, { bodySha256: 'a'.repeat(64), eventIdSource: 'header' });
  expect(c.status).toBe('received');
  const externalEventId = fx.name('EVT');
  expect(await inbox.storeEvent(main, { externalEventId, eventType: c.eventType, entityType: c.entityType, entityId: c.entityId, occurredAt: c.occurredAt, payload: c.payload, status: c.status, lastError: c.lastError })).toEqual({ stored: true });
  const row = await main.integrationInbox.findUnique({ where: { source_externalEventId: { source: 'razorpay', externalEventId } } });
  fx.track('inbox', row.id);
  return row.id;
}
const claimEvent = (client, id, label = 'w', leaseSeconds = 120) => inbox.claim(client, { id, workerId: wname(label), leaseSeconds });
async function processOne(client, id, environment = ENV) {
  const claim = await claimEvent(client, id);
  expect(claim).not.toBeNull();
  return processor.processClaim(client, claim, { env: environment });
}
const inboxOf = async (id) => {
  const [r] = await main.$queryRaw`SELECT status, attempts, last_error AS lastError, locked_by AS lockedBy, processed_at IS NOT NULL AS hasProcessedAt, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), next_attempt_at) AS nextIn FROM integration_inbox WHERE id = ${id}`;
  return { status: r.status, attempts: Number(r.attempts), lastError: r.lastError, lockedBy: r.lockedBy, done: Number(r.hasProcessedAt) === 1, nextIn: Number(r.nextIn) };
};
const makeDue = (id) => main.$executeRaw`UPDATE integration_inbox SET next_attempt_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ${id}`;
const setAttempts = (id, n) => main.$executeRaw`UPDATE integration_inbox SET attempts = ${n} WHERE id = ${id}`;
const expireLease = (id) => main.$executeRaw`UPDATE integration_inbox SET locked_until = UTC_TIMESTAMP(3) - INTERVAL 30 SECOND WHERE id = ${id}`;
const rowOf = (id) => main.payment.findUnique({ where: { id } });
const auditsOf = (caseId) => main.$queryRawUnsafe('SELECT action, reason_code AS reasonCode FROM audit_logs WHERE case_id = ? ORDER BY id', caseId);
const reasons = async (caseId) => (await auditsOf(caseId)).map((a) => `${a.action}:${a.reasonCode}`);
const invoiceStatus = async (id) => (await main.invoice.findUnique({ where: { id }, select: { status: true } })).status;
const paymentCount = (invoiceId) => main.payment.count({ where: { invoiceId } });

beforeAll(async () => {
  guard.assertIntegrationEnvironment(process.env);
  main = fx.newClient('main');
  c1 = fx.newClient('c1'); c2 = fx.newClient('c2'); c3 = fx.newClient('c3'); c4 = fx.newClient('c4');
  const live = await guard.verifyLiveIdentity(main);
  expect(live.database).toBe('humancare_test');
  baseline = await fx.snapshot(main);
  const [existing] = await main.$queryRaw`SELECT COUNT(*) AS n FROM integration_inbox WHERE source = 'razorpay'`;
  expect(Number(existing.n)).toBe(0); // the batch test is set-based over every razorpay row: there must be none but ours
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

describe('payment.captured', () => {
  it('completes the matching payment atomically with the inbox result: gateway id, the validated event time, audit; the invoice is unchanged', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const ev = captured(row);
    const id = await store(ev);
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', outcome: 'completed' });
    const after = await rowOf(row.id);
    expect(after).toMatchObject({ status: 'completed', externalReference: ev.payload.payment.entity.id });
    expect(after.transactedAt.getTime()).toBe(CREATED_AT * 1000); // D3: Razorpay's created_at, not the application clock
    expect(await inboxOf(id)).toMatchObject({ status: 'processed', lastError: null, lockedBy: null, done: true });
    expect(await reasons(inv.caseId)).toEqual(['payment.completed:webhook_capture']);
    expect(await invoiceStatus(inv.invoiceId)).toBe('issued');
  });
  it('a duplicate delivery (a second inbox row for the same capture) is a processed no-op', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const ev = captured(row);
    const a = await store(ev); const b = await store(ev);
    expect((await processOne(main, a)).outcome).toBe('completed');
    expect(await processOne(main, b)).toMatchObject({ status: 'processed', outcome: 'duplicate_capture' });
    expect((await rowOf(row.id)).externalReference).toBe(ev.payload.payment.entity.id);
    expect(await reasons(inv.caseId)).toEqual(['payment.completed:webhook_capture', 'payment.duplicate_capture:duplicate_capture']);
  });
  it('a different payment id for an already completed order keeps the evidence and flags it', async () => {
    const inv = await invoice();
    const row = await addCompleted(inv);
    const id = await store(captured(row));
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', code: 'different_payment_id' });
    expect((await rowOf(row.id)).externalReference).toBe(row.externalReference);
    expect(await reasons(inv.caseId)).toEqual(['payment.reconciliation_required:different_payment_id']);
  });
  it.each(['failed', 'cancelled'])('late capture (D1) on a %s payment: completed and flagged, no new order, invoice not reopened', async (status) => {
    const inv = await invoice();
    const row = await addPayment(inv, { status });
    const id = await store(captured(row));
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', code: 'late_capture' });
    expect((await rowOf(row.id)).status).toBe('completed');
    expect(await reasons(inv.caseId)).toEqual(['payment.late_capture_completed:late_capture', 'payment.reconciliation_required:late_capture']);
    expect(await paymentCount(inv.invoiceId)).toBe(1);
    expect(await invoiceStatus(inv.invoiceId)).toBe('issued');
  });
  it('overpayment: a second full payment on the same invoice is kept and flagged', async () => {
    const inv = await invoice();
    const first = await addCompleted(inv);
    const second = await addPayment(inv);
    const id = await store(captured(second));
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', code: 'flagged_for_operations' });
    expect((await rowOf(second.id)).status).toBe('completed');
    expect((await rowOf(first.id)).status).toBe('completed');
    expect(await reasons(inv.caseId)).toEqual(['payment.completed:webhook_capture', 'payment.reconciliation_required:overpayment']);
  });
  it.each([['missing', 'OMIT'], ['too old', 5], ['not a number', 'yesterday']])('a %s event time is quarantined: nothing completes and Operations is flagged (D3)', async (_l, createdAt) => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const ev = captured(row, {}, createdAt === 'OMIT' ? CREATED_AT : createdAt);
    if (createdAt === 'OMIT') delete ev.created_at; // an envelope with no created_at at all
    const id = await store(ev);
    expect(await processOne(main, id)).toMatchObject({ status: 'ignored', code: 'quarantined_invalid_time' });
    expect(await rowOf(row.id)).toMatchObject({ status: 'pending', externalReference: null, transactedAt: null });
    expect(await reasons(inv.caseId)).toEqual(['payment.reconciliation_required:invalid_transaction_time']);
    expect(await inboxOf(id)).toMatchObject({ status: 'ignored' });
  });
  it('a wrong amount or currency is flagged, not completed', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    expect(await processOne(main, await store(captured(row, { amount: 100 })))).toMatchObject({ status: 'processed', code: 'amount_mismatch' });
    expect(await processOne(main, await store(captured(row, { currency: 'USD' })))).toMatchObject({ status: 'processed', code: 'currency_mismatch' });
    expect((await rowOf(row.id)).status).toBe('pending');
  });
  it('a capture whose status is not "captured" is ignored without touching the payment', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    expect(await processOne(main, await store(captured(row, { status: 'authorized' })))).toMatchObject({ status: 'ignored', code: 'payment_status_mismatch' });
    expect((await rowOf(row.id)).status).toBe('pending');
  });
});

describe('unknown orders and the environment', () => {
  it('an order we do not know waits through the bounded attempts, then is ignored quietly: no flag, no failure, no audit anywhere', async () => {
    const inv = await invoice();
    const stranger = { razorpayOrderId: nextId('order_'), currency: 'INR', amount: '1500.000' };
    const id = await store(captured(stranger));
    for (let attemptNo = 1; attemptNo < processor.WAIT_ATTEMPTS; attemptNo += 1) {
      expect(await processOne(main, id)).toMatchObject({ status: 'received', code: 'awaiting_unknown_order' });
      expect(await inboxOf(id)).toMatchObject({ status: 'received', attempts: attemptNo });
      expect((await inboxOf(id)).nextIn).toBeGreaterThan(30); // a database-clock delay, not due yet
      await makeDue(id);
    }
    expect(await processOne(main, id)).toMatchObject({ status: 'ignored', code: 'unknown_order' });
    expect(await inboxOf(id)).toMatchObject({ status: 'ignored', attempts: processor.WAIT_ATTEMPTS, lastError: 'unknown_order' });
    expect(await auditsOf(inv.caseId)).toEqual([]);
  });
  it('an order that is attached AFTER the first attempt (the concurrent-attachment race) is found by the retry, not discarded', async () => {
    const inv = await invoice();
    const orderId = nextId('order_');
    const row = await addPayment(inv, { razorpayOrderId: null });
    const id = await store(captured({ razorpayOrderId: orderId, currency: 'INR', amount: '1500.000' }));
    expect((await processOne(main, id)).status).toBe('received'); // the order is not attached yet
    await main.payment.update({ where: { id: row.id }, data: { razorpayOrderId: orderId } }); // attached between attempts
    await makeDue(id);
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', outcome: 'completed' });
    expect((await rowOf(row.id)).status).toBe('completed');
  });
  it('an unconfigured environment applies nothing and schedules a retry', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const id = await store(captured(row));
    expect(await processOne(main, id, {})).toMatchObject({ status: 'received', code: 'environment_not_configured' });
    expect((await rowOf(row.id)).status).toBe('pending');
    expect(await inboxOf(id)).toMatchObject({ status: 'received', lastError: 'environment_not_configured', attempts: 1 });
    await makeDue(id);
    expect((await processOne(main, id)).outcome).toBe('completed'); // configured again: applied
  });
});

describe('payment.failed', () => {
  it('records the attempt and keeps the payment pending; several attempts then a successful capture still completes it', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const a = await store(failedEv(row)); const b = await store(failedEv(row));
    expect(await processOne(main, a)).toMatchObject({ status: 'processed', outcome: 'attempt_recorded' });
    expect(await processOne(main, b)).toMatchObject({ status: 'processed', outcome: 'attempt_recorded' });
    expect(await rowOf(row.id)).toMatchObject({ status: 'pending', externalReference: null });
    expect(await invoiceStatus(inv.invoiceId)).toBe('issued');
    expect((await processOne(main, await store(captured(row)))).outcome).toBe('completed');
    expect(await reasons(inv.caseId)).toEqual(['payment.attempt_failed:gateway_attempt_failed', 'payment.attempt_failed:gateway_attempt_failed', 'payment.completed:webhook_capture']);
  });
  it('out of order: a failed attempt that arrives after the capture is only a note; the completed payment is untouched', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const cap = captured(row);
    await processOne(main, await store(cap));
    expect(await processOne(main, await store(failedEv(row)))).toMatchObject({ status: 'processed', outcome: 'attempt_recorded' });
    expect(await rowOf(row.id)).toMatchObject({ status: 'completed', externalReference: cap.payload.payment.entity.id });
  });
});

describe('order.paid is reconciliation only', () => {
  it('never completes a payment: it waits, and on the final attempt flags the uncaptured order; the payment stays pending', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const id = await store(orderPaid(row));
    expect(await processOne(main, id)).toMatchObject({ status: 'received', code: 'awaiting_order_paid_pending_capture' });
    expect(await rowOf(row.id)).toMatchObject({ status: 'pending', externalReference: null, transactedAt: null });
    expect(await auditsOf(inv.caseId)).toEqual([]);
    await setAttempts(id, processor.WAIT_ATTEMPTS - 1);
    await makeDue(id);
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', code: 'order_paid_unreconciled' });
    expect(await rowOf(row.id)).toMatchObject({ status: 'pending', externalReference: null, transactedAt: null });
    expect(await reasons(inv.caseId)).toEqual(['payment.reconciliation_required:order_paid_not_completed']);
  });
  it('after the capture it records evidence once and changes nothing', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const id = await store(orderPaid(row));
    expect((await processOne(main, id)).status).toBe('received'); // arrived first
    await processOne(main, await store(captured(row)));
    await makeDue(id);
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', outcome: 'order_paid_recorded' });
    expect(await reasons(inv.caseId)).toEqual(['payment.completed:webhook_capture', 'payment.order_paid_observed:order_paid_event']);
  });
});

describe('refund.processed and refund.failed (existing rows only)', () => {
  it('completes an existing refund; the original, the invoice and the paid balance are untouched; a duplicate is a no-op', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv);
    const refund = await addRefund(inv, original);
    const ev = refundEv('refund.processed', refund, original);
    expect(await processOne(main, await store(ev))).toMatchObject({ status: 'processed', outcome: 'completed' });
    expect(await rowOf(refund.id)).toMatchObject({ status: 'completed' });
    expect((await rowOf(refund.id)).transactedAt.getTime()).toBe(CREATED_AT * 1000);
    expect(await processOne(main, await store(ev))).toMatchObject({ status: 'processed', outcome: 'already_completed' });
    expect((await rowOf(original.id)).status).toBe('completed');
    expect(await invoiceStatus(inv.invoiceId)).toBe('issued');
    expect(await paymentCount(inv.invoiceId)).toBe(2); // no row created
  });
  it('marks an existing pending refund failed, idempotently', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv);
    const refund = await addRefund(inv, original);
    const ev = refundEv('refund.failed', refund, original);
    expect(await processOne(main, await store(ev))).toMatchObject({ status: 'processed', outcome: 'failed' });
    expect(await processOne(main, await store(ev))).toMatchObject({ status: 'processed', outcome: 'already_failed' });
    expect((await rowOf(refund.id)).status).toBe('failed');
  });
  it('the cumulative limit: refunds that together exceed the original payment are flagged and the excess one stays pending', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv);
    const r1 = await addRefund(inv, original, { amount: '1000.000' });
    const r2 = await addRefund(inv, original, { amount: '600.000' });
    expect((await processOne(main, await store(refundEv('refund.processed', r1, original)))).outcome).toBe('completed');
    expect(await processOne(main, await store(refundEv('refund.processed', r2, original)))).toMatchObject({ status: 'processed', code: 'refund_exceeds_payment' });
    expect((await rowOf(r2.id)).status).toBe('pending');
  });
  it('a refund that overtook its row waits, then completes once the existing row is committed; nothing is created in between', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv);
    const refundRef = nextId('rfnd_');
    const ghost = { externalReference: refundRef, amount: '500.000', currency: 'INR' };
    const id = await store(refundEv('refund.processed', ghost, original));
    expect(await processOne(main, id)).toMatchObject({ status: 'received', code: 'awaiting_unknown_refund' });
    expect(await paymentCount(inv.invoiceId)).toBe(1);
    expect(await auditsOf(inv.caseId)).toEqual([]); // no flag while waiting
    const refund = await addRefund(inv, original, { externalReference: refundRef }); // the row is committed later
    await makeDue(id);
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', outcome: 'completed' });
    expect((await rowOf(refund.id)).status).toBe('completed');
  });
  it('a refund that never gets its row: after the bounded attempts an unknown refund of a known payment is flagged; no row is ever created', async () => {
    const inv = await invoice();
    const original = await addCompleted(inv);
    const id = await store(refundEv('refund.processed', { externalReference: nextId('rfnd_'), amount: '500.000', currency: 'INR' }, original));
    await setAttempts(id, processor.WAIT_ATTEMPTS - 1);
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', code: 'unknown_refund' });
    expect(await reasons(inv.caseId)).toEqual(['payment.reconciliation_required:unknown_refund']);
    expect(await paymentCount(inv.invoiceId)).toBe(1);
  });
  it('an unknown refund of an unknown payment is ignored quietly (another environment)', async () => {
    const inv = await invoice();
    const id = await store(refundEv('refund.processed', { externalReference: nextId('rfnd_'), amount: '500.000', currency: 'INR' }, { externalReference: nextId('pay_') }));
    await setAttempts(id, processor.WAIT_ATTEMPTS - 1);
    expect(await processOne(main, id)).toMatchObject({ status: 'ignored', code: 'unknown_refund' });
    expect(await auditsOf(inv.caseId)).toEqual([]);
  });
  it('a refund whose capture has not been applied yet waits and completes after the capture (out-of-order events)', async () => {
    const inv = await invoice();
    const pending = await addPayment(inv);
    const refund = await addRefund(inv, pending);
    // the original is still pending locally: complete it by the (later) capture event, then the refund event is applied
    const refundId = await store(refundEv('refund.processed', refund, { externalReference: 'pay_FUTURE1' + fx.runId }));
    expect(await processOne(main, refundId)).toMatchObject({ status: 'received', code: 'awaiting_original_not_completed' });
    expect((await rowOf(refund.id)).status).toBe('pending');
    const cap = captured(pending, { id: 'pay_FUTURE1' + fx.runId });
    expect((await processOne(main, await store(cap))).outcome).toBe('completed');
    await makeDue(refundId);
    expect(await processOne(main, refundId)).toMatchObject({ status: 'processed', outcome: 'completed' });
  });
});

describe('stale worker fencing and concurrency', () => {
  it('a worker whose lease expired and whose event was taken over applies NOTHING; the new owner applies it once', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const ev = captured(row);
    const id = await store(ev);
    const stale = await claimEvent(c1, id, 'stale', 120);
    await expireLease(id);
    await inbox.recoverExpiredLeases(main);
    const fresh = await claimEvent(c2, id, 'fresh', 120);
    expect(fresh.attempts).toBe(2);
    expect(await processor.processClaim(c1, stale, { env: ENV })).toMatchObject({ status: 'lease_lost' });
    expect((await rowOf(row.id)).status).toBe('pending'); // the stale worker changed nothing
    expect(await auditsOf(inv.caseId)).toEqual([]);
    expect(await processor.processClaim(c2, fresh, { env: ENV })).toMatchObject({ status: 'processed', outcome: 'completed' });
    expect(await processor.processClaim(c1, stale, { env: ENV })).toMatchObject({ status: 'lease_lost' }); // still fenced after the result
    expect(await inboxOf(id)).toMatchObject({ status: 'processed', attempts: 2 });
    expect((await auditsOf(inv.caseId)).length).toBe(1);
  });
  it('a lease that expired but was not yet taken over is also refused: nothing is applied', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const id = await store(captured(row));
    const claim = await claimEvent(c1, id);
    await expireLease(id);
    expect(await processor.processClaim(c1, claim, { env: ENV })).toMatchObject({ status: 'lease_lost' });
    expect((await rowOf(row.id)).status).toBe('pending');
    await inbox.recoverExpiredLeases(main); // the expired claim goes back to the queue ...
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', outcome: 'completed' }); // ... and a new owner applies it exactly once
    expect((await auditsOf(inv.caseId)).length).toBe(1);
  });
  it('ATOMIC: if the fenced inbox result cannot be written, the payment change that came before it is rolled back too', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const id = await store(captured(row));
    const claim = await claimEvent(main, id);
    const result = await processor.processClaim(main, claim, { env: ENV, deps: { inbox: { ...inbox, writeResult: async () => 0 } } });
    expect(result.status).toBe('lease_lost');
    expect(await rowOf(row.id)).toMatchObject({ status: 'pending', externalReference: null });
    expect(await auditsOf(inv.caseId)).toEqual([]);
    expect(await inboxOf(id)).toMatchObject({ status: 'processing', lockedBy: claim.workerId }); // the claim is untouched; recovery will deal with it
    await expireLease(id);
    await inbox.recoverExpiredLeases(main);
    expect(await processOne(main, id)).toMatchObject({ status: 'processed', outcome: 'completed' }); // the rolled-back event applies cleanly the second time
    expect((await auditsOf(inv.caseId)).length).toBe(1);
  });
  it('the same capture delivered as two events and processed at the same instant: exactly one completes, one is a duplicate, one audit', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const ev = captured(row);
    const a = await store(ev); const b = await store(ev);
    const [ca, cb] = [await claimEvent(c1, a), await claimEvent(c2, b)];
    const results = await Promise.all([attempt(processor.processClaim(c1, ca, { env: ENV })), attempt(processor.processClaim(c2, cb, { env: ENV }))]);
    expect(results.every((r) => r.ok && r.value.status === 'processed')).toBe(true);
    expect(results.map((r) => r.value.outcome).sort()).toEqual(['completed', 'duplicate_capture']);
    expect(await rowOf(row.id)).toMatchObject({ status: 'completed', externalReference: ev.payload.payment.entity.id });
    expect((await reasons(inv.caseId)).filter((r) => r === 'payment.completed:webhook_capture').length).toBe(1);
  });
  it('two workers racing for one event: only one claims and processes it', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const id = await store(captured(row));
    const claims = await Promise.all([c1, c2, c3, c4].map((c) => attempt(claimEvent(c, id))));
    const winners = claims.filter((c) => c.ok && c.value);
    expect(winners).toHaveLength(1);
    const owner = [c1, c2, c3, c4][claims.indexOf(winners[0])];
    expect((await processor.processClaim(owner, winners[0].value, { env: ENV })).status).toBe('processed');
  });
  it('captures and refund events on ONE invoice, processed together on four connections, finish without a deadlock', async () => {
    for (let round = 0; round < 3; round += 1) {
      const inv = await invoice({ amount: '3000.000' });
      const base = await addCompleted(inv, { amount: '1500.000' });
      const refund = await addRefund(inv, base);
      const p1 = await addPayment(inv, { amount: '700.000' });
      const p2 = await addPayment(inv, { amount: '800.000' });
      const ids = [await store(refundEv('refund.processed', refund, base)), await store(captured(p1)), await store(captured(p2)), await store(failedEv(p1))];
      const claims = [await claimEvent(c1, ids[0]), await claimEvent(c2, ids[1]), await claimEvent(c3, ids[2]), await claimEvent(c4, ids[3])];
      const results = await Promise.all([c1, c2, c3, c4].map((c, i) => attempt(processor.processClaim(c, claims[i], { env: ENV }))));
      expect(results.map((r) => (r.ok ? r.value.status : String(r.error.message).slice(0, 60)))).toEqual(['processed', 'processed', 'processed', 'processed']);
      expect((await rowOf(refund.id)).status).toBe('completed');
      expect((await rowOf(p1.id)).status).toBe('completed');
      expect((await rowOf(p2.id)).status).toBe('completed');
    }
  });
});

describe('rollback and audit consistency', () => {
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
  it('a failing audit write rolls the payment AND the inbox result back; the event is scheduled for retry with a short code, and the retry then succeeds', async () => {
    const inv = await invoice();
    const row = await addPayment(inv);
    const id = await store(captured(row));
    const claim = await claimEvent(c1, id);
    expect(await processor.processClaim(failingAudit(c1), claim, { env: ENV })).toMatchObject({ status: 'received', code: 'processing_error' });
    expect(await rowOf(row.id)).toMatchObject({ status: 'pending', externalReference: null, transactedAt: null });
    expect(await auditsOf(inv.caseId)).toEqual([]);
    expect(await inboxOf(id)).toMatchObject({ status: 'received', lastError: 'processing_error', attempts: 1, lockedBy: null });
    await makeDue(id);
    expect(await processOne(c2, id)).toMatchObject({ status: 'processed', outcome: 'completed' });
    expect(await reasons(inv.caseId)).toEqual(['payment.completed:webhook_capture']);
  });
  it('every audit row this processor produced uses only allow-listed data keys and contains no secret, signature, body or error text', async () => {
    const inv = await invoice();
    const row = await addPayment(inv, { status: 'failed' });
    await processOne(main, await store(captured(row)));
    const rows = await main.$queryRawUnsafe('SELECT action, actor_type AS actorType, source, after_data AS afterData FROM audit_logs WHERE case_id = ?', inv.caseId);
    expect(rows.length).toBeGreaterThan(0);
    const { ALLOWED_DATA_KEYS } = require('../../src/common/audit/business-audit');
    for (const r of rows) {
      expect(r).toMatchObject({ actorType: 'system', source: 'razorpay_webhook' });
      const data = typeof r.afterData === 'string' ? JSON.parse(r.afterData) : r.afterData;
      for (const key of Object.keys(data)) expect(ALLOWED_DATA_KEYS.has(key)).toBe(true);
      expect(JSON.stringify(data)).not.toMatch(/signature|secret|body|description|vpa|card|@/i);
    }
  });
});

describe('a whole worker pass', () => {
  it('processBatch recovers, claims and applies several different events in one pass', async () => {
    // Park every earlier event of this run that is still waiting, so the set-based pass sees only the three below.
    for (const id of [...new Set(fx.ids.inbox)]) await main.$executeRaw`UPDATE integration_inbox SET next_attempt_at = UTC_TIMESTAMP(3) + INTERVAL 1 DAY WHERE id = ${id} AND status = 'received'`;
    const inv = await invoice({ amount: '3000.000' });
    const a = await addPayment(inv, { amount: '1000.000' });
    const b = await addPayment(inv, { amount: '1000.000' });
    const base = await addCompleted(inv, { amount: '1000.000' });
    const refund = await addRefund(inv, base);
    const ids = [await store(captured(a)), await store(failedEv(b)), await store(refundEv('refund.processed', refund, base))];
    const tally = await processor.processBatch(c1, { workerId: wname('batch'), env: ENV });
    expect(tally).toMatchObject({ claimed: 3, skipped: 0, processed: 3 });
    for (const id of ids) expect((await inboxOf(id)).status).toBe('processed');
    expect((await rowOf(a.id)).status).toBe('completed');
    expect((await rowOf(b.id)).status).toBe('pending');
    expect((await rowOf(refund.id)).status).toBe('completed');
  });
});
