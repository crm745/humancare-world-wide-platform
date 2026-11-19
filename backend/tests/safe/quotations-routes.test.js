/* global describe, test, expect, jest, beforeAll, beforeEach, afterAll, afterEach */
// The Admin quotation endpoints through the REAL application (src/app.js) over HTTP with supertest: authentication, authorization, request
// validation, state-transition answers, the PDF response and its headers. Only the outside world is replaced: Prisma is the in-memory fake,
// uploads and ClamAV are stubs, push is not reachable (the safe-test setup blocks the network).
jest.mock('../../src/db/prisma', () => ({ prisma: require('./quotation-route-kit').db }));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { world, db, reset, kit } = require('./quotation-route-kit');
const { createLocalStorage } = require('../../src/modules/bitrix/quotation-storage');
const { app } = require('../../src/app');

const SECRET = 'fake-route-jwt-secret-0123456789';
const token = (payload) => jwt.sign(payload, SECRET, { expiresIn: '5m' });
const ADMIN = token({ sub: 7, role: 'admin' }); // legacy admin token (enforcement off): the database says role "admin"
const SUPERADMIN = token({ sub: 8, role: 'admin' }); // the database says role "superadmin"
const DISABLED_ADMIN = token({ sub: 9, role: 'admin' });
const PATIENT = token({ sub: 55, role: 'patient' });
const CORPORATE = token({ sub: 3, role: 'corporate', corporateId: 1 });
const EXPIRED = jwt.sign({ sub: 7, role: 'admin' }, SECRET, { expiresIn: -10 });
const WRONG_SECRET = jwt.sign({ sub: 7, role: 'admin' }, 'another-secret-another-secret-12345', { expiresIn: '5m' });

const storage = createLocalStorage({ root: os.tmpdir() });
const written = [];
let savedEnv; let spies;

beforeAll(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, { JWT_ACCESS_SECRET: SECRET, NODE_ENV: 'test' });
  delete process.env.ADMIN_PASSKEY_ENFORCEMENT;
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
  const bytes = over.bytes || kit.pdf(`route${seq}-${process.pid}`);
  const hash = kit.sha(bytes);
  const key = `quotations/case-3037/evroute${seq}-${process.pid}-${hash}.pdf`;
  await storage.putIfAbsent(key, bytes, hash);
  written.push(key);
  const { bytes: _b, ...rest } = over;
  const status = rest.status || 'draft';
  return db.caseQuotation.create({
    data: {
      caseId: 3037, dealLinkId: 1173, versionNumber: seq, bitrixDealId: kit.DEAL, bitrixFileId: String(65000 + seq), bitrixAmountRaw: '1000', bitrixCurrencyRaw: 'INR', bitrixDealStageId: 'C38:NEW',
      contentFingerprint: hash, storageProvider: 'local', storageKey: key, sizeBytes: bytes.length, sha256: hash, amount: '1000.000', currency: 'INR', validationError: null,
      status, workingSlot: ['draft', 'confirmed'].includes(status) ? 1 : null, liveSlot: ['published', 'accepted'].includes(status) ? 1 : null, scanStatus: 'clean', revision: 3,
      lastSeenAt: new Date(), ...(status === 'confirmed' ? { confirmedByAdminId: 7, confirmedAt: new Date() } : {}), ...rest,
    },
  });
}

const as = (method, url, auth) => { const r = request(app)[method](url); return auth ? r.set('Authorization', `Bearer ${auth}`) : r; };
const ROUTES = [
  ['get', '/admin/cases/3037/quotations'], ['get', '/admin/quotations/1'], ['get', '/admin/quotations/1/file'],
  ['post', '/admin/quotations/1/confirm'], ['post', '/admin/quotations/1/publish'], ['post', '/admin/quotations/1/withdraw'], ['post', '/admin/quotations/1/new-version'],
];

