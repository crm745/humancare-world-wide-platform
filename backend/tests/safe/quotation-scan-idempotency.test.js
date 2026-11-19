/* global describe, test, expect, jest, beforeEach, afterEach */
// Regression for quotation 762: the scan's audit key was derived from the PDF hash alone, so scanning the SAME bytes in a NEW stored file
// (an amount-only change) collided with the first scan's audit row (unique entity_type + entity_id + idempotency_key), the result transaction
// rolled back and the verdict was lost. The key now identifies the stored file. ClamAV is faked; stored files are REAL (temp folder).
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const fs = require('fs');
const path = require('path');
const kit = require('./quotation-test-kit');
const { runQuotationSync } = require('../../src/modules/bitrix/quotation-sync.service');
const { detectAndEnqueueQuotationSync } = require('../../src/modules/bitrix/quotation-outbox');
const { sweepPendingQuotationScans, attemptScan, scanAuditKey, describeError } = require('../../src/modules/bitrix/quotation-scan.service');

const { dealBody } = kit;
let rig;

beforeEach(async () => {
  rig = kit.makeRig();
  await detectAndEnqueueQuotationSync(rig.prisma, rig.world.caseRecord, rig.state.deal);
  await runQuotationSync(rig.ctx());
});
afterEach(() => rig.cleanup());

const row = () => rig.world.quotations[0];
const clean = () => jest.fn(async () => ({ status: 'clean' }));
const baseCtx = (extra = {}) => ({
  prisma: rig.prisma, storage: rig.storage, env: kit.ENV_ON, log: rig.log, clock: () => rig.world.clock, rng: () => 0.5, scanner: clean(), health: async () => true, ...extra,
});
const sweep = (extra = {}) => sweepPendingQuotationScans(baseCtx(extra));
const alerts = () => rig.log.error.mock.calls.filter(([m]) => /\[ALERT\]/.test(m));
const absolute = (key) => path.join(rig.root, ...key.split('/'));
const scanKeys = (action) => rig.world.audit.filter((a) => a.action === action).map((a) => a.idempotencyKey);
const identity = (r) => r.storageKey.split('/').pop().replace('.pdf', '');

// What Operations do in Bitrix: enter the amount. The PDF (and so its sha256) is unchanged; the sync stores it again under a new key.
let fileId = 80000;
async function sameBytesNewFile(amount) {
  fileId += 1;
  rig.state.deal = dealBody({ fileId, amount, currency: 'INR' });
  await detectAndEnqueueQuotationSync(rig.prisma, rig.world.caseRecord, rig.state.deal);
  rig.world.clock += 60 * 1000;
  await runQuotationSync(rig.ctx());
}

