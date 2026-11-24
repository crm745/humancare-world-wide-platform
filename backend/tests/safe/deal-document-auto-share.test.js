/* global describe, test, expect, jest, beforeEach */
// Automatic sharing of patient documents with the Bitrix24 Deal (modules/bitrix/deal-document-auto-share.js) on top of the REAL authorizeShare. No database, no network, no
// Bitrix: Prisma is an in-memory world whose transactions run one at a time (standing in for the request row lock) and really roll back; the stored file is an injected reader.
jest.mock('../../src/db/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));

const fs = require('fs');
const path = require('path');
const { prisma } = require('../../src/db/prisma');
const service = require('../../src/modules/bitrix/deal-document.service');
const auto = require('../../src/modules/bitrix/deal-document-auto-share');

const SHA = 'c'.repeat(64);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);
const ENV = { DOCUMENT_AUTO_SHARE: 'true', DOCUMENT_AUTO_SHARE_ADMIN_ID: '2', NODE_ENV: 'development', DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev' };
let world; let databaseName; let log; let readFile;

const makeDoc = (id, over = {}) => ({
  id, serviceRequestId: 61, originalName: `report-${id}.pdf`, storageKey: `s-${id}.pdf`, sizeBytes: 100, sha256: SHA, scanStatus: 'clean', reviewStatus: 'pending', supersededAt: null, caseDocumentId: null, ...over,
});

function build({ documents = [makeDoc(31)], approved = true, link = true } = {}) {
  world = {
    admins: [{ id: 2, role: 'admin', status: 'active', disabledAt: null, lockedUntil: null }],
    requests: { 61: { id: 61, serviceKey: 'privatecharter', reviewStatus: approved ? 'approved' : 'in_review' }, 62: { id: 62, serviceKey: 'privatecharter', reviewStatus: 'approved' } },
    cases: { 61: { id: 7, referenceNumber: 'CASE-1208', serviceRequestId: 61, bitrixDealLink: link ? { id: 5, bitrixDealId: null } : null }, 62: { id: 8, referenceNumber: 'CASE-1209', serviceRequestId: 62, bitrixDealLink: { id: 6, bitrixDealId: '900' } } },
    documents: new Map(documents.map((d) => [d.id, d])), shares: [], events: [], requestEvents: [], audit: [], nextShareId: 1, writes: 0,
  };
  const clone = (v) => (v ? JSON.parse(JSON.stringify(v)) : v);
  const tx = {
    $queryRaw: jest.fn(async () => []),
    serviceRequest: { findUnique: jest.fn(async ({ where }) => clone(world.requests[where.id]) || null) },
    case: { findUnique: jest.fn(async ({ where }) => clone(world.cases[where.serviceRequestId]) || null) },
    requestDocument: { findFirst: jest.fn(async ({ where }) => { const d = world.documents.get(where.id); return d && d.serviceRequestId === where.serviceRequestId ? { ...d } : null; }) },
    bitrixDealDocument: {
      findFirst: jest.fn(async ({ where }) => { const found = world.shares.filter((s) => s.dealLinkId === where.dealLinkId && s.requestDocumentId === where.requestDocumentId).sort((a, b) => b.generation - a.generation)[0]; return found ? { ...found } : null; }),
      create: jest.fn(async ({ data }) => {
        if (world.shares.some((s) => s.dealLinkId === data.dealLinkId && s.requestDocumentId === data.requestDocumentId && s.generation === data.generation)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        const row = { id: world.nextShareId, attempts: 0, ...data }; world.nextShareId += 1; world.shares.push(row); world.writes += 1; return { ...row };
      }),
    },
    integrationOutbox: { create: jest.fn(async ({ data }) => { if (world.events.some((e) => e.idempotencyKey === data.idempotencyKey)) throw Object.assign(new Error('unique'), { code: 'P2002' }); world.events.push(data); world.writes += 1; return data; }) },
    requestEvent: { create: jest.fn(async ({ data }) => { world.requestEvents.push(data); world.writes += 1; return data; }) },
    auditLog: { create: jest.fn(async ({ data }) => { world.audit.push(data); world.writes += 1; return data; }) },
  };
  let chain = Promise.resolve();
  prisma.$transaction.mockImplementation((callback) => {
    const run = chain.then(async () => {
      const snapshot = clone({ shares: world.shares, events: world.events, requestEvents: world.requestEvents, audit: world.audit, nextShareId: world.nextShareId });
      try { return await callback(tx); } catch (err) { Object.assign(world, snapshot); throw err; }
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  });
  const hasShare = (d) => world.shares.some((s) => s.requestDocumentId === d.id);
  Object.assign(prisma, {
    $queryRaw: jest.fn(async () => [{ db: databaseName }]),
    adminUser: { findUnique: jest.fn(async ({ where }) => { const a = world.admins.find((x) => x.id === where.id); return a ? { ...a } : null; }) },
    requestDocument: {
      findUnique: jest.fn(async ({ where }) => { const d = world.documents.get(where.id); return d ? { ...d } : null; }),
      findMany: jest.fn(async ({ where, take }) => {
        let list = [...world.documents.values()].filter((d) => d.scanStatus === where.scanStatus && d.supersededAt == null && d.reviewStatus !== 'rejected');
        if (where.serviceRequestId !== undefined) list = list.filter((d) => (where.serviceRequestId.in ? where.serviceRequestId.in.includes(d.serviceRequestId) : d.serviceRequestId === where.serviceRequestId));
        if (where.dealShares) list = list.filter((d) => !hasShare(d));
        if (where.serviceRequest) {
          list = list.filter((d) => {
            const r = world.requests[d.serviceRequestId]; const c = world.cases[d.serviceRequestId];
            return r.serviceKey === 'privatecharter' && r.reviewStatus === 'approved' && c && c.bitrixDealLink;
          });
        }
        return list.sort((a, b) => a.id - b.id).slice(0, take || 1000).map((d) => ({ id: d.id, serviceRequestId: d.serviceRequestId }));
      }),
    },
  });
  return tx;
}

const authorize = (args) => service.authorizeShare({ ...args, readFile });
const ctx = (extra = {}) => ({ prisma, env: ENV, now: () => new Date('2030-01-02T10:00:00Z'), log, authorize, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  databaseName = 'humancare_dev';
  log = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  readFile = jest.fn(async () => PDF);
  build();
});

describe('a clean scan alone authorizes sharing, as the system', () => {
  test('creates ONE share, ONE attach event, and records the system actor (Admin review is not required, the Case document need not exist)', async () => {
    const result = await auto.autoShareDocument(31, ctx());
    expect(result).toMatchObject({ outcome: 'shared', documentId: 31, shareId: 1 });
    expect(world.shares).toHaveLength(1);
    expect(world.shares[0]).toMatchObject({ dealLinkId: 5, requestDocumentId: 31, caseDocumentId: null, generation: 1, status: 'authorized', tryCount: 1, authorizedByAdminId: 2, detectedType: 'pdf', shareToken: `HC-D31G1-${SHA.slice(0, 8)}` });
    expect(world.events).toHaveLength(1);
    expect(world.events[0]).toMatchObject({ eventType: 'bitrix.deal.document.attach', caseId: 7, status: 'pending', idempotencyKey: 'bitrix.deal.document.attach:share:1:try:1' });
    expect(world.requestEvents[0]).toMatchObject({ serviceRequestId: 61, documentId: 31, action: 'document_share_authorized', actorType: 'system', actorId: 2 });
    expect(world.audit[0]).toMatchObject({ action: 'bitrix.deal.document.authorized', actorType: 'system', source: 'document_auto_share', actorId: '2', reasonCode: 'share_auto_authorized', caseId: 7 });
  });
  test('a document already approved by an Admin is shared the same way', async () => {
    build({ documents: [makeDoc(31, { reviewStatus: 'approved', caseDocumentId: 41 })] });
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'shared' });
    expect(world.shares[0].caseDocumentId).toBe(41);
  });
});

describe('what is never shared', () => {
  test.each([['pending'], ['error'], ['failed'], ['infected']])('a %s scan is never shared and nothing is written', async (scanStatus) => {
    build({ documents: [makeDoc(31, { scanStatus })] });
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'not_clean' });
    expect(await auto.autoShareRequest(61, ctx())).toMatchObject({ results: [] });
    expect(await auto.sweep(ctx())).toMatchObject({ results: [] });
    expect(world.writes).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  test('a rejected document is never shared, even clean', async () => {
    build({ documents: [makeDoc(31, { reviewStatus: 'rejected' })] });
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'rejected' });
    expect(await auto.autoShareRequest(61, ctx())).toMatchObject({ results: [] });
    expect(await auto.sweep(ctx())).toMatchObject({ results: [] });
    // and the share function itself refuses it too, whoever calls it
    await expect(service.authorizeShare({ requestId: 61, documentId: 31, adminId: 2, automation: true, readFile })).rejects.toMatchObject({ statusCode: 409, publicCode: 'document_rejected' });
    expect(world.writes).toBe(0);
  });
  test('a replaced (superseded) document is never shared', async () => {
    build({ documents: [makeDoc(31, { supersededAt: new Date('2030-01-01') })] });
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'superseded' });
    expect(world.writes).toBe(0);
  });
  test('a file that is not really a PDF or image is refused by the existing check', async () => {
    readFile.mockResolvedValue(Buffer.from('PK-not-a-pdf-at-all-just-some-text-bytes-here'));
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'refused', code: 'unsupported_type' });
    expect(world.writes).toBe(0);
  });
  test('a document of another request is never shared through this one', async () => {
    build({ documents: [makeDoc(31), makeDoc(77, { serviceRequestId: 62 })] });
    await expect(service.authorizeShare({ requestId: 61, documentId: 77, adminId: 2, automation: true, readFile })).rejects.toMatchObject({ statusCode: 404 });
    const result = await auto.autoShareRequest(61, ctx());
    expect(result.results.map((r) => r.documentId)).toEqual([31]);
    expect(world.shares.every((s) => s.dealLinkId === 5)).toBe(true); // request 61's own Deal link only
  });
});

