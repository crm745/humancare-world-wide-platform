/* global describe, test, expect, jest, beforeAll, beforeEach, afterAll, afterEach */
// The patient's quotation endpoints through the REAL application (src/app.js) over HTTP with supertest: authentication, ownership, request
// validation, decision answers, the PDF response. Prisma is the in-memory fake, uploads and ClamAV are stubs, the network is blocked.
jest.mock('../../src/db/prisma', () => ({ prisma: require('./quotation-route-kit').db }));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass }, uploadPatient: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const fs = require('fs');
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
let savedEnv; let spies;
const HOUR = 3600 * 1000;

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

let seq = 0;
async function seed(over = {}) {
  seq += 1;
  const bytes = over.bytes || kit.pdf(`pr${seq}-${process.pid}`);
  const hash = kit.sha(bytes);
  const key = `quotations/case-3037/evpr${seq}-${process.pid}-${hash}.pdf`;
  await storage.putIfAbsent(key, bytes, hash);
  written.push(key);
  const { bytes: _b, ...rest } = over;
  const status = rest.status || 'published';
  const now = Date.now();
  return db.caseQuotation.create({
    data: {
      caseId: 3037, dealLinkId: 1173, versionNumber: seq, bitrixDealId: kit.DEAL, bitrixFileId: String(65000 + seq), bitrixAmountRaw: '1000', bitrixCurrencyRaw: 'INR', bitrixDealStageId: 'C38:NEW',
      contentFingerprint: hash, storageProvider: 'local', storageKey: key, sizeBytes: bytes.length, sha256: hash, amount: '1000.000', currency: 'INR', validationError: null, status,
      workingSlot: ['draft', 'confirmed'].includes(status) ? 1 : null, liveSlot: ['published', 'accepted'].includes(status) ? 1 : null, scanStatus: 'clean', revision: 5, lastSeenAt: new Date(),
      ...(status !== 'draft' ? { confirmedByAdminId: 7, confirmedAt: new Date(now - 3 * HOUR) } : {}),
      ...(['published', 'accepted', 'rejected', 'superseded'].includes(status) ? { publishedByAdminId: 7, publishedAt: new Date(now - 2 * HOUR) } : {}),
      ...(status === 'accepted' ? { decidedByUserId: 55, decidedAt: new Date(now - HOUR) } : {}),
      ...rest,
    },
  });
}

const call = (method, url, auth) => { const r = request(app)[method](url); return auth ? r.set('Authorization', `Bearer ${auth}`) : r; };
const ROUTES = [['get', '/requests/me/4672/quotation'], ['get', '/quotations/1/file'], ['post', '/quotations/1/accept'], ['post', '/quotations/1/reject']];

describe('authentication', () => {
  test.each(ROUTES)('%s %s without a token, with an expired or forged one, is 401', async (method, url) => {
    for (const bad of [null, EXPIRED, FORGED, 'not.a.jwt']) expect((await call(method, url, bad).send({})).status).toBe(401);
  });

  test.each(ROUTES)('%s %s is refused to an Admin and to a corporate user, with no quotation data', async (method, url) => {
    for (const auth of [ADMIN, CORPORATE]) {
      const res = await call(method, url, auth).send({ reason: 'no thank you' });
      expect([401, 403]).toContain(res.status);
      expect(res.body).not.toHaveProperty('quotation');
    }
  });

  test('refused requests change nothing', async () => {
    const q = await seed();
    await call('post', `/quotations/${q.id}/accept`, ADMIN).send({});
    await call('post', `/quotations/${q.id}/reject`, null).send({ reason: 'no thank you' });
    expect(world.quotations[0]).toMatchObject({ status: 'published', decidedByUserId: null, revision: 5 });
    expect(world.audit).toEqual([]);
  });
});

