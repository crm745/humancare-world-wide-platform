/* global describe, test, expect, jest, beforeEach, afterEach */
// The legacy backfill (documents/legacy-backfill.js) for documents that live in the STORAGE SERVICE (S3, or the local storage adapter), next to the old local-disk documents it always handled.
//   * an S3 document is read through the storage service, staged into a private temporary copy, hashed, scanned and hashed again; it is NEVER looked for under the upload folder, so a valid S3 document
//     can no longer be marked failed for being "absent from local disk";
//   * the S3 adapter here is the REAL one (src/storage/s3.adapter.js) driven by a fake S3 client that records every command: only Get and Head are ever sent (no write, copy or delete);
//   * fail closed: a genuinely missing object is failed for good ONLY when the storage is confirmed healthy; an outage, a denied request, a wrong bucket or an unconfirmed state is a retryable error;
//     an object over the upload limit, or one the scanner cannot judge, is never marked clean;
//   * an infected object is blocked by its verdict but is neither moved nor deleted (no approved object-storage action), and is listed for Operations;
//   * the local quarantine is created 0700 with 0600 files, and existing quarantined files are never touched.
// The backfill script itself is never run here. No database, no network.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

jest.mock('../../src/middleware/upload.middleware', () => {
  const nodeFs = require('fs');
  const nodeOs = require('os');
  const nodePath = require('path');
  return { upload: {}, uploadPatient: {}, UPLOAD_DIR: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hc-bfobj-uploads-')) };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({ scanFile: jest.fn(), ping: jest.fn(async () => true), ENGINE: 'clamav', settings: () => ({}) }));
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const clamav = require('../../src/integrations/clamav/clamav');
const { UPLOAD_DIR } = require('../../src/middleware/upload.middleware');
const { backfillLegacyDocuments, isStoredObject, objectStorageHealthy, MAX_ATTEMPTS } = require('../../src/modules/documents/legacy-backfill');
const { stageObject, releaseStaged, PREFIX } = require('../../src/modules/documents/object-staging');
const { createS3Adapter } = require('../../src/storage/s3.adapter');
const { createLocalAdapter } = require('../../src/storage/local.adapter');
const { isKnownUnsafe, isScanClean } = require('../../src/modules/documents/document-scan');

const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');
const keyOf = (n, area = 'case-documents') => `${area}/2026/11/${String(n).padStart(32, '0')}.pdf`;
const POSIX = process.platform !== 'win32';

// ---- a fake database that understands what the backfill asks (including the storage-health witness query) -------------------------------------------------------------------------------
function fakeDb(rows) {
  const db = { docs: rows.map((r) => ({ scanAttempts: 0, scanNextAttemptAt: null, scanStatus: null, sha256: null, ...r })), audit: [] };
  const matches = (row, where) => Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return want.some((w) => matches(row, w));
    if (key === 'NOT') return !matches(row, want);
    const value = row[key];
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      if ('lt' in want) return value != null && value < want.lt;
      if ('lte' in want) return value != null && value <= want.lte;
      if ('startsWith' in want) return typeof value === 'string' && value.startsWith(want.startsWith);
      throw new Error(`unsupported where: ${JSON.stringify(want)}`);
    }
    return want === null ? value === null || value === undefined : value === want;
  });
  const withCase = (r) => ({ ...r, case: r.case || { id: r.caseId, referenceNumber: `CASE-${r.caseId}`, bitrixLeadId: null, serviceRequest: null } });
  db.document = {
    groupBy: async () => { const counts = new Map(); for (const r of db.docs) counts.set(r.scanStatus, (counts.get(r.scanStatus) || 0) + 1); return [...counts].map(([scanStatus, n]) => ({ scanStatus, _count: { _all: n } })); },
    findMany: async ({ where, take, orderBy }) => {
      const list = db.docs.filter((r) => matches(r, where));
      list.sort((a, b) => (orderBy && orderBy.id === 'desc' ? b.id - a.id : a.id - b.id));
      return list.slice(0, take).map((r) => withCase({ ...r }));
    },
    findFirst: async () => db.docs[0] || null,
    updateMany: async ({ where, data }) => {
      const row = db.docs.find((r) => r.id === where.id && (where.scanStatus === null ? r.scanStatus === null : r.scanStatus === where.scanStatus) && r.scanAttempts === where.scanAttempts);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  db.auditLog = { findFirst: async () => null, create: async ({ data }) => { db.audit.push(data); return data; } };
  db.$transaction = async (callback) => callback(db);
  return db;
}

// ---- the REAL S3 adapter over a fake S3 client that records every command ------------------------------------------------------------------------------------------------------------------
function makeBucket(objects = {}) {
  const state = { objects: new Map(Object.entries(objects)), sent: [], mode: null, gets: [] };
  const fail = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  const client = {
    send: async (command) => {
      const name = command.constructor.name;
      state.sent.push(name);
      if (state.mode === 'outage') throw fail('InternalError', 500);
      if (state.mode === 'denied') throw fail('AccessDenied', 403);
      if (state.mode === 'nobucket') throw fail('NoSuchBucket', 404);
      const body = state.objects.get(command.input.Key);
      if (!body) throw fail('NoSuchKey', 404);
      if (name === 'HeadObjectCommand') return { ContentLength: body.length, ContentType: 'application/pdf' };
      if (name === 'GetObjectCommand') { state.gets.push(command.input.Key); return { Body: Readable.from([body]), ContentLength: body.length, ContentType: 'application/pdf' }; }
      throw new Error(`a command that must never be sent: ${name}`); // Put, Delete, Copy... fail loudly (and stay in `sent`)
    },
  };
  const adapter = createS3Adapter({ config: { provider: 's3', region: 'ap-south-1', bucket: 'fake-bucket' }, client });
  return { state, adapter, storage: { storageFor: () => adapter } };
}

describe('classifying a stored reference', () => {
  test.each([
    ['/uploads/1700-report.pdf', false],
    ['1700-report.pdf', false],
    ['', false],
    [keyOf(1), true],
    [`/uploads/${keyOf(2, 'request-documents')}`, true], // a document copied into a Case from the review workflow keeps its storage key behind "/uploads/"
    [keyOf(3, 'corporate-documents'), true],
  ])('%p is %p', (fileUrl, stored) => {
    expect(isStoredObject(fileUrl)).toBe(stored);
  });
});

describe('the backfill for documents in the storage service', () => {
  let uploads;
  let quarantineDir;
  let tempDir;
  let clock;
  let scans;
  const T0 = Date.UTC(2030, 0, 1, 12, 0, 0);

  const scanner = () => jest.fn(async (file) => {
    const info = { file, existed: fs.existsSync(file), underUploads: file.startsWith(UPLOAD_DIR) || file.startsWith(uploads), underTemp: file.startsWith(tempDir) };
    if (POSIX) { info.fileMode = fs.statSync(file).mode & 0o777; info.dirMode = fs.statSync(path.dirname(file)).mode & 0o777; }
    scans.push(info);
    return fs.readFileSync(file).includes('EICAR') ? { status: 'infected', signature: 'Eicar-Test-Signature' } : { status: 'clean' };
  });
  const run = (db, bucket, extra = {}) => backfillLegacyDocuments({
    db, execute: true, scanner: scanner(), ping: async () => true, uploadDir: uploads, quarantineDir, clock: () => clock.t, runId: 'run-1', storage: bucket.storage, tempDir, ...extra,
  });
  const tempLeftovers = () => fs.readdirSync(tempDir);

  beforeEach(() => {
    uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-bfobj-local-'));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-bfobj-tmp-'));
    quarantineDir = path.join(uploads, 'quarantine');
    clock = { t: T0 };
    scans = [];
    clamav.scanFile.mockReset();
  });
  afterEach(() => {
    fs.rmSync(uploads, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('a clean S3 document is recorded clean (digest of the object, engine, time, one audit entry) although NOTHING of it is on local disk', async () => {
    const body = Buffer.from('%PDF-1.4 the S3 report');
    const bucket = makeBucket({ [keyOf(1)]: body });
    const db = fakeDb([{ id: 1, caseId: 10, type: 'Medical Report', fileUrl: keyOf(1) }]);
    expect(fs.readdirSync(uploads)).toEqual([]); // the upload folder is empty

    const report = await run(db, bucket);

    expect(db.docs[0]).toMatchObject({ scanStatus: 'clean', sha256: sha(body), scanEngine: 'clamav', scanAttempts: 1, scanNextAttemptAt: null });
    expect(db.docs[0].scannedAt).toBeInstanceOf(Date);
    expect(isScanClean(db.docs[0])).toBe(true);
    expect(report.outcomes).toMatchObject({ clean: 1, failed: 0, error: 0, infected: 0 });
    expect(report.items[0]).toMatchObject({ documentId: 1, source: 'object', outcome: 'clean' });
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ entityId: '1', action: 'legacy_document_scan', reasonCode: 'scan_clean', actorId: 'backfill' });
  });

  test('the scanner is given a PRIVATE temporary copy (outside the upload folder, 0700 folder, 0600 file), and no copy is left afterwards', async () => {
    const bucket = makeBucket({ [keyOf(1)]: Buffer.from('%PDF-1.4 copy me') });
    await run(fakeDb([{ id: 1, caseId: 10, type: 'Medical Report', fileUrl: keyOf(1) }]), bucket);
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({ existed: true, underTemp: true, underUploads: false });
    expect(path.basename(path.dirname(scans[0].file)).startsWith(PREFIX)).toBe(true);
    if (POSIX) expect([scans[0].dirMode, scans[0].fileMode]).toEqual([0o700, 0o600]);
    expect(fs.existsSync(scans[0].file)).toBe(false);
    expect(tempLeftovers()).toEqual([]);
  });

  test('only Get and Head are ever sent to S3: nothing is written, copied or deleted', async () => {
    const bucket = makeBucket({ [keyOf(1)]: Buffer.from('%PDF-1.4 a'), [keyOf(2)]: Buffer.from('EICAR infected') });
    await run(fakeDb([{ id: 1, caseId: 10, fileUrl: keyOf(1) }, { id: 2, caseId: 11, fileUrl: keyOf(2) }]), bucket);
    expect(new Set(bucket.state.sent)).toEqual(new Set(['GetObjectCommand']));
    expect(bucket.state.objects.size).toBe(2); // both objects are still there
  });

  test('a document copied into a Case from the review workflow ("/uploads/<storage key>") is read from the storage service, not as a local path', async () => {
    const key = keyOf(5, 'request-documents');
    const bucket = makeBucket({ [key]: Buffer.from('%PDF-1.4 copied') });
    const db = fakeDb([{ id: 1, caseId: 10, fileUrl: `/uploads/${key}` }]);
    await run(db, bucket);
    expect(bucket.state.gets).toEqual([key]);
    expect(db.docs[0].scanStatus).toBe('clean');
  });

  test('a genuinely MISSING object is failed for good, but only because a known-clean object of the same storage is still reachable (the storage is healthy)', async () => {
    const witness = Buffer.from('%PDF-1.4 witness');
    const bucket = makeBucket({ [keyOf(9)]: witness }); // keyOf(1) is not there
    const db = fakeDb([
      { id: 1, caseId: 10, fileUrl: keyOf(1) },
      { id: 9, caseId: 19, fileUrl: keyOf(9), scanStatus: 'clean', sha256: sha(witness), scanEngine: 'clamav' }, // a document a new upload stored: the witness
    ]);
    const report = await run(db, bucket);
    expect(db.docs[0]).toMatchObject({ scanStatus: 'failed', scanDetail: 'the stored object is missing' });
    expect(isKnownUnsafe(db.docs[0])).toBe(true); // fail closed: nobody can open it
    expect(report.outcomes.failed).toBe(1);
    expect(db.audit[0].reasonCode).toBe('scan_failed');
    expect(clamav.scanFile).not.toHaveBeenCalled();
  });

  test.each([
    ['the whole bucket is unreachable or wrong (every object answers "not found")', 'nobucket'],
    ['S3 is having an outage', 'outage'],
    ['the credentials are refused', 'denied'],
  ])('%s: an ERROR to retry with backoff, NEVER failed, nothing scanned', async (_label, mode) => {
    const witness = Buffer.from('%PDF-1.4 witness');
    const bucket = makeBucket({ [keyOf(1)]: Buffer.from('%PDF-1.4 present'), [keyOf(9)]: witness });
    bucket.state.mode = mode;
    const db = fakeDb([
      { id: 1, caseId: 10, fileUrl: keyOf(1) },
      { id: 9, caseId: 19, fileUrl: keyOf(9), scanStatus: 'clean', sha256: sha(witness) },
    ]);
    const report = await run(db, bucket);
    expect(db.docs[0].scanStatus).toBe('error');
    expect(db.docs[0].scanStatus).not.toBe('failed');
    expect(db.docs[0].scanNextAttemptAt).toBeInstanceOf(Date); // a retry is scheduled
    expect(report.outcomes).toMatchObject({ error: 1, failed: 0, clean: 0 });
    expect(clamav.scanFile).not.toHaveBeenCalled();
    expect(isScanClean(db.docs[0])).toBe(false);
  });

  test('a missing object with NO witness to prove the storage healthy is an error, not a failure (not sure is retried, never final)', async () => {
    const bucket = makeBucket({}); // an empty bucket and no clean document recorded anywhere
    const db = fakeDb([{ id: 1, caseId: 10, fileUrl: keyOf(1) }]);
    await run(db, bucket);
    expect(db.docs[0].scanStatus).toBe('error');
    expect(db.docs[0].scanDetail).toMatch(/could not be confirmed healthy/);
  });

  test('retries are bounded: after MAX_ATTEMPTS of "not sure" the document is failed with the reason, never marked clean', async () => {
    const bucket = makeBucket({});
    const db = fakeDb([{ id: 1, caseId: 10, fileUrl: keyOf(1), scanStatus: 'error', scanAttempts: MAX_ATTEMPTS - 1, scanNextAttemptAt: new Date(T0 - 1000) }]);
    await run(db, bucket);
    expect(db.docs[0]).toMatchObject({ scanStatus: 'failed', scanAttempts: MAX_ATTEMPTS });
    expect(db.docs[0].scanDetail).toMatch(/retries used up/);
  });

  test('an object larger than the upload limit cannot be scanned: failed, never clean, and it is not even handed to the scanner', async () => {
    const bucket = makeBucket({ [keyOf(1)]: Buffer.alloc(64, 1) });
    const db = fakeDb([{ id: 1, caseId: 10, fileUrl: keyOf(1) }]);
    await run(db, bucket, { maxObjectBytes: 16 });
    expect(db.docs[0]).toMatchObject({ scanStatus: 'failed' });
    expect(db.docs[0].scanDetail).toMatch(/larger than the upload limit/);
    expect(clamav.scanFile).not.toHaveBeenCalled();
    expect(tempLeftovers()).toEqual([]); // the partial copy was removed
  });

  test('a scanner that gives no verdict leaves an error to retry; a scanner that is down stops the run and gives the attempt back', async () => {
    const bucket = makeBucket({ [keyOf(1)]: Buffer.from('%PDF-1.4 x'), [keyOf(2)]: Buffer.from('%PDF-1.4 y') });
    const noVerdict = fakeDb([{ id: 1, caseId: 10, fileUrl: keyOf(1) }]);
    await run(noVerdict, bucket, { scanner: jest.fn(async () => ({ status: 'error', detail: 'no verdict' })) });
    expect(noVerdict.docs[0].scanStatus).toBe('error');
    expect(isScanClean(noVerdict.docs[0])).toBe(false);

    const down = fakeDb([{ id: 1, caseId: 10, fileUrl: keyOf(1) }, { id: 2, caseId: 11, fileUrl: keyOf(2) }]);
    const report = await run(down, bucket, { scanner: jest.fn(async () => ({ status: 'error', detail: 'down' })), ping: async () => false });
    expect(report.scannerUnavailable).toBe(true);
    expect(down.docs[0]).toMatchObject({ scanStatus: null, scanAttempts: 0 }); // the attempt was given back
    expect(down.docs[1]).toMatchObject({ scanStatus: null, scanAttempts: 0 }); // and the run stopped before the next one
    expect(tempLeftovers()).toEqual([]);
  });

  test('an INFECTED object is recorded infected (so nobody can open it) but is NOT moved, copied or deleted; it is listed for Operations; its temporary copy is removed', async () => {
    const bucket = makeBucket({ [keyOf(1)]: Buffer.from('EICAR test file') });
    const db = fakeDb([{ id: 1, caseId: 10, type: 'Medical Report', fileUrl: keyOf(1) }]);
    const report = await run(db, bucket);
    expect(db.docs[0]).toMatchObject({ scanStatus: 'infected', scanEngine: 'clamav' });
    expect(isKnownUnsafe(db.docs[0])).toBe(true);
    expect(report.outcomes.infected).toBe(1);
    expect(report.items[0]).toMatchObject({ outcome: 'infected', quarantined: false, objectLeftInStorage: true, signature: 'Eicar-Test-Signature' });
    expect(report.infectedObjectsInStorage).toEqual([{ documentId: 1, caseReference: 'CASE-10', signature: 'Eicar-Test-Signature' }]);
    expect(report.quarantineFailures).toBe(0);
    expect(bucket.state.objects.has(keyOf(1))).toBe(true); // still in S3
    expect(new Set(bucket.state.sent)).toEqual(new Set(['GetObjectCommand'])); // no delete or copy
    expect(fs.existsSync(quarantineDir)).toBe(false); // nothing was copied to local quarantine either
    expect(tempLeftovers()).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('EICAR test file');
  });

  test('DRY RUN reads nothing but metadata: HEAD only, no claim, no scan; it reports readable / missing / storage_unavailable', async () => {
    const bucket = makeBucket({ [keyOf(1)]: Buffer.from('%PDF-1.4 here') });
    const db = fakeDb([{ id: 1, caseId: 10, fileUrl: keyOf(1) }, { id: 2, caseId: 11, fileUrl: keyOf(2) }]);
    const before = JSON.stringify([db.docs, db.audit]);
    const report = await backfillLegacyDocuments({ db, execute: false, scanner: clamav.scanFile, ping: clamav.ping, uploadDir: uploads, quarantineDir, clock: () => clock.t, storage: bucket.storage, tempDir });
    expect(report.items.map((i) => [i.documentId, i.source, i.file])).toEqual([[1, 'object', 'readable'], [2, 'object', 'missing']]);
    expect(new Set(bucket.state.sent)).toEqual(new Set(['HeadObjectCommand']));
    expect(JSON.stringify([db.docs, db.audit])).toBe(before);
    expect(clamav.scanFile).not.toHaveBeenCalled();
    bucket.state.mode = 'outage';
    const outage = await backfillLegacyDocuments({ db, execute: false, scanner: clamav.scanFile, ping: clamav.ping, uploadDir: uploads, quarantineDir, clock: () => clock.t, storage: bucket.storage, tempDir });
    expect(outage.items.map((i) => i.file)).toEqual(['storage_unavailable', 'storage_unavailable']); // an outage is not "missing"
  });

  test('LOCAL and S3-backed documents in ONE run: the local file is read from the upload folder, the S3 one through the storage service, and the local one never asks the storage service', async () => {
    const localBody = fs.writeFileSync(path.join(uploads, 'old-report.pdf'), '%PDF-1.4 old local') || '%PDF-1.4 old local';
    const bucket = makeBucket({ [keyOf(1)]: Buffer.from('%PDF-1.4 in s3') });
    const asked = [];
    const storage = { storageFor: (key) => { asked.push(key); return bucket.adapter; } };
    const db = fakeDb([
      { id: 1, caseId: 10, fileUrl: '/uploads/old-report.pdf' },
      { id: 2, caseId: 11, fileUrl: keyOf(1) },
      { id: 3, caseId: 12, fileUrl: '/uploads/never-existed.pdf' }, // local, absent, and the upload folder is healthy: failed, exactly as before
    ]);
    const report = await run(db, { storage });
    expect(db.docs.map((d) => [d.id, d.scanStatus])).toEqual([[1, 'clean'], [2, 'clean'], [3, 'failed']]);
    expect(db.docs[0].sha256).toBe(sha(localBody));
    expect(report.items.map((i) => [i.documentId, i.source])).toEqual([[1, 'local'], [2, 'object'], [3, 'local']]);
    expect(asked.every((key) => key === keyOf(1))).toBe(true); // the storage service was only asked about the stored object
  });

  test('a document in the LOCAL storage adapter (a generated key under the storage root) is read through the storage service too', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-bfobj-adapter-'));
    try {
      const body = Buffer.from('%PDF-1.4 in the local adapter');
      const key = keyOf(7);
      fs.mkdirSync(path.join(root, path.dirname(key)), { recursive: true });
      fs.writeFileSync(path.join(root, key), body);
      const adapter = createLocalAdapter({ root });
      const db = fakeDb([{ id: 1, caseId: 10, fileUrl: key }]);
      await run(db, { storage: { storageFor: () => adapter } });
      expect(db.docs[0]).toMatchObject({ scanStatus: 'clean', sha256: sha(body) });
      expect(fs.readFileSync(path.join(root, key)).equals(body)).toBe(true); // untouched
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rerunning never rescans a clean S3 document, and a clean result is never overwritten', async () => {
    const bucket = makeBucket({ [keyOf(1)]: Buffer.from('%PDF-1.4 once') });
    const db = fakeDb([{ id: 1, caseId: 10, fileUrl: keyOf(1) }]);
    await run(db, bucket);
    const again = await run(db, bucket);
    expect(again.selected).toBe(0);
    expect(bucket.state.gets).toHaveLength(1);
    expect(db.docs[0].scanAttempts).toBe(1);
  });

  test('objectStorageHealthy: true only when a known-clean object is still reachable; any error or no witness is "not sure"', async () => {
    const witness = Buffer.from('%PDF-1.4 w');
    const db = fakeDb([{ id: 9, caseId: 1, fileUrl: keyOf(9), scanStatus: 'clean' }, { id: 8, caseId: 1, fileUrl: '/uploads/local.pdf', scanStatus: 'clean' }]);
    expect(await objectStorageHealthy({ db, storage: makeBucket({ [keyOf(9)]: witness }).storage })).toBe(true);
    expect(await objectStorageHealthy({ db, storage: makeBucket({}).storage })).toBe(false); // the witness is gone
    const outage = makeBucket({ [keyOf(9)]: witness }); outage.state.mode = 'outage';
    expect(await objectStorageHealthy({ db, storage: outage.storage })).toBe(false);
    expect(await objectStorageHealthy({ db: fakeDb([]), storage: makeBucket({}).storage })).toBe(false); // no witness at all
    expect(await objectStorageHealthy({ db: { document: { findMany: async () => { throw new Error('db down'); } } }, storage: makeBucket({}).storage })).toBe(false);
  });
});

describe('the temporary copy (documents/object-staging.js)', () => {
  let tempDir;
  beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-staging-')); });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });
  const adapterOf = (body) => ({ download: async () => ({ stream: Readable.from([body]) }) });

  test('stages the object privately, hashes it while it is written, and releases only its own folder', async () => {
    const body = Buffer.from('some bytes');
    const staged = await stageObject(adapterOf(body), 'case-documents/x', { tempDir, maxBytes: 100 });
    expect(staged.sha256).toBe(sha(body));
    expect(fs.readFileSync(staged.file).equals(body)).toBe(true);
    if (POSIX) expect([fs.statSync(staged.dir).mode & 0o777, fs.statSync(staged.file).mode & 0o777]).toEqual([0o700, 0o600]);
    expect(await releaseStaged(staged)).toBe(true);
    expect(fs.existsSync(staged.dir)).toBe(false);
  });

  test('releaseStaged removes NOTHING it did not make: a forged object, a folder outside the temp folder, a name without the prefix', async () => {
    const important = path.join(tempDir, 'important');
    fs.mkdirSync(important);
    fs.writeFileSync(path.join(important, 'keep.txt'), 'keep');
    expect(await releaseStaged({ dir: important, tempDir })).toBe(false); // not produced by stageObject
    expect(await releaseStaged(null)).toBe(false);
    const real = await stageObject(adapterOf(Buffer.from('x')), 'k/k', { tempDir, maxBytes: 10 });
    expect(await releaseStaged({ ...real, tempDir: path.join(tempDir, 'elsewhere') })).toBe(false); // a copy of the result is not the result
    expect(fs.existsSync(real.dir)).toBe(true);
    await releaseStaged(real);
    expect(fs.readFileSync(path.join(important, 'keep.txt'), 'utf8')).toBe('keep');
  });

  test('an oversized or failing copy removes its own folder before the error leaves; a missing object is the storage error unchanged', async () => {
    await expect(stageObject(adapterOf(Buffer.alloc(50, 1)), 'k/k', { tempDir, maxBytes: 10 })).rejects.toMatchObject({ code: 'too_large' });
    await expect(stageObject({ download: async () => ({ stream: new Readable({ read() { this.destroy(new Error('connection reset')); } }) }) }, 'k/k', { tempDir, maxBytes: 10 })).rejects.toThrow(/connection reset/);
    const { StorageError } = require('../../src/storage/errors');
    await expect(stageObject({ download: async () => { throw new StorageError('not_found', 'missing'); } }, 'k/k', { tempDir, maxBytes: 10 })).rejects.toMatchObject({ code: 'not_found' });
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });
});

describe('the local quarantine is private, and existing quarantined files are left alone', () => {
  let uploads;
  beforeEach(() => { uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-quarantine-')); });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(uploads, { recursive: true, force: true }); });

  test('the backfill creates the folder 0700 and chmods the moved file 0600 (best effort), never deleting what is already there', async () => {
    const quarantineDir = path.join(uploads, 'quarantine');
    fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(quarantineDir, 'older-infected.bin'), 'OLD'); // an earlier quarantined file
    fs.writeFileSync(path.join(uploads, 'bad.pdf'), 'EICAR');
    const made = [];
    const chmods = [];
    const fsApi = { ...fs, promises: {
      ...fs.promises,
      mkdir: async (p, options) => { made.push(options); return fs.promises.mkdir(p, options); },
      chmod: async (p, mode) => { chmods.push([p, mode]); return fs.promises.chmod(p, mode); },
    } };
    const db = fakeDb([{ id: 1, caseId: 10, fileUrl: '/uploads/bad.pdf' }]);
    const report = await backfillLegacyDocuments({
      db, execute: true, scanner: async () => ({ status: 'infected', signature: 'Eicar' }), ping: async () => true, uploadDir: uploads, quarantineDir, fsApi, clock: () => T_NOW,
    });
    expect(report.items[0]).toMatchObject({ outcome: 'infected', quarantined: true });
    expect(made).toEqual([{ recursive: true, mode: 0o700 }]);
    expect(chmods).toEqual([[quarantineDir, 0o700], [path.join(quarantineDir, 'bad.pdf'), 0o600]]);
    expect(fs.readFileSync(path.join(quarantineDir, 'older-infected.bin'), 'utf8')).toBe('OLD'); // nothing existing was deleted
    expect(fs.readFileSync(path.join(quarantineDir, 'bad.pdf'), 'utf8')).toBe('EICAR');
    if (POSIX) expect([fs.statSync(quarantineDir).mode & 0o777, fs.statSync(path.join(quarantineDir, 'bad.pdf')).mode & 0o777]).toEqual([0o700, 0o600]);
  });

  test('an infected UPLOAD (scanBeforeStore) is quarantined the same way: folder 0700, file 0600, an existing file kept', async () => {
    const { scanBeforeStore, QUARANTINE_DIR, QUARANTINE_DIR_MODE, QUARANTINE_FILE_MODE } = require('../../src/modules/documents/legacy-scan');
    expect([QUARANTINE_DIR_MODE, QUARANTINE_FILE_MODE]).toEqual([0o700, 0o600]);
    expect(QUARANTINE_DIR).toBe(path.join(UPLOAD_DIR, 'quarantine'));
    fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(QUARANTINE_DIR, 'earlier.bin'), 'EARLIER');
    const file = { path: path.join(UPLOAD_DIR, `infected-${Date.now()}.pdf`), originalname: 'x.pdf' };
    fs.writeFileSync(file.path, 'EICAR');
    const mkdir = jest.spyOn(fs.promises, 'mkdir');
    const chmod = jest.spyOn(fs.promises, 'chmod');
    await expect(scanBeforeStore(file, { scanner: async () => ({ status: 'infected', signature: 'Eicar' }) })).rejects.toMatchObject({ statusCode: 422, publicCode: 'file_infected' });
    expect(mkdir).toHaveBeenCalledWith(QUARANTINE_DIR, { recursive: true, mode: 0o700 });
    expect(chmod).toHaveBeenCalledWith(QUARANTINE_DIR, 0o700);
    expect(chmod).toHaveBeenCalledWith(path.join(QUARANTINE_DIR, path.basename(file.path)), 0o600);
    expect(fs.existsSync(file.path)).toBe(false); // moved out of the uploads folder
    expect(fs.readFileSync(path.join(QUARANTINE_DIR, path.basename(file.path)), 'utf8')).toBe('EICAR');
    expect(fs.readFileSync(path.join(QUARANTINE_DIR, 'earlier.bin'), 'utf8')).toBe('EARLIER');
    if (POSIX) expect(fs.statSync(path.join(QUARANTINE_DIR, path.basename(file.path))).mode & 0o777).toBe(0o600);
  });
});

const T_NOW = Date.UTC(2030, 0, 1, 12, 0, 0);