describe('every ordering of the events works', () => {
  test('scan BEFORE the Case: nothing can be shared yet; the approval hook shares it', async () => {
    build({ approved: false, link: false });
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'not_ready' });
    expect(world.writes).toBe(0);
    world.requests[61].reviewStatus = 'approved'; // the approval creates the Case and the Deal link in its own transaction
    world.cases[61].bitrixDealLink = { id: 5, bitrixDealId: null };
    const result = await auto.afterRequestApproved(61, ctx());
    expect(result.results).toEqual([expect.objectContaining({ documentId: 31, outcome: 'shared' })]);
    expect(world.shares).toHaveLength(1);
  });
  test('an approved request whose Deal link is missing is "not ready", not an error', async () => {
    build({ link: false });
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'not_ready', code: 'no_deal_link' });
    expect(world.writes).toBe(0);
  });
  test('Case AND Deal link BEFORE the scan: the scan-clean hook shares it', async () => {
    build();
    world.cases[61].bitrixDealLink = { id: 5, bitrixDealId: '21958' }; // the Deal exists already
    expect(await auto.afterScanClean(31, ctx())).toMatchObject({ outcome: 'shared' });
    expect(world.shares).toHaveLength(1);
  });
  test('Case before the Deal exists: shared now (the worker waits for the Deal); the sweep also finds a missed document', async () => {
    build({ documents: [makeDoc(31), makeDoc(32)] });
    expect(await auto.afterScanClean(31, ctx())).toMatchObject({ outcome: 'shared' }); // document 32's hook "was missed"
    const swept = await auto.sweep(ctx());
    expect(swept.results).toEqual([expect.objectContaining({ documentId: 32, outcome: 'shared' })]);
    expect(world.shares.map((s) => s.requestDocumentId)).toEqual([31, 32]);
  });
});