describe('authentication and authorization', () => {
  test.each(ROUTES)('%s %s without a token is 401', async (method, url) => {
    const res = await as(method, url, null).send({});
    expect(res.status).toBe(401);
  });

  test.each(ROUTES)('%s %s with an expired, forged or malformed token is 401', async (method, url) => {
    for (const bad of [EXPIRED, WRONG_SECRET, 'not.a.jwt']) expect((await as(method, url, bad).send({})).status).toBe(401);
  });

  // The Admin middleware does not recognise a patient or corporate token as an Admin session at all, so it answers 401 (never data, never 2xx).
  test.each(ROUTES)('%s %s is refused to a patient and to a corporate user', async (method, url) => {
    for (const auth of [PATIENT, CORPORATE]) {
      const res = await as(method, url, auth).send({});
      expect([401, 403]).toContain(res.status);
      expect(res.body).not.toHaveProperty('quotation');
      expect(res.body).not.toHaveProperty('quotations');
    }
  });

  test('a disabled Admin account is refused even with a valid token', async () => {
    await seed();
    expect((await as('get', '/admin/cases/3037/quotations', DISABLED_ADMIN)).status).toBe(401);
    expect((await as('post', '/admin/quotations/1/confirm', DISABLED_ADMIN).send({ revision: 3 })).status).toBe(401);
  });

  test('refused requests change nothing and touch no quotation', async () => {
    const q = await seed({ status: 'confirmed' });
    await as('post', `/admin/quotations/${q.id}/publish`, PATIENT).send({ revision: 3 });
    await as('post', `/admin/quotations/${q.id}/publish`, null).send({ revision: 3 });
    expect(world.quotations[0]).toMatchObject({ status: 'confirmed', revision: 3 });
    expect(world.notifications).toEqual([]);
    expect(world.audit).toEqual([]);
  });

  test('the routes are registered AFTER the Admin authentication middleware', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/modules/admin/admin.routes.js'), 'utf8');
    const auth = source.indexOf("adminRouter.use(requireAdminAuth(['admin']));");
    expect(auth).toBeGreaterThan(-1);
    for (const route of ["'/cases/:id/quotations'", "'/quotations/:id'", "'/quotations/:id/file'", "'/quotations/:id/confirm'", "'/quotations/:id/publish'", "'/quotations/:id/withdraw'", "'/quotations/:id/new-version'"]) {
      expect(source.indexOf(route)).toBeGreaterThan(auth);
    }
  });
});

