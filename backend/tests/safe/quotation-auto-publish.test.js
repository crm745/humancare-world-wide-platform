/* global describe, test, expect, jest, beforeEach, afterEach */
// Quotation auto-confirmation and auto-publication, rule by rule. In-memory world (the quotation test kit: a fake Prisma whose transaction serialises callers
// like the Case row lock and rolls back on a throw), REAL stored files in a temp folder, a fake read-only Bitrix, a fake push. No database, no network, no
// worker, no live Bitrix.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() }));

const fs = require('fs');
const path = require('path');
const kit = require('./quotation-test-kit');
const quotations = require('../../src/modules/quotations/quotations.service');
const auto = require('../../src/modules/quotations/quotation-auto-publish.service');
const config = require('../../src/modules/quotations/quotation-auto-publish.config');
const { ACTUAL_FIELD } = require('../../src/modules/bitrix/bitrix-profiles');

const { pdf, sha } = kit;
const ACTUAL_FILE_FIELD = 'UF_CRM_1795177914';
const ENV = {
  QUOTATION_AUTO_PUBLISH: 'true', QUOTATION_AUTO_PUBLISH_FROM: '2029-12-01T00:00:00Z', QUOTATION_AUTO_PUBLISH_ADMIN_ID: '2',
  BITRIX_DEAL_PROFILE: 'actual', BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true',
  DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev', NODE_ENV: 'development',
};
let rig; let push; let seq; let dealState; let api; let databaseName;

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

beforeEach(() => {
  rig = kit.makeRig();
  push = jest.fn(async () => undefined);
  seq = 0;
  databaseName = 'humancare_dev';
  rig.world.link = { ...rig.world.link, profile: 'actual' };
  rig.world.admins.push({ id: 2, name: 'Ops Admin', status: 'active', role: 'admin', disabledAt: null, lockedUntil: null });
  kit.attachInvoices(rig.prisma, rig.world);
  // What the real database offers and the kit does not: the Admin lookup, the audit lookup, and the database name question.
  rig.prisma.adminUser.findUnique = jest.fn(async ({ where }) => { const a = rig.world.admins.find((x) => x.id === where.id); return a ? { disabledAt: null, lockedUntil: null, ...a } : null; });
  rig.prisma.auditLog.findFirst = jest.fn(async ({ where }) => { const a = rig.world.audit.find((x) => kit.matches(x, where)); return a ? { id: 1 } : null; });
  const baseRaw = rig.prisma.$queryRaw;
  rig.prisma.$queryRaw = jest.fn(async (strings, ...values) => (String(strings && strings[0]).includes('DATABASE()') ? [{ db: databaseName }] : baseRaw(strings, ...values)));
  dealState = { deal: null };
  api = {
    getDeal: jest.fn(async () => ({ status: 'ok', deal: dealState.deal })),
    createDeal: jest.fn(), updateDealFiles: jest.fn(), updateDeal: jest.fn(), downloadBitrixFile: jest.fn(), getDealFileField: jest.fn(),
  };
  setDeal();
});
afterEach(() => rig.cleanup());

function setDeal(over = {}) {
  dealState.deal = {
    ID: kit.DEAL, CATEGORY_ID: '0', STAGE_ID: 'UC_R55CKV', [ACTUAL_FIELD.CASE_REFERENCE]: kit.REF,
    [ACTUAL_FILE_FIELD]: { id: 65001, showUrl: '/x', downloadUrl: '/y' }, OPPORTUNITY: '1000', CURRENCY_ID: 'INR', ...over,
  };
}
const ago = (seconds) => new Date(rig.world.clock - seconds * 1000);
const ctx = (extra = {}) => ({ prisma: rig.prisma, api, storage: rig.storage, env: ENV, now: () => new Date(rig.world.clock), push, log: rig.log, ...extra });
const sweep = (extra = {}) => auto.sweepQuotationAutoPublish(ctx(extra));
const row = (id) => rig.world.quotations.find((q) => q.id === id);
const audits = () => rig.world.audit.filter((a) => a.entityType === 'case_quotation');

