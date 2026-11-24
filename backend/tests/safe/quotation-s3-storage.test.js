/* global describe, test, expect, jest, beforeEach, afterEach */
// Quotation PDFs on the shared storage service: S3 rows next to historical local rows, the malware scan of S3 objects, hash checks,
// and the download gate. S3 is an in-memory fake, ClamAV is faked, local files are REAL (temp folder). No database, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/modules/notifications/push', () => ({ sendExpoPush: jest.fn() }), { virtual: true });

const { Readable } = require('stream');
const kit = require('./quotation-test-kit');
const { createQuotationStorage, keyFor, sha256Of } = require('../../src/modules/bitrix/quotation-storage');
const { runQuotationSync } = require('../../src/modules/bitrix/quotation-sync.service');
const { detectAndEnqueueQuotationSync } = require('../../src/modules/bitrix/quotation-outbox');
const { sweepPendingQuotationScans } = require('../../src/modules/bitrix/quotation-scan.service');
const { resolveQuotationFile } = require('../../src/modules/quotations/quotations.service');
const { StorageError } = require('../../src/storage/errors');

const { pdf, sha } = kit;

// An S3 stand-in with the shared adapter's interface.
function memoryS3() {
  const objects = new Map();
  const api = {
    objects, provider: 's3',
    exists: jest.fn(async (key) => objects.has(key)),
    getMetadata: jest.fn(async (key) => (objects.has(key) ? { size: objects.get(key).length } : null)),
    download: jest.fn(async (key) => {
      if (api.failReads) throw new StorageError('download_failed', 'x');
      if (!objects.has(key)) throw new StorageError('not_found', 'x');
      return { stream: Readable.from([objects.get(key)]), size: objects.get(key).length };
    }),
    upload: jest.fn(async (key, body) => {
      if (api.failUpload) throw new StorageError('upload_failed', 'x');
      const chunks = []; for await (const c of Buffer.isBuffer(body) ? [body] : body) chunks.push(c);
      const bytes = Buffer.concat(chunks); objects.set(key, bytes);
      return { key, size: bytes.length, sha256: api.lieAboutHash ? 'f'.repeat(64) : sha256Of(bytes) };
    }),
    delete: jest.fn(async (key) => { objects.delete(key); }),
  };
  return api;
}

let rig;
let s3;
let active;
const useStorage = () => { rig.storage = createQuotationStorage({ local: rig.storage, s3, activeProvider: () => active }); };

beforeEach(() => { rig = kit.makeRig(); s3 = memoryS3(); active = 's3'; useStorage(); });
afterEach(() => rig.cleanup());

const syncOnce = async () => {
  await detectAndEnqueueQuotationSync(rig.prisma, rig.world.caseRecord, rig.state.deal);
  return runQuotationSync(rig.ctx());
};
const row = () => rig.world.quotations[0];
const cleanStream = () => jest.fn(async (stream) => { for await (const c of stream) void c; return { status: 'clean' }; });
const sweep = (extra = {}) => sweepPendingQuotationScans({
  prisma: rig.prisma, storage: rig.storage, env: kit.ENV_ON, log: rig.log, clock: () => rig.world.clock, rng: () => 0.5,
  scanner: jest.fn(async () => { throw new Error('the file scanner must not be used for an S3 object'); }), streamScanner: cleanStream(), health: async () => true, ...extra,
});