describe('duplicates and concurrency', () => {
  test('the same document authorized twice, by any hook, gives one share and one event', async () => {
    expect(await auto.afterScanClean(31, ctx())).toMatchObject({ outcome: 'shared' });
    expect(await auto.afterScanClean(31, ctx())).toMatchObject({ outcome: 'already_shared' });
    expect(await auto.afterRequestApproved(61, ctx())).toMatchObject({ results: [expect.objectContaining({ outcome: 'already_shared' })] });
    expect(await auto.sweep(ctx())).toMatchObject({ results: [] }); // no longer without a share
    expect(world.shares).toHaveLength(1);
    expect(world.events).toHaveLength(1);
    expect(world.audit).toHaveLength(1);
  });
  test('concurrent callers (scan callback, approval hook and sweep at once) still make exactly one share and one event', async () => {
    const results = await Promise.all([auto.afterScanClean(31, ctx()), auto.afterScanClean(31, ctx()), auto.afterRequestApproved(61, ctx()), auto.sweep(ctx())]);
    expect(results).toHaveLength(4);
    expect(world.shares).toHaveLength(1);
    expect(world.events).toHaveLength(1);
    expect(world.requestEvents).toHaveLength(1);
  });
  test('a failed write rolls the whole authorization back (no share without its event)', async () => {
    const tx = build();
    tx.integrationOutbox.create.mockRejectedValueOnce(new Error('simulated write failure'));
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'error' });
    expect(world.shares).toHaveLength(0);
    expect(world.events).toHaveLength(0);
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'shared' }); // the next call succeeds
  });
});

