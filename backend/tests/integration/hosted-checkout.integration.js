/* global describe, it, expect, beforeAll, afterAll */
// Hosted Razorpay Checkout on REAL MySQL (humancare_test) through the REAL HTTP handlers (src/app): session creation, the single-use page (the database's
// unique key decides, also under concurrency), ownership and binding, expiry, the browser return in every outcome, and the rule that ONLY the verified
// webhook + worker completes a payment. The Razorpay order comes from the real order service with a FAKE gateway (no network).
// Only synthetic PAYTEST_<runid> rows are written (see helpers/payments-fixture.js).
const crypto = require('crypto');
const request = require('supertest');
const guard = require('../../src/common/safety/integration-runner-guard');
const seed = require('../../scripts/lib/payable-invoice-seed');
const worker = require('../../src/modules/payments/razorpay-webhook.worker');
const orders = require('../../src/modules/payments/payment-orders.service');
const tokens = require('../../src/modules/payments/checkout-session.token');
const { signAccessToken } = require('../../src/modules/auth/auth.service');
const kit = require('../safe/payments-test-kit');
const { PaymentsFixture } = require('./helpers/payments-fixture');

const fx = new PaymentsFixture();
let main; let app; let baseline; let cleanupReport; let afterSnapshot; let remaining; let gateway;
const WEBHOOK_SECRET = 'FAKE_WEBHOOK_SECRET_VALUE_FOR_TESTS_12345';
const saved = {};
const ENV_KEYS = ['JWT_ACCESS_SECRET', 'PAYMENTS_ENABLED', 'PAYMENTS_ENVIRONMENT_ID', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let keyCounter = 0;
const nextKey = () => { keyCounter += 1; return `hostkey-${fx.runId.toLowerCase()}-${String(keyCounter).padStart(6, '0')}`; };

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
// A patient with a payable invoice AND an open Razorpay order (made by the real order service, fake gateway).
async function readyPatient(label) {
  const p = await patient(label);
  const result = await seed.runSeed(main, seed.parseArgs(['--request-id', String(p.requestId), '--user-id', String(p.userId), '--execute']), { marker: fx.name('SEED') });
  const c = result.created;
  fx.track('admin', c.adminId); fx.track('link', c.linkId); fx.track('quotation', c.quotationId); fx.track('invoice', c.invoiceId);
  const made = await orders.createPaymentOrder({
    userId: p.userId, invoiceId: String(c.invoiceId), idempotencyKey: nextKey(), body: { mode: 'full' }, db: main, env: process.env, fetchImpl: gateway.fetchImpl, log: kit.silentLog(),
  });
  return { ...p, invoiceId: c.invoiceId, orderId: made.payload.razorpay.orderId };
}

const sessionOf = (p) => request(app).post(`/invoices/${p.invoiceId}/checkout-sessions`).set(auth(p.token));
const invoiceOf = (p, t = p.token) => request(app).get(`/invoices/${p.invoiceId}`).set(auth(t));
const checkoutAudits = (p) => main.$queryRawUnsafe("SELECT COUNT(*) AS n FROM audit_logs WHERE case_id = ? AND action = 'payment.checkout_opened'", p.caseId).then((r) => Number(r[0].n));

async function sendWebhook(event) {
  const body = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  const eventId = fx.name('EVT');
  const res = await request(app).post('/integrations/razorpay/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', sig).set('x-razorpay-event-id', eventId).send(body);
  const row = await main.integrationInbox.findUnique({ where: { source_externalEventId: { source: 'razorpay', externalEventId: eventId } } });
  if (row) fx.track('inbox', row.id);
  return { res, row };
}
const entity = (event, orderId, paymentId, status) => ({ event, created_at: 1795000000, payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 150000, currency: 'INR', status } } } });
const runWorker = () => worker.runRazorpayWebhookWorker({ env: process.env, db: main, logger: kit.silentLog() });

