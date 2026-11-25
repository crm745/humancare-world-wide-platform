/* global describe, test, expect, jest, beforeEach, beforeAll, afterAll */
// M3: the original (Case) document upload path. File names are cleaned and length-limited before they are stored; a database failure, a scanner failure or any unexpected error never leaves the
// uploaded file behind; and a document that WAS stored never loses its file. The REAL controller, upload policy, hashing and per-Case lock run on real temporary files; the database, ClamAV,
// the review service and Bitrix are recorders with switchable failures. No database, no network.
// Storage: a document is scanned BEFORE it is stored (scanBeforeStore), then checked and moved into the storage service (storage/ingest.js; the local adapter rooted in the temporary folder below)
// under a generated key. A row refers to that OBJECT; whenever no row ends up referring to it, the object is deleted, and the temporary file always is.
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-upload-cleanup-'));
const mockState = { requests: new Map(), docs: [], scans: [], bitrix: [], reviewCalls: [], fail: {}, nextId: 1 };
const mockBoom = (what) => Object.assign(new Error(`database failure: ${what}`), { code: 'P1001' });

jest.mock('../../src/middleware/upload.middleware', () => ({ upload: {}, UPLOAD_DIR: mockDir }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/db/prisma', () => ({
  prisma: {
    document: {
      count: async ({ where }) => { if (mockState.fail.count) throw mockBoom('count'); return mockState.docs.filter((d) => d.caseId === where.caseId).length; },
      findMany: async ({ where }) => { if (mockState.fail.list) throw mockBoom('list'); return mockState.docs.filter((d) => d.caseId === where.caseId && (!where.type || d.type === where.type)); },
      findFirst: async ({ where }) => { if (mockState.fail.probe) throw mockBoom('probe'); return mockState.docs.find((d) => d.fileUrl === where.fileUrl) || null; },
    },
    user: { findUnique: async () => ({ id: 7, name: 'Asha', email: 'a@example.invalid' }) },
  },
}));
jest.mock('../../src/modules/requests/requests.service', () => ({
  getRequestForUser: jest.fn(async (userId, id) => {
    if (mockState.fail.request) throw mockBoom('request lookup');
    const request = mockState.requests.get(Number(id));
    if (!request || request.userId !== userId) { const err = new Error('Request not found'); err.statusCode = 404; throw err; }
    return request;
  }),
  createRequest: jest.fn(), findRequestByClientRequestId: jest.fn(), listRequestsForUser: jest.fn(), listDocumentsForUser: jest.fn(),
}));
jest.mock('../../src/modules/documents/documents.service', () => ({
  addDocumentToCase: jest.fn(async (caseId, data) => {
    await new Promise((resolve) => setImmediate(resolve));
    const row = { id: mockState.nextId++, caseId, uploadedAt: new Date(), sha256: data.scan && data.scan.sha256, scanStatus: 'clean', ...data };
    if (mockState.fail.createAfterWrite) { mockState.docs.push(row); throw mockBoom('connection lost after the write was committed'); }
    if (mockState.fail.create) throw mockBoom('insert');
    if (mockState.fail.createUnique) { const err = new Error('Unique constraint failed'); err.code = 'P2002'; throw err; }
    mockState.docs.push(row);
    return row;
  }),
  findCaseDocumentByClientUploadId: jest.fn(async (caseId, clientUploadId) => {
    if (mockState.fail.find) throw mockBoom('replay lookup');
    return mockState.docs.find((d) => d.caseId === caseId && d.clientUploadId === clientUploadId) || null;
  }),
}));
jest.mock('../../src/modules/documents/legacy-scan', () => {
  const actual = jest.requireActual('../../src/modules/documents/legacy-scan');
  return {
    ...actual,
    scanBeforeStore: jest.fn(async (file, { expectedSha256 }) => {
      mockState.scans.push({ path: file.path });
      if (mockState.fail.scanThrows) throw new Error('the scan layer failed in an unexpected way (and did not clean up)');
      return { sha256: mockState.fail.scanDigest ? 'f'.repeat(64) : expectedSha256, engine: 'clamav', scannedAt: new Date() };
    }),
  };
});
jest.mock('../../src/modules/request-review/request-review.service', () => ({
  addPatientDocument: jest.fn(async (args) => { mockState.reviewCalls.push(args); if (mockState.fail.review) throw mockBoom('review insert'); return { id: 900, serviceRequestId: args.requestId, originalName: 'x.pdf' }; }),
  scanRequestDocument: jest.fn(async () => null),
  toUploadResponse: (doc) => ({ id: doc.id, name: doc.originalName }),
  createReviewRequest: jest.fn(),
}));
jest.mock('../../src/modules/bitrix/bitrix.service', () => ({ createLead: jest.fn(), sendMedicalReportToBitrix: jest.fn(async (...args) => { mockState.bitrix.push(args); return true; }) }));
jest.mock('../../src/modules/geo/geo.service', () => ({ resolveCityRefs: jest.fn(), getVerifiedCity: jest.fn() }));