describe('storing (the sync) with S3 active', () => {
  test('the PDF goes to S3 under its quotation key, the row records provider "s3", nothing is written locally', async () => {
    await syncOnce();
    expect(row()).toMatchObject({ storageProvider: 's3', scanStatus: 'pending', sha256: sha(rig.state.pdf) });
    expect(row().storageKey).toMatch(/^quotations\/case-\d+\/ev\d+-[0-9a-f]{64}\.pdf$/);
    expect(s3.objects.get(row().storageKey)).toEqual(rig.state.pdf);
    expect(s3.upload.mock.calls[0][2]).toMatchObject({ contentType: 'application/pdf' });
    expect(rig.filesOnDisk()).toEqual([]);
  });
  test('storage router: a hash that does not match the bytes is refused before upload; S3 returning another hash removes the object', async () => {
    const key = keyFor(5, 1, sha(pdf('x')));
    await expect(rig.storage.putIfAbsent(key, pdf('x'), 'e'.repeat(64))).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect(s3.upload).not.toHaveBeenCalled();
    s3.lieAboutHash = true;
    await expect(rig.storage.putIfAbsent(key, pdf('x'), sha(pdf('x')))).rejects.toMatchObject({ code: 'verify_failed' });
    expect(s3.objects.has(key)).toBe(false);
  });
  test('the same event again finds its own object; other content under the same key is a conflict, never an overwrite', async () => {
    const key = keyFor(5, 1, sha(pdf('x')));
    expect(await rig.storage.putIfAbsent(key, pdf('x'), sha(pdf('x')))).toEqual({ created: true, provider: 's3' });
    expect(await rig.storage.putIfAbsent(key, pdf('x'), sha(pdf('x')))).toEqual({ created: false, provider: 's3' });
    s3.objects.set(key, Buffer.from('%PDF-other'));
    await expect(rig.storage.putIfAbsent(key, pdf('x'), sha(pdf('x')))).rejects.toMatchObject({ code: 'conflict' });
  });
  test('an S3 outage while storing retries the event (nothing is recorded)', async () => {
    s3.failUpload = true;
    await syncOnce();
    expect(rig.world.quotations).toHaveLength(0);
  });
  test('delete and read of an S3 object', async () => {
    const key = keyFor(5, 1, sha(pdf('x')));
    await rig.storage.putIfAbsent(key, pdf('x'), sha(pdf('x')));
    expect(await rig.storage.hashOf(key, 's3')).toBe(sha(pdf('x')));
    expect(await rig.storage.readVerified(key, sha(pdf('x')), 's3')).toEqual(pdf('x'));
    await expect(rig.storage.readVerified(key, 'a'.repeat(64), 's3')).rejects.toMatchObject({ code: 'file_changed' });
    await rig.storage.remove(key, 's3');
    expect(s3.objects.has(key)).toBe(false);
  });
});

describe('malware scan of an S3 quotation (streamed from storage)', () => {
  beforeEach(syncOnce);

  test('clean: scanned as a stream, row clean, bound to the sha256', async () => {
    const streamScanner = cleanStream();
    const result = await sweep({ streamScanner });
    expect(result.results[0]).toMatchObject({ outcome: 'clean' });
    expect(streamScanner).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ scanStatus: 'clean', scanEngine: 'clamav' });
    expect(s3.objects.has(row().storageKey)).toBe(true);
  });
  test('infected: row infected, object removed from S3, never usable', async () => {
    const key = row().storageKey;
    const result = await sweep({ streamScanner: jest.fn(async () => ({ status: 'infected', signature: 'Eicar' })) });
    expect(result.results[0]).toMatchObject({ outcome: 'infected' });
    expect(row().scanStatus).toBe('infected');
    expect(s3.objects.has(key)).toBe(false);
  });
  test.each([
    ['scanner unavailable', { status: 'error', detail: 'cannot reach the scanner' }],
    ['timeout', { status: 'error', detail: 'scan timed out' }],
    ['no verdict', undefined],
  ])('%s fails closed: never clean, retried later', async (_n, verdict) => {
    const result = await sweep({ streamScanner: jest.fn(async () => verdict) });
    expect(result.results[0]).toMatchObject({ outcome: 'retry' });
    expect(row().scanStatus).not.toBe('clean');
  });
  test('scanner down before the sweep: nothing is scanned and no attempt is used', async () => {
    const streamScanner = jest.fn();
    expect(await sweep({ streamScanner, health: async () => false })).toMatchObject({ scannerUnavailable: true, checked: 0 });
    expect(streamScanner).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ scanStatus: 'pending', scanAttempts: 0 });
  });
  test('hash mismatch (object replaced in S3): final failure, never clean, scanner not even called', async () => {
    s3.objects.set(row().storageKey, Buffer.from('%PDF-1.4 swapped'));
    const streamScanner = jest.fn();
    const result = await sweep({ streamScanner });
    expect(result.results[0]).toMatchObject({ outcome: 'failed' });
    expect(streamScanner).not.toHaveBeenCalled();
    expect(row().scanStatus).toBe('error');
    expect(row().scanNextAttemptAt).toBeNull();
  });
  test('object changes while it is being scanned: not clean', async () => {
    const streamScanner = jest.fn(async () => { s3.objects.set(row().storageKey, Buffer.from('%PDF-1.4 swapped')); return { status: 'clean' }; });
    expect((await sweep({ streamScanner })).results[0]).toMatchObject({ outcome: 'failed' });
    expect(row().scanStatus).not.toBe('clean');
  });
  test('object missing: final; S3 unreachable: storage problem, no attempt used up, never clean', async () => {
    s3.objects.delete(row().storageKey);
    expect((await sweep()).results[0]).toMatchObject({ outcome: 'failed' });
    expect(row().scanStatus).toBe('error');
  });
  test('S3 outage during the scan is a storage problem', async () => {
    s3.failReads = true;
    expect((await sweep()).results[0]).toMatchObject({ outcome: 'storage_unavailable' });
    expect(row().scanStatus).not.toBe('clean');
    expect(row().scanAttempts).toBe(0);
  });
});