beforeAll(async () => {
  guard.assertIntegrationEnvironment(process.env);
  main = fx.newClient('main');
  const live = await guard.verifyLiveIdentity(main);
  expect(live.database).toBe('humancare_test');
  baseline = await fx.snapshot(main);
  const [existing] = await main.$queryRaw`SELECT COUNT(*) AS n FROM integration_inbox WHERE source = 'razorpay'`;
  expect(Number(existing.n)).toBe(0); // the worker pass is set-based over every razorpay row
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  if (!process.env.JWT_ACCESS_SECRET) process.env.JWT_ACCESS_SECRET = `host-test-secret-${fx.runId}`;
  Object.assign(process.env, { PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_KEY_ID: kit.KEY_ID, RAZORPAY_KEY_SECRET: kit.SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET });
  gateway = kit.makeGateway({ orderPrefix: `HOST${fx.runId}x` });
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

describe('a valid patient checkout, end to end', () => {
  it('session -> page (once) -> browser return -> still pending -> signed webhook -> worker -> completed; no second order is ever created', async () => {
    const p = await readyPatient('A');
    const createsBefore = gateway.creates().length;

    const made = await sessionOf(p);
    expect(made.status).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    expect(Object.keys(made.body).sort()).toEqual(['checkoutPath', 'expiresAt']);
    expect(made.body.checkoutPath).toMatch(/^\/checkout\/[A-Za-z0-9_.-]+$/);
    expect(JSON.stringify(made.body)).not.toMatch(/Bearer|eyJhbGci/); // no login token in the link

    const page = await request(app).get(made.body.checkoutPath);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+' https:\/\/checkout\.razorpay\.com/);
    expect(page.text).toContain(kit.KEY_ID);
    expect(page.text).toContain(p.orderId);
    for (const secret of [kit.SECRET, WEBHOOK_SECRET, process.env.JWT_ACCESS_SECRET, p.token]) expect(page.text).not.toContain(secret);
    expect(await checkoutAudits(p)).toBe(1);

    // the same link again is refused
    const again = await request(app).get(made.body.checkoutPath);
    expect(again.status).toBe(410);
    expect(again.text).not.toContain(p.orderId);

    // the browser comes back (Razorpay's redirect-mode callback) claiming success: the app is told to wait, the payment is NOT completed
    // the return token travels inside the page's data block
    const cfg = JSON.parse(/<script type="application\/json" id="hc-config">([^<]*)<\/script>/.exec(page.text)[1]);
    expect(Object.keys(cfg).sort()).toEqual(['amount', 'currency', 'invoiceId', 'keyId', 'orderId', 'returnToken']);
    expect(cfg).toMatchObject({ keyId: kit.KEY_ID, orderId: p.orderId, amount: 150000, currency: 'INR', invoiceId: p.invoiceId });
    const back = await request(app).post(`/checkout/return/${cfg.returnToken}`).type('form').send({ razorpay_payment_id: `pay_HOST${fx.runId}A1`, razorpay_order_id: p.orderId, razorpay_signature: 'a'.repeat(64) });
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe(`humancare://payment-return?invoice=${p.invoiceId}&result=submitted`);
    let status = await invoiceOf(p);
    expect(status.body.invoice).toMatchObject({ paid: '0.00', hasOpenPayment: true });
    expect(status.body.invoice.payments[0].status).toBe('pending');

    // the verified webhook is the only thing that completes it
    const received = await sendWebhook(entity('payment.captured', p.orderId, `pay_HOST${fx.runId}A1`, 'captured'));
    expect(received.res.status).toBe(200);
    expect(await runWorker()).toMatchObject({ active: true, claimed: 1, processed: 1 });
    status = await invoiceOf(p);
    expect(status.body.invoice).toMatchObject({ paid: '1500.00', balance: '0.00', payable: false, hasOpenPayment: false });
    expect(status.body.invoice.payments[0].status).toBe('completed');
    expect(gateway.creates().length).toBe(createsBefore); // the hosted flow created no order
    expect(await main.payment.count({ where: { invoiceId: p.invoiceId } })).toBe(1); // and no payment

    // once paid, no new session can be made
    expect((await sessionOf(p)).status).toBe(409);
  });
});

describe('single use, for real', () => {
  it('four simultaneous requests for one session: exactly one gets the page, three are refused, one audit row', async () => {
    const p = await readyPatient('B');
    const { body } = await sessionOf(p);
    const results = await Promise.all([1, 2, 3, 4].map(() => request(app).get(body.checkoutPath)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 410, 410, 410]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await checkoutAudits(p)).toBe(1);
  });
  it('two different sessions for the same payment are each good once', async () => {
    const p = await readyPatient('C');
    const a = (await sessionOf(p)).body.checkoutPath; const b = (await sessionOf(p)).body.checkoutPath;
    expect((await request(app).get(a)).status).toBe(200);
    expect((await request(app).get(b)).status).toBe(200);
    expect((await request(app).get(a)).status).toBe(410);
    expect(await checkoutAudits(p)).toBe(2);
  });
});

describe('expiry, ownership and binding', () => {
  it('an expired session is refused and not consumed; garbage and tampered links are invalid', async () => {
    const p = await readyPatient('D');
    const payment = await main.payment.findFirst({ where: { invoiceId: p.invoiceId } });
    const old = tokens.signToken('s', { userId: p.userId, invoiceId: p.invoiceId, paymentId: payment.id }, { now: new Date(Date.now() - 11 * 60 * 1000) });
    const expired = await request(app).get(`/checkout/${old.token}`);
    expect(expired.status).toBe(410);
    expect(expired.text).toContain('expired');
    expect(await checkoutAudits(p)).toBe(0);
    expect((await request(app).get('/checkout/garbage')).status).toBe(400);
    const fresh = tokens.signToken('s', { userId: p.userId, invoiceId: p.invoiceId, paymentId: payment.id });
    const [payload, signature] = fresh.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), uid: p.userId + 1 })).toString('base64url');
    expect((await request(app).get(`/checkout/${forged}.${signature}`)).status).toBe(400);
    expect(await checkoutAudits(p)).toBe(0);
  });
  it('another patient cannot create a session for this invoice (the same 404 as a missing invoice); a signed token for the wrong patient or the wrong invoice opens nothing', async () => {
    const a = await readyPatient('E');
    const b = await readyPatient('F');
    const theirs = await request(app).post(`/invoices/${a.invoiceId}/checkout-sessions`).set(auth(b.token));
    const missing = await request(app).post('/invoices/2147483000/checkout-sessions').set(auth(b.token));
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual(missing.body);
    const payA = await main.payment.findFirst({ where: { invoiceId: a.invoiceId } });
    const payB = await main.payment.findFirst({ where: { invoiceId: b.invoiceId } });
    const wrongPatient = tokens.signToken('s', { userId: b.userId, invoiceId: a.invoiceId, paymentId: payA.id });
    const wrongInvoice = tokens.signToken('s', { userId: a.userId, invoiceId: a.invoiceId, paymentId: payB.id });
    for (const t of [wrongPatient, wrongInvoice]) {
      const r = await request(app).get(`/checkout/${t.token}`);
      expect(r.status).toBe(409);
      expect(r.text).not.toMatch(/rzp_|order_/);
    }
    expect(await checkoutAudits(a)).toBe(0);
    expect(await checkoutAudits(b)).toBe(0);
  });
  it('no session without an open payment, and none for an invoice with no payment started: the hosted page never creates an order', async () => {
    const p = await patient('G');
    const result = await seed.runSeed(main, seed.parseArgs(['--request-id', String(p.requestId), '--user-id', String(p.userId), '--execute']), { marker: fx.name('SEED') });
    const c = result.created;
    fx.track('admin', c.adminId); fx.track('link', c.linkId); fx.track('quotation', c.quotationId); fx.track('invoice', c.invoiceId);
    const createsBefore = gateway.creates().length;
    const r = await request(app).post(`/invoices/${c.invoiceId}/checkout-sessions`).set(auth(p.token));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'no_open_payment' });
    expect(gateway.creates().length).toBe(createsBefore);
    expect(await main.payment.count({ where: { invoiceId: c.invoiceId } })).toBe(0);
  });
});

