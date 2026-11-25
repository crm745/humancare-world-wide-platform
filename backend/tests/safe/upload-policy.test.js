/* global describe, test, expect, jest, beforeEach, beforeAll, afterAll */
// M2: one upload policy for every patient service (src/modules/requests/upload-policy.js): at most 30 documents per request (Mortal Remains 10), files whose real content matches their type and name,
// no empty files, no uploads to a cancelled or completed request, on both storage paths. The REAL controller (uploadRequestDocument), policy, hashing and per-Case lock run on real temporary
// files; the database, the ClamAV scan, the review service and Bitrix are recorders. ClamAV scanning, idempotent uploads and recovery are shown to be intact. No database, no network.
// Storage: a document is scanned BEFORE it is stored (scanBeforeStore), then checked and moved into the storage service under a generated key (storage/ingest.js; the local adapter, rooted in the
// temporary folder below). The stored object is what a row refers to, never a "/uploads/<name>" path. A .doc is refused by the storage service's own rules, before anything is scanned.
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-upload-policy-'));
const mockState = { requests: new Map(), docs: [], reviewDocs: [], scans: [], bitrix: [], reviewCalls: [], scanVerdict: 'clean', nextId: 1 };

jest.mock('../../src/middleware/upload.middleware', () => ({ upload: {}, UPLOAD_DIR: mockDir }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/db/prisma', () => ({
  prisma: {
    document: {
      count: async ({ where }) => mockState.docs.filter((d) => d.caseId === where.caseId).length,
      findMany: async ({ where }) => mockState.docs.filter((d) => d.caseId === where.caseId && (!where.type || d.type === where.type)),
    },
    user: { findUnique: async () => ({ id: 7, name: 'Asha', email: 'a@example.invalid' }) },
  },
}));
jest.mock('../../src/modules/requests/requests.service', () => ({
  getRequestForUser: jest.fn(async (userId, id) => {
    const request = mockState.requests.get(Number(id));
    if (!request || request.userId !== userId) { const err = new Error('Request not found'); err.statusCode = 404; throw err; }
    return request;
  }),
  createRequest: jest.fn(), findRequestByClientRequestId: jest.fn(), listRequestsForUser: jest.fn(), listDocumentsForUser: jest.fn(),
}));
jest.mock('../../src/modules/documents/documents.service', () => ({
  addDocumentToCase: jest.fn(async (caseId, data) => { await new Promise((resolve) => setImmediate(resolve)); const row = { id: mockState.nextId++, caseId, uploadedAt: new Date(), sha256: data.scan && data.scan.sha256, scanStatus: 'clean', ...data }; mockState.docs.push(row); return row; }),
  findCaseDocumentByClientUploadId: jest.fn(async (caseId, clientUploadId) => mockState.docs.find((d) => d.caseId === caseId && d.clientUploadId === clientUploadId) || null),
}));
jest.mock('../../src/modules/documents/legacy-scan', () => {
  const actual = jest.requireActual('../../src/modules/documents/legacy-scan');
  const { httpError } = require('../../src/modules/request-review/request-review.files');
  return {
    ...actual,
    // The real scanBeforeStore is covered by legacy-document-scan-protection.test.js; here it is a recorder with ClamAV's three outcomes.
    scanBeforeStore: jest.fn(async (file, { expectedSha256 }) => {
      mockState.scans.push({ path: file.path, sha256: expectedSha256 });
      if (mockState.scanVerdict === 'infected') throw httpError(422, 'This file was blocked because it may contain a virus. It was not saved.', 'file_infected');
      if (mockState.scanVerdict === 'down') throw httpError(503, 'We could not scan this file for viruses right now, so it was not saved. Please try again in a moment.', 'scan_unavailable');
      return { sha256: expectedSha256, engine: 'clamav', scannedAt: new Date() };
    }),
  };
});
jest.mock('../../src/modules/request-review/request-review.service', () => ({
  addPatientDocument: jest.fn(async (args) => { mockState.reviewCalls.push(args); const row = { id: mockState.nextId++, serviceRequestId: args.requestId, clientUploadId: args.clientUploadId || null, originalName: args.file.originalname, sizeBytes: args.file.size, scanStatus: 'pending', reviewStatus: 'pending' }; mockState.reviewDocs.push(row); return row; }),
  scanRequestDocument: jest.fn(async (id) => mockState.reviewDocs.find((d) => d.id === id)),
  toUploadResponse: (doc) => ({ id: doc.id, name: doc.originalName }),
  createReviewRequest: jest.fn(),
}));
jest.mock('../../src/modules/bitrix/bitrix.service', () => ({ createLead: jest.fn(), sendMedicalReportToBitrix: jest.fn(async (...args) => { mockState.bitrix.push(args); return true; }) }));
jest.mock('../../src/modules/geo/geo.service', () => ({ resolveCityRefs: jest.fn(), getVerifiedCity: jest.fn() }));