describe('seeing the quotation', () => {
  test('the owner gets the active published quotation, uncached, with nothing internal', async () => {
    const q = await seed({ validUntil: new Date(Date.now() + 24 * HOUR) });
    const res = await call('get', '/requests/me/4672/quotation', OWNER);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body.quotation).toMatchObject({ id: q.id, versionNumber: q.versionNumber, status: 'published', amount: '1000.000', currency: 'INR', expired: false, canDecide: true, fileAvailable: true });
    expect(res.text).not.toMatch(/quotations\/case-|storageKey|sha256|evpr|\.pdf|bitrix|confirmedBy/i);
  });

  test('no quotation yet, or only unpublished ones: an empty answer, not an error', async () => {
    expect((await call('get', '/requests/me/4672/quotation', OWNER)).body).toEqual({ quotation: null, lastDecision: null });
    await seed({ status: 'draft' });
    await seed({ status: 'confirmed' });
    await seed({ status: 'withdrawn' });
    expect((await call('get', '/requests/me/4672/quotation', OWNER)).body).toEqual({ quotation: null, lastDecision: null });
  });

  test('another patient\'s request, an unknown one and a malformed one are 404', async () => {
    await seed();
    expect((await call('get', '/requests/me/4672/quotation', STRANGER)).status).toBe(404);
    expect((await call('get', '/requests/me/9999/quotation', OWNER)).status).toBe(404);
    expect((await call('get', '/requests/me/abc/quotation', OWNER)).status).toBe(404);
  });
});

describe('the PDF', () => {
  test('is a sandboxed, never-cached, never-sniffed PDF download for the owner', async () => {
    const bytes = kit.pdf('the-quotation-route');
    const q = await seed({ bytes });
    const res = await call('get', `/quotations/${q.id}/file`, OWNER).buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bytes);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['content-disposition']).toBe(`attachment; filename="CASE-4037-quotation-v${q.versionNumber}.pdf"`);
    expect(world.audit.filter((a) => a.action === 'quotation.file_viewed')).toHaveLength(1);
  });

  test('never reaches another patient, an unpublished version, a superseded or rejected one, or an unclean file', async () => {
    const q = await seed();
    expect((await call('get', `/quotations/${q.id}/file`, STRANGER)).status).toBe(404);
    for (const status of ['draft', 'confirmed', 'withdrawn']) {
      const hidden = await seed({ status });
      const res = await call('get', `/quotations/${hidden.id}/file`, OWNER);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).not.toMatch(/pdf/);
    }
    const rejected = await seed({ status: 'rejected' });
    expect((await call('get', `/quotations/${rejected.id}/file`, OWNER)).body.code).toBe('quotation_not_available');
    const dirty = await seed({ scanStatus: 'infected' });
    const res = await call('get', `/quotations/${dirty.id}/file`, OWNER);
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.text).not.toMatch(/quotations\/case-/);
  });

  test('a file that no longer matches its hash is not served', async () => {
    const q = await seed();
    fs.writeFileSync(storage.pathOf(q.storageKey), 'tampered');
    expect((await call('get', `/quotations/${q.id}/file`, OWNER)).body.code).toBe('quotation_not_available');
  });
});

