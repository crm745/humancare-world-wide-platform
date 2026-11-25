/* global describe, test, expect, jest, beforeEach, afterEach */
// Access rules on top of storage: unauthorized users, documents that are not scanned clean, tampered / missing / unreachable objects,
// legacy local keys next to S3 keys, and the document download controller. Prisma and storage are mocked; no database, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: { document: { findUnique: jest.fn() }, requestDocument: { findUnique: jest.fn() } } }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));

const crypto = require('crypto');
const { Readable } = require('stream');
const { prisma } = require('../../src/db/prisma');
const storage = require('../../src/storage');
const { StorageError } = require('../../src/storage/errors');
const files = require('../../src/modules/request-review/request-review.files');
const { downloadDocument } = require('../../src/modules/documents/documents.controller');

const BODY = Buffer.from('%PDF-1.4 patient report');
const sha = crypto.createHash('sha256').update(BODY).digest('hex');
const KEY = `request-documents/2026/11/${'a'.repeat(32)}.pdf`;

function fakeAdapter(objects) {
  return {
    provider: 'fake',
    download: jest.fn(async (key) => {
      if (!objects.has(key)) throw new StorageError('not_found', 'missing');
      const value = objects.get(key);
      if (value instanceof Error) throw value;
      return { stream: Readable.from([value]), size: value.length };
    }),
    getMetadata: jest.fn(async (key) => (objects.has(key) && !(objects.get(key) instanceof Error) ? { size: objects.get(key).length } : null)),
    exists: jest.fn(async (key) => objects.has(key)),
    delete: jest.fn(async () => undefined),
  };
}
const makeRes = () => {
  const chunks = [];
  const res = new (require('stream').Writable)({ write(c, _e, cb) { chunks.push(c); cb(); } });
  Object.assign(res, {
    headers: {}, set(k, v) { this.headers[k] = v; return this; }, type() { return this; }, attachment(n) { this.filename = n; return this; },
    status(code) { this.statusCode = code; return this; }, json() { return this; }, send(b) { this.sent = b; this.end(); return this; }, chunks,
  });
  return res;
};
const next = jest.fn();

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => storage.setStorageForTests(null));

describe('verified reads of workflow documents', () => {
  const doc = { storageKey: KEY, sha256: sha, sizeBytes: BODY.length };

  test('intact object: fileProblem null and bytes returned', async () => {
    storage.setStorageForTests(fakeAdapter(new Map([[KEY, BODY]])));
    expect(await files.fileProblem(doc)).toBeNull();
    expect(await files.readVerifiedFile(doc)).toEqual(BODY);
  });
  test('tampered object is refused (409 file_changed)', async () => {
    storage.setStorageForTests(fakeAdapter(new Map([[KEY, Buffer.from('%PDF-1.4 patient reporX')]])));
    expect(await files.fileProblem(doc)).toMatchObject({ code: 'file_changed' });
    await expect(files.readVerifiedFile(doc)).rejects.toMatchObject({ statusCode: 409, publicCode: 'file_changed' });
  });
  test('missing object is 404, unreachable storage is 503 (not "missing")', async () => {
    storage.setStorageForTests(fakeAdapter(new Map()));
    expect(await files.fileProblem(doc)).toMatchObject({ code: 'file_missing' });
    await expect(files.readVerifiedFile(doc)).rejects.toMatchObject({ statusCode: 404 });
    const down = fakeAdapter(new Map([[KEY, new StorageError('download_failed', 'x')]]));
    down.getMetadata = jest.fn(async () => { throw new StorageError('metadata_failed', 'x'); });
    storage.setStorageForTests(down);
    expect(await files.fileProblem(doc)).toMatchObject({ code: 'storage_unavailable' });
    await expect(files.readVerifiedFile(doc)).rejects.toMatchObject({ statusCode: 503, publicCode: 'storage_unavailable' });
  });
  test('no recorded checksum fails closed', async () => {
    storage.setStorageForTests(fakeAdapter(new Map([[KEY, BODY]])));
    await expect(files.readVerifiedFile({ ...doc, sha256: null })).rejects.toMatchObject({ publicCode: 'checksum_missing' });
    expect(await files.fileProblem({ ...doc, sha256: null })).toMatchObject({ code: 'checksum_missing' });
  });
  test('a case document is served only after a clean scan AND approval', () => {
    const caseDoc = { id: 9 };
    for (const scanStatus of ['pending', 'error', 'failed', 'infected']) {
      expect(() => files.assertCaseDocumentServable({ caseDocumentId: 9, scanStatus, reviewStatus: 'approved' }, caseDoc)).toThrow(/virus scan/);
    }
    expect(() => files.assertCaseDocumentServable({ caseDocumentId: 9, scanStatus: 'clean', reviewStatus: 'pending' }, caseDoc)).toThrow();
    expect(() => files.assertCaseDocumentServable({ caseDocumentId: 8, scanStatus: 'clean', reviewStatus: 'approved' }, caseDoc)).toThrow(/not linked/);
    expect(() => files.assertCaseDocumentServable({ caseDocumentId: 9, scanStatus: 'clean', reviewStatus: 'approved' }, caseDoc)).not.toThrow();
  });
});