describe('what an Admin and a Superadmin may do', () => {
  test('an Admin lists the history of a Case (by id or CASE reference) and reads one version', async () => {
    const q = await seed();
    const byId = await as('get', '/admin/cases/3037/quotations', ADMIN);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ caseId: 3037, caseReference: 'CASE-4037', quotations: [{ id: q.id, status: 'draft', scanStatus: 'clean', amount: '1000.000', currency: 'INR', actions: { canConfirm: true } }] });
    expect((await as('get', '/admin/cases/CASE-4037/quotations', ADMIN)).status).toBe(200);
    expect((await as('get', `/admin/quotations/${q.id}`, ADMIN)).body.quotation.id).toBe(q.id);
    expect((await as('get', '/admin/quotations/999', ADMIN)).status).toBe(404);
    expect((await as('get', '/admin/quotations/abc', ADMIN)).status).toBe(404);
    expect((await as('get', '/admin/cases/9999/quotations', ADMIN)).status).toBe(404);
  });

  test('confirm and publish are two separate calls; both an Admin and a Superadmin can make them; the role is audited', async () => {
    const q = await seed();
    const confirm = await as('post', `/admin/quotations/${q.id}/confirm`, ADMIN).send({ revision: 3 });
    expect(confirm.status).toBe(201);
    expect(confirm.body).toMatchObject({ alreadyConfirmed: false, quotation: { status: 'confirmed', revision: 4, confirmedBy: { id: 7, name: 'Asha Admin' } } });
    expect(world.notifications).toEqual([]); // confirming never notifies
    const publish = await as('post', `/admin/quotations/${q.id}/publish`, SUPERADMIN).send({ revision: 4 });
    expect(publish.status).toBe(201);
    expect(publish.body).toMatchObject({ alreadyPublished: false, quotation: { status: 'published', publishedBy: { id: 8, name: 'Ravi Super' }, live: true } });
    expect(world.audit.map((a) => [a.action, a.actorId, a.actorRole])).toEqual([['quotation.confirmed', '7', 'admin'], ['quotation.published', '8', 'superadmin']]);
    expect(world.notifications).toHaveLength(1);
  });

  test('a repeated call answers 200 (already done) and does not repeat the side effects', async () => {
    const q = await seed({ status: 'confirmed' });
    expect((await as('post', `/admin/quotations/${q.id}/publish`, ADMIN).send({ revision: 3 })).status).toBe(201);
    const again = await as('post', `/admin/quotations/${q.id}/publish`, ADMIN).send({ revision: 3 });
    expect(again.status).toBe(200);
    expect(again.body.alreadyPublished).toBe(true);
    expect(world.notifications).toHaveLength(1);
  });

  test('two publishes at the same time: one 201, one 200, ONE notification', async () => {
    const q = await seed({ status: 'confirmed' });
    const [a, b] = await Promise.all([as('post', `/admin/quotations/${q.id}/publish`, ADMIN).send({ revision: 3 }), as('post', `/admin/quotations/${q.id}/publish`, SUPERADMIN).send({ revision: 3 })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(world.notifications).toHaveLength(1);
  });

  test('withdraw needs a reason and the revision; the reason is stored, not echoed into the audit trail', async () => {
    const q = await seed();
    expect((await as('post', `/admin/quotations/${q.id}/withdraw`, ADMIN).send({ revision: 3 })).body).toMatchObject({ code: 'reason_invalid' });
    expect((await as('post', `/admin/quotations/${q.id}/withdraw`, ADMIN).send({ reason: 'Wrong amount quoted' })).body).toMatchObject({ code: 'revision_required' });
    const ok = await as('post', `/admin/quotations/${q.id}/withdraw`, ADMIN).send({ revision: 3, reason: 'Wrong amount quoted' });
    expect(ok.status).toBe(201);
    expect(ok.body.quotation).toMatchObject({ status: 'withdrawn', withdrawReason: 'Wrong amount quoted', withdrawnBy: { id: 7 } });
    expect(JSON.stringify(world.audit)).not.toMatch(/Wrong amount quoted/);
  });

  test('a new version is made from an accepted head only', async () => {
    const q = await seed({ status: 'accepted', confirmedByAdminId: 7, confirmedAt: new Date(), publishedByAdminId: 7, publishedAt: new Date(), decidedByUserId: 55, decidedAt: new Date() });
    const res = await as('post', `/admin/quotations/${q.id}/new-version`, ADMIN).send({ revision: 3 });
    expect(res.status).toBe(201);
    expect(res.body.quotation).toMatchObject({ versionNumber: q.versionNumber + 1, status: 'draft', scanStatus: 'pending' });
    written.push(world.quotations[1].storageKey);
    expect((await as('post', `/admin/quotations/${res.body.quotation.id}/new-version`, ADMIN).send({ revision: 0 })).body).toMatchObject({ code: 'quotation_not_versionable' });
  });
});