// A stored draft with its real file: clean, valid, 1000 INR, scanned 130 s ago (settled), created 10 minutes ago, Bitrix file 65001, amount "1000", currency "INR".
async function seed(over = {}) {
  seq += 1;
  const bytes = over.bytes || pdf(`q${seq}`);
  const hash = sha(bytes);
  const key = `quotations/case-3037/ev${900 + seq}-${hash}.pdf`;
  await rig.storage.putIfAbsent(key, bytes, hash);
  const { bytes: _b, ...rest } = over;
  const status = rest.status || 'draft';
  return rig.prisma.caseQuotation.create({
    data: {
      caseId: 3037, dealLinkId: 1173, versionNumber: seq, bitrixDealId: kit.DEAL, bitrixFileId: '65001', bitrixAmountRaw: '1000', bitrixCurrencyRaw: 'INR',
      bitrixDealStageId: 'UC_R55CKV', contentFingerprint: hash, storageProvider: 'local', storageKey: key, sizeBytes: bytes.length, sha256: hash,
      amount: '1000.000', currency: 'INR', validationError: null, status, workingSlot: ['draft', 'confirmed'].includes(status) ? 1 : null,
      liveSlot: ['published', 'accepted'].includes(status) ? 1 : null, scanStatus: 'clean', scannedAt: ago(130), createdAt: ago(600), revision: 3, lastSeenAt: ago(60), ...rest,
    },
  });
}
const outcomes = (result) => result.results.map((r) => r.outcome);
const untouched = (id, before) => expect(row(id)).toEqual(before);

describe('the happy path', () => {
  test('a clean, settled draft in the stage "Quoted" is confirmed, published and notified once, as the system', async () => {
    const q = await seed();
    const result = await sweep();
    expect(result).toMatchObject({ active: true, checked: 1 });
    expect(outcomes(result)).toEqual(['published']);
    expect(row(q.id)).toMatchObject({ status: 'published', liveSlot: 1, workingSlot: null, confirmedByAdminId: 2, publishedByAdminId: 2 });
    expect(rig.world.notifications).toHaveLength(1);
    expect(rig.world.notifications[0]).toMatchObject({ recipientType: 'patient', recipientId: 55, kind: 'quotation_ready', body: quotations.NOTICE_BODY });
    expect(push).toHaveBeenCalledTimes(1);
    const rows = audits();
    expect(rows.map((a) => a.action)).toEqual(['quotation.confirmed', 'quotation.published']);
    for (const a of rows) expect(a).toMatchObject({ actorType: 'system', source: 'quotation_auto', actorId: '2', actorRole: 'admin' });
    expect(rows.map((a) => a.reasonCode)).toEqual(['auto_confirmed', 'auto_published']);
  });
  test('it never creates an invoice, a payment or a Bitrix write', async () => {
    await seed();
    await sweep();
    expect(rig.world.invoices).toHaveLength(0);
    expect(api.getDeal).toHaveBeenCalledTimes(1);
    for (const write of ['createDeal', 'updateDealFiles', 'updateDeal', 'downloadBitrixFile', 'getDealFileField']) expect(api[write]).not.toHaveBeenCalled();
  });
});