describe('document download controller', () => {
  const caseDocument = (overrides = {}) => ({ id: 9, name: 'report.pdf', fileUrl: KEY, case: { corporateId: 3, serviceRequest: { userId: 7 } }, ...overrides });

  test('an unauthorized user gets 404 and storage is never touched', async () => {
    const adapter = fakeAdapter(new Map([[KEY, BODY]]));
    storage.setStorageForTests(adapter);
    prisma.document.findUnique.mockResolvedValue(caseDocument());
    const err = await new Promise((resolve) => downloadDocument({ params: { id: 9 }, user: { role: 'patient', id: 99 } }, makeRes(), resolve));
    expect(err.statusCode).toBe(404);
    expect(adapter.download).not.toHaveBeenCalled();
  });
  test('a workflow document whose scan is pending is refused (409), nothing is read', async () => {
    const adapter = fakeAdapter(new Map([[KEY, BODY]]));
    storage.setStorageForTests(adapter);
    prisma.document.findUnique.mockResolvedValue(caseDocument());
    prisma.requestDocument.findUnique.mockResolvedValue({ caseDocumentId: 9, scanStatus: 'pending', reviewStatus: 'approved', storageKey: KEY, sha256: sha, sizeBytes: BODY.length });
    const err = await new Promise((resolve) => downloadDocument({ params: { id: 9 }, user: { role: 'patient', id: 7 } }, makeRes(), resolve));
    expect(err).toMatchObject({ statusCode: 409, publicCode: 'document_not_clean' });
    expect(adapter.download).not.toHaveBeenCalled();
  });
  test('the owner downloads a clean, approved workflow document: verified bytes, nosniff, attachment', async () => {
    storage.setStorageForTests(fakeAdapter(new Map([[KEY, BODY]])));
    prisma.document.findUnique.mockResolvedValue(caseDocument());
    prisma.requestDocument.findUnique.mockResolvedValue({ caseDocumentId: 9, scanStatus: 'clean', reviewStatus: 'approved', storageKey: KEY, sha256: sha, sizeBytes: BODY.length });
    const res = makeRes();
    await downloadDocument({ params: { id: 9 }, user: { role: 'patient', id: 7 } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.sent).toEqual(BODY);
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.filename).toBe('report.pdf');
  });
  test('a legacy "/uploads/<name>" document is streamed from the local adapter, an S3-era key from the configured one', async () => {
    const adapter = fakeAdapter(new Map([['1700-legacy.pdf', BODY], ['case-documents/2026/11/' + 'b'.repeat(32) + '.pdf', BODY]]));
    storage.setStorageForTests(adapter);
    prisma.requestDocument.findUnique.mockResolvedValue(null);
    for (const fileUrl of ['/uploads/1700-legacy.pdf', 'case-documents/2026/11/' + 'b'.repeat(32) + '.pdf']) {
      // a new upload always carries its clean scan record; a corporate holding a patient's Case is served only such a document (documents/document-scan.js)
      prisma.document.findUnique.mockResolvedValue(caseDocument({ fileUrl, scanStatus: 'clean' }));
      const res = makeRes();
      await downloadDocument({ params: { id: 9 }, user: { role: 'corporate', corporateId: 3 } }, res, next);
      await new Promise((r) => setImmediate(r));
      expect(Buffer.concat(res.chunks)).toEqual(BODY);
    }
    expect(adapter.download).toHaveBeenCalledWith('1700-legacy.pdf');
    expect(next).not.toHaveBeenCalled();
  });
  test('a missing object is a 404, not a crash', async () => {
    storage.setStorageForTests(fakeAdapter(new Map()));
    prisma.requestDocument.findUnique.mockResolvedValue(null);
    prisma.document.findUnique.mockResolvedValue(caseDocument());
    const err = await new Promise((resolve) => downloadDocument({ params: { id: 9 }, user: { role: 'patient', id: 7 } }, makeRes(), resolve));
    expect(err).toMatchObject({ statusCode: 404 });
  });
});
