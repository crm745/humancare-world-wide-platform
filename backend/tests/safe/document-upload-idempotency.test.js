/* global describe, test, expect, beforeEach, jest */
// Phase 5: idempotent document uploads, malware scanning before anything is stored on the original path, and SHA-256 content identity on both paths. The REAL controller, documents service and review workflow run on a FAKE database that enforces the two new unique indexes
// ((case_id, client_upload_id) and (service_request_id, client_upload_id)), takes the request's row lock like InnoDB, and lets two inserts race. ClamAV (the scan) and Bitrix (the
// medical-report message) are counted, never contacted. No database, no network: run with jest.safe.config.js (DATABASE_URL is a closed port and fetch is blocked).
const fs = require('fs');
const path = require('path');

// The uploads folder (and its quarantine folder) is a temporary one: nothing here touches the real backend/uploads.
jest.mock('../../src/middleware/upload.middleware', () => {
  const nodeFs = require('fs');
  const nodeOs = require('os');
  const nodePath = require('path');
  return { upload: {}, UPLOAD_DIR: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hc-uploads-')) };
});

jest.mock('../../src/db/prisma', () => {
  const state = { requests: [], docs: [], reqDocs: [], events: [], users: [{ id: 7, fullName: 'Asha', email: 'a@example.invalid' }], nextDoc: 1, nextReqDoc: 1, locks: new Map(), delay: true };
  const tick = () => (state.delay ? new Promise((resolve) => setImmediate(resolve)) : Promise.resolve());
  const uniqueError = (target) => Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002', meta: { target } });
  const match = (row, where) => Object.entries(where || {}).every(([k, v]) => (v && typeof v === 'object' && !(v instanceof Date) ? true : row[k] === v));
  const tables = {
    serviceRequest: {
      async findFirst({ where }) {
        const row = state.requests.find((r) => r.id === where.id && r.userId === where.userId);
        if (!row) return null;
        return { ...row, case: row.case ? { ...row.case, stageEvents: [], documents: state.docs.filter((d) => d.caseId === row.case.id) } : null, requestDocuments: state.reqDocs.filter((d) => d.serviceRequestId === row.id) };
      },
      async findUnique({ where }) { const row = state.requests.find((r) => r.id === where.id); return row ? { ...row } : null; },
      async update({ where, data }) { const row = state.requests.find((r) => r.id === where.id); Object.assign(row, data); return { ...row }; },
    },
    document: {
      async findFirst({ where }) { await tick(); const row = state.docs.find((d) => match(d, where)); return row ? { ...row } : null; },
      async count({ where }) { return state.docs.filter((d) => match(d, where)).length; },
      async findMany({ where }) { return state.docs.filter((d) => match(d, where)).map((d) => ({ ...d })); },
      async create({ data }) {
        await tick();
        if (data.clientUploadId && state.docs.some((d) => d.caseId === data.caseId && d.clientUploadId === data.clientUploadId)) throw uniqueError('uq_documents_case_client_upload');
        const row = { id: state.nextDoc++, uploadedAt: new Date('2026-11-20T10:00:00Z'), clientUploadId: null, ...data };
        state.docs.push(row);
        return { ...row };
      },
    },
    requestDocument: {
      async findFirst({ where }) { await tick(); const row = state.reqDocs.find((d) => match(d, where)); return row ? { ...row } : null; },
      async findMany({ where }) { return state.reqDocs.filter((d) => match(d, where)).map((d) => ({ ...d })); },
      async create({ data }) {
        await tick();
        if (data.clientUploadId && state.reqDocs.some((d) => d.serviceRequestId === data.serviceRequestId && d.clientUploadId === data.clientUploadId)) throw uniqueError('uq_request_documents_request_client_upload');
        const row = { id: state.nextReqDoc++, uploadedAt: new Date('2026-11-20T10:00:00Z'), scanStatus: 'pending', reviewStatus: 'pending', replacesId: null, supersededAt: null, clientUploadId: null, ...data };
        state.reqDocs.push(row);
        return { ...row };
      },
      async update({ where, data }) { const row = state.reqDocs.find((d) => d.id === where.id); Object.assign(row, data); return { ...row }; },
    },
    requestEvent: { async create({ data }) { state.events.push(data); return data; } },
    user: { async findUnique({ where }) { return state.users.find((u) => u.id === where.id) || null; } },
  };
  const prisma = { ...tables, __state: state };
  // A transaction takes the request's row lock when it runs the lock query and keeps it until it ends (InnoDB's SELECT ... FOR UPDATE).
  prisma.$transaction = async (callback) => {
    let release = () => {};
    let lockedId = null;
    const tx = {
      ...tables,
      async $queryRaw(_strings, id) {
        lockedId = id;
        while (state.locks.has(id)) await state.locks.get(id);
        state.locks.set(id, new Promise((resolve) => { release = () => { state.locks.delete(id); resolve(); }; }));
        return [{ id }];
      },
    };
    try { return await callback(tx); } finally { if (lockedId !== null) release(); }
  };
  return { prisma };
});

const mockScan = jest.fn();
jest.mock('../../src/modules/request-review/request-review.service', () => {
  const actual = jest.requireActual('../../src/modules/request-review/request-review.service');
  return { ...actual, scanRequestDocument: (...args) => mockScan(...args) };
});
const mockClam = jest.fn();
jest.mock('../../src/integrations/clamav/clamav', () => ({ scanFile: (...args) => mockClam(...args), ping: async () => true, ENGINE: 'clamav', settings: () => ({}) }));
const mockCase = { id: 20, corporateId: 5, bitrixLeadId: 777 };
jest.mock('../../src/modules/cases/cases.service', () => ({ ...jest.requireActual('../../src/modules/cases/cases.service'), getCaseById: async () => ({ ...mockCase }) }));
const mockBitrix = jest.fn(async () => ({}));
jest.mock('../../src/modules/bitrix/bitrix.service', () => ({ sendMedicalReportToBitrix: (...args) => mockBitrix(...args) }));

const { prisma } = require('../../src/db/prisma');
const { uploadRequestDocument } = require('../../src/modules/requests/requests.controller');
const { uploadCaseDocument } = require('../../src/modules/cases/cases.controller');
const { resolveAdminDownload } = require('../../src/modules/request-review/request-review.service');
const { UPLOAD_DIR, } = require('../../src/middleware/upload.middleware');
const { toPatientRequest } = require('../../src/modules/requests/request-response');
const { parseClientUploadId } = require('../../src/modules/requests/client-upload-id');

const state = prisma.__state;
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';
const dir = UPLOAD_DIR; // the (temporary) uploads folder: the original path hashes the stored file from here, as in production
let fileCounter = 0;
const tmpFiles = [];

function makeFile(name = 'report.pdf', body = '%PDF-1.4 test report') {
  fileCounter += 1;
  const filename = `${Date.now()}-${fileCounter}-${name}`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, body);
  tmpFiles.push(full);
  return { path: full, originalname: name, filename, mimetype: 'application/pdf', size: Buffer.byteLength(body) };
}
async function upload({ userId = 7, requestId = 1, file = makeFile(), clientUploadId, extra = {} } = {}) {
  const out = { file };
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  const body = { ...(clientUploadId !== undefined ? { clientUploadId } : {}), ...extra };
  await uploadRequestDocument({ file, user: { id: userId }, params: { id: requestId }, body }, res, (err) => { out.err = err; });
  return out;
}
const exists = (file) => fs.existsSync(file.path);
// A refusal reaches the client either as a direct answer (the original flow) or through next(err) (the review workflow's HTTP errors): both carry a status and a code.
const statusOf = (out) => (out.status !== undefined ? out.status : out.err && out.err.statusCode);
const codeOf = (out) => (out.body && out.body.code) || (out.err && (out.err.publicCode || out.err.code));