describe('multiple documents on one request', () => {
  test('every clean, non-rejected document gets its own share, token and event; the rest are skipped', async () => {
    build({ documents: [makeDoc(31), makeDoc(32, { reviewStatus: 'approved' }), makeDoc(33, { scanStatus: 'infected' }), makeDoc(34, { scanStatus: 'pending' }), makeDoc(35, { reviewStatus: 'rejected' }), makeDoc(36)] });
    const result = await auto.afterRequestApproved(61, ctx());
    expect(result.results.map((r) => [r.documentId, r.outcome])).toEqual([[31, 'shared'], [32, 'shared'], [36, 'shared']]);
    expect(new Set(world.shares.map((s) => s.shareToken)).size).toBe(3);
    expect(world.events.map((e) => e.idempotencyKey)).toEqual(['bitrix.deal.document.attach:share:1:try:1', 'bitrix.deal.document.attach:share:2:try:1', 'bitrix.deal.document.attach:share:3:try:1']);
  });
});

describe('the sweep (safety net)', () => {
  test('finds only clean, current, non-rejected documents of approved Private Charter requests with a Deal link and no share; it is idempotent and limited', async () => {
    build({ documents: [makeDoc(31), makeDoc(32), makeDoc(33, { serviceRequestId: 62 })] });
    world.requests[62].serviceKey = 'ground'; // not a Deal request
    const first = await auto.sweep(ctx({ limit: 1 }));
    expect(first.results.map((r) => r.documentId)).toEqual([31]);
    const second = await auto.sweep(ctx());
    expect(second.results.map((r) => r.documentId)).toEqual([32]);
    expect((await auto.sweep(ctx())).results).toEqual([]);
    expect(world.shares.map((s) => s.requestDocumentId)).toEqual([31, 32]);
  });
  test('an unapproved request or one without a Deal link is left alone', async () => {
    build({ approved: false });
    expect((await auto.sweep(ctx())).results).toEqual([]);
    build({ link: false });
    expect((await auto.sweep(ctx())).results).toEqual([]);
    expect(world.writes).toBe(0);
  });
  test('requestIds narrows it to one request', async () => {
    build({ documents: [makeDoc(31), makeDoc(33, { serviceRequestId: 62 })] });
    expect((await auto.sweep(ctx({ requestIds: [62] }))).results.map((r) => r.documentId)).toEqual([33]);
    expect(world.shares.map((s) => s.requestDocumentId)).toEqual([33]);
  });
});