describe('scan and validity gates (nothing is acted on)', () => {
  test.each([['pending'], ['error'], ['infected']])('a %s scan is never confirmed or published', async (scanStatus) => {
    const q = await seed({ scanStatus, scannedAt: scanStatus === 'pending' ? null : ago(500) });
    const before = { ...row(q.id) };
    const result = await sweep();
    expect(result.checked).toBe(0); // not even a candidate
    const direct = await auto.processOne(ctx(), { from: new Date('2029-12-01T00:00:00Z'), adminId: 2, settleSeconds: 120, profile: require('../../src/modules/bitrix/bitrix-profiles').ACTUAL_PROFILE }, q.id);
    expect(direct.outcome).toBe('scan_not_clean');
    untouched(q.id, before);
    expect(rig.world.audit).toHaveLength(0);
    expect(rig.world.notifications).toHaveLength(0);
    expect(api.getDeal).not.toHaveBeenCalled();
  });
  test('a version with a missing or invalid amount or currency is never acted on', async () => {
    const a = await seed({ amount: null, currency: null, bitrixAmountRaw: null });
    const before = { ...row(a.id) };
    expect((await sweep()).checked).toBe(0);
    untouched(a.id, before);
    const b = await seed({ validationError: 'amount_invalid' });
    expect((await sweep()).checked).toBe(0);
    expect(row(b.id).status).toBe('draft');
    expect(rig.world.notifications).toHaveLength(0);
  });
  test('only the HEAD version, only after the cutoff', async () => {
    const old = await seed();
    await seed({ status: 'withdrawn', workingSlot: null, withdrawnAt: ago(5), withdrawnByAdminId: 7, withdrawReason: 'Superseded by hand' });
    const result = await sweep();
    expect(outcomes(result)).toEqual(['not_head_version']);
    expect(row(old.id).status).toBe('draft');
    const early = await seed({ createdAt: new Date('2029-11-01T00:00:00Z') });
    expect(outcomes(await sweep())).not.toContain('published');
    expect(row(early.id).status).toBe('draft');
  });
});

describe('the designated Admin is verified on every sweep', () => {
  test.each([
    ['disabled', { status: 'disabled' }, 'admin_not_active'],
    ['invited', { status: 'invited' }, 'admin_not_active'],
    ['soft-disabled', { disabledAt: new Date(0) }, 'admin_disabled'],
    ['locked', { lockedUntil: new Date('2031-01-01T00:00:00Z') }, 'admin_locked'],
    ['a superadmin', { role: 'superadmin' }, 'admin_role_not_admin'],
  ])('%s: nothing is read from Bitrix or written', async (_name, patch, code) => {
    const q = await seed();
    const before = { ...row(q.id) };
    Object.assign(rig.world.admins.find((a) => a.id === 2), patch);
    const result = await sweep();
    expect(result).toMatchObject({ code, checked: 0 });
    untouched(q.id, before);
    expect(api.getDeal).not.toHaveBeenCalled();
    expect(rig.world.audit).toHaveLength(0);
    expect(rig.world.notifications).toHaveLength(0);
  });
  test('a missing account stops the sweep, and an Admin disabled mid-sweep stops it before the next action', async () => {
    const q = await seed();
    rig.world.admins.splice(rig.world.admins.findIndex((a) => a.id === 2), 1);
    expect((await sweep()).code).toBe('admin_not_found');
    rig.world.admins.push({ id: 2, name: 'Ops Admin', status: 'active', role: 'admin' });
    const spy = jest.spyOn(quotations, 'confirmQuotation').mockImplementationOnce(async (...args) => {
      const result = await jest.requireActual('../../src/modules/quotations/quotations.service').confirmQuotation(...args);
      rig.world.admins.find((a) => a.id === 2).status = 'disabled'; // disabled right after the confirmation
      return result;
    });
    const result = await sweep();
    spy.mockRestore();
    expect(outcomes(result)).toEqual(['admin_unusable']);
    expect(row(q.id).status).toBe('confirmed'); // never published
    expect(rig.world.notifications).toHaveLength(0);
  });
});

