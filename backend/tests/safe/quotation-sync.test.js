/* global describe, test, expect, jest, beforeEach, afterEach */
// The quotation sync worker end to end, in memory: detection (outbox event), Bitrix reads (fake), storage (REAL local files in a temp folder),
// the version rules, audit, failures and retries. No database, no network, no Bitrix write method exists in the fake.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const kit = require('./quotation-test-kit');
const { runQuotationSync, MAX_ATTEMPTS } = require('../../src/modules/bitrix/quotation-sync.service');
const { detectAndEnqueueQuotationSync } = require('../../src/modules/bitrix/quotation-outbox');
const { BitrixDealCallError } = require('../../src/modules/bitrix/bitrix-deal.api');

const { DEAL, dealBody, pdf, sha } = kit;
let rig;

beforeEach(() => { rig = kit.makeRig(); });
afterEach(() => rig.cleanup());

const detect = () => detectAndEnqueueQuotationSync(rig.prisma, rig.world.caseRecord, rig.state.deal);
const pass = (extra) => runQuotationSync(rig.ctx(extra));
const rows = () => rig.world.quotations;
const actions = () => rig.world.audit.map((a) => a.action);
const event = (id) => rig.world.events.find((e) => e.id === id);
const firstSync = async () => { await detect(); return pass(); };
// A new upload in Bitrix is a new file: new bytes AND a new file id (the amount and currency stay as they were unless given).
let nextFileId = 70000;
const reupload = (label, money = {}) => {
  nextFileId += 1;
  rig.state.pdf = pdf(label);
  rig.state.deal = dealBody({ fileId: nextFileId, amount: rig.state.deal.UF_CRM_6A3399F56ECFF, currency: rig.state.deal.UF_CRM_6A23F4E86AA45, ...money });
};

