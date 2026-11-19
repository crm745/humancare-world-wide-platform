/* global describe, test, expect, jest, beforeEach, afterEach */
// Malware scanning of stored quotations: ClamAV is faked, the stored files are REAL (temp folder). No database, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const fs = require('fs');
const path = require('path');
const kit = require('./quotation-test-kit');
const { runQuotationSync } = require('../../src/modules/bitrix/quotation-sync.service');
const { detectAndEnqueueQuotationSync } = require('../../src/modules/bitrix/quotation-outbox');
const { sweepPendingQuotationScans } = require('../../src/modules/bitrix/quotation-scan.service');
const { SCAN_RETRY } = require('../../src/modules/request-review/request-review.config');

const { pdf, sha, dealBody } = kit;
let rig;

beforeEach(async () => {
  rig = kit.makeRig();
  await detectAndEnqueueQuotationSync(rig.prisma, rig.world.caseRecord, rig.state.deal);
  await runQuotationSync(rig.ctx());
});
afterEach(() => rig.cleanup());

const row = () => rig.world.quotations[0];
const clean = () => jest.fn(async () => ({ status: 'clean' }));
const sweep = (extra = {}) => sweepPendingQuotationScans({
  prisma: rig.prisma, storage: rig.storage, env: kit.ENV_ON, log: rig.log, clock: () => rig.world.clock, rng: () => 0.5, scanner: clean(), health: async () => true, ...extra,
});
const alerts = () => rig.log.error.mock.calls.filter(([m]) => /\[ALERT\]/.test(m));
const absolute = (key) => path.join(rig.root, ...key.split('/'));

describe('a sync result starts out unscanned and unconfirmable', () => {
  test('pending, never eligible: the database refuses to confirm or publish a row that is not clean', () => {
    expect(row()).toMatchObject({ status: 'draft', scanStatus: 'pending', confirmedAt: null, publishedAt: null });
    const migration = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261118100000_phase2_case_quotations/migration.sql'), 'utf8');
    const check = /CONSTRAINT `case_quotations_confirmed_chk` CHECK \(([^\n]+)\)/.exec(migration)[1];
    expect(check).toContain("`scan_status` = 'clean'");
    expect(check).toContain('`amount` IS NOT NULL AND `currency` IS NOT NULL AND `validation_error` IS NULL');
    expect(check).toContain("`status` NOT IN ('confirmed','published','accepted','rejected','superseded')");
  });
});

describe('a clean file', () => {
  test('is recorded as clean with the engine and time, audited once, and nothing else changes', async () => {
    const scanner = clean();
    const result = await sweep({ scanner });
    expect(result).toMatchObject({ active: true, checked: 1 });
    expect(result.results[0]).toMatchObject({ outcome: 'clean' });
    expect(row()).toMatchObject({ scanStatus: 'clean', scanEngine: 'clamav', scanAttempts: 1, scanNextAttemptAt: null, revision: 1, status: 'draft', confirmedAt: null, publishedAt: null, amount: null });
    expect(row().scannedAt).toBeInstanceOf(Date);
    expect(rig.world.audit.map((a) => a.action)).toEqual(['quotation.version_created', 'quotation.scan_clean']);
    expect(scanner).toHaveBeenCalledWith(absolute(row().storageKey));
    expect(fs.existsSync(absolute(row().storageKey))).toBe(true);
  });

  test('is never scanned twice: a clean row is final', async () => {
    await sweep();
    const again = jest.fn();
    expect(await sweep({ scanner: again })).toMatchObject({ checked: 0, due: 0 });
    expect(again).not.toHaveBeenCalled();
  });
});

describe('an infected file', () => {
  test('is recorded as infected, moved to quarantine, alerted, audited; the version can never be confirmed', async () => {
    const key = row().storageKey;
    const result = await sweep({ scanner: jest.fn(async () => ({ status: 'infected', signature: 'Eicar-Test-Signature' })) });
    expect(result.results[0]).toMatchObject({ outcome: 'infected' });
    expect(row()).toMatchObject({ scanStatus: 'infected', status: 'draft', confirmedAt: null });
    expect(row().scanDetail).toContain('Eicar-Test-Signature');
    expect(fs.existsSync(absolute(key))).toBe(false);
    expect(fs.existsSync(absolute(`quarantine/${key}`))).toBe(true);
    expect(alerts()).toHaveLength(1);
    expect(rig.world.audit.at(-1)).toMatchObject({ action: 'quotation.scan_infected', reasonCode: 'infected' });
    expect((await sweep()).checked).toBe(0); // final
  });
});