describe('failed, cancelled and abandoned checkouts', () => {
  it('a failed attempt (webhook) leaves the payment pending and the patient can open a new session; a cancel return and an abandoned browser change nothing', async () => {
    const p = await readyPatient('H');
    const first = (await sessionOf(p)).body.checkoutPath;
    const page = await request(app).get(first);
    const cfg = JSON.parse(/<script type="application\/json" id="hc-config">([^<]*)<\/script>/.exec(page.text)[1]);

    // the patient cancels: the page leaves through the return route with "cancelled"
    const cancel = await request(app).get(`/checkout/return/${cfg.returnToken}?result=cancelled`);
    expect(cancel.status).toBe(303);
    expect(cancel.headers.location).toBe(`humancare://payment-return?invoice=${p.invoiceId}&result=cancelled`);
    // Razorpay reports a failed attempt (error post to the callback, and the verified webhook)
    const failedPost = await request(app).post(`/checkout/return/${cfg.returnToken}`).type('form').send({ 'error[code]': 'BAD_REQUEST_ERROR', 'error[description]': 'private detail' });
    expect(failedPost.headers.location).toBe(`humancare://payment-return?invoice=${p.invoiceId}&result=failed`);
    expect(failedPost.text).not.toContain('private detail');
    expect((await sendWebhook(entity('payment.failed', p.orderId, `pay_HOST${fx.runId}H1`, 'failed'))).res.status).toBe(200);
    expect(await runWorker()).toMatchObject({ active: true, claimed: 1, processed: 1 });

    let status = await invoiceOf(p);
    expect(status.body.invoice).toMatchObject({ paid: '0.00', hasOpenPayment: true });
    expect(status.body.invoice.payments[0].status).toBe('pending'); // one failed attempt is not the end of the order

    // abandoned: the browser was simply closed. Nothing happened on the server, the order is still open, and a NEW session works
    const retry = await sessionOf(p);
    expect(retry.status).toBe(201);
    expect((await request(app).get(retry.body.checkoutPath)).status).toBe(200);
    status = await invoiceOf(p);
    expect(status.body.invoice.payments[0].status).toBe('pending');
    expect(await main.payment.count({ where: { invoiceId: p.invoiceId } })).toBe(1);
  });
  it('a browser claiming success without any webhook never completes anything, however often it comes back', async () => {
    const p = await readyPatient('I');
    const page = await request(app).get((await sessionOf(p)).body.checkoutPath);
    const cfg = JSON.parse(/<script type="application\/json" id="hc-config">([^<]*)<\/script>/.exec(page.text)[1]);
    for (let i = 0; i < 3; i += 1) {
      await request(app).post(`/checkout/return/${cfg.returnToken}`).type('form').send({ razorpay_payment_id: `pay_HOST${fx.runId}I${i}`, razorpay_order_id: p.orderId, razorpay_signature: 'b'.repeat(64) });
      await request(app).get(`/checkout/return/${cfg.returnToken}?result=submitted`);
    }
    expect(await runWorker()).toMatchObject({ active: true, claimed: 0 }); // no webhook was stored: there is nothing to apply
    const payment = await main.payment.findFirst({ where: { invoiceId: p.invoiceId } });
    expect(payment).toMatchObject({ status: 'pending', externalReference: null, transactedAt: null });
    expect((await invoiceOf(p)).body.invoice).toMatchObject({ paid: '0.00', hasOpenPayment: true });
  });
});
