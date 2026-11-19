/* global describe, test, expect, jest, beforeEach, afterEach */
// Operations quotation management, rule by rule. In-memory world (fake Prisma whose transaction serialises callers like the Case row lock and rolls
// back on a throw), REAL stored files in a temp folder, a fake push. No database, no network, no Bitrix.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const kit = require('./quotation-test-kit');
const svc = require('../../src/modules/quotations/quotations.service');

const { pdf, sha } = kit;
let rig; let push; let seq;

beforeEach(() => { rig = kit.makeRig(); push = jest.fn(async () => undefined); seq = 0; });
afterEach(() => rig.cleanup());

const deps = (extra = {}) => ({ prisma: rig.prisma, storage: rig.storage, now: () => new Date(rig.world.clock), push, log: rig.log, ...extra });
const ADMIN = { adminId: 7, adminRole: 'admin' };
const SUPER = { adminId: 8, adminRole: 'superadmin' };
const rows = () => rig.world.quotations;
const row = (id) => rig.world.quotations.find((q) => q.id === id);
const actions = () => rig.world.audit.map((a) => a.action);

// A stored quotation version with its real file. Defaults: a clean, valid draft (1000 INR) at revision 3, like quotation 762.
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
      caseId: 3037, dealLinkId: 1173, versionNumber: seq, bitrixDealId: kit.DEAL, bitrixFileId: String(65000 + seq), bitrixAmountRaw: '1000', bitrixCurrencyRaw: 'INR',
      bitrixDealStageId: 'C38:NEW', contentFingerprint: hash, storageProvider: 'local', storageKey: key, sizeBytes: bytes.length, sha256: hash,
      amount: '1000.000', currency: 'INR', validationError: null, status, workingSlot: ['draft', 'confirmed'].includes(status) ? 1 : null,
      liveSlot: ['published', 'accepted'].includes(status) ? 1 : null, scanStatus: 'clean', revision: 3, lastSeenAt: new Date(rig.world.clock), ...rest,
    },
  });
}
const confirmed = (over = {}) => seed({ status: 'confirmed', confirmedByAdminId: 7, confirmedAt: new Date(rig.world.clock - 1000), ...over });
const published = (over = {}) => seed({ status: 'published', confirmedByAdminId: 7, confirmedAt: new Date(rig.world.clock - 2000), publishedByAdminId: 7, publishedAt: new Date(rig.world.clock - 1000), ...over });
const decided = (status, over = {}) => seed({ status, confirmedByAdminId: 7, confirmedAt: new Date(rig.world.clock - 3000), publishedByAdminId: 7, publishedAt: new Date(rig.world.clock - 2000), decidedByUserId: 55, decidedAt: new Date(rig.world.clock - 1000), ...(status === 'rejected' ? { rejectionReason: 'too high' } : {}), ...over });
const confirmCall = (q, extra = {}) => svc.confirmQuotation({ quotationId: q.id, revision: q.revision, ...ADMIN, ...extra }, deps());
const publishCall = (q, extra = {}) => svc.publishQuotation({ quotationId: q.id, revision: q.revision, ...ADMIN, ...extra }, deps());
const withdrawCall = (q, extra = {}) => svc.withdrawQuotation({ quotationId: q.id, revision: q.revision, reason: 'Wrong amount quoted', ...ADMIN, ...extra }, deps());
const rejectsWith = async (promise, status, code) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err).not.toBeNull();
  expect(err).toMatchObject({ statusCode: status, ...(code ? { publicCode: code } : {}) });
  return err;
};

