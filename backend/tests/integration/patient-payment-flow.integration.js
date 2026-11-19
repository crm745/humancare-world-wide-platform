/* global describe, it, expect, beforeAll, afterAll */
// The whole patient payment path on REAL MySQL (humancare_test) through the REAL HTTP handlers (src/app): the guarded seed makes a request payable, the
// patient sees the invoice (GET /requests/me/:id, GET /invoices/:id), an order is created through the real order service with a FAKE gateway (no network),
// a signed webhook is received, the Razorpay worker applies it, and the patient's status shows the payment completed. Ownership, tampering and "the app's
// own say-so never completes a payment" are checked. Only synthetic PAYTEST_<runid> rows are written (see helpers/payments-fixture.js).
const crypto = require('crypto');
const request = require('supertest');
const guard = require('../../src/common/safety/integration-runner-guard');
const seed = require('../../scripts/lib/payable-invoice-seed');
const worker = require('../../src/modules/payments/razorpay-webhook.worker');
const orders = require('../../src/modules/payments/payment-orders.service');
const { signAccessToken } = require('../../src/modules/auth/auth.service');
const kit = require('../safe/payments-test-kit');
const { PaymentsFixture } = require('./helpers/payments-fixture');

const fx = new PaymentsFixture();
let main; let app; let baseline; let cleanupReport; let afterSnapshot; let remaining; let gateway;
const WEBHOOK_SECRET = 'FAKE_WEBHOOK_SECRET_VALUE_FOR_TESTS_12345';
const saved = {};
const ENV_KEYS = ['JWT_ACCESS_SECRET', 'PAYMENTS_ENABLED', 'PAYMENTS_ENVIRONMENT_ID', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];

// A patient with a Private Charter request and its Case (synthetic, registered for cleanup).
async function patient(label) {
  const n = fx.counter + 1;
  const user = await main.user.create({ data: { name: fx.name(`PATIENT${label}`), email: `${fx.prefix}_${label}${n}@example.invalid` } });
  fx.track('user', user.id);
  const req = await main.serviceRequest.create({
    data: { userId: user.id, serviceType: 'PAYTEST synthetic', serviceKey: 'privatecharter', patientName: fx.name('PATIENT'), origin: 'Synthetic-A', destination: 'Synthetic-B', referenceNumber: fx.name('SR') },
  });
  fx.track('request', req.id);
  const kase = await main.case.create({
    data: { serviceRequestId: req.id, referenceNumber: fx.name('CASE'), patientName: fx.name('PATIENT'), serviceType: 'PAYTEST synthetic', origin: 'Synthetic-A', destination: 'Synthetic-B' },
  });
  fx.track('case', kase.id);
  return { userId: user.id, requestId: req.id, caseId: kase.id, token: signAccessToken({ sub: user.id, role: 'patient' }) };
}

async function seedFor(p, extra = []) {
  const options = seed.parseArgs(['--request-id', String(p.requestId), '--user-id', String(p.userId), '--execute', ...extra]);
  const result = await seed.runSeed(main, options, { marker: fx.name("SEED") });
  const c = result.created;
  fx.track('admin', c.adminId); fx.track('link', c.linkId); fx.track('quotation', c.quotationId); fx.track('invoice', c.invoiceId);
  return c;
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });
let keyCounter = 0;
const nextKey = () => { keyCounter += 1; return `flowkey-${fx.runId.toLowerCase()}-${String(keyCounter).padStart(6, '0')}`; };
const createOrder = (p, invoiceId, key) => orders.createPaymentOrder({
  userId: p.userId, invoiceId: String(invoiceId), idempotencyKey: key, body: { mode: 'full' }, db: main, env: process.env, fetchImpl: gateway.fetchImpl, log: kit.silentLog(),
});