describe('an Admin\'s revocation and manual authorization stay compatible', () => {
  test('a revoked share is never re-shared automatically; an Admin can still authorize it again by hand', async () => {
    await auto.autoShareDocument(31, ctx());
    world.shares[0].status = 'revoked';
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'revoked_by_admin' });
    expect((await auto.sweep(ctx())).results).toEqual([]); // it has a share row, so it is not even a candidate
    expect(world.shares).toHaveLength(1);
    build({ documents: [makeDoc(31, { reviewStatus: 'approved', caseDocumentId: 41 })] });
    await auto.autoShareDocument(31, ctx());
    world.shares[0].status = 'revoked';
    const manual = await service.authorizeShare({ requestId: 61, documentId: 31, adminId: 3, readFile });
    expect(manual.alreadyAuthorized).toBe(false);
    expect(world.shares).toHaveLength(2);
    expect(world.shares[1]).toMatchObject({ generation: 2, authorizedByAdminId: 3 });
  });
  test('a failed or active share is left to the worker and to the Admin retry: the automation creates nothing new', async () => {
    await auto.autoShareDocument(31, ctx());
    for (const status of ['failed', 'attaching', 'attached', 'ambiguous']) {
      world.shares[0].status = status;
      expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'already_shared' });
    }
    expect(world.shares).toHaveLength(1);
    expect(world.events).toHaveLength(1);
  });
  test('MANUAL authorization keeps every old rule: it still needs an APPROVED document in the Case, and records the Admin from the portal', async () => {
    await expect(service.authorizeShare({ requestId: 61, documentId: 31, adminId: 3, readFile })).rejects.toMatchObject({ statusCode: 409, publicCode: 'document_not_approved' });
    build({ documents: [makeDoc(31, { reviewStatus: 'approved', caseDocumentId: null })] });
    await expect(service.authorizeShare({ requestId: 61, documentId: 31, adminId: 3, readFile })).rejects.toMatchObject({ statusCode: 409, publicCode: 'not_in_case' });
    build({ documents: [makeDoc(31, { reviewStatus: 'approved', caseDocumentId: 41 })] });
    const result = await service.authorizeShare({ requestId: 61, documentId: 31, adminId: 3, readFile });
    expect(result.alreadyAuthorized).toBe(false);
    expect(world.requestEvents[0]).toMatchObject({ actorType: 'admin', actorId: 3 });
    expect(world.audit[0]).toMatchObject({ actorType: 'admin', source: 'admin_portal', reasonCode: 'share_authorized', actorId: '3' });
    // and a manual call is idempotent with an automatic share that already exists
    expect((await service.authorizeShare({ requestId: 61, documentId: 31, adminId: 3, readFile })).alreadyAuthorized).toBe(true);
  });
  test('only a strict boolean true marks the automation: anything else is an ordinary manual authorization', async () => {
    for (const automation of ['true', 1, {}, 'document_auto_share']) {
      build({ documents: [makeDoc(31)] }); // pending review, no Case document
      await expect(service.authorizeShare({ requestId: 61, documentId: 31, adminId: 2, readFile, automation })).rejects.toMatchObject({ publicCode: 'document_not_approved' });
    }
  });
});