describe('deciding', () => {
  test('accept: 201, then the same call again is 200 (already accepted); the decision is stored for this patient and version', async () => {
    const q = await seed();
    const first = await call('post', `/quotations/${q.id}/accept`, OWNER).send({});
    expect(first.status).toBe(201);
    expect(first.headers['cache-control']).toMatch(/no-store/);
    expect(first.body).toMatchObject({ alreadyAccepted: false, quotation: { id: q.id, status: 'accepted', canDecide: false } });
    expect(world.quotations[0]).toMatchObject({ status: 'accepted', decidedByUserId: 55 });
    const again = await call('post', `/quotations/${q.id}/accept`, OWNER).send({});
    expect(again.status).toBe(200);
    expect(again.body.alreadyAccepted).toBe(true);
    expect(world.audit.filter((a) => a.action === 'quotation.accepted')).toHaveLength(1);
  });

  test('reject needs a reason: 400 without one; with one it is stored and the quotation is no longer active', async () => {
    const q = await seed();
    for (const body of [{}, { reason: '' }, { reason: 'no' }, { reason: 42 }]) {
      const res = await call('post', `/quotations/${q.id}/reject`, OWNER).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('reason_invalid');
    }
    expect(world.quotations[0].status).toBe('published');
    const ok = await call('post', `/quotations/${q.id}/reject`, OWNER).send({ reason: 'The amount is higher than agreed' });
    expect(ok.status).toBe(201);
    expect(ok.body.quotation).toMatchObject({ status: 'rejected', rejectionReason: 'The amount is higher than agreed' });
    expect(world.quotations[0]).toMatchObject({ status: 'rejected', rejectionReason: 'The amount is higher than agreed', decidedByUserId: 55 });
    expect((await call('get', '/requests/me/4672/quotation', OWNER)).body).toMatchObject({ quotation: null, lastDecision: { status: 'rejected' } });
    expect(JSON.stringify(world.audit)).not.toMatch(/higher than agreed/);
  });

  test('a decision is final: the opposite decision answers 409 quotation_already_decided', async () => {
    const q = await seed();
    await call('post', `/quotations/${q.id}/accept`, OWNER).send({});
    const res = await call('post', `/quotations/${q.id}/reject`, OWNER).send({ reason: 'I changed my mind' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('quotation_already_decided');
    expect(world.quotations[0]).toMatchObject({ status: 'accepted', rejectionReason: null });
  });

  test('another patient cannot decide (404), an expired quotation answers 409 quotation_expired, a superseded one 409 quotation_superseded', async () => {
    const q = await seed();
    expect((await call('post', `/quotations/${q.id}/accept`, STRANGER).send({})).status).toBe(404);
    expect(world.quotations[0].status).toBe('published');
    const expired = await seed({ validUntil: new Date(Date.now() - 1000) });
    expect((await call('post', `/quotations/${expired.id}/accept`, OWNER).send({})).body.code).toBe('quotation_expired');
    const old = await seed({ status: 'superseded', supersededAt: new Date(), supersededById: 99, liveSlot: null });
    expect((await call('post', `/quotations/${old.id}/reject`, OWNER).send({ reason: 'too late now' })).body.code).toBe('quotation_superseded');
  });

  test('unpublished versions cannot be decided: 404', async () => {
    for (const status of ['draft', 'confirmed', 'withdrawn']) {
      const hidden = await seed({ status });
      expect((await call('post', `/quotations/${hidden.id}/accept`, OWNER).send({})).status).toBe(404);
      expect((await call('post', `/quotations/${hidden.id}/reject`, OWNER).send({ reason: 'no thank you' })).status).toBe(404);
    }
  });

  test('two decisions at the same time: one stored, the other refused or reported as already done', async () => {
    const q = await seed();
    const [a, r] = await Promise.all([call('post', `/quotations/${q.id}/accept`, OWNER).send({}), call('post', `/quotations/${q.id}/reject`, OWNER).send({ reason: 'too expensive for us' })]);
    expect([a.status, r.status].sort()).toEqual([201, 409]);
    expect(world.audit.filter((x) => x.action.startsWith('quotation.') && x.action !== 'quotation.file_viewed')).toHaveLength(1);
  });

  test('extra body fields (status, amount, patient id ...) are ignored; wrong methods and paths are not routes', async () => {
    const q = await seed();
    const res = await call('post', `/quotations/${q.id}/accept`, OWNER).send({ status: 'rejected', amount: '1', decidedByUserId: 99, userId: 99 });
    expect(res.status).toBe(201);
    expect(world.quotations[0]).toMatchObject({ status: 'accepted', decidedByUserId: 55, amount: '1000.000' });
    expect((await call('get', `/quotations/${q.id}/accept`, OWNER)).status).toBe(404);
    expect((await call('delete', `/quotations/${q.id}`, OWNER)).status).toBe(404);
    expect((await call('get', `/quotations/${q.id}`, OWNER)).status).toBe(404); // no unrestricted lookup by id
    expect((await call('post', '/quotations/abc/accept', OWNER).send({})).status).toBe(404);
  });
});
