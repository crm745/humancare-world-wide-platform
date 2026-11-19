/* global describe, test, expect, jest, beforeAll, beforeEach, afterAll, afterEach */
// Phase 4 over HTTP (real src/app.js, supertest): the invoice that follows an acceptance, the patient's retry, and the Admin endpoints.
// Prisma is the in-memory fake, uploads and ClamAV are stubs, the network is blocked.
jest.mock('../../src/db/prisma', () => ({ prisma: require('./quotation-route-kit').db }));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const os = require('os');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { world, db, reset, kit } = require('./quotation-route-kit');
const { createLocalStorage } = require('../../src/modules/bitrix/quotation-storage');
const { app } = require('../../src/app');

const SECRET = 'fake-route-jwt-secret-0123456789';
const token = (payload) => jwt.sign(payload, SECRET, { expiresIn: '5m' });
const OWNER = token({ sub: 55, role: 'patient' });
const STRANGER = token({ sub: 56, role: 'patient' });
const ADMIN = token({ sub: 7, role: 'admin' });
const CORPORATE = token({ sub: 3, role: 'corporate', corporateId: 1 });
const EXPIRED = jwt.sign({ sub: 55, role: 'patient' }, SECRET, { expiresIn: -10 });
const FORGED = jwt.sign({ sub: 55, role: 'patient' }, 'another-secret-another-secret-12345', { expiresIn: '5m' });

const storage = createLocalStorage({ root: os.tmpdir() });
const written = [];
const HOUR = 3600 * 1000;
let savedEnv; let spies; let seq = 0;

beforeAll(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, { JWT_ACCESS_SECRET: SECRET, NODE_ENV: 'test' });
  spies = ['log', 'info', 'warn', 'error'].map((n) => jest.spyOn(console, n).mockImplementation(() => undefined));
});
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  spies.forEach((s) => s.mockRestore());
});
beforeEach(() => { reset(); jest.clearAllMocks(); });
afterEach(async () => { for (const key of written.splice(0)) await storage.remove(key).catch(() => undefined); });

async function seed(over = {}) {
  seq += 1;
  const bytes = kit.pdf(`ir${seq}-${process.pid}`);
  const hash = kit.sha(bytes);
  const key = `quotations/case-3037/evir${seq}-${process.pid}-${hash}.pdf`;
  await storage.putIfAbsent(key, bytes, hash);
  written.push(key);
  const status = over.status || 'published';
  const now = Date.now();
  return db.caseQuotation.create({
    data: {
      caseId: 3037, dealLinkId: 1173, versionNumber: seq, bitrixDealId: kit.DEAL, bitrixFileId: String(67000 + seq), bitrixAmountRaw: '1000', bitrixCurrencyRaw: 'INR', bitrixDealStageId: 'C38:NEW',
      contentFingerprint: hash, storageProvider: 'local', storageKey: key, sizeBytes: bytes.length, sha256: hash, amount: '1000.000', currency: 'INR', validationError: null, status,
      workingSlot: null, liveSlot: ['published', 'accepted'].includes(status) ? 1 : null, scanStatus: 'clean', revision: 5, lastSeenAt: new Date(),
      confirmedByAdminId: 7, confirmedAt: new Date(now - 3 * HOUR), publishedByAdminId: 7, publishedAt: new Date(now - 2 * HOUR),
      ...(status === 'accepted' ? { decidedByUserId: 55, decidedAt: new Date(now - HOUR) } : {}),
      ...over,
    },
  });
}
const call = (method, url, auth) => { const r = request(app)[method](url); return auth ? r.set('Authorization', `Bearer ${auth}`) : r; };