beforeEach(() => {
  state.requests.length = 0; state.docs.length = 0; state.reqDocs.length = 0; state.events.length = 0; state.locks.clear();
  state.nextDoc = 1; state.nextReqDoc = 1;
  mockScan.mockReset();
  mockScan.mockImplementation(async (id) => { const row = state.reqDocs.find((d) => d.id === id); row.scanStatus = 'clean'; return { ...row }; });
  mockBitrix.mockClear();
  mockClam.mockReset();
  mockClam.mockImplementation(async () => ({ status: 'clean' }));
  // request 1: the review workflow (no Case yet); request 2: the original flow, a Case and a Bitrix lead; request 3: Mortal Remains; request 4: owned by another patient
  state.requests.push(
    { id: 1, userId: 7, serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', reviewStatus: 'awaiting_documents', case: null, bitrixLeadId: null, submittedAt: null },
    { id: 2, userId: 7, serviceKey: 'ground', serviceType: 'Ground Ambulance', reviewStatus: null, case: { id: 20 }, bitrixLeadId: 555, patientName: 'Asha', patientContact: '+91 98765 43210' },
    { id: 3, userId: 7, serviceKey: 'mortal', serviceType: 'Mortal Remains Transportation', reviewStatus: null, case: { id: 30 }, bitrixLeadId: null },
    { id: 4, userId: 9, serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', reviewStatus: 'awaiting_documents', case: null, bitrixLeadId: null },
  );
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } });

describe('the upload id', () => {
  test('is optional, lower-cased, and refused when it is not a UUID', () => {
    expect(parseClientUploadId(undefined)).toEqual({ present: false });
    expect(parseClientUploadId(null)).toEqual({ present: false });
    expect(parseClientUploadId('')).toEqual({ present: false });
    expect(parseClientUploadId(ID_A.toUpperCase())).toEqual({ present: true, valid: true, id: ID_A });
    for (const bad of ['abc', 'x'.repeat(36), 5, {}, '11111111-1111-4111-8111-11111111111g']) expect(parseClientUploadId(bad)).toEqual({ present: true, valid: false });
  });

  test('a malformed id is a 400, the new file is deleted and nothing is stored or scanned', async () => {
    const out = await upload({ clientUploadId: 'not-a-uuid' });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/UUID/);
    expect(exists(out.file)).toBe(false);
    expect(state.reqDocs).toHaveLength(0);
    expect(mockScan).not.toHaveBeenCalled();
  });
});