describe('download gate (admin) for an S3 quotation', () => {
  const resolve = () => resolveQuotationFile({ quotationId: row().id, adminId: 1, adminRole: 'superadmin' }, { prisma: rig.prisma, storage: rig.storage, now: () => new Date(rig.world.clock), log: rig.log });
  beforeEach(syncOnce);

  test('pending, error, infected: refused and S3 is never read', async () => {
    for (const scanStatus of ['pending', 'error', 'infected']) {
      row().scanStatus = scanStatus;
      await expect(resolve()).rejects.toMatchObject({ statusCode: 409, publicCode: 'scan_not_clean' });
    }
    expect(s3.download).not.toHaveBeenCalled();
  });
  test('clean: the verified bytes are returned; a tampered object is refused', async () => {
    await sweep();
    expect((await resolve()).buffer).toEqual(rig.state.pdf);
    s3.objects.set(row().storageKey, Buffer.from('%PDF-1.4 swapped'));
    await expect(resolve()).rejects.toMatchObject({ publicCode: 'file_unverified' });
  });
});

describe('historical local quotations stay reachable when S3 is the active provider', () => {
  test('a "local" row is read, hashed, scanned from disk and removed locally, whatever is active now', async () => {
    active = 'local';
    await syncOnce(); // written while local was active
    expect(row().storageProvider).toBe('local');
    const key = row().storageKey;
    active = 's3'; // S3 switched on afterwards
    expect(await rig.storage.hashOf(key, 'local')).toBe(row().sha256);
    expect(await rig.storage.readVerified(key, row().sha256, 'local')).toEqual(rig.state.pdf);
    const fileScanner = jest.fn(async () => ({ status: 'clean' }));
    const result = await sweep({ scanner: fileScanner, streamScanner: jest.fn() });
    expect(result.results[0]).toMatchObject({ outcome: 'clean' });
    expect(fileScanner).toHaveBeenCalledTimes(1);
    expect(s3.download).not.toHaveBeenCalled();
    await rig.storage.remove(key, 'local');
    expect(rig.filesOnDisk()).toEqual([]);
  });
  test('a row with no provider is treated as local (rows written before the column mattered)', async () => {
    active = 'local';
    await syncOnce();
    const key = row().storageKey;
    active = 's3';
    expect(await rig.storage.readVerified(key, row().sha256)).toEqual(rig.state.pdf);
  });
  test('an S3 row is still read from S3 if STORAGE_PROVIDER is switched back to local', async () => {
    await syncOnce();
    const key = row().storageKey;
    active = 'local';
    expect(await rig.storage.readVerified(key, row().sha256, 's3')).toEqual(rig.state.pdf);
  });
});