describe('the Bitrix stage and content (read only)', () => {
  test.each([['C38:NEW'], ['UC_OTHER'], ['NEW'], ['WON'], [undefined]])('stage %s is not "Quoted"', async (stage) => {
    const q = await seed();
    setDeal({ STAGE_ID: stage });
    expect(outcomes(await sweep())).toEqual(['stage_not_quoted']);
    expect(row(q.id).status).toBe('draft');
    expect(rig.world.audit).toHaveLength(0);
  });
  test('a Deal of another pipeline, another Case, or with different content is refused', async () => {
    const q = await seed();
    setDeal({ CATEGORY_ID: '38' });
    expect(outcomes(await sweep())).toEqual(['deal_mismatch']);
    setDeal({ [ACTUAL_FIELD.CASE_REFERENCE]: 'CASE-9999' });
    expect(outcomes(await sweep())).toEqual(['deal_mismatch']);
    setDeal({ OPPORTUNITY: '1200' });
    expect(outcomes(await sweep())).toEqual(['bitrix_content_differs']);
    setDeal({ CURRENCY_ID: 'USD' });
    expect(outcomes(await sweep())).toEqual(['bitrix_content_differs']);
    setDeal({ [ACTUAL_FILE_FIELD]: { id: 70000 } });
    expect(outcomes(await sweep())).toEqual(['bitrix_content_differs']);
    setDeal({ [ACTUAL_FILE_FIELD]: null });
    expect(outcomes(await sweep())).toEqual(['bitrix_content_differs']);
    expect(row(q.id).status).toBe('draft');
    expect(rig.world.notifications).toHaveLength(0);
  });
  test('Bitrix being unreachable or the link of another profile means no action', async () => {
    const q = await seed();
    api.getDeal.mockResolvedValueOnce({ status: 'uncertain', reason: 'timeout' });
    expect(outcomes(await sweep())).toEqual(['bitrix_unavailable']);
    rig.world.link = { ...rig.world.link, profile: 'test' };
    expect(outcomes(await sweep())).toEqual(['deal_profile_mismatch']);
    expect(row(q.id).status).toBe('draft');
  });
});

describe('the settle delay (120 seconds)', () => {
  test('a version scanned 119 s ago waits; at 120 s it is acted on', async () => {
    const q = await seed({ scannedAt: ago(119) });
    expect((await sweep()).checked).toBe(0);
    expect(row(q.id).status).toBe('draft');
    rig.world.clock += 1000; // now exactly 120 s
    expect(outcomes(await sweep())).toEqual(['published']);
  });
  test('a replaced file resets the scan, so a changed version cannot be published from an old scan', async () => {
    const q = await seed();
    Object.assign(row(q.id), { scanStatus: 'pending', scannedAt: null, revision: 4 }); // what the sync does when the PDF or amount changes
    expect((await sweep()).checked).toBe(0);
    expect(row(q.id).status).toBe('draft');
  });
  test('the settle period can only be raised, never lowered below 120', () => {
    expect(config.readSettings({ ...ENV, QUOTATION_AUTO_PUBLISH_SETTLE_SECONDS: '300' }).settings.settleSeconds).toBe(300);
    expect(config.readSettings(ENV).settings.settleSeconds).toBe(120);
    for (const bad of ['119', '0', '-5', '120.5', 'abc', '90000']) expect(config.readSettings({ ...ENV, QUOTATION_AUTO_PUBLISH_SETTLE_SECONDS: bad }).problem).toBe('settle_invalid');
  });
});