describe('blocked actions answer 409 with a code the Portal can show', () => {
  test('an unclean or invalid draft cannot be confirmed: the blockers are listed', async () => {
    const q = await seed({ scanStatus: 'pending', amount: null, currency: null, validationError: 'amount_missing' });
    const res = await as('post', `/admin/quotations/${q.id}/confirm`, ADMIN).send({ revision: 3 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'scan_not_clean', blockers: [{ code: 'scan_not_clean' }, { code: 'quotation_invalid', detail: 'amount_missing' }] });
    expect(world.quotations[0]).toMatchObject({ status: 'draft', revision: 3 });
  });

  test('an unconfirmed quotation cannot be published; an accepted one needs a new version', async () => {
    const draft = await seed();
    expect((await as('post', `/admin/quotations/${draft.id}/publish`, ADMIN).send({ revision: 3 })).body.code).toBe('quotation_not_confirmed');
    const accepted = await seed({ status: 'accepted', confirmedByAdminId: 7, confirmedAt: new Date(), publishedByAdminId: 7, publishedAt: new Date(), decidedByUserId: 55, decidedAt: new Date() });
    const res = await as('post', `/admin/quotations/${accepted.id}/publish`, ADMIN).send({ revision: 3 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('new_version_required');
    expect(world.notifications).toEqual([]);
  });

  test('a stale revision answers 409 with the current revision', async () => {
    const q = await seed();
    const res = await as('post', `/admin/quotations/${q.id}/confirm`, ADMIN).send({ revision: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'quotation_changed', currentRevision: 3 });
  });

  test('extra body fields (status, amount, adminId ...) are ignored: nothing can be forced through the body', async () => {
    const q = await seed();
    const res = await as('post', `/admin/quotations/${q.id}/publish`, ADMIN).send({ revision: 3, status: 'published', amount: '999999', currency: 'USD', adminId: 8, liveSlot: 1 });
    expect(res.status).toBe(409);
    expect(world.quotations[0]).toMatchObject({ status: 'draft', amount: '1000.000', currency: 'INR' });
    const ok = await as('post', `/admin/quotations/${q.id}/confirm`, ADMIN).send({ revision: 3, amount: '999999', currency: 'USD', confirmedByAdminId: 8 });
    expect(ok.status).toBe(201);
    expect(world.quotations[0]).toMatchObject({ status: 'confirmed', amount: '1000.000', currency: 'INR', confirmedByAdminId: 7 });
  });

  test('a body that is not an object, or a wrong method, is not accepted', async () => {
    const q = await seed();
    expect((await as('post', `/admin/quotations/${q.id}/confirm`, ADMIN).send('revision=3')).status).toBe(400);
    expect((await as('get', `/admin/quotations/${q.id}/confirm`, ADMIN)).status).toBe(404);
    expect((await as('delete', `/admin/quotations/${q.id}`, ADMIN)).status).toBe(404);
    expect((await as('patch', `/admin/quotations/${q.id}`, ADMIN).send({ status: 'published' })).status).toBe(404);
  });
});

describe('the PDF', () => {
  test('is a sandboxed, never-cached, never-sniffed PDF for an authenticated Admin; a download by default, inline on request', async () => {
    const bytes = kit.pdf('visible-quotation');
    const q = await seed({ bytes });
    const res = await as('get', `/admin/quotations/${q.id}/file`, ADMIN).buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bytes);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['content-disposition']).toBe(`attachment; filename="CASE-4037-quotation-v${q.versionNumber}.pdf"`);
    const inline = await as('get', `/admin/quotations/${q.id}/file?disposition=inline`, ADMIN);
    expect(inline.headers['content-disposition']).toMatch(/^inline; filename=/);
    expect(world.audit.filter((a) => a.action === 'quotation.file_viewed')).toHaveLength(2);
  });

  test('is never sent to a patient, a corporate user or an anonymous caller', async () => {
    const q = await seed();
    for (const auth of [null, PATIENT, CORPORATE]) {
      const res = await as('get', `/admin/quotations/${q.id}/file`, auth);
      expect([401, 403]).toContain(res.status);
      expect(res.headers['content-type']).not.toMatch(/pdf/);
    }
    expect(world.audit).toEqual([]);
  });

  test.each(['pending', 'error', 'infected'])('a %s file is refused with a 409 JSON answer, never as a PDF', async (scanStatus) => {
    const q = await seed({ scanStatus });
    const res = await as('get', `/admin/quotations/${q.id}/file`, ADMIN);
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.code).toBe('scan_not_clean');
  });

  test('a file that no longer matches its hash is refused', async () => {
    const q = await seed();
    fs.writeFileSync(storage.pathOf(q.storageKey), 'tampered');
    expect((await as('get', `/admin/quotations/${q.id}/file`, ADMIN)).body.code).toBe('file_unverified');
  });

  test('no response ever carries the storage key or a file path', async () => {
    const q = await seed({ status: 'confirmed' });
    const bodies = [
      (await as('get', '/admin/cases/3037/quotations', ADMIN)).text,
      (await as('get', `/admin/quotations/${q.id}`, ADMIN)).text,
      (await as('post', `/admin/quotations/${q.id}/publish`, ADMIN).send({ revision: 3 })).text,
    ].join('\n');
    expect(bodies).not.toMatch(/quotations\/case-|storageKey|evroute|\.pdf/);
  });
});