describe('POST /quotations/:id/accept creates the invoice and reports its state', () => {
  test('accepting answers 201 with the quotation and invoice.status ready; one invoice exists', async () => {
    const q = await seed();
    const res = await call('post', `/quotations/${q.id}/accept`, OWNER).send({});
    expect(res.status).toBe(201);
    expect(res.body.quotation.status).toBe('accepted');
    expect(res.body.invoice).toEqual({ status: 'ready' });
    expect(world.invoices).toHaveLength(1);
    expect(world.invoices[0]).toMatchObject({ quotationId: q.id, amount: '1000.000', currency: 'INR', status: 'issued', allowPartialPayment: false });
    expect(res.text).not.toMatch(/idempotency/i);
  });

  test('repeating the accept answers 200 and creates no second invoice or audit row', async () => {
    const q = await seed();
    await call('post', `/quotations/${q.id}/accept`, OWNER).send({});
    const audit = world.audit.length;
    const again = await call('post', `/quotations/${q.id}/accept`, OWNER).send({});
    expect(again.status).toBe(200);
    expect(again.body.invoice).toEqual({ status: 'ready' });
    expect(world.invoices).toHaveLength(1);
    expect(world.audit).toHaveLength(audit);
  });

  test('if invoice creation fails the acceptance stands (201, invoice pending) and the retry endpoint completes it', async () => {
    const q = await seed();
    const real = db.invoice.create;
    db.invoice.create = jest.fn(async () => { throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); });
    const res = await call('post', `/quotations/${q.id}/accept`, OWNER).send({});
    expect(res.status).toBe(201);
    expect(res.body.quotation.status).toBe('accepted');
    expect(res.body.invoice).toEqual({ status: 'pending' });
    expect(world.quotations[0]).toMatchObject({ status: 'accepted', decidedByUserId: 55 });
    expect(world.invoices).toHaveLength(0);
    expect(world.audit.map((a) => a.action)).toEqual(['quotation.accepted', 'invoice.creation_failed']);
    db.invoice.create = real;
    const retry = await call('post', `/quotations/${q.id}/invoice`, OWNER).send({});
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ invoice: { status: 'ready', invoiceNumber: `INV-${kit.REF}-V${q.versionNumber}` } });
    expect((await call('post', `/quotations/${q.id}/invoice`, OWNER).send({})).status).toBe(200);
    expect(world.invoices).toHaveLength(1);
  });

  test('rejecting creates no invoice; the invoice endpoint refuses a rejected or unpublished quotation', async () => {
    const q = await seed();
    await call('post', `/quotations/${q.id}/reject`, OWNER).send({ reason: 'Too expensive for me' });
    expect(world.invoices).toHaveLength(0);
    const refused = await call('post', `/quotations/${q.id}/invoice`, OWNER).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('quotation_not_accepted');
    const draft = await seed({ status: 'confirmed', publishedAt: null, publishedByAdminId: null });
    expect((await call('post', `/quotations/${draft.id}/invoice`, OWNER).send({})).status).toBe(404);
    expect(world.invoices).toHaveLength(0);
  });
});

describe('POST /quotations/:id/invoice authentication and ownership', () => {
  test('401 without a valid token, refused to Admin and corporate, 404 for another patient', async () => {
    const q = await seed({ status: 'accepted' });
    for (const bad of [null, EXPIRED, FORGED]) expect((await call('post', `/quotations/${q.id}/invoice`, bad).send({})).status).toBe(401);
    for (const auth of [ADMIN, CORPORATE]) expect([401, 403]).toContain((await call('post', `/quotations/${q.id}/invoice`, auth).send({})).status);
    expect((await call('post', `/quotations/${q.id}/invoice`, STRANGER).send({})).status).toBe(404);
    expect(world.invoices).toHaveLength(0);
  });
});

describe('Admin endpoints', () => {
  test('only an Admin may use the awaiting list, the manual retry and the partial-payment authorization', async () => {
    const q = await seed({ status: 'accepted' });
    for (const [method, url] of [['get', '/admin/invoices/awaiting'], ['post', `/admin/quotations/${q.id}/invoice`], ['post', '/admin/invoices/1/partial-payment']]) {
      expect([401, 403]).toContain((await call(method, url, null).send({})).status);
      expect([401, 403]).toContain((await call(method, url, OWNER).send({})).status);
    }
    expect(world.invoices).toHaveLength(0);
  });

  test('an Admin sees the accepted quotation without an invoice, retries it, and authorizes partial payment once', async () => {
    const q = await seed({ status: 'accepted' });
    const list = await call('get', '/admin/invoices/awaiting', ADMIN);
    expect(list.status).toBe(200);
    expect(list.body.quotations.map((r) => r.id)).toEqual([q.id]);
    const made = await call('post', `/admin/quotations/${q.id}/invoice`, ADMIN).send({});
    expect(made.status).toBe(201);
    expect(made.body.created).toBe(true);
    expect((await call('post', `/admin/quotations/${q.id}/invoice`, ADMIN).send({})).status).toBe(200);
    expect((await call('get', '/admin/invoices/awaiting', ADMIN)).body.quotations).toEqual([]);
    const auth = await call('post', `/admin/invoices/${made.body.invoice.id}/partial-payment`, ADMIN).send({});
    expect(auth.status).toBe(201);
    expect(auth.body.invoice).toMatchObject({ allowPartialPayment: true, partialPaymentAuthorizedByAdminId: 7 });
    expect((await call('post', `/admin/invoices/${made.body.invoice.id}/partial-payment`, ADMIN).send({})).status).toBe(200);
    expect(world.audit.filter((a) => a.action === 'invoice.partial_payment_authorized')).toHaveLength(1);
    expect(world.invoices).toHaveLength(1);
  });
});