describe('cases that need a person', () => {
  test('an accepted live quotation is never replaced', async () => {
    const accepted = await seed({ status: 'accepted', confirmedByAdminId: 7, confirmedAt: ago(900), publishedByAdminId: 7, publishedAt: ago(800), decidedByUserId: 55, decidedAt: ago(700), scannedAt: ago(900) });
    const draft = await seed();
    expect(outcomes(await sweep())).toEqual(['accepted_quotation_live']);
    expect(row(draft.id).status).toBe('draft');
    expect(row(accepted.id).status).toBe('accepted');
    expect(row(accepted.id).supersededAt == null).toBe(true);
    expect(rig.world.notifications).toHaveLength(0);
  });
  test('a Case that already has an invoice is skipped', async () => {
    const q = await seed();
    rig.world.invoices.push({ id: 1, caseId: 3037, quotationId: null, status: 'issued', amount: '1000.000', currency: 'INR' });
    expect(outcomes(await sweep())).toEqual(['case_has_invoice']);
    expect(row(q.id).status).toBe('draft');
  });
  test('a closed or ineligible Case is skipped', async () => {
    const q = await seed();
    rig.world.caseRecord.status = 'cancelled';
    expect(outcomes(await sweep())).toEqual(['case_closed']);
    rig.world.caseRecord.status = 'in_progress';
    rig.world.request.bitrixLeadId = 99;
    expect(outcomes(await sweep())).toEqual(['case_not_eligible']);
    expect(row(q.id).status).toBe('draft');
  });
  test('a confirmation made by a person is never carried on; the sweep\'s own is', async () => {
    const byPerson = await seed({ status: 'confirmed', confirmedByAdminId: 7, confirmedAt: ago(500), revision: 4 });
    expect(outcomes(await sweep())).toEqual(['confirmed_by_person']);
    expect(row(byPerson.id).status).toBe('confirmed');
    expect(rig.world.notifications).toHaveLength(0);
  });
  test('a confirmation the sweep made but could not follow with publication is completed on the next sweep', async () => {
    const q = await seed();
    const actual = jest.requireActual('../../src/modules/quotations/quotations.service');
    const spy = jest.spyOn(quotations, 'publishQuotation').mockRejectedValueOnce(Object.assign(new Error('x'), { statusCode: 409, publicCode: 'quotation_changed' }));
    const first = await sweep();
    spy.mockRestore();
    expect(outcomes(first)).toEqual(['refused:quotation_changed:confirmed']);
    expect(row(q.id).status).toBe('confirmed');
    expect(actual.publishQuotation).toBeDefined();
    expect(outcomes(await sweep())).toEqual(['published']);
    expect(rig.world.notifications).toHaveLength(1);
  });
});