const { uploadRequestDocument } = require('../../src/modules/requests/requests.controller');
const { safeDocumentName, NAME_MAX } = require('../../src/modules/requests/upload-policy');

// A structurally valid PDF (tests/safe/document-fixtures.js): the storage service's checks run on the real bytes, as in production.
const fx = require('./document-fixtures');
let PDF;
beforeAll(async () => { PDF = await fx.validPdf(); });
const PDF_TYPE = 'application/pdf';
let counter = 0;
function makeFile({ name = 'report.pdf', content = PDF } = {}) {
  counter += 1;
  const filename = `${counter}-stored.pdf`; // what multer would have made: its own sanitised name, whatever the client called the file
  const filePath = path.join(mockDir, filename);
  fs.writeFileSync(filePath, content);
  return { path: filePath, filename, originalname: name, mimetype: PDF_TYPE, size: content.length };
}
async function upload({ file = makeFile(), requestId = 1, body = {} } = {}) {
  const out = { file };
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  await uploadRequestDocument({ file, params: { id: String(requestId) }, body, user: { id: 7 } }, res, (err) => { out.err = err; });
  return out;
}
const exists = (file) => fs.existsSync(file.path);
const addRequest = (extra = {}) => { const request = { id: 1, userId: 7, serviceKey: 'ground', serviceType: 'Ground Ambulance', status: 'submitted', reviewStatus: null, destination: 'Mumbai', bitrixLeadId: null, case: { id: 10, status: 'submitted' }, requestDocuments: [], ...extra }; mockState.requests.set(request.id, request); return request; };
// The objects the storage service holds (the local adapter, rooted in mockDir): every file under case-documents/.
function storedObjects(dir = path.join(mockDir, 'case-documents')) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? storedObjects(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const GENERATED = /^case-documents\/\d{4}\/\d{2}\/[a-f0-9]{32}\.pdf$/;
// Anything left that no row refers to: a temporary file in the uploads folder, or a stored object with no document row.
const leftovers = () => [
  ...fs.readdirSync(mockDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
  ...storedObjects().filter((p) => !mockState.docs.some((d) => path.join(mockDir, d.fileUrl) === p)).map((p) => path.relative(mockDir, p)),
];

beforeEach(() => {
  mockState.requests.clear(); mockState.docs.length = 0; mockState.scans.length = 0; mockState.bitrix.length = 0; mockState.reviewCalls.length = 0; mockState.fail = {}; mockState.nextId = 1;
  for (const f of fs.readdirSync(mockDir)) fs.rmSync(path.join(mockDir, f), { recursive: true, force: true });
  addRequest();
});
afterAll(() => { fs.rmSync(mockDir, { recursive: true, force: true }); });

describe('safeDocumentName', () => {
  test('a normal name is unchanged', () => {
    for (const name of ['report.pdf', 'Discharge summary (final).pdf', 'आशा-रिपोर्ट.pdf', 'تقرير طبي.pdf', 'José Núñez 2026.docx', 'scan-1.JPG']) expect(safeDocumentName(name)).toBe(name);
  });
  test('control characters, path separators and traversal are removed', () => {
    expect(safeDocumentName('a\u0000b\u0007c.pdf')).toBe('abc.pdf');
    expect(safeDocumentName('../../etc/passwd')).toBe('etcpasswd');
    expect(safeDocumentName('C:\\Users\\x\\report.pdf')).toBe('C:Usersxreport.pdf');
    expect(safeDocumentName('line1\nline2\r\n.pdf')).toBe('line1 line2 .pdf');
    expect(safeDocumentName('tab\tname.pdf')).toBe('tab name.pdf');
    expect(safeDocumentName('del\u007fx.pdf')).toBe('delx.pdf');
    expect(safeDocumentName('c1\u0085x.pdf')).toBe('c1x.pdf');
  });
  test('bidirectional overrides, zero-width characters and line separators cannot disguise a name', () => {
    expect(safeDocumentName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(safeDocumentName('a\u200Bb\u200Dc\uFEFF.pdf')).toBe('abc.pdf');
    expect(safeDocumentName('x\u2028y\u2029z.pdf')).toBe('x y z.pdf'); // the separators are line breaks: a space, like a newline
    expect(safeDocumentName('\u2066x\u2069.pdf')).toBe('x.pdf');
  });
  test('unpaired surrogates are removed (they cannot be stored) and emoji are kept whole', () => {
    expect(safeDocumentName('a\uD800b\uDC00c.pdf')).toBe('abc.pdf');
    expect(safeDocumentName('scan \u{1F600}.pdf')).toBe('scan \u{1F600}.pdf');
    expect(safeDocumentName('\u{1F600}'.repeat(300))).toBe('\u{1F600}'.repeat(NAME_MAX));
    for (const name of ['x'.repeat(190) + '\u{1F600}\u{1F600}.pdf', '\u{1F468}\u200D\u{1F469}'.repeat(100)]) expect(safeDocumentName(name).isWellFormed()).toBe(true);
  });
  test('leading and trailing dots and spaces are dropped; nothing left means "document"', () => {
    expect(safeDocumentName('.htaccess')).toBe('htaccess');
    expect(safeDocumentName('  ..  report.pdf  ')).toBe('report.pdf');
    expect(safeDocumentName('report.pdf. . ')).toBe('report.pdf');
    for (const empty of ['', '   ', '...', '\u0000\u0001', '../', '\\', null, undefined]) expect(safeDocumentName(empty)).toBe('document');
    expect(safeDocumentName(12345)).toBe('12345');
  });
  test('Unicode is normalised (NFC) so one name is one string', () => {
    expect(safeDocumentName('e\u0301.pdf')).toBe('\u00e9.pdf');
  });
  test('a long name is cut to 191 characters, keeping its extension and never splitting a character', () => {
    const long = `${'x'.repeat(300)}.pdf`;
    const cut = safeDocumentName(long);
    expect(Array.from(cut)).toHaveLength(NAME_MAX);
    expect(cut.endsWith('.pdf')).toBe(true);
    expect(safeDocumentName('a'.repeat(191))).toHaveLength(191); // exactly the limit is untouched
    expect(Array.from(safeDocumentName('a'.repeat(192)))).toHaveLength(191);
    const emoji = safeDocumentName(`${'\u{1F600}'.repeat(250)}.docx`);
    expect(Array.from(emoji)).toHaveLength(NAME_MAX);
    expect(emoji.endsWith('.docx')).toBe(true);
    expect(emoji.isWellFormed()).toBe(true);
    expect(safeDocumentName(`${'b'.repeat(250)}.${'e'.repeat(30)}`)).toHaveLength(NAME_MAX); // an absurd "extension" is not kept
  });
  test('idempotent: cleaning a cleaned name changes nothing', () => {
    for (const name of ['a\u0000b/c.pdf', `${'x'.repeat(300)}.pdf`, '\u202Eevil.exe', '  ..hidden.pdf']) { const once = safeDocumentName(name); expect(safeDocumentName(once)).toBe(once); }
  });
});

describe('file names through the upload', () => {
  test('a long, hostile name is stored cleaned; the stored object and its content are untouched', async () => {
    const hostile = `${'x'.repeat(260)}\u0000/../\u202E.pdf`;
    const file = makeFile({ name: hostile });
    // the content check uses the original extension: this name ends in ".pdf" after the controls, so it passes only if its extension is still .pdf
    const out = await upload({ file });
    expect(out.status).toBe(201);
    const stored = mockState.docs[0];
    expect(Array.from(stored.name).length).toBeLessThanOrEqual(NAME_MAX);
    expect(stored.name).not.toMatch(/[\u0000-\u001f/\\\u202e]/);
    expect(stored.fileUrl).toMatch(GENERATED); // the object's key is generated, never derived from the patient's text (or from multer's temporary name)
    expect(stored.fileUrl).not.toContain(file.filename);
    expect(fs.readFileSync(path.join(mockDir, stored.fileUrl)).equals(PDF)).toBe(true); // original content preserved byte for byte
    expect(exists(file)).toBe(false); // the temporary file is gone
    expect(mockState.scans).toHaveLength(1); // ClamAV scanned it
  });
  test.each([
    ['a long name', `${'long-'.repeat(80)}.pdf`],
    ['Unicode', 'आशा नायर रिपोर्ट.pdf'],
    ['emoji', `${'\u{1F600}'.repeat(150)}.pdf`],
    ['spaces and dots', '  my report . final .pdf'],
  ])('%s is accepted and stored within the column limit', async (_label, name) => {
    const out = await upload({ file: makeFile({ name }) });
    expect(out.status).toBe(201);
    expect(Array.from(mockState.docs[0].name).length).toBeLessThanOrEqual(NAME_MAX);
    expect(mockState.docs[0].name.endsWith('.pdf')).toBe(true);
    expect(mockState.docs[0].name.isWellFormed()).toBe(true);
  });
  test('the name is also what the CRM message lists (never the raw client text)', async () => {
    addRequest({ bitrixLeadId: 'L-1' });
    await upload({ file: makeFile({ name: 'a\u0000b\u202E.pdf' }) });
    expect(mockState.bitrix).toHaveLength(1);
    expect(mockState.bitrix[0][1].name).toBe('ab.pdf');
  });
  test('a retry with the same clientUploadId and a long name is still answered with the original (idempotency intact)', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const name = `${'n'.repeat(300)}.pdf`;
    expect((await upload({ file: makeFile({ name }), body: { clientUploadId: id } })).status).toBe(201);
    const again = await upload({ file: makeFile({ name }), body: { clientUploadId: id } });
    expect(again.status).toBe(200);
    expect(mockState.docs).toHaveLength(1);
    expect(mockState.scans).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });
  test('the content/extension check still uses the ORIGINAL name: a double extension that ends elsewhere is refused and cleaned up', async () => {
    const out = await upload({ file: makeFile({ name: 'report.pdf.exe' }) });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('file_type_mismatch');
    expect(exists(out.file)).toBe(false);
  });
});

describe('a database failure never leaves the uploaded file behind', () => {
  test.each([
    ['the insert fails', { create: true }],
    ['the replay lookup fails', { find: true }, { clientUploadId: '44444444-4444-4444-8444-444444444444' }],
    ['the file-count query fails', { count: true }],
    ['the request lookup fails', { request: true }],
    ['the scan layer fails in an unexpected way', { scanThrows: true }],
  ])('%s: the error goes to the error handler and the file is deleted', async (_label, fail, body = {}) => {
    mockState.fail = fail;
    const out = await upload({ body });
    expect(out.err).toBeInstanceOf(Error);
    expect(out.status).toBeUndefined(); // no success response
    expect(exists(out.file)).toBe(false);
    expect(mockState.docs).toHaveLength(0);
    expect(leftovers()).toEqual([]);
  });
  test('the insert failing after the scan: the scanned file is deleted too (it was clean, but nothing refers to it)', async () => {
    mockState.fail = { create: true };
    const out = await upload();
    expect(mockState.scans).toHaveLength(1);
    expect(exists(out.file)).toBe(false);
    expect(storedObjects()).toHaveLength(0); // ...and so is the object that was already in storage
  });
  test('the failure leaves the system usable: the next upload works and is stored normally', async () => {
    mockState.fail = { create: true };
    const failed = await upload();
    expect(failed.err).toBeInstanceOf(Error);
    mockState.fail = {};
    const ok = await upload();
    expect(ok.status).toBe(201);
    expect(storedObjects()).toHaveLength(1); // stored normally: one object, referred to by the row
    expect(mockState.docs).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });
  test('a write that actually succeeded (connection lost after the commit) keeps its file, because a row refers to it', async () => {
    mockState.fail = { createAfterWrite: true };
    const out = await upload();
    expect(out.err).toBeInstanceOf(Error);
    expect(mockState.docs).toHaveLength(1);
    expect(storedObjects()).toHaveLength(1); // the object a row refers to is never deleted
    expect(leftovers()).toEqual([]);
  });
  test('when the database cannot even be asked, an uncertain file is deleted rather than left unreferenced', async () => {
    mockState.fail = { createAfterWrite: true, probe: true };
    const out = await upload();
    expect(out.err).toBeInstanceOf(Error);
    expect(exists(out.file)).toBe(false);
    expect(storedObjects()).toHaveLength(0);
  });
  test('a failure AFTER the row exists (the CRM message list) never deletes the stored document\'s file', async () => {
    addRequest({ bitrixLeadId: 'L-1' });
    mockState.fail = { list: true };
    const out = await upload();
    expect(out.err).toBeInstanceOf(Error);
    expect(mockState.docs).toHaveLength(1);
    expect(storedObjects()).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });
  test('the same upload winning the race in another process: the original is returned and only THIS copy is deleted', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    const first = await upload({ body: { clientUploadId: id } });
    expect(first.status).toBe(201);
    // the replay lookup misses (as it would in the race window), then the unique index rejects the insert
    const { findCaseDocumentByClientUploadId } = require('../../src/modules/documents/documents.service');
    findCaseDocumentByClientUploadId.mockImplementationOnce(async () => null);
    mockState.fail = { createUnique: true };
    const second = await upload({ body: { clientUploadId: id } });
    expect(second.status).toBe(200);
    expect(exists(second.file)).toBe(false);
    expect(storedObjects()).toHaveLength(1); // only the original's object remains; this copy's was deleted
    expect(path.join(mockDir, mockState.docs[0].fileUrl)).toBe(storedObjects()[0]);
    expect(mockState.docs).toHaveLength(1);
  });
});

describe('the object store and the scan digest', () => {
  test('the scan was of different bytes than the ones stored: 503, the stored object is deleted, no row, the temporary file is gone', async () => {
    mockState.fail = { scanDigest: true };
    const out = await upload();
    expect(out.err && out.err.statusCode).toBe(503);
    expect(out.err.publicCode).toBe('scan_unavailable');
    expect(mockState.docs).toHaveLength(0);
    expect(storedObjects()).toHaveLength(0);
    expect(exists(out.file)).toBe(false);
  });
  test('the object store refusing the write: the error goes to the error handler, nothing is stored, no row, the temporary file is gone', async () => {
    const storage = require('../../src/storage');
    const { StorageError } = require('../../src/storage/errors');
    const adapter = { provider: 'local', upload: jest.fn(async () => { throw new StorageError('upload_failed', 'The file could not be stored.'); }), delete: jest.fn(async () => undefined) };
    storage.setStorageForTests(adapter);
    try {
      const out = await upload();
      expect(adapter.upload).toHaveBeenCalledTimes(1);
      expect(out.err).toBeInstanceOf(Error);
      expect(out.status).toBeUndefined();
      expect(mockState.docs).toHaveLength(0);
      expect(exists(out.file)).toBe(false);
      expect(mockState.scans).toHaveLength(1); // it was scanned first (scan before store)
    } finally { storage.setStorageForTests(null); }
  });
  test('a stored object whose row insert fails is deleted through the storage service (not left behind in the bucket)', async () => {
    const storage = require('../../src/storage');
    const real = storage.getStorage();
    const deleted = [];
    const adapter = { ...real, provider: real.provider, upload: (...args) => real.upload(...args), delete: jest.fn(async (key) => { deleted.push(key); return real.delete(key); }), download: (...a) => real.download(...a), getMetadata: (...a) => real.getMetadata(...a) };
    storage.setStorageForTests(adapter);
    try {
      mockState.fail = { create: true };
      const out = await upload();
      expect(out.err).toBeInstanceOf(Error);
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toMatch(GENERATED);
      expect(storedObjects()).toHaveLength(0);
    } finally { storage.setStorageForTests(null); }
  });
});

describe('every refusal path cleans up', () => {
  test.each([
    ['no case yet', () => addRequest({ case: null }), {}],
    ['a request that is not the patient\'s', () => mockState.requests.clear(), {}],
    ['a cancelled request', () => addRequest({ status: 'cancelled', case: { id: 10, status: 'cancelled' } }), {}],
    ['a malformed clientUploadId', () => {}, { clientUploadId: 'nope' }],
    ['Teleconsultation (structured)', () => addRequest({ serviceKey: 'tele', destination: '' }), {}],
  ])('%s', async (_label, setup, body) => {
    setup();
    const out = await upload({ body });
    expect(exists(out.file)).toBe(false);
    expect(mockState.docs).toHaveLength(0);
    expect(mockState.scans).toHaveLength(0);
    expect(storedObjects()).toHaveLength(0);
  });
  test('the cap, an empty file and a wrong-type file', async () => {
    for (let i = 0; i < 30; i += 1) mockState.docs.push({ id: 9000 + i, caseId: 10, type: 'Medical Report', fileUrl: `case-documents/2026/11/${String(i).padStart(32, '0')}.pdf` });
    const full = await upload();
    expect(full.body.code).toBe('too_many_documents');
    expect(exists(full.file)).toBe(false);
    mockState.docs.length = 0;
    const empty = await upload({ file: makeFile({ content: Buffer.alloc(0) }) });
    expect(empty.body.code).toBe('file_empty');
    expect(exists(empty.file)).toBe(false);
    const wrong = await upload({ file: makeFile({ content: Buffer.from('<html></html>') }) });
    expect(wrong.body.code).toBe('file_type_mismatch');
    expect(exists(wrong.file)).toBe(false);
    expect(leftovers()).toEqual([]);
  });
  test('the review path: a failing insert and a failing request lookup leave nothing behind', async () => {
    addRequest({ id: 2, serviceKey: 'privatecharter', reviewStatus: 'in_review', case: null });
    mockState.fail = { review: true };
    const failed = await upload({ requestId: 2 });
    expect(failed.err).toBeInstanceOf(Error);
    expect(exists(failed.file)).toBe(false);
    mockState.fail = { request: true };
    const lookup = await upload({ requestId: 2 });
    expect(exists(lookup.file)).toBe(false);
    mockState.fail = {};
    const ok = await upload({ requestId: 2 });
    expect(ok.status).toBe(201);
    expect(exists(ok.file)).toBe(true); // a stored review document keeps its file
  });
  test('after a whole battery of failures nothing is left in the uploads folder except stored documents', async () => {
    for (const fail of [{ create: true }, { find: true }, { count: true }, { scanThrows: true }]) {
      mockState.fail = fail;
      await upload({ body: fail.find ? { clientUploadId: '66666666-6666-4666-8666-666666666666' } : {} });
    }
    mockState.fail = {};
    await upload();
    expect(mockState.docs).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });
});