describe('confirm', () => {
  test('a clean, valid draft becomes confirmed: admin id and time recorded, audited, and NOTHING is published, notified or invoiced', async () => {
    const q = await seed();
    const result = await confirmCall(q);
    expect(result.alreadyConfirmed).toBe(false);
    expect(row(q.id)).toMatchObject({ status: 'confirmed', confirmedByAdminId: 7, revision: 4, workingSlot: 1, liveSlot: null, publishedAt: null, publishedByAdminId: null });
    expect(+row(q.id).confirmedAt).toBe(rig.world.clock);
    expect(result.quotation).toMatchObject({ status: 'confirmed', revision: 4, confirmedBy: { id: 7, name: 'Asha Admin' }, actions: { canConfirm: false, canPublish: true, canWithdraw: true } });
    expect(rig.world.audit).toHaveLength(1);
    expect(rig.world.audit[0]).toMatchObject({
      action: 'quotation.confirmed', entityType: 'case_quotation', entityId: String(q.id), caseId: 3037, actorType: 'admin', actorId: '7', actorRole: 'admin', source: 'admin_portal',
      reasonCode: 'admin_confirmed', beforeData: { status: 'draft' }, idempotencyKey: `quotation.confirmed:${q.id}:r3`,
    });
    expect(rig.world.notifications).toEqual([]);
    expect(push).not.toHaveBeenCalled();
    for (const model of ['invoice', 'payment']) expect(rig.prisma[model]).toBeUndefined();
  });

  test('a Superadmin may confirm too, and the role is what is audited', async () => {
    const q = await seed();
    await svc.confirmQuotation({ quotationId: q.id, revision: 3, ...SUPER }, deps());
    expect(row(q.id)).toMatchObject({ status: 'confirmed', confirmedByAdminId: 8 });
    expect(rig.world.audit[0]).toMatchObject({ actorId: '8', actorRole: 'superadmin' });
  });

  test.each([['pending'], ['error'], ['infected']])('a version whose scan is %s can never be confirmed', async (scanStatus) => {
    const q = await seed({ scanStatus });
    const err = await rejectsWith(confirmCall(q), 409, 'scan_not_clean');
    expect(err.blockers[0].code).toBe('scan_not_clean');
    expect(row(q.id)).toMatchObject({ status: 'draft', confirmedAt: null, revision: 3 });
    expect(rig.world.audit).toEqual([]);
  });

  test.each([
    ['no amount', { amount: null, currency: null, validationError: 'amount_missing' }, 'amount_missing'],
    ['no currency', { amount: null, currency: null, validationError: 'currency_missing' }, 'currency_missing'],
    ['an amount that could not be stored exactly', { amount: null, currency: null, validationError: 'amount_precision' }, 'amount_precision'],
    ['a validation error alone', { validationError: 'currency_invalid' }, 'currency_invalid'],
    ['only one half of the pair', { currency: null }, undefined],
  ])('an invalid quotation (%s) cannot be confirmed', async (_n, fields, detail) => {
    const q = await seed(fields);
    const err = await rejectsWith(confirmCall(q), 409, 'quotation_invalid');
    if (detail) expect(err.blockers.find((b) => b.code === 'quotation_invalid').detail).toBe(detail);
    expect(row(q.id)).toMatchObject({ status: 'draft', confirmedAt: null });
    expect(rig.world.audit).toEqual([]);
  });

  test('a stored PDF that is missing or no longer matches its hash cannot be confirmed', async () => {
    const tampered = await seed();
    require('fs').writeFileSync(rig.storage.pathOf(tampered.storageKey), 'tampered');
    await rejectsWith(confirmCall(tampered), 409, 'file_unverified');
    const gone = await seed();
    require('fs').rmSync(rig.storage.pathOf(gone.storageKey));
    await rejectsWith(confirmCall(gone), 409, 'file_unverified');
    expect(rows().every((q) => q.status === 'draft')).toBe(true);
  });

  test('a closed Case cannot have a quotation confirmed', async () => {
    const q = await seed();
    rig.world.caseRecord.status = 'completed';
    await rejectsWith(confirmCall(q), 409, 'case_closed');
  });

  test('the revision the Admin looked at is required, and a changed version is refused (the sync may have replaced the PDF in place)', async () => {
    const q = await seed();
    await rejectsWith(svc.confirmQuotation({ quotationId: q.id, ...ADMIN }, deps()), 400, 'revision_required');
    await rejectsWith(svc.confirmQuotation({ quotationId: q.id, revision: '3', ...ADMIN }, deps()), 400, 'revision_required');
    const err = await rejectsWith(svc.confirmQuotation({ quotationId: q.id, revision: 2, ...ADMIN }, deps()), 409, 'quotation_changed');
    expect(err.currentRevision).toBe(3);
    expect(row(q.id)).toMatchObject({ status: 'draft', revision: 3 });
  });

  test('an unknown id, a malformed id, a missing admin and a non-Private-Charter Case are refused', async () => {
    await rejectsWith(svc.confirmQuotation({ quotationId: 999, revision: 0, ...ADMIN }, deps()), 404, 'quotation_not_found');
    await rejectsWith(svc.confirmQuotation({ quotationId: '1; DROP', revision: 0, ...ADMIN }, deps()), 404, 'quotation_not_found');
    const q = await seed();
    await rejectsWith(svc.confirmQuotation({ quotationId: q.id, revision: 3, adminId: undefined }, deps()), 401, 'admin_required');
    rig.world.request.serviceKey = 'ground';
    await rejectsWith(confirmCall(q), 404, 'case_not_found');
  });

  test.each(['published', 'accepted', 'rejected', 'withdrawn', 'superseded'])('a %s version cannot be confirmed and is left exactly as it was', async (status) => {
    const q = status === 'published' ? await published() : status === 'withdrawn' ? await seed({ status, withdrawnAt: new Date(), withdrawnByAdminId: 7, withdrawReason: 'x', workingSlot: null }) : await decided(status, status === 'superseded' ? { supersededAt: new Date(), supersededById: 99, liveSlot: null } : {});
    const before = JSON.stringify(row(q.id));
    await rejectsWith(confirmCall(q), 409, 'quotation_not_draft');
    expect(JSON.stringify(row(q.id))).toBe(before);
  });

  test('a repeated confirmation is a no-op: same state, one audit row, the first admin stays the confirmer', async () => {
    const q = await seed();
    await confirmCall(q);
    const again = await svc.confirmQuotation({ quotationId: q.id, revision: 3, ...SUPER }, deps());
    expect(again.alreadyConfirmed).toBe(true);
    expect(row(q.id)).toMatchObject({ status: 'confirmed', confirmedByAdminId: 7, revision: 4 });
    expect(actions()).toEqual(['quotation.confirmed']);
  });

  test('two confirmations at the same time: one wins, the other sees "already confirmed"; one audit row, one revision step', async () => {
    const q = await seed();
    const results = await Promise.all([confirmCall(q), svc.confirmQuotation({ quotationId: q.id, revision: 3, ...SUPER }, deps())]);
    expect(results.map((r) => r.alreadyConfirmed).sort()).toEqual([false, true]);
    expect(row(q.id).revision).toBe(4);
    expect(actions()).toEqual(['quotation.confirmed']);
  });
});