describe('the first upload', () => {
  test('creates draft version 1: stored privately, scan pending, amount and currency still awaiting Operations', async () => {
    expect(await detect()).toEqual({ queued: true, reason: 'queued' });
    const result = await pass();

    expect(result).toMatchObject({ active: true, claimed: 1 });
    expect(result.results[0]).toMatchObject({ outcome: 'created', versionNumber: 1 });
    const [q] = rows();
    expect(q).toMatchObject({
      caseId: 3037, versionNumber: 1, status: 'draft', workingSlot: 1, liveSlot: null, revision: 0, scanStatus: 'pending', scanAttempts: 0,
      amount: null, currency: null, validationError: 'amount_missing', bitrixAmountRaw: null, bitrixCurrencyRaw: null,
      bitrixFileId: '65834', bitrixDealId: DEAL, bitrixDealStageId: 'C38:NEW', dealLinkId: 1173, storageProvider: 'local',
      sizeBytes: rig.state.pdf.length, sha256: sha(rig.state.pdf), confirmedAt: null, confirmedByAdminId: null, publishedAt: null,
    });
    expect(q.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(q.storageKey).toMatch(/^quotations\/case-3037\/ev\d+-[0-9a-f]{64}\.pdf$/);
    expect(rig.filesOnDisk()).toEqual([q.storageKey]); // exactly one object, no temporary file
    expect(await rig.storage.hashOf(q.storageKey)).toBe(q.sha256);
    expect(event(464)).toMatchObject({ status: 'completed', attempts: 1 });
    expect(actions()).toEqual(['quotation.version_created']);
    expect(rig.world.audit[0]).toMatchObject({ entityType: 'case_quotation', actorType: 'bitrix', reasonCode: 'first_upload', idempotencyKey: 'quotation.version_created:event:464' });
  });

  test('uses only Bitrix READ calls (deal read, file read, one download) and never a write method', async () => {
    await firstSync();
    expect(rig.api.calls).toEqual(['crm.deal.get', 'crm.item.get', 'download']);
    expect(rig.api.createDeal).not.toHaveBeenCalled();
    expect(rig.api.updateDealFiles).not.toHaveBeenCalled();
  });

  test('a complete amount and currency are parsed exactly and stored with the version', async () => {
    rig.state.deal = dealBody({ amount: '12500.5', currency: 'INR' });
    await firstSync();
    expect(rows()[0]).toMatchObject({ amount: '12500.50', currency: 'INR', validationError: null, bitrixAmountRaw: '12500.5', bitrixCurrencyRaw: 'INR', status: 'draft', confirmedAt: null });
  });

  test('an amount that cannot be stored exactly leaves the pair null with a code: still a draft, never confirmable', async () => {
    rig.state.deal = dealBody({ amount: '10.001', currency: 'INR' });
    await firstSync();
    expect(rows()[0]).toMatchObject({ amount: null, currency: null, validationError: 'amount_precision', bitrixAmountRaw: '10.001', status: 'draft', confirmedByAdminId: null });
  });

  test('nothing else is created: no invoice or payment model is even reachable from the fake, and no notification is written', async () => {
    await firstSync();
    for (const model of ['invoice', 'payment']) expect(rig.prisma[model]).toBeUndefined();
    expect(rig.prisma.notification.create).not.toHaveBeenCalled(); // a sync result is never announced to the patient
    expect(rig.prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('repeated syncs create no duplicates', () => {
  test('after a successful sync the same Deal is not queued again and a pass claims nothing', async () => {
    await firstSync();
    expect(await detect()).toEqual({ queued: false, reason: 'unchanged' });
    expect((await pass()).claimed).toBe(0);
    expect(rows()).toHaveLength(1);
  });

  test('the same observation can be queued only once, even before it is processed', async () => {
    expect((await detect()).queued).toBe(true);
    expect(await detect()).toEqual({ queued: false, reason: 'already_queued' });
    expect(rig.world.events).toHaveLength(1);
  });

  test('the same PDF uploaded again under a new Bitrix file id stores nothing new and does not loop', async () => {
    await firstSync();
    rig.state.deal = dealBody({ fileId: 70001 });
    expect((await detect()).queued).toBe(true);
    const result = await pass();
    expect(result.results[0]).toMatchObject({ outcome: 'unchanged', code: 'unchanged_content' });
    expect(rows()).toHaveLength(1);
    expect(rig.filesOnDisk()).toHaveLength(1);
    expect(await detect()).toEqual({ queued: false, reason: 'already_queued' }); // same observation: refused by the unique key
  });

  test('a retry of the same event after a crash reuses the same stored object: one row, one file', async () => {
    await detect();
    rig.prisma.caseQuotation.create.mockRejectedValueOnce(new Error('crash after the file was stored'));
    await pass();
    expect(rows()).toHaveLength(0);
    expect(rig.filesOnDisk()).toHaveLength(1); // the staged object exists, no row refers to it yet
    const [stale] = rig.world.events;
    Object.assign(stale, { status: 'pending', lockedBy: null, lockedUntil: null, nextAt: 0 }); // lease recovery
    await pass();
    expect(rows()).toHaveLength(1);
    expect(rig.filesOnDisk()).toEqual([rows()[0].storageKey]);
  });

  test('two events for the same content processed at the same time give one version and one stored file', async () => {
    await detect();
    kitAddSecondEvent();
    const ctx = rig.ctx();
    const claims = [];
    for (const e of rig.world.events) claims.push(await rig.store.claim(rig.prisma, { id: e.id, workerId: 'w1', leaseSeconds: 120 }));
    const { processQuotationEvent } = require('../../src/modules/bitrix/quotation-sync.service');
    const outcomes = await Promise.all(claims.map((c) => processQuotationEvent(ctx, c)));
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['created', 'unchanged']);
    expect(rows()).toHaveLength(1);
    expect(rig.filesOnDisk()).toEqual([rows()[0].storageKey]);
  });
  function kitAddSecondEvent() { kit.addEvent(rig.world, { idempotencyKey: 'second' }); }
});

describe('versioning', () => {
  test('a change BEFORE publication updates the working version in place and resets its scan; the old file is kept, never overwritten', async () => {
    await firstSync();
    const first = { ...rows()[0] };
    Object.assign(rows()[0], { scanStatus: 'clean', scanAttempts: 1, scannedAt: new Date(), scanEngine: 'clamav' });
    reupload('two', { amount: '2500', currency: 'INR' });
    expect((await detect()).queued).toBe(true);
    expect((await pass()).results[0]).toMatchObject({ outcome: 'updated', versionNumber: 1 });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      id: first.id, versionNumber: 1, status: 'draft', revision: 1, amount: '2500.00', currency: 'INR', validationError: null, sha256: sha(rig.state.pdf),
      scanStatus: 'pending', scanAttempts: 0, scanNextAttemptAt: null, scannedAt: null, scanEngine: null,
    });
    expect(rows()[0].storageKey).not.toBe(first.storageKey);
    expect(rig.filesOnDisk()).toHaveLength(2); // the earlier file is kept
    expect(actions()).toEqual(['quotation.version_created', 'quotation.working_version_updated']);
    expect(rig.world.audit[1]).toMatchObject({ reasonCode: 'content_changed_before_publication', beforeData: { status: 'draft', bitrixFileId: '65834' } });
  });

  test('only the amount changing (same PDF) is a change too', async () => {
    await firstSync();
    rig.state.deal = dealBody({ amount: '99', currency: 'USD' });
    expect((await detect()).queued).toBe(true);
    expect((await pass()).results[0]).toMatchObject({ outcome: 'updated' });
    expect(rows()[0]).toMatchObject({ amount: '99.00', currency: 'USD' });
  });

  test('a confirmed (unpublished) version returns to draft when its content changes, losing its confirmation', async () => {
    rig.state.deal = dealBody({ amount: '100', currency: 'INR' });
    await firstSync();
    Object.assign(rows()[0], { status: 'confirmed', confirmedAt: new Date(), confirmedByAdminId: 7, scanStatus: 'clean' });
    rig.state.deal = dealBody({ amount: '200', currency: 'INR' });
    await detect();
    expect((await pass()).results[0]).toMatchObject({ outcome: 'updated' });
    expect(rows()[0]).toMatchObject({ status: 'draft', confirmedAt: null, confirmedByAdminId: null, scanStatus: 'pending', amount: '200.00' });
    expect(rig.world.audit.at(-1).reasonCode).toBe('confirmed_returned_to_draft');
  });

  test('a change AFTER publication creates version 2 as a new draft; version 1 is not touched', async () => {
    await firstSync();
    Object.assign(rows()[0], { status: 'published', workingSlot: null, liveSlot: 1, publishedAt: new Date(), scanStatus: 'clean' });
    const v1 = { ...rows()[0] };
    reupload('revised');
    await detect();
    expect((await pass()).results[0]).toMatchObject({ outcome: 'created', versionNumber: 2 });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toEqual(v1);
    expect(rows()[1]).toMatchObject({ versionNumber: 2, status: 'draft', workingSlot: 1, liveSlot: null, scanStatus: 'pending', revision: 0 });
    expect(rig.world.audit.at(-1)).toMatchObject({ reasonCode: 'content_changed_after_head', afterData: expect.objectContaining({ previousQuotationId: v1.id }) });

    // a further change now updates version 2 (the unpublished working version), not a version 3
    reupload('revised again');
    await detect();
    expect((await pass()).results[0]).toMatchObject({ outcome: 'updated', versionNumber: 2 });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toEqual(v1);
  });

  test.each(['accepted', 'rejected', 'withdrawn', 'superseded'])('a %s head is immutable: a change creates the next version and the head stays exactly as it was', async (status) => {
    await firstSync();
    Object.assign(rows()[0], { status });
    const head = { ...rows()[0] };
    reupload(`after ${status}`);
    await detect();
    expect((await pass()).results[0]).toMatchObject({ outcome: 'created', versionNumber: 2 });
    expect(rows()[0]).toEqual(head);
  });

  test.each(['accepted', 'rejected', 'published'])('unchanged Bitrix content on a %s head queues and creates nothing (re-publishing is an Operations action, not a sync)', async (status) => {
    await firstSync();
    Object.assign(rows()[0], { status });
    expect(await detect()).toEqual({ queued: false, reason: 'unchanged' });
    expect(rows()).toHaveLength(1);
  });

  test('going back to an earlier value (A, B, A) is a new observation, not a refused duplicate', async () => {
    await firstSync(); // A
    reupload('B');
    await detect();
    await pass(); // B (updates version 1 in place)
    reupload('one'); // the original PDF uploaded again: a new Bitrix file with the old content
    expect((await detect()).queued).toBe(true);
    expect((await pass()).results[0]).toMatchObject({ outcome: 'updated' });
    expect(rows()[0].sha256).toBe(sha(pdf('one')));
  });
});

describe('Bitrix-side edge cases', () => {
  test('a file removed in Bitrix changes and deletes nothing: Operations are alerted once', async () => {
    await firstSync();
    const before = JSON.stringify(rows());
    const files = rig.filesOnDisk();
    rig.state.deal = dealBody({ fileId: null });
    expect((await detect()).queued).toBe(true);
    expect((await pass()).results[0]).toMatchObject({ outcome: 'file_removed' });
    expect(JSON.stringify(rows())).toBe(before);
    expect(rig.filesOnDisk()).toEqual(files);
    expect(actions()).toContain('quotation.file_removed_in_bitrix');
    expect(rig.log.error.mock.calls.some(([m]) => /\[ALERT\].*removed/.test(m))).toBe(true);
    expect(await detect()).toEqual({ queued: false, reason: 'already_queued' });
  });

  test('no file and no version: nothing is queued', async () => {
    rig.state.deal = dealBody({ fileId: null });
    expect(await detect()).toEqual({ queued: false, reason: 'unchanged' });
  });

  test.each(['C38:WON', 'C38:LOSE'])('a Deal in %s is finished: nothing is queued, and a queued event completes without writing', async (stage) => {
    rig.state.deal = dealBody({ stage });
    expect(await detect()).toEqual({ queued: false, reason: 'deal_closed' });
    kit.addEvent(rig.world, { idempotencyKey: 'forced' });
    expect((await pass()).results[0]).toMatchObject({ outcome: 'deal_closed' });
    expect(rows()).toHaveLength(0);
  });

  test('a closed Case completes the event without writing', async () => {
    rig.world.caseRecord.status = 'completed';
    kit.addEvent(rig.world, { idempotencyKey: 'forced' });
    expect((await pass()).results[0]).toMatchObject({ outcome: 'case_closed' });
    expect(rows()).toHaveLength(0);
  });

  test('an unreadable file field is not guessed at: nothing is queued', async () => {
    rig.state.deal = { ...dealBody(), UF_CRM_1794985313: { id: 'abc' } };
    expect(await detect()).toEqual({ queued: false, reason: 'file_unreadable' });
  });
});

describe('failures and retries', () => {
  test('a Bitrix read that fails is retried with a growing delay, then fails for good with an audit row and an alert', async () => {
    rig.state.dealError = 'uncertain';
    await detect();
    const e = rig.world.events[0];
    let previousDelay = 0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await pass();
      expect(result.results[0]).toMatchObject({ outcome: 'retry', code: 'bitrix_read_failed' });
      expect(e).toMatchObject({ status: 'pending', attempts: attempt });
      const delay = e.nextAt - rig.world.clock;
      expect(delay).toBeGreaterThanOrEqual(previousDelay);
      previousDelay = delay;
      expect((await pass()).claimed).toBe(0); // not due yet
      rig.world.clock = e.nextAt + 1;
    }
    expect((await pass()).results[0]).toMatchObject({ outcome: 'failed' });
    expect(e).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(actions()).toEqual(['quotation.sync_failed']);
    expect(rig.log.error.mock.calls.some(([m]) => /\[ALERT\]/.test(m))).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  test('a definitive refusal (not a PDF, too large ...) fails at once; nothing is stored', async () => {
    rig.state.downloadError = new BitrixDealCallError('definitive', 'invalid_pdf', 'no header');
    await detect();
    expect((await pass()).results[0]).toMatchObject({ outcome: 'failed', code: 'download_invalid_pdf' });
    expect(event(464)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(rig.world.audit[0]).toMatchObject({ action: 'quotation.sync_failed', reasonCode: 'code:download_invalid_pdf' });
    expect(rows()).toHaveLength(0);
    expect(rig.filesOnDisk()).toEqual([]);
  });

  test('a download that times out is retried, not failed', async () => {
    rig.state.downloadError = new BitrixDealCallError('ambiguous', 'timeout');
    await detect();
    expect((await pass()).results[0]).toMatchObject({ outcome: 'retry', code: 'download_timeout' });
    expect(event(464).status).toBe('pending');
    rig.state.downloadError = null; // Bitrix recovers
    rig.world.clock = event(464).nextAt + 1;
    expect((await pass()).results[0]).toMatchObject({ outcome: 'created' });
  });

  test.each([
    ['a Deal that is not this Case\'s Deal (reference)', { ref: 'CASE-9999' }, 'reference_mismatch'],
    ['a Deal in another pipeline', { category: '5' }, 'category_mismatch'],
  ])('%s is never synced', async (_n, body, code) => {
    rig.state.deal = { ...dealBody(), ...(body.ref ? { UF_CRM_1794548440549: body.ref } : {}), ...(body.category ? { CATEGORY_ID: body.category } : {}) };
    kit.addEvent(rig.world, { idempotencyKey: 'forced' });
    expect((await pass()).results[0]).toMatchObject({ outcome: 'failed', code });
    expect(rows()).toHaveLength(0);
  });

  test('a Case that is not an approved Private Charter Case fails the event', async () => {
    rig.world.request.reviewStatus = null;
    kit.addEvent(rig.world, { idempotencyKey: 'forced' });
    expect((await pass()).results[0]).toMatchObject({ outcome: 'failed', code: 'case_not_eligible' });
  });

  test('a storage problem that may pass is retried; a conflicting object fails the event', async () => {
    rig.storage.putIfAbsent = jest.fn().mockRejectedValueOnce(Object.assign(new Error('io'), { code: 'EIO' })).mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'StorageError', code: 'conflict' }));
    await detect();
    expect((await pass()).results[0]).toMatchObject({ outcome: 'retry', code: 'storage_EIO' });
    rig.world.clock = event(464).nextAt + 1;
    expect((await pass()).results[0]).toMatchObject({ outcome: 'failed', code: 'storage_conflict' });
    expect(rows()).toHaveLength(0);
  });

  test('a lost lease writes NOTHING: no version, no audit row, the event is left as it was', async () => {
    await detect();
    rig.store.writeResult.mockImplementation(async () => 0);
    expect((await pass()).results[0]).toMatchObject({ outcome: 'lease_lost' });
    expect(rows()).toHaveLength(0);
    expect(rig.world.audit).toEqual([]);
  });

  test('a version that changed during processing is retried, never overwritten', async () => {
    await firstSync();
    reupload('next');
    await detect();
    const realUpdate = rig.prisma.caseQuotation.updateMany.getMockImplementation();
    rig.prisma.caseQuotation.updateMany.mockImplementationOnce(async () => { rows()[0].revision += 1; return { count: 0 }; });
    expect((await pass()).results[0]).toMatchObject({ outcome: 'retry', code: 'concurrent_change' });
    expect(rows()[0].sha256).toBe(sha(pdf('one')));
    rig.prisma.caseQuotation.updateMany.mockImplementation(realUpdate);
  });
});

describe('scope and switches', () => {
  test('a scoped pass processes only the named Case: any other pending event is left exactly as it was', async () => {
    await detect();
    const other = kit.addEvent(rig.world, { caseId: 3203, idempotencyKey: 'other-case' });
    const result = await pass({ scope: { caseIds: [3037] } });
    expect(result.claimed).toBe(1);
    expect(other).toMatchObject({ status: 'pending', attempts: 0 });
    expect(rig.store.claim).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['the quotation switch is off', { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }],
    ['the Deal switch is off', { BITRIX_SYNC_ENABLED: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }],
    ['everything is unset', {}],
  ])('the worker is completely idle when %s', async (_n, env) => {
    await detect();
    expect(await pass({ env })).toEqual({ active: false, claimed: 0 });
    expect(rig.store.findCandidateIds).not.toHaveBeenCalled();
    expect(rig.api.getDeal).not.toHaveBeenCalled();
    expect(rig.prisma.$transaction).not.toHaveBeenCalled();
  });
});