const { uploadRequestDocument } = require('../../src/modules/requests/requests.controller');
const policy = require('../../src/modules/requests/upload-policy');

// Real file contents (the first bytes are what the policy reads).
// Valid files (tests/safe/document-fixtures.js): the storage service's checks (storage/ingest.js: type and structure) run on the real bytes, as in production.
const fx = require('./document-fixtures');
let PDF; // built with pdf-lib (async): see beforeAll below. Tables below pass `() => PDF`, which makeFile resolves at call time.
const JPEG = fx.validJpeg();
const PNG = fx.validPng();
const WEBP = fx.validWebp();
const DOC = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(40, 4)]); // a legacy .doc: refused by the storage service everywhere
const DOCX = fx.validDocx();
beforeAll(async () => { PDF = await fx.validPdf(); });
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(40, 6)]);
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

let counter = 0;
function makeFile({ name = 'report.pdf', mimetype = MIME.pdf, content: given = PDF } = {}) {
  const content = typeof given === 'function' ? given() : given;
  counter += 1;
  const filename = `${counter}-${name}`;
  const filePath = path.join(mockDir, filename);
  fs.writeFileSync(filePath, content);
  return { path: filePath, filename, originalname: name, mimetype, size: content.length };
}
async function upload({ file = makeFile(), requestId = 1, body = {}, userId = 7 } = {}) {
  const out = { file };
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  await uploadRequestDocument({ file, params: { id: String(requestId) }, body, user: { id: userId } }, res, (err) => { out.err = err; });
  return out;
}
const exists = (file) => fs.existsSync(file.path); // the TEMPORARY file multer wrote: ingestUpload / the cleanup always remove it
// The objects the storage service holds (the local adapter, rooted in mockDir): every file under case-documents/ (and nothing else is a stored document).
function storedObjects(dir = path.join(mockDir, 'case-documents')) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? storedObjects(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const GENERATED = /^case-documents\/\d{4}\/\d{2}\/[a-f0-9]{32}\.(pdf|jpg|png|webp|docx)$/;
const addRequest = (extra = {}) => { const request = { id: 1, userId: 7, serviceKey: 'ground', serviceType: 'Ground Ambulance', status: 'submitted', reviewStatus: null, destination: 'Mumbai', bitrixLeadId: null, case: { id: 10, status: 'submitted' }, requestDocuments: [], ...extra }; mockState.requests.set(request.id, request); return request; };
const fill = (n, caseId = 10) => { for (let i = 0; i < n; i += 1) mockState.docs.push({ id: 5000 + i, caseId, type: 'Medical Report', name: `old-${i}.pdf` }); };

beforeEach(() => {
  mockState.requests.clear(); mockState.docs.length = 0; mockState.reviewDocs.length = 0; mockState.scans.length = 0; mockState.bitrix.length = 0; mockState.reviewCalls.length = 0;
  mockState.scanVerdict = 'clean'; mockState.nextId = 1;
  fs.rmSync(path.join(mockDir, 'case-documents'), { recursive: true, force: true });
  addRequest();
});
afterAll(() => { fs.rmSync(mockDir, { recursive: true, force: true }); });

describe('the policy constants', () => {
  test('30 files for every service, 10 for Mortal Remains, 10 MB, and the review workflow shares the same 30', () => {
    expect(policy.MAX_DOCUMENTS_PER_REQUEST).toBe(30);
    expect(require('../../src/modules/request-review/request-review.config').MAX_DOCUMENTS_PER_REQUEST).toBe(30);
    for (const key of ['ground', 'commercialair_stretcher', 'commercialair_wheelchair', 'homecare', 'medvalue', 'marine', 'hospital', 'privatecharter', 'air', undefined]) expect(policy.maxFilesFor(key)).toBe(30);
    for (const key of ['mortal', 'mortal_domestic', 'mortal_international']) expect(policy.maxFilesFor(key)).toBe(10);
    expect(policy.MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('a valid upload is stored as before (ClamAV scanning intact)', () => {
  test.each([['pdf', () => PDF, MIME.pdf], ['jpg', () => JPEG, MIME.jpg], ['png', () => PNG, MIME.png], ['webp', () => WEBP, MIME.webp]])('%s', async (ext, content, mimetype) => {
    const out = await upload({ file: makeFile({ name: `scan.${ext}`, mimetype, content }) });
    expect({ ext, status: out.status }).toEqual({ ext, status: 201 });
    expect(mockState.scans).toHaveLength(1); // scanned BEFORE it was stored
    expect(mockState.docs.filter((d) => d.caseId === 10)).toHaveLength(1);
    const row = mockState.docs[0];
    expect(row).toMatchObject({ type: 'Medical Report', name: `scan.${ext}`, scan: { engine: 'clamav' } });
    // the row refers to an OBJECT in the storage service (a generated key), never to a "/uploads/<name>" path, and the clean scan record is the digest of exactly the stored bytes
    expect(row.fileUrl).toMatch(GENERATED);
    expect(row.fileUrl).not.toContain('/uploads/');
    const stored = fs.readFileSync(path.join(mockDir, row.fileUrl));
    expect(require('crypto').createHash('sha256').update(stored).digest('hex')).toBe(row.scan.sha256);
    expect(row.fileSizeBytes).toBe(stored.length);
    expect(exists(out.file)).toBe(false); // the temporary file is gone: the object in storage is the document
    expect(storedObjects()).toHaveLength(1);
  });
  test('a structurally valid .docx is not a patient document type (the patient upload policy of the storage service: PDF, JPG, PNG, WEBP): 400 file_type_not_allowed, never scanned or stored (a corporate case upload accepts it)', async () => {
    const out = await upload({ file: makeFile({ name: 'scan.docx', mimetype: MIME.docx, content: DOCX }) });
    expect(out.err && out.err.publicCode).toBe('file_type_not_allowed');
    expect(mockState.scans).toHaveLength(0);
    expect(mockState.docs).toHaveLength(0);
    expect(storedObjects()).toHaveLength(0);
    expect(exists(out.file)).toBe(false);
  });
  test('a legacy .doc is refused (400 file_type_not_allowed): never scanned, never stored, no row, the temporary file is deleted', async () => {
    const out = await upload({ file: makeFile({ name: 'scan.doc', mimetype: MIME.doc, content: DOC }) });
    expect(out.err && out.err.statusCode).toBe(400);
    expect(out.err.publicCode).toBe('file_type_not_allowed');
    expect(mockState.scans).toHaveLength(0); // the storage service's rules run BEFORE the scan
    expect(mockState.docs).toHaveLength(0);
    expect(storedObjects()).toHaveLength(0);
    expect(exists(out.file)).toBe(false);
  });
  test('a file that passes the type check but fails the structure check is refused before it is scanned or stored (an encrypted PDF)', async () => {
    const encrypted = await fx.pdfWith('encrypted');
    const out = await upload({ file: makeFile({ name: 'locked.pdf', mimetype: MIME.pdf, content: encrypted }) });
    expect(out.err && out.err.statusCode).toBe(400);
    expect(out.err.publicCode).toBe('file_encrypted');
    expect(mockState.scans).toHaveLength(0);
    expect(mockState.docs).toHaveLength(0);
    expect(storedObjects()).toHaveLength(0);
    expect(exists(out.file)).toBe(false);
  });
  test('active content in a PDF (JavaScript) is refused the same way', async () => {
    const out = await upload({ file: makeFile({ name: 'active.pdf', mimetype: MIME.pdf, content: await fx.pdfWith('openaction') }) });
    expect(out.err && out.err.publicCode).toBe('file_structure_invalid');
    expect(mockState.scans).toHaveLength(0);
    expect(storedObjects()).toHaveLength(0);
  });
  test('upper-case extensions and .jpeg are fine', async () => {
    expect((await upload({ file: makeFile({ name: 'SCAN.PDF' }) })).status).toBe(201);
    expect((await upload({ file: makeFile({ name: 'photo.jpeg', mimetype: MIME.jpg, content: () => JPEG }) })).status).toBe(201);
  });
  test('an infected file and a scanner outage are still refused (422 / 503), nothing is stored and the file is not kept as a document', async () => {
    mockState.scanVerdict = 'infected';
    const infected = await upload();
    expect(infected.err && infected.err.statusCode).toBe(422);
    expect(infected.err.publicCode).toBe('file_infected');
    mockState.scanVerdict = 'down';
    const down = await upload();
    expect(down.err && down.err.statusCode).toBe(503);
    expect(mockState.docs).toHaveLength(0);
    expect(storedObjects()).toHaveLength(0); // the scan comes first: nothing reached the storage service
  });
  test('a retry with the same clientUploadId is answered with the original: no second scan, no second document', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect((await upload({ body: { clientUploadId: id } })).status).toBe(201);
    const again = await upload({ body: { clientUploadId: id }, file: makeFile() });
    expect(again.status).toBe(200);
    expect(mockState.docs).toHaveLength(1);
    expect(mockState.scans).toHaveLength(1);
    expect(storedObjects()).toHaveLength(1); // the repeat's copy was deleted, not stored
    expect(exists(again.file)).toBe(false);
  });
});

describe('invalid files are refused, discarded and never scanned or stored', () => {
  const BAD = [
    ['HTML named .pdf, declared PDF', { name: 'x.pdf', mimetype: MIME.pdf, content: HTML }, 'file_type_mismatch'],
    ['an executable named .pdf', { name: 'x.pdf', mimetype: MIME.pdf, content: EXE }, 'file_type_mismatch'],
    ['a GIF declared as PNG', { name: 'x.png', mimetype: MIME.png, content: GIF }, 'file_type_mismatch'],
    ['PNG bytes declared as PDF', { name: 'x.pdf', mimetype: MIME.pdf, content: () => PNG }, 'file_type_mismatch'],
    ['PDF bytes with a .png name', { name: 'x.png', mimetype: MIME.png, content: () => PDF }, 'file_type_mismatch'],
    ['PDF bytes with a .exe name', { name: 'x.exe', mimetype: MIME.pdf, content: () => PDF }, 'file_type_mismatch'],
    ['PDF bytes with no extension', { name: 'report', mimetype: MIME.pdf, content: () => PDF }, 'file_type_mismatch'],
    ['PDF bytes declared as DOCX', { name: 'x.docx', mimetype: MIME.docx, content: () => PDF }, 'file_type_mismatch'],
    ['a double extension that ends in a script', { name: 'x.pdf.js', mimetype: MIME.pdf, content: () => PDF }, 'file_type_mismatch'],
    ['random text declared as JPEG', { name: 'x.jpg', mimetype: MIME.jpg, content: Buffer.from('just some text, not an image') }, 'file_type_mismatch'],
    ['an empty file', { name: 'x.pdf', mimetype: MIME.pdf, content: Buffer.alloc(0) }, 'file_empty'],
  ];
  test.each(BAD)('%s', async (_name, spec, code) => {
    const out = await upload({ file: makeFile(spec) });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe(code);
    expect(exists(out.file)).toBe(false); // nothing left behind
    expect(mockState.scans).toHaveLength(0);
    expect(mockState.docs).toHaveLength(0);
    expect(storedObjects()).toHaveLength(0);
  });
  test('a file over 10 MB (as multer reports it) and an unreadable one are refused', async () => {
    const big = makeFile();
    big.size = policy.MAX_FILE_BYTES + 1;
    expect((await upload({ file: big })).body.code).toBe('file_too_large');
    const gone = makeFile();
    fs.rmSync(gone.path);
    const out = await upload({ file: gone });
    expect(out.status).toBe(400); // the controller's own read (the file's digest) fails first
    expect(mockState.docs).toHaveLength(0);
    expect(mockState.scans).toHaveLength(0);
  });
  test('the same checks run for the review workflow (Private Charter): refused before anything is stored', async () => {
    addRequest({ id: 2, serviceKey: 'privatecharter', reviewStatus: 'awaiting_documents', case: null });
    const out = await upload({ requestId: 2, file: makeFile({ name: 'x.pdf', mimetype: MIME.pdf, content: HTML }) });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('file_type_mismatch');
    expect(exists(out.file)).toBe(false);
    expect(mockState.reviewCalls).toHaveLength(0);
    const ok = await upload({ requestId: 2 });
    expect(ok.status).toBe(201);
    expect(mockState.reviewCalls).toHaveLength(1);
  });
});

describe('the per-request file limit is the same for every service', () => {
  const SERVICES = [['Ground Ambulance', 'ground'], ['Commercial Air', 'commercialair_stretcher'], ['Home Healthcare', 'homecare'], ['Medical Value Travel', 'medvalue'], ['Marine', 'marine'], ['Hospitalization', 'hospital'], ['older air', 'air']];
  test.each(SERVICES)('%s: the 30th is accepted and the 31st refused', async (_name, serviceKey) => {
    mockState.requests.clear();
    addRequest({ serviceKey });
    fill(29);
    expect((await upload()).status).toBe(201);
    const refused = await upload();
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'too_many_documents', error: 'A request can hold at most 30 documents.' });
    expect(exists(refused.file)).toBe(false);
    expect(mockState.docs).toHaveLength(30);
    expect(mockState.scans).toHaveLength(1); // the refused one was not even scanned
    expect(storedObjects()).toHaveLength(1); // only the accepted one is in storage
  });
  test('Mortal Remains keeps its own limit of 10 and its wording; its files are "Supporting Document" and are never sent to Bitrix', async () => {
    addRequest({ serviceKey: 'mortal', bitrixLeadId: 'L-1' });
    fill(9);
    const ok = await upload();
    expect(ok.status).toBe(201);
    expect(mockState.docs.at(-1).type).toBe('Supporting Document');
    expect(mockState.bitrix).toHaveLength(0);
    const refused = await upload();
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('A Mortal Remains request can have at most 10 documents.');
  });
  test('Medical Report uploads still go to the CRM lead exactly once each', async () => {
    addRequest({ bitrixLeadId: 'L-1' });
    await upload();
    expect(mockState.bitrix).toHaveLength(1);
  });
  test('one request\'s count does not affect another\'s', async () => {
    addRequest({ id: 3, case: { id: 33, status: 'submitted' } });
    fill(30, 10);
    expect((await upload({ requestId: 1 })).status).toBe(400);
    expect((await upload({ requestId: 3 })).status).toBe(201);
  });
  test('parallel uploads at the limit cannot all get in: with one slot left exactly one succeeds', async () => {
    fill(29);
    const results = await Promise.all([upload(), upload(), upload(), upload()]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(mockState.docs).toHaveLength(30);
    for (const refused of results.filter((r) => r.status === 400)) expect(exists(refused.file)).toBe(false);
    // the three that lost the race were scanned and stored before the per-Case count was taken again: their objects are deleted, only the accepted one stays
    expect(storedObjects()).toHaveLength(1);
  });
  test('the review workflow\'s own cap of 30 is unchanged (it is enforced inside addPatientDocument)', async () => {
    const { addPatientDocument } = require('../../src/modules/request-review/request-review.service');
    addRequest({ id: 2, serviceKey: 'privatecharter', reviewStatus: 'in_review', case: null });
    addPatientDocument.mockImplementationOnce(async () => { const err = new Error('A request can hold at most 30 documents.'); err.statusCode = 400; err.publicCode = 'too_many_documents'; throw err; });
    const out = await upload({ requestId: 2 });
    expect(out.err.publicCode).toBe('too_many_documents');
  });
});

describe('cancelled and completed requests take no documents', () => {
  test.each(['cancelled', 'completed'])('%s: 409 request_closed on the original path, file discarded, nothing scanned or stored', async (status) => {
    mockState.requests.clear();
    addRequest({ status, case: { id: 10, status } });
    const out = await upload();
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('request_closed');
    expect(out.body.error).toContain(status);
    expect(exists(out.file)).toBe(false);
    expect(mockState.scans).toHaveLength(0);
    expect(mockState.docs).toHaveLength(0);
  });
  test.each(['cancelled', 'completed'])('%s: the same on the review workflow', async (status) => {
    addRequest({ id: 2, serviceKey: 'privatecharter', reviewStatus: 'in_review', status, case: null });
    const out = await upload({ requestId: 2 });
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('request_closed');
    expect(exists(out.file)).toBe(false);
    expect(mockState.reviewCalls).toHaveLength(0);
  });
  test.each(['submitted', 'scheduled', 'in_progress'])('%s requests still take documents', async (status) => {
    mockState.requests.clear();
    addRequest({ status, case: { id: 10, status } });
    expect((await upload()).status).toBe(201);
  });
  test('an upload the server already holds is still answered with the original after the request closed (upload recovery)', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect((await upload({ body: { clientUploadId: id } })).status).toBe(201);
    mockState.requests.get(1).status = 'completed';
    const again = await upload({ body: { clientUploadId: id } });
    // the legacy path answers a replay before judging the request (it is not a new document)
    expect(again.status).toBe(200);
    expect(mockState.docs).toHaveLength(1);
    // review workflow: a replay is recognised from the request's own document list
    addRequest({ id: 2, serviceKey: 'privatecharter', reviewStatus: 'in_review', status: 'completed', case: null, requestDocuments: [{ id: 77, clientUploadId: id }] });
    const { addPatientDocument } = require('../../src/modules/request-review/request-review.service');
    addPatientDocument.mockImplementationOnce(async () => ({ id: 77, originalName: 'report.pdf', replayed: true })); // what the real service answers for a document it already holds
    const review = await upload({ requestId: 2, body: { clientUploadId: id } });
    expect(review.status).toBe(200);
    expect(review.body.document.id).toBe(77);
  });
});

describe('ownership and the other service rules are unchanged', () => {
  test('another patient\'s request is a 404 and their file is discarded', async () => {
    const out = await upload({ userId: 9 });
    expect(out.err.statusCode).toBe(404);
    expect(exists(out.file)).toBe(false);
    expect(mockState.docs).toHaveLength(0);
  });
  test('no file is a 400; a malformed clientUploadId is a 400 and the file is discarded', async () => {
    const none = {}; const res = { status(c) { none.status = c; return this; }, json(p) { none.body = p; return this; } };
    await uploadRequestDocument({ file: undefined, params: { id: '1' }, body: {}, user: { id: 7 } }, res, () => {});
    expect(none.status).toBe(400);
    const bad = await upload({ body: { clientUploadId: 'not-a-uuid' } });
    expect(bad.status).toBe(400);
    expect(exists(bad.file)).toBe(false);
  });
  test('Teleconsultation (structured) and Corporate Medical Solutions still take no documents, and are checked before the new rules', async () => {
    mockState.requests.clear();
    addRequest({ serviceKey: 'tele', destination: '' });
    const tele = await upload();
    expect(tele.status).toBe(400);
    expect(tele.body.error).toMatch(/Teleconsultation/);
    expect(exists(tele.file)).toBe(false);
  });
});