describe('publish', () => {
  test('a confirmed version is published: publisher and time recorded, it becomes the live version, the patient is notified exactly once', async () => {
    const q = await confirmed();
    const result = await publishCall(q);
    expect(result.alreadyPublished).toBe(false);
    expect(row(q.id)).toMatchObject({ status: 'published', publishedByAdminId: 7, workingSlot: null, liveSlot: 1, revision: 4, validUntil: null });
    expect(+row(q.id).publishedAt).toBe(rig.world.clock);
    expect(actions()).toEqual(['quotation.published']);
    expect(rig.world.audit[0]).toMatchObject({ actorType: 'admin', actorId: '7', source: 'admin_portal', reasonCode: 'admin_published', beforeData: { status: 'confirmed' }, idempotencyKey: `quotation.published:${q.id}:r3` });
    expect(rig.world.notifications).toEqual([{ id: 1, readAt: null, recipientType: 'patient', recipientId: 55, kind: 'quotation_ready', title: 'CASE-4037 quotation', body: svc.NOTICE_BODY }]);
    expect(svc.NOTICE_BODY).not.toMatch(/\d|INR|amount/i); // fixed text: never an amount or anything from Bitrix
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('ExponentPushToken[test]', { title: 'CASE-4037 quotation', body: svc.NOTICE_BODY });
  });

  test('an unconfirmed version cannot be published, and nothing is notified', async () => {
    const q = await seed();
    await rejectsWith(publishCall(q), 409, 'quotation_not_confirmed');
    expect(row(q.id)).toMatchObject({ status: 'draft', publishedAt: null });
    expect(rig.world.notifications).toEqual([]);
    expect(rig.world.audit).toEqual([]);
  });

  test('an accepted version cannot be published again: a new version (and a fresh acceptance) is required; rejected, withdrawn and superseded are refused too', async () => {
    const accepted = await decided('accepted');
    const beforeAccepted = JSON.stringify(row(accepted.id));
    const err = await rejectsWith(publishCall(accepted), 409, 'new_version_required');
    expect(err.message).toMatch(/fresh acceptance/);
    expect(JSON.stringify(row(accepted.id))).toBe(beforeAccepted);
    for (const status of ['rejected', 'superseded']) {
      const q = await decided(status, status === 'superseded' ? { supersededAt: new Date(), supersededById: 99, liveSlot: null } : {});
      await rejectsWith(publishCall(q), 409, 'quotation_not_publishable');
    }
    expect(rig.world.notifications).toEqual([]);
  });

  test('a repeated publication is a no-op: one audit row, ONE notification, one push', async () => {
    const q = await confirmed();
    await publishCall(q);
    const again = await svc.publishQuotation({ quotationId: q.id, revision: 3, ...SUPER }, deps());
    expect(again.alreadyPublished).toBe(true);
    expect(row(q.id)).toMatchObject({ status: 'published', publishedByAdminId: 7, revision: 4 });
    expect(rig.world.notifications).toHaveLength(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(actions()).toEqual(['quotation.published']);
  });

  test('two publications at the same time give ONE notification (the compare-and-set has a single winner)', async () => {
    const q = await confirmed();
    const results = await Promise.all([publishCall(q), svc.publishQuotation({ quotationId: q.id, revision: 3, ...SUPER }, deps())]);
    expect(results.map((r) => r.alreadyPublished).sort()).toEqual([false, true]);
    expect(rig.world.notifications).toHaveLength(1);
    expect(rig.world.audit.filter((a) => a.action === 'quotation.published')).toHaveLength(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  test('a notification that cannot be written rolls the whole publication back; a push that fails never fails the publication', async () => {
    const q = await confirmed();
    rig.prisma.notification.create.mockRejectedValueOnce(new Error('database down'));
    await expect(publishCall(q)).rejects.toThrow('database down');
    expect(row(q.id)).toMatchObject({ status: 'confirmed', publishedAt: null, liveSlot: null, revision: 3 });
    expect(rig.world.audit).toEqual([]);
    expect(rig.world.notifications).toEqual([]);

    push.mockRejectedValueOnce(new Error('expo down'));
    await expect(publishCall(q)).resolves.toMatchObject({ alreadyPublished: false });
    expect(rig.world.notifications).toHaveLength(1);
    expect(rig.log.warn).toHaveBeenCalled();
  });

  test('publishing re-checks everything: scan, money, file and Case', async () => {
    const dirty = await confirmed({ scanStatus: 'pending' });
    await rejectsWith(publishCall(dirty), 409, 'scan_not_clean');
    const invalid = await confirmed({ amount: null, currency: null, validationError: 'amount_missing' });
    await rejectsWith(publishCall(invalid), 409, 'quotation_invalid');
    const tampered = await confirmed();
    require('fs').writeFileSync(rig.storage.pathOf(tampered.storageKey), 'x');
    await rejectsWith(publishCall(tampered), 409, 'file_unverified');
    const fine = await confirmed();
    rig.world.caseRecord.status = 'cancelled';
    await rejectsWith(publishCall(fine), 409, 'case_closed');
    expect(rig.world.notifications).toEqual([]);
    expect(rows().every((q) => q.status === 'confirmed')).toBe(true);
  });

  test('a changed version is refused (the revision the Admin looked at is stale)', async () => {
    const q = await confirmed();
    await rejectsWith(svc.publishQuotation({ quotationId: q.id, revision: 2, ...ADMIN }, deps()), 409, 'quotation_changed');
    await rejectsWith(svc.publishQuotation({ quotationId: q.id, ...ADMIN }, deps()), 400, 'revision_required');
    expect(row(q.id).status).toBe('confirmed');
  });

  test('an optional validity date must be in the future; it is stored and the version expires by computation, not by a stored state', async () => {
    const q = await confirmed();
    await rejectsWith(publishCall(q, { validUntil: new Date(rig.world.clock - 1000).toISOString() }), 400, 'valid_until_invalid');
    await rejectsWith(publishCall(q, { validUntil: 'next tuesday-ish' }), 400, 'valid_until_invalid');
    expect(row(q.id).status).toBe('confirmed');
    const until = new Date(rig.world.clock + 3600 * 1000).toISOString();
    await publishCall(q, { validUntil: until });
    expect(row(q.id).validUntil.toISOString()).toBe(until);
    expect(await svc.findActivePublishedQuotation(rig.prisma, 3037, new Date(rig.world.clock))).toMatchObject({ id: q.id });
    expect(await svc.findActivePublishedQuotation(rig.prisma, 3037, new Date(rig.world.clock + 2 * 3600 * 1000))).toBeNull();
  });

  test('publishing a newer version supersedes the previous PUBLISHED one (status superseded, successor recorded, no longer live) and notifies once for the new one', async () => {
    const v1 = await published();
    const v2 = await confirmed();
    await publishCall(v2);
    expect(row(v1.id)).toMatchObject({ status: 'superseded', supersededById: v2.id, liveSlot: null, revision: 4 });
    expect(row(v1.id).supersededAt).toBeInstanceOf(Date);
    expect(row(v2.id)).toMatchObject({ status: 'published', liveSlot: 1 });
    expect(actions()).toEqual(['quotation.superseded', 'quotation.published']);
    expect(rig.world.notifications).toHaveLength(1);
    expect((await svc.findActivePublishedQuotation(rig.prisma, 3037, new Date(rig.world.clock))).id).toBe(v2.id);
  });

  test('publishing a newer version over an ACCEPTED one keeps it accepted and immutable: only supersededAt, supersededById and liveSlot change', async () => {
    const v1 = await decided('accepted', { liveSlot: 1 });
    const before = { ...row(v1.id) };
    const v2 = await confirmed();
    await publishCall(v2);
    const after = row(v1.id);
    expect(after).toMatchObject({ status: 'accepted', supersededById: v2.id, liveSlot: null });
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])).sort();
    expect(changed).toEqual(['liveSlot', 'revision', 'supersededAt', 'supersededById']);
    expect(after).toMatchObject({ decidedByUserId: 55, amount: before.amount, sha256: before.sha256, storageKey: before.storageKey });
  });
});

describe('withdraw', () => {
  test.each([['draft', () => seed()], ['confirmed', () => confirmed()], ['published', () => published()]])('a %s version can be withdrawn with a reason: recorded, audited, never live again', async (_s, make) => {
    const q = await make();
    const before = JSON.stringify(row(q.id).publishedAt);
    const result = await withdrawCall(q, { reason: '  Amount was wrong  ' });
    expect(result.alreadyWithdrawn).toBe(false);
    expect(row(q.id)).toMatchObject({ status: 'withdrawn', withdrawnByAdminId: 7, withdrawReason: 'Amount was wrong', workingSlot: null, liveSlot: null, revision: 4 });
    expect(row(q.id).withdrawnAt).toBeInstanceOf(Date);
    expect(JSON.stringify(row(q.id).publishedAt)).toBe(before); // history is kept
    expect(rig.world.audit[0]).toMatchObject({ action: 'quotation.withdrawn', actorType: 'admin', actorId: '7', reasonCode: 'admin_withdrawn', beforeData: { status: q.status } });
    expect(JSON.stringify(rig.world.audit)).not.toMatch(/Amount was wrong/); // the reason text lives on the row, never in the audit trail
    expect(await svc.findActivePublishedQuotation(rig.prisma, 3037, new Date(rig.world.clock))).toBeNull();
    expect(rig.world.notifications).toEqual([]);
  });

  test.each([[undefined], [''], ['  '], ['no'], ['x'.repeat(1001)], [42]])('a reason of %p is refused and nothing changes', async (reason) => {
    const q = await seed();
    await rejectsWith(withdrawCall(q, { reason }), 400, 'reason_invalid');
    expect(row(q.id).status).toBe('draft');
    expect(rig.world.audit).toEqual([]);
  });

  test.each(['accepted', 'rejected', 'superseded'])('a %s version is immutable: it cannot be withdrawn', async (status) => {
    const q = await decided(status, status === 'superseded' ? { supersededAt: new Date(), supersededById: 99, liveSlot: null } : {});
    const before = JSON.stringify(row(q.id));
    await rejectsWith(withdrawCall(q), 409, 'quotation_immutable');
    expect(JSON.stringify(row(q.id))).toBe(before);
  });

  test('a repeated withdrawal is a no-op; a stale revision is refused', async () => {
    const q = await seed();
    await withdrawCall(q);
    expect((await svc.withdrawQuotation({ quotationId: q.id, revision: 3, reason: 'again please', ...SUPER }, deps())).alreadyWithdrawn).toBe(true);
    expect(actions()).toEqual(['quotation.withdrawn']);
    expect(row(q.id).withdrawnByAdminId).toBe(7);
    const other = await seed();
    await rejectsWith(svc.withdrawQuotation({ quotationId: other.id, revision: 1, reason: 'valid reason', ...ADMIN }, deps()), 409, 'quotation_changed');
  });

  test('a withdraw racing a publish: exactly one of them wins, and the loser is refused cleanly', async () => {
    const q = await confirmed();
    const [a, b] = await Promise.allSettled([publishCall(q), withdrawCall(q)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const state = row(q.id).status;
    expect(['published', 'withdrawn']).toContain(state);
    expect(rig.world.notifications).toHaveLength(state === 'published' ? 1 : 0);
  });
});

describe('a new version of an immutable quotation (the only way to publish identical content again)', () => {
  test('an accepted head gets a NEW draft copy: new key, same bytes, same money, scan pending, nothing confirmed; the accepted version is untouched', async () => {
    const v1 = await decided('accepted');
    const before = JSON.stringify(row(v1.id));
    const result = await svc.createNewVersion({ quotationId: v1.id, revision: 3, ...ADMIN }, deps());
    expect(JSON.stringify(row(v1.id))).toBe(before);
    expect(result.quotation).toMatchObject({ versionNumber: 2, status: 'draft', scanStatus: 'pending', amount: '1000.000', currency: 'INR', confirmedAt: null, publishedAt: null, revision: 0 });
    const v2 = rows()[1];
    expect(v2.storageKey).not.toBe(v1.storageKey);
    expect(v2.storageKey).toMatch(/^quotations\/case-3037\/cp\d+-[0-9a-f]{8}-[0-9a-f]{64}\.pdf$/);
    expect(await rig.storage.hashOf(v2.storageKey)).toBe(v1.sha256);
    expect(v2).toMatchObject({ sha256: v1.sha256, status: 'draft', workingSlot: 1, liveSlot: null, scanStatus: 'pending' });
    expect(rig.world.audit.at(-1)).toMatchObject({ action: 'quotation.new_version_created', reasonCode: 'new_version_requested' });
    expect(rig.world.notifications).toEqual([]);
  });

  test.each(['rejected', 'withdrawn', 'superseded'])('a %s head can be re-versioned too', async (status) => {
    const q = await decided(status, status === 'superseded' ? { supersededAt: new Date(), supersededById: 99, liveSlot: null } : {});
    await expect(svc.createNewVersion({ quotationId: q.id, revision: 3, ...ADMIN }, deps())).resolves.toBeTruthy();
    expect(rows()).toHaveLength(2);
  });

  test('refused while the Case already has a working version, from a published or draft source, from an older version, or without a clean file', async () => {
    const accepted = await decided('accepted');
    const working = await seed();
    await rejectsWith(svc.createNewVersion({ quotationId: accepted.id, revision: 3, ...ADMIN }, deps()), 409, 'working_version_exists');
    await rejectsWith(svc.createNewVersion({ quotationId: working.id, revision: 3, ...ADMIN }, deps()), 409, 'quotation_not_versionable');
    row(working.id).status = 'withdrawn'; row(working.id).workingSlot = null;
    await rejectsWith(svc.createNewVersion({ quotationId: accepted.id, revision: 3, ...ADMIN }, deps()), 409, 'not_latest_version');
    const dirty = await decided('rejected', { scanStatus: 'infected' });
    await rejectsWith(svc.createNewVersion({ quotationId: dirty.id, revision: 3, ...ADMIN }, deps()), 409, 'scan_not_clean');
    expect(rows().filter((q) => q.status === 'draft')).toHaveLength(0);
  });

  test('a failure while creating the version leaves no copy behind', async () => {
    const v1 = await decided('accepted');
    const before = rig.filesOnDisk();
    rig.prisma.caseQuotation.create.mockRejectedValueOnce(new Error('database down'));
    await expect(svc.createNewVersion({ quotationId: v1.id, revision: 3, ...ADMIN }, deps())).rejects.toThrow('database down');
    expect(rig.filesOnDisk()).toEqual(before);
    expect(rows()).toHaveLength(1);
  });
});

describe('what a patient may see (the latest ACTIVE published version)', () => {
  test.each([['draft'], ['confirmed'], ['withdrawn'], ['rejected'], ['superseded']])('a %s version is never active', async (status) => {
    const q = await seed({ status, ...(status === 'withdrawn' ? { withdrawnAt: new Date(), withdrawnByAdminId: 7, withdrawReason: 'x', workingSlot: null } : {}) });
    if (['rejected', 'superseded'].includes(status)) Object.assign(row(q.id), { confirmedAt: new Date(), publishedAt: new Date(), liveSlot: null });
    expect(await svc.findActivePublishedQuotation(rig.prisma, 3037, new Date(rig.world.clock))).toBeNull();
  });
  test('only the live published (or accepted) version is returned', async () => {
    await decided('rejected');
    const live = await published();
    expect((await svc.findActivePublishedQuotation(rig.prisma, 3037, new Date(rig.world.clock))).id).toBe(live.id);
    row(live.id).status = 'accepted';
    expect((await svc.findActivePublishedQuotation(rig.prisma, 3037, new Date(rig.world.clock))).id).toBe(live.id);
  });
});

describe('the PDF', () => {
  test('is served only while the scan is clean and the file matches its hash, and EVERY access is audited', async () => {
    const bytes = pdf('the-quotation');
    const q = await seed({ bytes });
    const a = await svc.resolveQuotationFile({ quotationId: q.id, ...ADMIN }, deps());
    const b = await svc.resolveQuotationFile({ quotationId: q.id, ...SUPER }, deps());
    expect(a.buffer).toEqual(bytes);
    expect(b.buffer).toEqual(bytes);
    expect(a.name).toBe(`CASE-4037-quotation-v${q.versionNumber}.pdf`);
    const views = rig.world.audit.filter((x) => x.action === 'quotation.file_viewed');
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ actorId: '7', source: 'admin_portal', idempotencyKey: null });
    expect(views[1]).toMatchObject({ actorId: '8', actorRole: 'superadmin' });
  });

  test.each(['pending', 'error', 'infected'])('a %s file is never served and nothing is audited as viewed', async (scanStatus) => {
    const q = await seed({ scanStatus });
    await rejectsWith(svc.resolveQuotationFile({ quotationId: q.id, ...ADMIN }, deps()), 409, 'scan_not_clean');
    expect(rig.world.audit).toEqual([]);
  });

  test('a file that was changed or removed is never served; an unknown quotation is a 404', async () => {
    const q = await seed();
    require('fs').writeFileSync(rig.storage.pathOf(q.storageKey), 'tampered');
    await rejectsWith(svc.resolveQuotationFile({ quotationId: q.id, ...ADMIN }, deps()), 409, 'file_unverified');
    await rejectsWith(svc.resolveQuotationFile({ quotationId: 12345, ...ADMIN }, deps()), 404, 'quotation_not_found');
    rig.world.request.serviceKey = 'ground';
    await rejectsWith(svc.resolveQuotationFile({ quotationId: q.id, ...ADMIN }, deps()), 404, 'case_not_found');
  });
});

describe('what the Admin sees', () => {
  test('the history is newest first, admin names are resolved, and the allowed actions follow the state', async () => {
    const v1 = await decided('accepted');
    Object.assign(row(v1.id), { liveSlot: null });
    const v2 = await seed({ versionNumber: 2 });
    const list = await svc.listCaseQuotations({ caseId: 3037 }, deps());
    expect(list).toMatchObject({ caseId: 3037, caseReference: 'CASE-4037' });
    expect(list.quotations.map((q) => q.versionNumber)).toEqual([row(v2.id).versionNumber, row(v1.id).versionNumber].sort((a, b) => b - a));
    const [newest, older] = list.quotations;
    expect(newest.actions).toMatchObject({ canConfirm: true, canPublish: false, canWithdraw: true, canCreateVersion: false, canViewFile: true, blockers: [] });
    expect(older).toMatchObject({ status: 'accepted', confirmedBy: { id: 7, name: 'Asha Admin' }, publishedBy: { id: 7, name: 'Asha Admin' } });
    expect(older.actions).toMatchObject({ canConfirm: false, canPublish: false, canWithdraw: false, canCreateVersion: false });
  });

  test('a lookup by CASE reference works; an unknown Case is a 404', async () => {
    await seed();
    expect((await svc.listCaseQuotations({ caseId: 'CASE-4037' }, deps())).quotations).toHaveLength(1);
    await rejectsWith(svc.listCaseQuotations({ caseId: 'CASE-0000' }, deps()), 404, 'case_not_found');
    await rejectsWith(svc.listCaseQuotations({ caseId: 999 }, deps()), 404, 'case_not_found');
  });

  test('the actions of each state: a clean valid draft can be confirmed; blockers are listed for an unclean or invalid one; confirmed can be published; an accepted head can be re-versioned', async () => {
    const draftOk = svc.quotationActions({ status: 'draft', scanStatus: 'clean', amount: '1', currency: 'INR', validationError: null }, { isHead: true, hasWorking: true, caseClosed: false });
    expect(draftOk).toMatchObject({ canConfirm: true, canPublish: false, canWithdraw: true, canCreateVersion: false });
    const draftBad = svc.quotationActions({ status: 'draft', scanStatus: 'pending', amount: null, currency: null, validationError: 'amount_missing' }, { isHead: true, hasWorking: true, caseClosed: false });
    expect(draftBad.canConfirm).toBe(false);
    expect(draftBad.blockers.map((b) => b.code)).toEqual(['scan_not_clean', 'quotation_invalid']);
    expect(draftBad.canViewFile).toBe(false);
    expect(svc.quotationActions({ status: 'confirmed', scanStatus: 'clean', amount: '1', currency: 'INR' }, { isHead: true, hasWorking: true, caseClosed: false })).toMatchObject({ canPublish: true, canConfirm: false });
    expect(svc.quotationActions({ status: 'published', scanStatus: 'clean', amount: '1', currency: 'INR' }, { isHead: true, hasWorking: false, caseClosed: false })).toMatchObject({ canWithdraw: true, canPublish: false, canCreateVersion: false });
    expect(svc.quotationActions({ status: 'accepted', scanStatus: 'clean', amount: '1', currency: 'INR' }, { isHead: true, hasWorking: false, caseClosed: false })).toMatchObject({ canCreateVersion: true, canWithdraw: false });
    expect(svc.quotationActions({ status: 'accepted', scanStatus: 'clean', amount: '1', currency: 'INR' }, { isHead: true, hasWorking: false, caseClosed: true }).canCreateVersion).toBe(false);
    expect(svc.quotationActions({ status: 'draft', scanStatus: 'clean', amount: '1', currency: 'INR' }, { isHead: true, hasWorking: true, caseClosed: true }).canConfirm).toBe(false);
  });

  test('the view never exposes the storage key, a file path or a Bitrix download link', async () => {
    const q = await seed();
    const text = JSON.stringify(await svc.getQuotation({ quotationId: q.id }, deps()));
    expect(text).not.toMatch(/quotations\/case-|storageKey|\.pdf|urlMachine|downloadUrl|https?:/);
  });
});

describe('what this module must never do', () => {
  test('no Bitrix call, no invoice or payment creation, no S3', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../../src/modules/quotations/quotations.service.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(source).not.toMatch(/bitrix-deal\.api|crm\.|createDeal|updateDealFiles|fetch\(/);
    expect(source).not.toMatch(/\.(invoice|payment)\b/);
    expect(source).not.toMatch(/aws|S3Client/i);
  });
});