describe('review workflow documents (request_documents)', () => {
  test('the first upload creates one document, scans it once, and returns the id', async () => {
    const out = await upload({ clientUploadId: ID_A });
    expect(out.err).toBeUndefined();
    expect(out.status).toBe(201);
    expect(out.body.document).toMatchObject({ id: 1, clientUploadId: ID_A, scanStatus: 'clean' });
    expect(state.reqDocs).toHaveLength(1);
    expect(state.reqDocs[0].clientUploadId).toBe(ID_A);
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(exists(out.file)).toBe(true); // a genuinely new document keeps its file
  });

  test('the same id again returns the ORIGINAL document (200), deletes the new copy, and does nothing else', async () => {
    const first = await upload({ clientUploadId: ID_A });
    const eventsAfterFirst = state.events.length;
    const second = await upload({ clientUploadId: ID_A.toUpperCase(), file: makeFile('report.pdf') });
    expect(second.status).toBe(200);
    expect(second.body.document.id).toBe(first.body.document.id);
    expect(second.body.document.clientUploadId).toBe(ID_A);
    expect(state.reqDocs).toHaveLength(1);
    expect(exists(second.file)).toBe(false);
    expect(exists(first.file)).toBe(true);
    expect(mockScan).toHaveBeenCalledTimes(1); // no second ClamAV scan
    expect(state.events).toHaveLength(eventsAfterFirst); // no second "uploaded" event
    expect(state.requests[0].reviewStatus).toBe('in_review'); // moved once, by the first upload
  });

  test('different ids create different documents, each scanned once', async () => {
    const a = await upload({ clientUploadId: ID_A });
    const b = await upload({ clientUploadId: ID_B });
    expect(a.body.document.id).not.toBe(b.body.document.id);
    expect(state.reqDocs).toHaveLength(2);
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  test('a replay is recognised by the id alone, but is refused if it carries a different file than the original', async () => {
    await upload({ clientUploadId: ID_A, file: makeFile('a.pdf', '%PDF-1.4 first') });
    const different = await upload({ clientUploadId: ID_A, file: makeFile('a.pdf', '%PDF-1.4 SECOND, other content') });
    expect(statusOf(different)).toBe(409);
    expect(codeOf(different)).toBe('client_upload_id_reused');
    expect(exists(different.file)).toBe(false);
    expect(state.reqDocs).toHaveLength(1);
    // the same NAME and SIZE under a NEW id is a different upload: never matched by name or size
    const sameNameNewId = await upload({ clientUploadId: ID_B, file: makeFile('a.pdf', '%PDF-1.4 first') });
    expect(sameNameNewId.status).toBe(201);
    expect(state.reqDocs).toHaveLength(2);
  });

  test('a replacement carrying an id replaces once; its replay replaces nothing more', async () => {
    const original = await upload({ clientUploadId: ID_A });
    const replacement = await upload({ clientUploadId: ID_B, file: makeFile('new.pdf', '%PDF-1.4 new'), extra: { replacesDocumentId: String(original.body.document.id) } });
    expect(replacement.status).toBe(201);
    expect(state.reqDocs.find((d) => d.id === original.body.document.id).supersededAt).toBeInstanceOf(Date);
    const stamp = state.reqDocs.find((d) => d.id === original.body.document.id).supersededAt;
    const eventsBefore = state.events.length;
    const replay = await upload({ clientUploadId: ID_B, file: makeFile('new.pdf', '%PDF-1.4 new'), extra: { replacesDocumentId: String(original.body.document.id) } });
    expect(replay.status).toBe(200); // not "the document to replace was already replaced" (a 400): the original answer
    expect(replay.body.document.id).toBe(replacement.body.document.id);
    expect(state.reqDocs).toHaveLength(2);
    expect(state.reqDocs.find((d) => d.id === original.body.document.id).supersededAt).toBe(stamp);
    expect(state.events).toHaveLength(eventsBefore);
  });

  test('a replay does not count against the 30-document limit and is answered even after the request was approved', async () => {
    const first = await upload({ clientUploadId: ID_A });
    for (let i = 0; i < 29; i += 1) state.reqDocs.push({ id: 100 + i, serviceRequestId: 1, clientUploadId: null, sizeBytes: 1, supersededAt: null });
    state.requests[0].reviewStatus = 'approved';
    const replay = await upload({ clientUploadId: ID_A });
    expect(replay.status).toBe(200);
    expect(replay.body.document.id).toBe(first.body.document.id);
    const fresh = await upload({ clientUploadId: ID_C });
    expect(statusOf(fresh)).toBe(409); // a NEW upload on an approved request is still refused, as before
    expect(codeOf(fresh)).toBe('request_approved');
  });

  test('five concurrent copies of the same upload create exactly one document, one scan, and delete four files', async () => {
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => upload({ clientUploadId: ID_A })));
    expect(outs.every((o) => o.err === undefined)).toBe(true);
    expect(state.reqDocs).toHaveLength(1);
    expect(new Set(outs.map((o) => o.body.document.id)).size).toBe(1);
    expect(outs.filter((o) => o.status === 201)).toHaveLength(1);
    expect(outs.filter((o) => o.status === 200)).toHaveLength(4);
    expect(outs.filter((o) => exists(o.file))).toHaveLength(1);
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  test('the unique index is the final protection when the lock is not enough (the insert loses the race)', async () => {
    // Plant the winner AFTER this upload's lookup and BEFORE its insert, as another server process could.
    const realFindFirst = prisma.requestDocument.findFirst;
    let planted = false;
    prisma.requestDocument.findFirst = async (args) => {
      const found = await realFindFirst(args);
      if (!planted && args.where && args.where.clientUploadId) {
        planted = true;
        state.reqDocs.push({ id: 900, serviceRequestId: 1, clientUploadId: ID_A, originalName: 'report.pdf', sizeBytes: 19, sha256: null, scanStatus: 'clean', reviewStatus: 'pending', replacesId: null, uploadedAt: new Date() });
      }
      return found;
    };
    try {
      const out = await upload({ clientUploadId: ID_A });
      expect(out.status).toBe(200);
      expect(out.body.document.id).toBe(900);
      expect(exists(out.file)).toBe(false);
      expect(mockScan).not.toHaveBeenCalled();
    } finally {
      prisma.requestDocument.findFirst = realFindFirst;
    }
  });

  test('another patient can neither use nor see the document: their request lookup fails first and their file is deleted', async () => {
    await upload({ clientUploadId: ID_A });
    const stranger = await upload({ userId: 9, requestId: 1, clientUploadId: ID_A });
    expect(stranger.err).toBeDefined();
    expect(stranger.err.statusCode).toBe(404);
    expect(exists(stranger.file)).toBe(false);
    expect(state.reqDocs).toHaveLength(1);
    // the same id on THEIR OWN request is a separate upload
    const own = await upload({ userId: 9, requestId: 4, clientUploadId: ID_A });
    expect(own.status).toBe(201);
    expect(state.reqDocs).toHaveLength(2);
    expect(state.reqDocs.map((d) => d.serviceRequestId).sort()).toEqual([1, 4]);
  });

  test('an older app that sends no id keeps working: every upload is its own document', async () => {
    const a = await upload();
    const b = await upload();
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(state.reqDocs).toHaveLength(2);
    expect(state.reqDocs.every((d) => d.clientUploadId === undefined || d.clientUploadId === null)).toBe(true);
    expect(a.body.document).not.toHaveProperty('clientUploadId');
  });

  test('malware scanning stays fail-closed: a scanner that is down leaves the new document unusable, and a replay does not retry the scan', async () => {
    mockScan.mockRejectedValue(new Error('ClamAV unreachable'));
    const out = await upload({ clientUploadId: ID_A });
    expect(out.status).toBe(201); // saved...
    expect(out.body.document.scanStatus).toBe('pending'); // ...but never "clean": the worker's sweep scans it later
    expect(state.reqDocs[0].scanStatus).not.toBe('clean');
    const replay = await upload({ clientUploadId: ID_A });
    expect(replay.status).toBe(200);
    expect(replay.body.document.scanStatus).toBe('pending');
    expect(mockScan).toHaveBeenCalledTimes(1);
  });
});

describe('original-flow documents (documents, attached to a Case)', () => {
  test('the first upload saves one document and sends the Bitrix medical report once', async () => {
    const out = await upload({ requestId: 2, clientUploadId: ID_A });
    expect(out.status).toBe(201);
    expect(out.body.document).toMatchObject({ id: 1, type: 'Medical Report', clientUploadId: ID_A });
    expect(out.body.document).not.toHaveProperty('fileUrl');
    expect(state.docs).toHaveLength(1);
    expect(mockBitrix).toHaveBeenCalledTimes(1);
    expect(mockClam).toHaveBeenCalledTimes(1); // scanned once, before it was stored (documents/legacy-scan.js)
    expect(mockScan).not.toHaveBeenCalled(); // the review workflow's own scan is not involved
  });

  test('the same id again returns the original (200), deletes the copy, and sends nothing to Bitrix', async () => {
    const first = await upload({ requestId: 2, clientUploadId: ID_A });
    const second = await upload({ requestId: 2, clientUploadId: ID_A, file: makeFile('report.pdf') });
    expect(second.status).toBe(200);
    expect(second.body.document.id).toBe(first.body.document.id);
    expect(state.docs).toHaveLength(1);
    expect(exists(second.file)).toBe(false);
    expect(mockBitrix).toHaveBeenCalledTimes(1);
    expect(mockClam).toHaveBeenCalledTimes(1); // the repeat was not scanned again
  });

  test('a replay with a different file is refused, and a new id is a new document', async () => {
    await upload({ requestId: 2, clientUploadId: ID_A, file: makeFile('a.pdf', '%PDF-1.4 first') });
    const different = await upload({ requestId: 2, clientUploadId: ID_A, file: makeFile('b.pdf', '%PDF-1.4 second') });
    expect(statusOf(different)).toBe(409);
    expect(codeOf(different)).toBe('client_upload_id_reused');
    expect(exists(different.file)).toBe(false);
    const another = await upload({ requestId: 2, clientUploadId: ID_B });
    expect(another.status).toBe(201);
    expect(state.docs).toHaveLength(2);
    expect(mockBitrix).toHaveBeenCalledTimes(2);
  });

  test('five concurrent copies create one document and one Bitrix message (the unique index decides the race)', async () => {
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => upload({ requestId: 2, clientUploadId: ID_A })));
    expect(outs.every((o) => o.err === undefined)).toBe(true);
    expect(state.docs).toHaveLength(1);
    expect(new Set(outs.map((o) => o.body.document.id)).size).toBe(1);
    expect(outs.filter((o) => o.status === 201)).toHaveLength(1);
    expect(outs.filter((o) => o.status === 200)).toHaveLength(4);
    expect(outs.filter((o) => exists(o.file))).toHaveLength(1);
    expect(mockBitrix).toHaveBeenCalledTimes(1);
    expect(mockClam).toHaveBeenCalledTimes(1); // one scan for five copies: the others waited for the first and were answered from its document
  });

  test('another patient cannot reach the document or the case; an older app without an id still gets one document per upload', async () => {
    await upload({ requestId: 2, clientUploadId: ID_A });
    const stranger = await upload({ userId: 9, requestId: 2, clientUploadId: ID_A });
    expect(stranger.err.statusCode).toBe(404);
    expect(exists(stranger.file)).toBe(false);
    expect(state.docs).toHaveLength(1);
    await upload({ requestId: 2 });
    await upload({ requestId: 2 });
    expect(state.docs).toHaveLength(3);
  });

  test('Mortal Remains: the 10-document limit still holds for new uploads, and a replay of an accepted one is never counted against it', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`);
    for (const id of ids) expect((await upload({ requestId: 3, clientUploadId: id })).status).toBe(201);
    expect(state.docs).toHaveLength(10);
    expect(state.docs.every((d) => d.type === 'Supporting Document')).toBe(true);
    expect(mockBitrix).not.toHaveBeenCalled(); // Mortal Remains documents are never sent to Bitrix
    const eleventh = await upload({ requestId: 3, clientUploadId: ID_C });
    expect(eleventh.status).toBe(400);
    expect(eleventh.body.error).toMatch(/at most 10/);
    expect(exists(eleventh.file)).toBe(false);
    const replay = await upload({ requestId: 3, clientUploadId: ids[4] });
    expect(replay.status).toBe(200); // the limit does not apply to a repeat
    expect(state.docs).toHaveLength(10);
  });

  test('Mortal Remains still checks the file content for a new upload', async () => {
    const out = await upload({ requestId: 3, clientUploadId: ID_A, file: makeFile('fake.pdf', 'this is not a pdf at all') });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/does not match/);
    expect(state.docs).toHaveLength(0);
  });
});

describe('what the app can read back, and the migration', () => {
  test('a request carries each document\'s upload id and says the server supports ids; the stored path never leaves', () => {
    const response = toPatientRequest({
      id: 1, case: { id: 20, documents: [{ id: 5, type: 'Medical Report', name: 'a.pdf', fileSizeBytes: 3, uploadedAt: 't', clientUploadId: ID_A, fileUrl: '/uploads/secret' }] },
      requestDocuments: [{ id: 6, originalName: 'b.pdf', sizeBytes: 3, uploadedAt: 't', clientUploadId: ID_B, storageKey: 'secret', sha256: 'x' }],
    });
    expect(response.case.documents[0]).toEqual({ id: 5, type: 'Medical Report', name: 'a.pdf', fileSizeBytes: 3, uploadedAt: 't', clientUploadId: ID_A });
    expect(response.requestDocuments[0]).toEqual({ id: 6, originalName: 'b.pdf', sizeBytes: 3, uploadedAt: 't', clientUploadId: ID_B });
    expect(response.clientUploadIdSupported).toBe(true);
    expect(JSON.stringify(response)).not.toMatch(/secret|sha256|storageKey|fileUrl/);
  });

  test('the migration keeps the upload-id column and unique index on each table (the scan columns it also adds are checked in legacy-document-scan-protection.test.js), and the rollback removes them', () => {
    const base = path.join(__dirname, '../../prisma/migrations/20261120100000_document_client_upload_id');
    const up = fs.readFileSync(path.join(base, 'migration.sql'), 'utf8');
    const down = fs.readFileSync(path.join(base, 'down.sql'), 'utf8');
    const code = (sql) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code(up)).toContain('ALTER TABLE `documents`');
    expect(code(up)).toContain('ADD COLUMN `client_upload_id` VARCHAR(36) NULL');
    expect(code(up)).toContain('ADD UNIQUE INDEX `uq_documents_case_client_upload` (`case_id`, `client_upload_id`)');
    expect(code(up)).toContain('ALTER TABLE `request_documents`');
    expect(code(up)).toContain('ADD UNIQUE INDEX `uq_request_documents_request_client_upload` (`service_request_id`, `client_upload_id`)');
    expect(code(up)).not.toMatch(/DROP|DELETE|UPDATE|TRUNCATE|MODIFY|RENAME/i);
    expect(code(down)).toContain('DROP INDEX `uq_documents_case_client_upload`');
    expect(code(down)).toContain('DROP INDEX `uq_request_documents_request_client_upload`');
    expect(code(down).match(/DROP COLUMN `client_upload_id`/g)).toHaveLength(2);
    expect(code(up)).not.toMatch(/NOT NULL(?! DEFAULT 0)/); // the only NOT NULL column is scan_attempts, with its default
    const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    expect(schema).toContain('@@unique([caseId, clientUploadId], map: "uq_documents_case_client_upload")');
    expect(schema).toContain('@@unique([serviceRequestId, clientUploadId], map: "uq_request_documents_request_client_upload")');
  });
});

// ---- Phase 5 corrections -------------------------------------------------------------------------------------------------------------------------------------------------------------
const quarantined = (file) => fs.existsSync(path.join(UPLOAD_DIR, 'quarantine', path.basename(file.path)));

describe('original-flow documents are scanned BEFORE they are stored (fail closed)', () => {
  test('the scan happens before any row exists and before anything is sent to Bitrix; a clean verdict then stores the document', async () => {
    const seen = {};
    mockClam.mockImplementation(async () => { seen.docsAtScan = state.docs.length; seen.bitrixAtScan = mockBitrix.mock.calls.length; return { status: 'clean' }; });
    const out = await upload({ requestId: 2, clientUploadId: ID_A });
    expect(out.status).toBe(201);
    expect(seen).toEqual({ docsAtScan: 0, bitrixAtScan: 0 });
    expect(state.docs).toHaveLength(1);
    expect(mockBitrix).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['the scanner is down', async () => ({ status: 'error', detail: 'cannot reach the scanner (ECONNREFUSED)' })],
    ['the scan times out', async () => ({ status: 'error', detail: 'scan timed out' })],
    ['the scanner throws', async () => { throw new Error('socket hang up'); }],
    ['the scanner gives an unexpected answer', async () => ({ status: 'unknown' })],
    ['the scanner gives no verdict at all', async () => undefined],
  ])('%s: 503, nothing is stored or sent, the file is deleted (fail closed), and the same upload works once the scanner is back', async (_why, verdict) => {
    mockClam.mockImplementationOnce(verdict);
    const refused = await upload({ requestId: 2, clientUploadId: ID_A });
    expect(statusOf(refused)).toBe(503);
    expect(codeOf(refused)).toBe('scan_unavailable');
    expect(state.docs).toHaveLength(0);
    expect(mockBitrix).not.toHaveBeenCalled();
    expect(exists(refused.file)).toBe(false);
    const again = await upload({ requestId: 2, clientUploadId: ID_A }); // the app's retry carries the SAME id: nothing was stored, so it is a normal first upload
    expect(again.status).toBe(201);
    expect(state.docs).toHaveLength(1);
    expect(mockBitrix).toHaveBeenCalledTimes(1);
  });

  test('a new row is stored WITH its clean scan record (digest of the stored file, engine, time); a repeat changes nothing and a refused upload stores no row at all', async () => {
    const body = '%PDF-1.4 record me';
    const out = await upload({ requestId: 2, clientUploadId: ID_A, file: makeFile('rec.pdf', body) });
    expect(out.status).toBe(201);
    expect(state.docs).toHaveLength(1);
    expect(state.docs[0]).toMatchObject({ scanStatus: 'clean', scanEngine: 'clamav', sha256: require('crypto').createHash('sha256').update(body).digest('hex') });
    expect(state.docs[0].scannedAt).toBeInstanceOf(Date);
    const before = JSON.stringify(state.docs);
    await upload({ requestId: 2, clientUploadId: ID_A, file: makeFile('rec.pdf', body) });
    expect(JSON.stringify(state.docs)).toBe(before);
    mockClam.mockImplementationOnce(async () => ({ status: 'error' }));
    await upload({ requestId: 2, clientUploadId: ID_B });
    expect(state.docs).toHaveLength(1); // the refused upload left no row, so no row without a clean record
    expect(state.docs.every((d) => d.scanStatus === 'clean')).toBe(true);
  });

  test('an infected file is blocked (422), quarantined, never stored and never sent to Bitrix', async () => {
    mockClam.mockImplementationOnce(async () => ({ status: 'infected', signature: 'Eicar-Test-Signature' }));
    const out = await upload({ requestId: 2, clientUploadId: ID_A });
    expect(statusOf(out)).toBe(422);
    expect(codeOf(out)).toBe('file_infected');
    expect(JSON.stringify(out.body || out.err.message)).not.toMatch(/Eicar/); // the signature is not shown to the patient
    expect(state.docs).toHaveLength(0);
    expect(mockBitrix).not.toHaveBeenCalled();
    expect(exists(out.file)).toBe(false);
    expect(quarantined(out.file)).toBe(true);
  });

  test('"clean" must describe the bytes that are kept: a file that changes while it is scanned is refused', async () => {
    mockClam.mockImplementationOnce(async (filePath) => { fs.appendFileSync(filePath, 'tampered'); return { status: 'clean' }; });
    const out = await upload({ requestId: 2, clientUploadId: ID_A });
    expect(codeOf(out)).toBe('scan_unavailable');
    expect(state.docs).toHaveLength(0);
    expect(exists(out.file)).toBe(false);
  });

  test('without an upload id (an older app) the scan is exactly as strict', async () => {
    mockClam.mockImplementationOnce(async () => ({ status: 'error' }));
    const out = await upload({ requestId: 2 });
    expect(codeOf(out)).toBe('scan_unavailable');
    expect(state.docs).toHaveLength(0);
  });

  test('Mortal Remains: a refused upload is never scanned, a new one is scanned once, and a repeat is not scanned', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`);
    for (const id of ids) await upload({ requestId: 3, clientUploadId: id });
    expect(mockClam).toHaveBeenCalledTimes(10);
    await upload({ requestId: 3, clientUploadId: ID_C }); // the eleventh: refused by the limit
    await upload({ requestId: 3, clientUploadId: ids[2] }); // a repeat
    expect(mockClam).toHaveBeenCalledTimes(10);
  });

  test('the corporate case upload is the same original path: scanned before it is stored; infected, scanner down and no verdict are refused', async () => {
    const asCorporate = async () => {
      const file = makeFile('c.pdf');
      const out = { file };
      const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
      await uploadCaseDocument({ file, user: { id: 50, corporateId: 5 }, params: { id: 20 }, body: { type: 'Medical Report' } }, res, (err) => { out.err = err; });
      return out;
    };
    const seen = {};
    mockClam.mockImplementationOnce(async () => { seen.docs = state.docs.length; return { status: 'clean' }; });
    expect((await asCorporate()).status).toBe(201);
    expect(seen.docs).toBe(0);
    expect(state.docs).toHaveLength(1);
    mockClam.mockImplementationOnce(async () => ({ status: 'error' }));
    const down = await asCorporate();
    expect(codeOf(down)).toBe('scan_unavailable');
    mockClam.mockImplementationOnce(async () => ({ status: 'infected', signature: 'X' }));
    const infected = await asCorporate();
    expect(codeOf(infected)).toBe('file_infected');
    expect(state.docs).toHaveLength(1);
    expect(mockBitrix).toHaveBeenCalledTimes(1);
  });

  test('there is no second scanning system: the original path calls the same ClamAV client as the review worker, and the unscanned-document route is closed', () => {
    const legacy = fs.readFileSync(path.join(__dirname, '../../src/modules/documents/legacy-scan.js'), 'utf8');
    expect(legacy).toContain("require('../../integrations/clamav/clamav')");
    expect(legacy).not.toMatch(/net\.createConnection|zINSTREAM/); // it never talks to clamd itself
    expect(fs.readFileSync(path.join(__dirname, '../../src/modules/requests/requests.controller.js'), 'utf8')).toMatch(/const scan = await scanBeforeStore\(req\.file, \{ expectedSha256: sha256 \}\);[^\n]*\n\s+let document;/);
    expect(fs.readFileSync(path.join(__dirname, '../../src/modules/cases/cases.controller.js'), 'utf8')).toMatch(/const scan = await scanBeforeStore\(req\.file\);\s+const document = await addDocumentToCase/);
  });
});