describe('the Admin and the environment are verified every time; production fails closed', () => {
  test('with the switch off, or not exactly "true", nothing is read or written', async () => {
    for (const value of [undefined, '', 'TRUE', '1', 'false', 'yes']) {
      jest.clearAllMocks();
      expect(await auto.autoShareDocument(31, ctx({ env: { ...ENV, DOCUMENT_AUTO_SHARE: value } }))).toMatchObject({ outcome: 'disabled', code: 'switch_off' });
    }
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.adminUser.findUnique).not.toHaveBeenCalled();
    expect(world.writes).toBe(0);
  });
  test.each([
    [{ NODE_ENV: 'production' }, 'refused_in_production'], [{ NODE_ENV: 'test' }, 'node_env_test'],
    [{ DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }, 'database_not_humancare_dev'], [{ DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }, 'database_host_not_local'],
    [{ DATABASE_URL: undefined }, 'database_url_invalid'],
    [{ DOCUMENT_AUTO_SHARE_ADMIN_ID: undefined }, 'admin_id_missing_or_invalid'], [{ DOCUMENT_AUTO_SHARE_ADMIN_ID: '0' }, 'admin_id_missing_or_invalid'], [{ DOCUMENT_AUTO_SHARE_ADMIN_ID: '2 ' }, 'admin_id_missing_or_invalid'],
  ])('%j is refused (%s) before the database is touched', async (patch, code) => {
    expect(await auto.autoShareDocument(31, ctx({ env: { ...ENV, ...patch } }))).toMatchObject({ outcome: 'disabled', code });
    expect(await auto.afterRequestApproved(61, ctx({ env: { ...ENV, ...patch } }))).toMatchObject({ outcome: 'disabled', code });
    expect(await auto.sweep(ctx({ env: { ...ENV, ...patch } }))).toMatchObject({ outcome: 'disabled', code });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(world.writes).toBe(0);
  });
  test('the database SERVER must answer humancare_dev, not only the URL', async () => {
    databaseName = 'humancare_test';
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'disabled', code: 'database_not_humancare_dev' });
    expect(world.writes).toBe(0);
  });
  test.each([
    ['disabled', { status: 'disabled' }, 'admin_not_active'], ['invited', { status: 'invited' }, 'admin_not_active'], ['soft-disabled', { disabledAt: new Date(0) }, 'admin_disabled'],
    ['locked', { lockedUntil: new Date('2031-01-01T00:00:00Z') }, 'admin_locked'], ['a superadmin', { role: 'superadmin' }, 'admin_role_not_admin'],
  ])('Admin 2 %s: nothing is shared', async (_n, patch, code) => {
    Object.assign(world.admins[0], patch);
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'disabled', code });
    expect(await auto.afterRequestApproved(61, ctx())).toMatchObject({ outcome: 'disabled', code });
    expect(await auto.sweep(ctx())).toMatchObject({ outcome: 'disabled', code });
    expect(world.writes).toBe(0);
  });
  test('a missing Admin account stops everything', async () => {
    world.admins = [];
    expect(await auto.autoShareDocument(31, ctx())).toMatchObject({ outcome: 'disabled', code: 'admin_not_found' });
  });
  test('the hooks never throw, whatever fails, and never report a secret', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(Object.assign(new Error('Access denied mysql://u:hunter2@localhost'), { code: 'P1001' }));
    expect(await auto.afterScanClean(31, ctx())).toMatchObject({ outcome: 'disabled' });
    expect(await auto.afterScanClean(31, ctx({ authorize: async () => { throw Object.assign(new Error('boom hunter2'), { code: 'EBOOM' }); } }))).toMatchObject({ outcome: 'error', code: 'EBOOM' });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('hunter2');
    prisma.requestDocument.findUnique.mockRejectedValueOnce(new Error('x'));
    expect(await auto.afterScanClean(31, ctx())).toMatchObject({ outcome: 'error' });
    expect(await auto.afterRequestApproved(61, ctx({ prisma: undefined }))).toMatchObject({ outcome: 'disabled', code: 'database_not_humancare_dev' }); // no usable database: fails closed
  });
});

describe('wiring: the hooks, the sweep and the scope', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
  const code = (rel) => read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  test('the scan hook runs only after a CLEAN verdict was written, and the approval hook only after the commit of a NEW approval', () => {
    const text = code('src/modules/request-review/request-review.service.js');
    expect(text).toMatch(/if \(status === SCAN\.CLEAN\) await require\('\.\.\/bitrix\/deal-document-auto-share'\)\.afterScanClean\(documentId\)/);
    expect(text).toMatch(/if \(!result\.alreadyApproved\) await require\('\.\.\/bitrix\/deal-document-auto-share'\)\.afterRequestApproved\(result\.request\.id\)/);
    expect(text.indexOf('afterRequestApproved')).toBeGreaterThan(text.indexOf('const result = await prisma.$transaction'));
  });
  test('the document job runs the sweep first and then the existing worker', async () => {
    const job = require('../../src/jobs/bitrix-deal-document.job');
    expect(job).toMatchObject({ name: 'bitrix-deal-document', intervalMs: 30000, runOnStart: false });
    expect(code('src/jobs/bitrix-deal-document.job.js')).toMatch(/await sweepAutoShare\(\);[\s\S]*runDealDocumentWorker\(\)/);
  });
  test('the module sends nothing to Bitrix, changes no document and does not use .env or payments', () => {
    const text = code('src/modules/bitrix/deal-document-auto-share.js');
    for (const forbidden of [/bitrix-deal\.api|bitrix\.service|getDeal|updateDealFiles|fetch\(/, /dotenv/, /razorpay|payment|invoice/i, /requestDocument\.(update|delete|create)|\.deleteMany|\$executeRaw/]) expect({ hit: forbidden.test(text) }).toEqual({ hit: false });
    expect(text).toMatch(/automation: true/);
  });
});