describe('retries', () => {
  test('a scanner that gives no verdict is retried after a growing delay, using one attempt each time', async () => {
    const failing = jest.fn(async () => ({ status: 'error', detail: 'cannot reach the scanner' }));
    expect((await sweep({ scanner: failing })).results[0]).toMatchObject({ outcome: 'retry' });
    expect(row()).toMatchObject({ scanStatus: 'error', scanAttempts: 1 });
    const firstDelay = +row().scanNextAttemptAt - rig.world.clock;
    expect(firstDelay).toBeGreaterThan(0);
    expect((await sweep({ scanner: failing })).checked).toBe(0); // backing off

    rig.world.clock = +row().scanNextAttemptAt + 1;
    await sweep({ scanner: failing });
    expect(row()).toMatchObject({ scanStatus: 'error', scanAttempts: 2 });
    expect(+row().scanNextAttemptAt - rig.world.clock).toBeGreaterThan(firstDelay);

    rig.world.clock = +row().scanNextAttemptAt + 1;
    expect((await sweep({ scanner: clean() })).results[0]).toMatchObject({ outcome: 'clean' });
    expect(row()).toMatchObject({ scanStatus: 'clean', scanAttempts: 3 });
  });

  test('after the last attempt the row ends in a FINAL error: alerted, audited and never scanned again', async () => {
    Object.assign(row(), { scanStatus: 'error', scanAttempts: SCAN_RETRY.maxAttempts, scanNextAttemptAt: new Date(rig.world.clock - 1000) });
    const scanner = jest.fn();
    const result = await sweep({ scanner });
    expect(result.results[0]).toMatchObject({ outcome: 'exhausted' });
    expect(scanner).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ scanStatus: 'error', scanNextAttemptAt: null });
    expect(row().scanDetail).toMatch(/retries_exhausted/);
    expect(alerts()).toHaveLength(1);
    expect(rig.world.audit.at(-1)).toMatchObject({ action: 'quotation.scan_failed', reasonCode: 'retries_exhausted' });
    rig.world.clock += 10 * 24 * 3600 * 1000;
    expect(await sweep({ scanner })).toMatchObject({ checked: 0, due: 0 });
  });

  test('while ClamAV is down nothing is claimed and no attempt is used up', async () => {
    const scanner = jest.fn();
    expect(await sweep({ scanner, health: async () => false })).toMatchObject({ checked: 0, due: 1, scannerUnavailable: true });
    expect(scanner).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ scanStatus: 'pending', scanAttempts: 0 });
  });

  test('a storage that cannot be reached gives the attempt back and looks again later', async () => {
    fs.rmSync(path.join(rig.root, 'quotations'), { recursive: true });
    const result = await sweep();
    expect(result.results[0]).toMatchObject({ outcome: 'storage_unavailable' });
    expect(row()).toMatchObject({ scanStatus: 'error', scanAttempts: 0 });
    expect(+row().scanNextAttemptAt).toBe(rig.world.clock + SCAN_RETRY.storageRecheckMs);
  });
});

describe('a file that cannot be trusted fails for good', () => {
  test('changed on disk (checksum mismatch): final error, never scanned, never reported clean', async () => {
    fs.writeFileSync(absolute(row().storageKey), 'tampered');
    const scanner = jest.fn();
    expect((await sweep({ scanner })).results[0]).toMatchObject({ outcome: 'failed' });
    expect(scanner).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ scanStatus: 'error', scanNextAttemptAt: null });
    expect(row().scanDetail).toMatch(/checksum/);
    expect(alerts()).toHaveLength(1);
  });

  test('changed while it was being scanned: a clean verdict is not accepted', async () => {
    const result = await sweep({ scanner: jest.fn(async (file) => { fs.appendFileSync(file, 'x'); return { status: 'clean' }; }) });
    expect(result.results[0]).toMatchObject({ outcome: 'failed' });
    expect(row()).toMatchObject({ scanStatus: 'error', scanNextAttemptAt: null });
  });

  test('missing from a reachable storage folder: final error', async () => {
    fs.rmSync(absolute(row().storageKey));
    expect((await sweep()).results[0]).toMatchObject({ outcome: 'failed' });
    expect(row().scanDetail).toMatch(/missing/);
  });
});