describe('SHA-256 content identity on both paths', () => {
  test('review path: the same id with identical content (even under another file name) returns the original; the same name and size with different content is a 409', async () => {
    const first = await upload({ clientUploadId: ID_A, file: makeFile('a.pdf', '%PDF-1.4 AAAAAAAA') });
    const renamed = await upload({ clientUploadId: ID_A, file: makeFile('renamed-copy.pdf', '%PDF-1.4 AAAAAAAA') });
    expect(renamed.status).toBe(200);
    expect(renamed.body.document.id).toBe(first.body.document.id);
    const sameNameAndSize = await upload({ clientUploadId: ID_A, file: makeFile('a.pdf', '%PDF-1.4 BBBBBBBB') }); // same name, same length, different bytes
    expect(statusOf(sameNameAndSize)).toBe(409);
    expect(codeOf(sameNameAndSize)).toBe('client_upload_id_reused');
    expect(exists(sameNameAndSize.file)).toBe(false);
    expect(state.reqDocs).toHaveLength(1);
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  test('original path: the same id with identical content (another file name) returns the original; the same name and size with different content is a 409', async () => {
    const first = await upload({ requestId: 2, clientUploadId: ID_A, file: makeFile('a.pdf', '%PDF-1.4 AAAAAAAA') });
    const renamed = await upload({ requestId: 2, clientUploadId: ID_A, file: makeFile('renamed-copy.pdf', '%PDF-1.4 AAAAAAAA') });
    expect(renamed.status).toBe(200);
    expect(renamed.body.document.id).toBe(first.body.document.id);
    const sameNameAndSize = await upload({ requestId: 2, clientUploadId: ID_A, file: makeFile('a.pdf', '%PDF-1.4 BBBBBBBB') });
    expect(sameNameAndSize.status).toBe(409);
    expect(sameNameAndSize.body.code).toBe('client_upload_id_reused');
    expect(exists(sameNameAndSize.file)).toBe(false);
    expect(state.docs).toHaveLength(1);
    expect(mockClam).toHaveBeenCalledTimes(1); // neither repeat was scanned
    expect(mockBitrix).toHaveBeenCalledTimes(1);
  });

  test('a repeat is only answered when the original\'s content can be PROVED the same: an unreadable stored file, or a review row with no digest, is refused', async () => {
    const first = await upload({ requestId: 2, clientUploadId: ID_A });
    fs.rmSync(first.file.path, { force: true }); // the stored original can no longer be read
    const unverifiable = await upload({ requestId: 2, clientUploadId: ID_A });
    expect(unverifiable.status).toBe(409);
    await upload({ clientUploadId: ID_B });
    state.reqDocs[0].sha256 = null;
    const noDigest = await upload({ clientUploadId: ID_B });
    expect(statusOf(noDigest)).toBe(409);
    expect(state.reqDocs).toHaveLength(1);
  });

  test('older apps (no id) are unaffected by any of this: no digest comparison, every upload is its own document, each still scanned', async () => {
    await upload({ requestId: 2, file: makeFile('a.pdf', '%PDF-1.4 SAME') });
    await upload({ requestId: 2, file: makeFile('a.pdf', '%PDF-1.4 SAME') });
    expect(state.docs).toHaveLength(2);
    expect(mockClam).toHaveBeenCalledTimes(2);
  });
});

describe('administrators cannot open a document until it was scanned clean', () => {
  const adminOpens = (id, requestId = 1) => resolveAdminDownload({ requestId, documentId: id, adminId: 3 }).then(() => ({ opened: true }), (err) => ({ opened: false, status: err.statusCode, code: err.publicCode }));

  test('a document whose scan could not run (scanner down) is "pending": the admin gate refuses it, and a repeat does not scan it', async () => {
    mockScan.mockRejectedValue(new Error('ClamAV unreachable'));
    const out = await upload({ clientUploadId: ID_A });
    expect(out.body.document.scanStatus).toBe('pending');
    const events = state.events.length;
    expect(await adminOpens(out.body.document.id)).toEqual({ opened: false, status: 409, code: 'document_not_clean' });
    expect(state.events).toHaveLength(events); // no "downloaded" event: nothing was served
  });

  test.each(['pending', 'error', 'infected', 'failed'])('a request document whose scan status is "%s" cannot be opened by an admin', async (status) => {
    await upload({ clientUploadId: ID_A });
    state.reqDocs[0].scanStatus = status;
    expect(await adminOpens(state.reqDocs[0].id)).toEqual({ opened: false, status: 409, code: 'document_not_clean' });
  });

  test('an infected review-workflow document is never marked clean, and the replay of its upload does not rescan it', async () => {
    mockScan.mockImplementation(async (id) => { const row = state.reqDocs.find((d) => d.id === id); row.scanStatus = 'infected'; return { ...row }; });
    const out = await upload({ clientUploadId: ID_A });
    expect(out.body.document.scanStatus).toBe('infected');
    const replay = await upload({ clientUploadId: ID_A });
    expect(replay.status).toBe(200);
    expect(replay.body.document.scanStatus).toBe('infected');
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(await adminOpens(out.body.document.id)).toMatchObject({ opened: false, code: 'document_not_clean' });
  });

  test('the administrators\' routes reach only request_documents rows (which carry a scan status), never the unscanned original table', () => {
    const adminDir = path.join(__dirname, '../../src/modules/admin');
    for (const name of fs.readdirSync(adminDir).filter((f) => f.endsWith('.js'))) {
      expect(fs.readFileSync(path.join(adminDir, name), 'utf8')).not.toMatch(/prisma\.document\.|documents\.service|case\.documents/);
    }
    const routes = fs.readFileSync(path.join(adminDir, 'admin.routes.js'), 'utf8');
    expect(routes).toContain("adminRouter.get('/requests/:id/documents/:docId/file', downloadDocument);");
    expect(routes).toMatch(/downloadDocument[\s\S]*request-review\.controller/);
  });
});