describe('races, revisions and idempotency', () => {
  test('a version changed by the sync between confirmation and publication is not published', async () => {
    const q = await seed();
    const actual = jest.requireActual('../../src/modules/quotations/quotations.service');
    const spy = jest.spyOn(quotations, 'confirmQuotation').mockImplementationOnce(async (...args) => {
      const result = await actual.confirmQuotation(...args);
      // The sync replaces the PDF in place: back to draft, confirmation cleared, scan reset, revision up.
      Object.assign(row(q.id), { status: 'draft', confirmedByAdminId: null, confirmedAt: null, scanStatus: 'pending', scannedAt: null, revision: row(q.id).revision + 1 });
      return result;
    });
    const result = await sweep();
    spy.mockRestore();
    expect(outcomes(result)[0]).toMatch(/^refused:/);
    expect(row(q.id).status).toBe('draft');
    expect(rig.world.notifications).toHaveLength(0);
    expect(audits().map((a) => a.action)).not.toContain('quotation.published');
  });
  test('running it again changes nothing: one notification, one confirmation, one publication', async () => {
    const q = await seed();
    await sweep();
    const snapshot = JSON.stringify(rig.world.audit);
    const again = await sweep();
    expect(again.checked).toBe(0);
    expect(JSON.stringify(rig.world.audit)).toBe(snapshot);
    expect((await auto.processOne(ctx(), config.readSettings(ENV).settings, q.id)).outcome).toBe('not_working_version');
    expect(rig.world.notifications).toHaveLength(1);
    expect(push).toHaveBeenCalledTimes(1);
  });
  test('two processes at once: exactly one notification, one audit row per action', async () => {
    const q = await seed();
    const settings = config.readSettings(ENV).settings;
    const results = await Promise.all([auto.processOne(ctx(), settings, q.id), auto.processOne(ctx(), settings, q.id)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(expect.arrayContaining(['published']));
    expect(rig.world.notifications).toHaveLength(1);
    expect(audits().filter((a) => a.action === 'quotation.confirmed')).toHaveLength(1);
    expect(audits().filter((a) => a.action === 'quotation.published')).toHaveLength(1);
    expect(row(q.id).status).toBe('published');
  });
  test('two sweeps in one process: the second does nothing', async () => {
    await seed();
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect([a, b].filter((r) => r.skipped === 'already_running')).toHaveLength(1);
    expect(rig.world.notifications).toHaveLength(1);
  });
  test('a newer version replaces the previous live PUBLISHED one through the existing supersession', async () => {
    const live = await seed({ status: 'published', confirmedByAdminId: 7, confirmedAt: ago(900), publishedByAdminId: 7, publishedAt: ago(800), scannedAt: ago(900) });
    const next = await seed({ bitrixFileId: '65001' });
    expect(outcomes(await sweep())).toEqual(['published']);
    expect(row(live.id)).toMatchObject({ status: 'superseded', liveSlot: null, supersededById: next.id });
    expect(row(next.id)).toMatchObject({ status: 'published', liveSlot: 1 });
  });
});

describe('configuration: everything OFF by default, fail closed, development database only', () => {
  const prismaThatMustNotBeUsed = new Proxy({}, { get() { throw new Error('the database must not be touched'); } });
  test('with no environment, or the switch not exactly "true", nothing is touched', async () => {
    for (const env of [{}, { ...ENV, QUOTATION_AUTO_PUBLISH: 'TRUE' }, { ...ENV, QUOTATION_AUTO_PUBLISH: '1' }, { ...ENV, QUOTATION_AUTO_PUBLISH: 'false' }, { ...ENV, QUOTATION_AUTO_PUBLISH: undefined }]) {
      const result = await auto.sweepQuotationAutoPublish({ prisma: prismaThatMustNotBeUsed, api, env, log: rig.log });
      expect(result).toMatchObject({ active: false, code: 'switch_off' });
    }
    expect(api.getDeal).not.toHaveBeenCalled();
  });
  test.each([
    [{ NODE_ENV: 'production' }, 'refused_in_production'],
    [{ QUOTATION_AUTO_PUBLISH_FROM: undefined }, 'cutoff_missing_or_invalid'],
    [{ QUOTATION_AUTO_PUBLISH_FROM: '2029-12-01' }, 'cutoff_missing_or_invalid'],
    [{ QUOTATION_AUTO_PUBLISH_ADMIN_ID: undefined }, 'admin_id_missing_or_invalid'],
    [{ QUOTATION_AUTO_PUBLISH_ADMIN_ID: '0' }, 'admin_id_missing_or_invalid'],
    [{ QUOTATION_AUTO_PUBLISH_ADMIN_ID: '2 ' }, 'admin_id_missing_or_invalid'],
    [{ DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }, 'database_not_humancare_dev'],
    [{ DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }, 'database_host_not_local'],
    [{ DATABASE_URL: undefined }, 'database_url_invalid'],
    [{ BITRIX_DEAL_PROFILE: 'test' }, 'profile_not_actual'],
    [{ BITRIX_DEAL_PROFILE: undefined }, 'profile_not_actual'],
    [{ BITRIX_QUOTATION_SYNC_ENABLED: 'false' }, 'quotation_sync_inactive'],
  ])('%j is refused (%s)', async (patch, code) => {
    const env = { ...ENV, ...patch };
    const result = await auto.sweepQuotationAutoPublish({ prisma: prismaThatMustNotBeUsed, api, env, log: rig.log });
    expect(result).toMatchObject({ active: false, code });
  });
  test('the database SERVER must confirm humancare_dev, not only the URL', async () => {
    const q = await seed();
    databaseName = 'humancare_test';
    expect(await sweep()).toMatchObject({ active: false, code: 'database_not_humancare_dev' });
    expect(row(q.id).status).toBe('draft');
    expect(api.getDeal).not.toHaveBeenCalled();
  });
  test('the required stage is fixed and Category 0 is required', () => {
    expect(config.REQUIRED_STAGE_ID).toBe('UC_R55CKV');
    expect(config.readSettings(ENV).settings.profile).toMatchObject({ name: 'actual', categoryId: 0 });
  });
});

describe('manual confirmation and publication are unchanged', () => {
  const deps = () => ({ prisma: rig.prisma, storage: rig.storage, now: () => new Date(rig.world.clock), push, log: rig.log });
  test('an Admin action is still recorded as that Admin from the Admin Portal', async () => {
    const q = await seed({ scannedAt: ago(5) });
    const confirmed = await quotations.confirmQuotation({ quotationId: q.id, revision: q.revision, adminId: 7, adminRole: 'admin' }, deps());
    await quotations.publishQuotation({ quotationId: q.id, revision: confirmed.quotation.revision, adminId: 7, adminRole: 'admin' }, deps());
    expect(audits().map((a) => [a.action, a.actorType, a.source, a.reasonCode])).toEqual([
      ['quotation.confirmed', 'admin', 'admin_portal', 'admin_confirmed'], ['quotation.published', 'admin', 'admin_portal', 'admin_published'],
    ]);
  });
  test('only a strict boolean true marks the system; anything else is an ordinary Admin action', async () => {
    for (const automation of ['true', 1, 'quotation_auto', {}]) {
      const q = await seed({ scannedAt: ago(5) });
      await quotations.confirmQuotation({ quotationId: q.id, revision: q.revision, adminId: 7, adminRole: 'admin', automation }, deps());
    }
    expect(audits().every((a) => a.actorType === 'admin' && a.source === 'admin_portal')).toBe(true);
  });
  test('the HTTP layer never forwards the marker from a request body', () => {
    const controller = read('src/modules/quotations/quotations.controller.js');
    expect(controller).not.toMatch(/automation/);
  });
  test('the existing safeguards still apply to the sweep: a non-clean scan is refused by the service itself', async () => {
    const q = await seed({ scanStatus: 'pending', scannedAt: null });
    const err = await quotations.confirmQuotation({ quotationId: q.id, revision: q.revision, adminId: 2, adminRole: 'admin', automation: true }, deps()).then(() => null, (e) => e);
    expect(err).toMatchObject({ statusCode: 409, publicCode: 'scan_not_clean' });
  });
});

describe('wiring and what this feature must never do', () => {
  test('the job is registered, named and scheduled like the others, and is inert by default', async () => {
    const job = require('../../src/jobs/quotation-auto-publish.job');
    expect(job).toMatchObject({ name: 'quotation-auto-publish', intervalMs: 60000, runOnStart: false });
    expect(require('../../src/jobs/index').jobs.map((j) => j.name)).toContain('quotation-auto-publish');
    const saved = process.env.QUOTATION_AUTO_PUBLISH;
    delete process.env.QUOTATION_AUTO_PUBLISH;
    try { expect(await job.run()).toMatchObject({ active: false, code: 'switch_off' }); } finally { if (saved !== undefined) process.env.QUOTATION_AUTO_PUBLISH = saved; }
  });
  test('the sources never create an invoice or payment, charge anyone, or write to Bitrix', () => {
    const code = ['src/modules/quotations/quotation-auto-publish.service.js', 'src/modules/quotations/quotation-auto-publish.config.js', 'src/jobs/quotation-auto-publish.job.js']
      .map((rel) => read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')).join('\n');
    for (const forbidden of [/ensureInvoice/, /invoice\.create/, /createPaymentOrder/, /payment\.create/, /razorpay/i, /createDeal/, /updateDeal/, /crm\.deal\.(add|update)/, /dotenv/, /writeFile|appendFile|require\('fs'\)/]) expect(code).not.toMatch(forbidden);
    expect(code).toMatch(/getDeal/); // the one Bitrix call, a read
  });
});