describe('a replaced file is never judged by an old verdict', () => {
  test('if the sync replaces the file while it is being scanned, the old result is discarded', async () => {
    const result = await sweep({
      scanner: jest.fn(async () => {
        // what the sync does for a changed, unpublished version
        Object.assign(row(), { storageKey: `quotations/case-3037/ev999-${'c'.repeat(64)}.pdf`, sha256: 'c'.repeat(64), scanStatus: 'pending', scanAttempts: 0, scanNextAttemptAt: null });
        return { status: 'clean' };
      }),
    });
    expect(result.results[0]).toMatchObject({ outcome: 'discarded' });
    expect(row()).toMatchObject({ scanStatus: 'pending', scanAttempts: 0, sha256: 'c'.repeat(64) });
    expect(rig.world.audit.map((a) => a.action)).not.toContain('quotation.scan_clean');
  });

  test('a changed upload goes back to pending and is scanned again as its own file', async () => {
    await sweep();
    expect(row().scanStatus).toBe('clean');
    rig.state.pdf = pdf('second');
    rig.state.deal = dealBody({ fileId: 70002 });
    await detectAndEnqueueQuotationSync(rig.prisma, rig.world.caseRecord, rig.state.deal);
    await runQuotationSync(rig.ctx());
    expect(row()).toMatchObject({ scanStatus: 'pending', sha256: sha(pdf('second')), status: 'draft' });
    await sweep();
    expect(row().scanStatus).toBe('clean');
    expect(rig.world.audit.filter((a) => a.action === 'quotation.scan_clean')).toHaveLength(2);
  });
});

describe('scope and switches', () => {
  test('a scoped sweep touches only the named Cases', async () => {
    rig.world.quotations.push({ ...row(), id: 99, caseId: 9999, versionNumber: 1, storageKey: 'quotations/case-9999/x.pdf' });
    const scanner = clean();
    const result = await sweep({ scanner, caseIds: [3037] });
    expect(result.results).toHaveLength(1);
    expect(rig.world.quotations.find((q) => q.id === 99).scanStatus).toBe('pending');
    expect(scanner).toHaveBeenCalledTimes(1);
  });

  test('quotationIds pins a pass to the named quotation: another quotation of the SAME Case is neither claimed nor scanned', async () => {
    rig.world.quotations.push({ ...row(), id: 55, versionNumber: 2, storageKey: 'quotations/case-3037/other.pdf', scanAttempts: 0, scanNextAttemptAt: null });
    const scanner = clean();
    const result = await sweep({ scanner, caseIds: [3037], quotationIds: [row().id] });
    expect(result.results.map((r) => r.id)).toEqual([row().id]);
    expect(scanner).toHaveBeenCalledTimes(1);
    expect(rig.world.quotations.find((q) => q.id === 55)).toMatchObject({ scanStatus: 'pending', scanAttempts: 0 });
    expect(rig.prisma.caseQuotation.findMany.mock.calls.at(-1)[0].where).toMatchObject({ caseId: { in: [3037] }, id: { in: [row().id] } });
  });

  test('without quotationIds the sweep is exactly as before', async () => {
    await sweep({ caseIds: [3037] });
    expect(rig.prisma.caseQuotation.findMany.mock.calls.at(-1)[0].where).not.toHaveProperty('id');
  });

  test.each([['the quotation switch is off', { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }], ['nothing is set', {}]])('the sweep is idle when %s', async (_n, env) => {
    const scanner = jest.fn();
    expect(await sweep({ env, scanner })).toEqual({ active: false, checked: 0 });
    expect(scanner).not.toHaveBeenCalled();
    expect(rig.prisma.caseQuotation.findMany).not.toHaveBeenCalled();
  });
});
