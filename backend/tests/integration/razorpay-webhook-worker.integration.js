/* global describe, it, expect, beforeAll, afterAll */
// The scheduled Razorpay worker pass on REAL MySQL (humancare_test): the gates keep events waiting, a due Razorpay event is applied end to end, a due
// Bitrix24 event in the same table is never touched, and overlapping passes never run twice. Only synthetic PAYTEST_<runid> rows are written.
const guard = require('../../src/common/safety/integration-runner-guard');
const inbox = require('../../src/modules/payments/razorpay-webhook.inbox.store');
const worker = require('../../src/modules/payments/razorpay-webhook.worker');
const { classifyEvent } = require('../../src/modules/payments/razorpay-webhook.events');
const { PaymentsFixture } = require('./helpers/payments-fixture');

const fx = new PaymentsFixture();
let main; let c1; let c2; let baseline; let cleanupReport; let afterSnapshot; let remaining;
let seq = 0;
const GOOD = { PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_WEBHOOK_SECRET: 'FAKE_WEBHOOK_SECRET_VALUE_12345' };
const quiet = () => ({ log: () => {}, warn: () => {}, error: () => {} });
const nextId = (prefix) => { seq += 1; return `${prefix}${fx.runId}${seq}`; };

async function setup() {
  const inv = await fx.buildInvoice(main, {});
  const orderId = nextId('order_');
  const payment = await main.payment.create({
    data: { invoiceId: inv.invoiceId, caseId: inv.caseId, currency: 'INR', kind: 'payment', status: 'pending', method: 'razorpay', amount: inv.amount, razorpayOrderId: orderId, idempotencyKey: fx.name('PAY') },
  });
  fx.track('payment', payment.id);
  const envelope = { event: 'payment.captured', created_at: 1795000000, payload: { payment: { entity: { id: nextId('pay_'), order_id: orderId, amount: 150000, currency: 'INR', status: 'captured' } } } };
  const c = classifyEvent(envelope, { bodySha256: 'a'.repeat(64), eventIdSource: 'header' });
  const externalEventId = fx.name('EVT');
  await inbox.storeEvent(main, { externalEventId, eventType: c.eventType, entityType: c.entityType, entityId: c.entityId, occurredAt: c.occurredAt, payload: c.payload, status: c.status, lastError: c.lastError });
  const row = await main.integrationInbox.findUnique({ where: { source_externalEventId: { source: 'razorpay', externalEventId } } });
  fx.track('inbox', row.id);
  return { inv, payment, inboxId: row.id };
}
const bitrixRow = async () => {
  const row = await main.integrationInbox.create({
    data: { source: 'bitrix24', externalEventId: fx.name('BX'), eventType: 'ONCRMDEALUPDATE', entityType: 'deal', entityId: '4711', payload: { event: 'ONCRMDEALUPDATE', dealId: '4711' }, status: 'received', nextAttemptAt: new Date(0) },
  });
  fx.track('inbox', row.id);
  return row;
};
const inboxOf = (id) => main.integrationInbox.findUnique({ where: { id }, select: { status: true, attempts: true, lockedBy: true, lastError: true } });
const paymentOf = (id) => main.payment.findUnique({ where: { id } });