async function sendWebhook(event, { secret = WEBHOOK_SECRET, signature } = {}) {
  const body = JSON.stringify(event);
  const sig = signature || crypto.createHmac('sha256', secret).update(body).digest('hex');
  const eventId = fx.name('EVT');
  const res = await request(app).post('/integrations/razorpay/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', sig).set('x-razorpay-event-id', eventId).send(body);
  const row = await main.integrationInbox.findUnique({ where: { source_externalEventId: { source: 'razorpay', externalEventId: eventId } } });
  if (row) fx.track('inbox', row.id);
  return { res, row };
}
const capturedEvent = (orderId, paymentId, amount = 150000) => ({ event: 'payment.captured', created_at: 1795000000, payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured', email: 'must-not-be-stored@example.invalid' } } } });

beforeAll(async () => {
  guard.assertIntegrationEnvironment(process.env);
  main = fx.newClient('main');
  const live = await guard.verifyLiveIdentity(main);
  expect(live.database).toBe('humancare_test');
  baseline = await fx.snapshot(main);
  const [existing] = await main.$queryRaw`SELECT COUNT(*) AS n FROM integration_inbox WHERE source = 'razorpay'`;
  expect(Number(existing.n)).toBe(0); // the worker pass is set-based over every razorpay row
  // The test's OWN process environment (never a file): fake Test Mode settings, and a JWT secret if the isolated file has none.
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  if (!process.env.JWT_ACCESS_SECRET) process.env.JWT_ACCESS_SECRET = `flow-test-secret-${fx.runId}`;
  Object.assign(process.env, { PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_KEY_ID: kit.KEY_ID, RAZORPAY_KEY_SECRET: kit.SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET });
  gateway = kit.makeGateway({ orderPrefix: `FLOW${fx.runId}x` });
  ({ app } = require('../../src/app'));
}, 60000);

afterAll(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  try {
    cleanupReport = await fx.cleanup(main);
    remaining = await fx.remaining(main);
    afterSnapshot = await fx.snapshot(main);
  } finally {
    await fx.disconnectAll();
    await require('../../src/db/prisma').prisma.$disconnect();
  }
  expect(cleanupReport.failures).toEqual([]);
  expect(Object.values(remaining).every((n) => n === 0)).toBe(true);
  expect(afterSnapshot.counts).toEqual(baseline.counts);
  expect(afterSnapshot.checksums).toEqual(baseline.checksums);
}, 120000);

describe('the guarded seed on the real database', () => {
  it('a dry run writes nothing; a wrong patient is refused; the real run makes the request payable; a second seed on the same Case is refused', async () => {
    const p = await patient('A');
    const stranger = await patient('B');
    const count = () => main.$queryRaw`SELECT (SELECT COUNT(*) FROM invoices) AS i, (SELECT COUNT(*) FROM case_quotations) AS q, (SELECT COUNT(*) FROM admin_users) AS a, (SELECT COUNT(*) FROM bitrix_deal_links) AS l`;
    const before = await count();
    const dry = await seed.runSeed(main, seed.parseArgs(['--request-id', String(p.requestId), '--user-id', String(p.userId)]));
    expect(dry).toMatchObject({ executed: false, plan: { caseId: p.caseId, versionNumber: 1 } });
    expect(await count()).toEqual(before);
    // the OTHER patient's id with this request id: refused, nothing written
    await expect(seed.runSeed(main, seed.parseArgs(['--request-id', String(p.requestId), '--user-id', String(stranger.userId), '--execute']))).rejects.toMatchObject({ code: 'request_not_found_for_this_patient' });
    expect(await count()).toEqual(before);
    const c = await seedFor(p, ['--due-days', '30']);
    const invoice = await main.invoice.findUnique({ where: { id: c.invoiceId } });
    expect(invoice).toMatchObject({ caseId: p.caseId, status: 'issued', source: 'quotation', currency: 'INR', quotationId: c.quotationId });
    expect(String(invoice.amount)).toBe('1500');
    const quotation = await main.caseQuotation.findUnique({ where: { id: c.quotationId } });
    expect(quotation).toMatchObject({ status: 'accepted', liveSlot: 1, decidedByUserId: p.userId, versionNumber: 1 });
    await expect(seed.runSeed(main, seed.parseArgs(['--request-id', String(p.requestId), '--user-id', String(p.userId), '--execute']))).rejects.toMatchObject({ code: 'case_already_has_a_live_quotation' });
  });
});

describe('invoice viewing and ownership over HTTP', () => {
  it('the patient sees the invoice in the request details and in GET /invoices/:id; another patient sees nothing; no internal data leaks', async () => {
    const p = await patient('C');
    const other = await patient('D');
    const c = await seedFor(p);
    const details = await request(app).get(`/requests/me/${p.requestId}`).set(auth(p.token));
    expect(details.status).toBe(200);
    expect(details.body.request.invoices).toEqual([{
      id: c.invoiceId, status: 'issued', amount: '1500.00', currency: 'INR', dueDate: null, allowPartialPayment: false, paid: '0.00', balance: '1500.00',
      payable: true, payableReason: null, hasOpenPayment: false, payments: [],
    }]);
    const one = await request(app).get(`/invoices/${c.invoiceId}`).set(auth(p.token));
    expect(one.status).toBe(200);
    expect(one.headers['cache-control']).toBe('no-store');
    expect(one.body.invoice).toEqual(details.body.request.invoices[0]);
    // another patient: the request is not theirs (404), the invoice is not theirs (the same 404 as a missing invoice)
    expect((await request(app).get(`/requests/me/${p.requestId}`).set(auth(other.token))).status).toBe(404);
    const theirs = await request(app).get(`/invoices/${c.invoiceId}`).set(auth(other.token));
    const missing = await request(app).get('/invoices/2147483000').set(auth(other.token));
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual(missing.body);
    // a patient with no invoice sees an empty list
    expect((await request(app).get(`/requests/me/${other.requestId}`).set(auth(other.token))).body.request.invoices).toEqual([]);
    expect((await request(app).get(`/invoices/${c.invoiceId}`)).status).toBe(401);
  });
});

describe('from the invoice to a payment confirmed by the verified webhook', () => {
  it('order -> (Checkout happens in the app, which proves nothing) -> signed webhook -> worker -> the patient sees the payment completed', async () => {
    const p = await patient('E');
    const c = await seedFor(p);

    // 1. the order (fake gateway): the response carries only what Checkout needs
    const key = nextKey();
    const made = await createOrder(p, c.invoiceId, key);
    const createsAfterOrder = gateway.creates().length;
    expect(made).toMatchObject({ outcome: 'ok', created: true });
    const { razorpay, ...rest } = made.payload;
    expect(Object.keys(razorpay).sort()).toEqual(['amount', 'currency', 'keyId', 'orderId']);
    expect(razorpay).toMatchObject({ keyId: kit.KEY_ID, amount: 150000, currency: 'INR' });
    expect(rest).toMatchObject({ invoiceId: c.invoiceId, status: 'pending', amount: '1500.00', currency: 'INR' });
    expect(JSON.stringify(made.payload)).not.toMatch(/FAKE_SECRET|receipt|hc_|notes/i);
    const orderId = razorpay.orderId;

    // 2. the patient's status while Checkout is open
    const open = await request(app).get(`/invoices/${c.invoiceId}`).set(auth(p.token));
    expect(open.body.invoice).toMatchObject({ hasOpenPayment: true, paid: '0.00', balance: '1500.00' });
    expect(open.body.invoice.payments).toHaveLength(1);
    expect(open.body.invoice.payments[0]).toMatchObject({ kind: 'payment', status: 'pending', amount: '1500.00' });

    // 3. a forged or unsigned webhook is refused and stores nothing
    const payId = `pay_FLOW${fx.runId}A1`;
    const forged = await sendWebhook(capturedEvent(orderId, payId), { secret: 'a-different-secret-value-xxxxxxxxxxxx' });
    expect(forged.res.status).toBe(401);
    expect(forged.row).toBeNull();

    // 4. the genuine webhook is received and stored (allow-listed fields only) ... but receiving it completes NOTHING
    const received = await sendWebhook(capturedEvent(orderId, payId));
    expect(received.res.status).toBe(200);
    expect(received.res.body).toEqual({ ok: true });
    expect(received.row).toMatchObject({ source: 'razorpay', status: 'received', eventType: 'payment.captured' });
    expect(JSON.stringify(received.row.payload)).not.toMatch(/must-not-be-stored|email/);
    let status = await request(app).get(`/invoices/${c.invoiceId}`).set(auth(p.token));
    expect(status.body.invoice).toMatchObject({ paid: '0.00', hasOpenPayment: true });
    expect(status.body.invoice.payments[0].status).toBe('pending');

    // 5. the worker applies the verified event
    expect(await worker.runRazorpayWebhookWorker({ env: process.env, db: main, logger: kit.silentLog() })).toMatchObject({ active: true, claimed: 1, processed: 1 });
    expect(await main.integrationInbox.findUnique({ where: { id: received.row.id }, select: { status: true } })).toEqual({ status: 'processed' });

    // 6. the patient now sees the payment completed and the invoice fully paid
    status = await request(app).get(`/invoices/${c.invoiceId}`).set(auth(p.token));
    expect(status.body.invoice).toMatchObject({ paid: '1500.00', balance: '0.00', payable: false, payableReason: 'fully_paid', hasOpenPayment: false });
    expect(status.body.invoice.payments[0]).toMatchObject({ status: 'completed', amount: '1500.00' });
    expect(status.body.invoice.payments[0].transactedAt).toBe(new Date(1795000000 * 1000).toISOString()); // D3: Razorpay's own created_at
    expect(JSON.stringify(status.body)).not.toMatch(/pay_FLOW|order_FLOW|rzp|idempotency/i);
    const again = await request(app).get(`/requests/me/${p.requestId}`).set(auth(p.token));
    expect(again.body.request.invoices[0]).toMatchObject({ paid: '1500.00', payable: false });

    // 7. a retry of the order request after completion returns the status only: no new order, no checkout block
    const replay = await createOrder(p, c.invoiceId, key);
    expect(replay.payload).toMatchObject({ status: 'completed' });
    expect(replay.payload.razorpay).toBeUndefined();
    expect(gateway.creates()).toHaveLength(createsAfterOrder); // Razorpay was not asked for another order
    // and a fresh order for the paid invoice is refused
    await expect(createOrder(p, c.invoiceId, nextKey())).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a duplicate delivery of the same event changes nothing further', async () => {
    const p = await patient('F');
    const c = await seedFor(p);
    const made = await createOrder(p, c.invoiceId, nextKey());
    const event = capturedEvent(made.payload.razorpay.orderId, `pay_FLOW${fx.runId}B1`);
    await sendWebhook(event);
    expect((await worker.runRazorpayWebhookWorker({ env: process.env, db: main, logger: kit.silentLog() })).processed).toBe(1);
    const second = await sendWebhook(event); // Razorpay retries: a different event id, the same signed body
    expect(second.res.status).toBe(200);
    await worker.runRazorpayWebhookWorker({ env: process.env, db: main, logger: kit.silentLog() });
    const payments = await main.payment.findMany({ where: { invoiceId: c.invoiceId } });
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('completed');
    const audits = await main.$queryRawUnsafe("SELECT COUNT(*) AS n FROM audit_logs WHERE case_id = ? AND action = 'payment.completed'", p.caseId);
    expect(Number(audits[0].n)).toBe(1);
  });
});