describe('scan audit keys identify the STORED FILE, not just the PDF bytes', () => {
  test('the key is derived from the storage key: ev<event>-<sha256>, deterministic, short and safe', () => {
    const sha = 'a'.repeat(64);
    const storageKey = `quotations/case-3037/ev466-${sha}.pdf`;
    const key = scanAuditKey('quotation.scan_clean', { id: 762, storageKey, sha256: sha });
    expect(key).toBe(`quotation.scan_clean:762:ev466-${sha}`);
    expect(scanAuditKey('quotation.scan_clean', { id: 762, storageKey, sha256: sha })).toBe(key);
    expect(key.length).toBeLessThanOrEqual(191);
    // the same bytes in another stored file
    expect(scanAuditKey('quotation.scan_clean', { id: 762, storageKey: `quotations/case-3037/ev467-${sha}.pdf`, sha256: sha })).not.toBe(key);
    // different actions never share a key
    expect(scanAuditKey('quotation.scan_infected', { id: 762, storageKey })).not.toBe(key);
    // anything unexpected is hashed into a short safe token
    expect(scanAuditKey('quotation.scan_clean', { id: 762, storageKey: '../weird key!' })).toMatch(/^quotation\.scan_clean:762:[0-9a-f]{64}$/);
  });

  test('SAME PDF, NEW storage key (amount-only change): the second scan succeeds, the row ends clean, both results are audited under different keys', async () => {
    await sweep();
    const first = { ...row() };
    expect(first.scanStatus).toBe('clean');

    await sameBytesNewFile('1000');
    expect(row()).toMatchObject({ scanStatus: 'pending', amount: '1000.00', currency: 'INR', sha256: first.sha256 });
    expect(row().storageKey).not.toBe(first.storageKey);

    const result = await sweep();
    expect(result.results[0]).toMatchObject({ outcome: 'clean' }); // before the fix this threw P2002 and the verdict was lost
    expect(row()).toMatchObject({ scanStatus: 'clean', scanEngine: 'clamav', status: 'draft', confirmedAt: null, publishedAt: null });
    const keys = scanKeys('quotation.scan_clean');
    expect(keys).toEqual([`quotation.scan_clean:${first.id}:${identity(first)}`, `quotation.scan_clean:${row().id}:${identity(row())}`]);
    expect(new Set(keys).size).toBe(2);
  });

  test('SAME storage key: the key does not change between attempts or revisions, so a repeated audit write is still refused (idempotent), never doubled', async () => {
    await sweep();
    const keyBefore = scanKeys('quotation.scan_clean')[0];
    // the same stored file is scanned again: back to pending with the SAME storage key and hash
    Object.assign(row(), { scanStatus: 'pending', scanAttempts: 0, scanNextAttemptAt: null, revision: row().revision + 5 });
    await expect(attemptScan(baseCtx(), row().id)).rejects.toMatchObject({ code: 'P2002' });
    expect(scanKeys('quotation.scan_clean')).toEqual([keyBefore]); // no second audit row
    expect(row()).toMatchObject({ scanStatus: 'pending' }); // the failed transaction wrote nothing
    expect(scanAuditKey('quotation.scan_clean', row())).toBe(keyBefore); // independent of attempts and revision
  });

  test('infected: the same bytes in a replacement file are audited as a new infected result, not refused', async () => {
    const infected = () => jest.fn(async () => ({ status: 'infected', signature: 'Eicar-Test-Signature' }));
    await sweep({ scanner: infected() });
    expect(row().scanStatus).toBe('infected');
    await sameBytesNewFile('250');
    expect(row().scanStatus).toBe('pending');
    expect((await sweep({ scanner: infected() })).results[0]).toMatchObject({ outcome: 'infected' });
    const keys = scanKeys('quotation.scan_infected');
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(alerts()).toHaveLength(2);
  });

  test('failed: the same bytes in a replacement file are audited as a new failure, not refused', async () => {
    fs.writeFileSync(absolute(row().storageKey), 'tampered');
    expect((await sweep()).results[0]).toMatchObject({ outcome: 'failed' });
    await sameBytesNewFile('250');
    fs.writeFileSync(absolute(row().storageKey), 'tampered again');
    expect((await sweep()).results[0]).toMatchObject({ outcome: 'failed' });
    const keys = scanKeys('quotation.scan_failed');
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  test('retry/backoff is unchanged: a scanner without a verdict still uses one attempt, backs off and writes no scan audit row', async () => {
    await sweep({ scanner: jest.fn(async () => ({ status: 'error', detail: 'down' })) });
    expect(row()).toMatchObject({ scanStatus: 'error', scanAttempts: 1 });
    expect(+row().scanNextAttemptAt).toBeGreaterThan(rig.world.clock);
    expect(rig.world.audit.map((a) => a.action)).toEqual(['quotation.version_created']);
  });

  test('versioning and publication rules are untouched: the scan never changes status, confirmation, publication or the money', async () => {
    await sameBytesNewFile('1000');
    const before = { status: row().status, amount: row().amount, currency: row().currency, confirmedAt: row().confirmedAt, publishedAt: row().publishedAt, versionNumber: row().versionNumber };
    await sweep();
    expect(row()).toMatchObject(before);
    expect(rig.world.quotations).toHaveLength(1);
  });
});

describe('scan error logging', () => {
  const prismaError = () => Object.assign(new Error('Unique constraint failed on the fields: (`idempotency_key`) value "SECRET-VALUE"'), {
    name: 'PrismaClientKnownRequestError', code: 'P2002', meta: { target: ['entity_type', 'entity_id', 'idempotency_key'] },
  });

  test('describeError gives the name, the code and the constraint target, and never the message', () => {
    expect(describeError(prismaError())).toBe('PrismaClientKnownRequestError code=P2002 target=entity_type,entity_id,idempotency_key');
    expect(describeError(Object.assign(new Error('x'), { name: 'PrismaClientKnownRequestError', code: 'P2002', meta: { target: 'audit_logs_idx' } }))).toBe('PrismaClientKnownRequestError code=P2002 target=audit_logs_idx');
    expect(describeError(Object.assign(new Error('disk'), { code: 'EIO' }))).toBe('Error code=EIO');
    expect(describeError(new Error('plain'))).toBe('Error');
    expect(describeError(null)).toBe('error');
    expect(describeError(prismaError())).not.toMatch(/SECRET|value/);
  });

  test('control characters and separators in a code or target cannot forge a log line', () => {
    const text = describeError(Object.assign(new Error('x'), { code: 'P2002\ninjected', meta: { target: ['a b;c\n[ALERT] fake'] } }));
    expect(text).not.toMatch(/[\n\r;[\]]/); // no line breaks, separators or brackets
    expect(text.split(' ')).toHaveLength(3); // only the format's own separators: name, code=..., target=...
    expect(text.length).toBeLessThan(200);
  });

  test('a failure while recording a scan result is logged with its code and target; the message, query and file content never reach the log', async () => {
    rig.prisma.auditLog.create.mockImplementationOnce(async () => { throw prismaError(); });
    const result = await sweep();
    expect(result).toMatchObject({ active: true, checked: 0, due: 1 });
    const lines = rig.log.error.mock.calls.map(([m]) => m);
    expect(lines).toEqual([`[quotation-scan] quotation ${row().id}: PrismaClientKnownRequestError code=P2002 target=entity_type,entity_id,idempotency_key`]);
    expect(lines.join('\n')).not.toMatch(/SECRET-VALUE|%PDF/);
    expect(row()).toMatchObject({ scanStatus: 'pending' }); // nothing was recorded; the lease from the claim remains
  });
});