beforeAll(async () => {
  guard.assertIntegrationEnvironment(process.env);
  main = fx.newClient('main'); c1 = fx.newClient('c1'); c2 = fx.newClient('c2');
  const live = await guard.verifyLiveIdentity(main);
  expect(live.database).toBe('humancare_test');
  baseline = await fx.snapshot(main);
  const [existing] = await main.$queryRaw`SELECT COUNT(*) AS n FROM integration_inbox WHERE source = 'razorpay'`;
  expect(Number(existing.n)).toBe(0); // the pass is set-based over every razorpay row
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

describe('the gates keep events waiting', () => {
  it.each([
    ['payments disabled', { ...GOOD, PAYMENTS_ENABLED: 'false' }, 'payments_disabled'],
    ['no environment id', { ...GOOD, PAYMENTS_ENVIRONMENT_ID: undefined }, 'environment_id_missing'],
    ['no webhook secret', { ...GOOD, RAZORPAY_WEBHOOK_SECRET: undefined }, 'webhook_secret_missing'],
  ])('%s: a due event is neither claimed nor changed', async (_l, env, code) => {
    worker.resetForTests();
    const t = await setup();
    expect(await worker.runRazorpayWebhookWorker({ env, db: main, logger: quiet() })).toEqual({ active: false, code });
    expect(await inboxOf(t.inboxId)).toMatchObject({ status: 'received', attempts: 0, lockedBy: null });
    expect((await paymentOf(t.payment.id)).status).toBe('pending');
    await main.$executeRaw`UPDATE integration_inbox SET next_attempt_at = UTC_TIMESTAMP(3) + INTERVAL 1 DAY WHERE id = ${t.inboxId}`; // parked: later passes must see only their own event
  });
});

describe('a worker pass', () => {
  it('applies a due Razorpay event end to end and never touches a due Bitrix24 event sitting in the same table', async () => {
    worker.resetForTests();
    const t = await setup();
    const bx = await bitrixRow();
    const before = await inboxOf(bx.id);
    const result = await worker.runRazorpayWebhookWorker({ env: GOOD, db: c1, logger: quiet() });
    expect(result).toMatchObject({ active: true, claimed: 1, processed: 1 });
    expect(await inboxOf(t.inboxId)).toMatchObject({ status: 'processed', lockedBy: null });
    expect(await paymentOf(t.payment.id)).toMatchObject({ status: 'completed' });
    expect(await inboxOf(bx.id)).toEqual(before); // not claimed, not recovered, not changed: still waiting for the Bitrix worker
    expect(before).toMatchObject({ status: 'received', attempts: 0 });
  });
  it('a pass with nothing due claims nothing', async () => {
    worker.resetForTests();
    expect(await worker.runRazorpayWebhookWorker({ env: GOOD, db: c1, logger: quiet() })).toMatchObject({ active: true, claimed: 0 });
  });
  it('two passes started together in one process: one runs, the other is skipped; the event is applied once', async () => {
    worker.resetForTests();
    const t = await setup();
    const results = await Promise.all([worker.runRazorpayWebhookWorker({ env: GOOD, db: c1, logger: quiet() }), worker.runRazorpayWebhookWorker({ env: GOOD, db: c2, logger: quiet() })]);
    expect(results.filter((r) => r.skipped === 'already_running')).toHaveLength(1);
    expect(results.filter((r) => r.claimed === 1)).toHaveLength(1);
    expect(await inboxOf(t.inboxId)).toMatchObject({ status: 'processed', attempts: 1 });
    const audits = await main.$queryRawUnsafe("SELECT COUNT(*) AS n FROM audit_logs WHERE case_id = ? AND action = 'payment.completed'", t.inv.caseId);
    expect(Number(audits[0].n)).toBe(1);
  });
  it('a worker in ANOTHER process (simulated by a second pass with a different worker id) can never apply the same event twice: the claim and lease decide', async () => {
    worker.resetForTests();
    const t = await setup();
    const claim = await inbox.claim(c2, { id: t.inboxId, workerId: `PT${fx.runId}-other`, leaseSeconds: 120 });
    expect(claim).not.toBeNull();
    // the scheduled pass runs while the other worker holds a live lease: it must not take the event
    expect(await worker.runRazorpayWebhookWorker({ env: GOOD, db: c1, logger: quiet() })).toMatchObject({ active: true, claimed: 0 });
    expect(await inboxOf(t.inboxId)).toMatchObject({ status: 'processing', lockedBy: claim.workerId });
    expect((await paymentOf(t.payment.id)).status).toBe('pending');
  });
});
