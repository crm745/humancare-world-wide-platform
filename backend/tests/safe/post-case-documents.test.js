/* global describe, test, expect, jest, beforeEach */
// Post-Case documents through the existing DocumentRequest workflow: an Admin asks the patient for more documents AFTER the approval,
// the patient uploads for that request, an Admin reviews, an approved document joins the Case. Sharing the document with Bitrix stays a
// separate, explicit Admin authorization. No database: Prisma is mocked and its $transaction runs against an in-memory world.
jest.mock('../../src/db/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
// The upload checks and the move into storage are covered by storage-ingest.test.js; here the stored object is a given.
jest.mock('../../src/storage/ingest', () => ({
  ingestUpload: jest.fn(async () => ({ key: `request-documents/2026/11/${'a'.repeat(32)}.pdf`, sha256: 'd'.repeat(64), size: 123, contentType: 'application/pdf' })),
  discardStored: jest.fn(async () => undefined),
}));
jest.mock('../../src/modules/request-review/request-review.files', () => ({
  ...jest.requireActual('../../src/modules/request-review/request-review.files'),
  hashFile: jest.fn().mockResolvedValue('d'.repeat(64)),
  fileProblem: jest.fn().mockResolvedValue(null),
}));

const { prisma } = require('../../src/db/prisma');
const files = require('../../src/modules/request-review/request-review.files');
const review = require('../../src/modules/request-review/request-review.service');

let world;
let writes;
let outcome;

const upload = { path: 'does-not-exist.tmp', originalname: 'extra.pdf', filename: '1-extra.pdf', size: 123, mimetype: 'application/pdf' };

function setUp({ request, caseRecord, documentRequests, documents, failOn = null } = {}) {
  world = {
    request: request === undefined ? { id: 61, userId: 7, referenceNumber: 'REQ-1061', reviewStatus: 'approved', serviceKey: 'privatecharter', submittedAt: new Date() } : request,
    caseRecord: caseRecord === undefined ? { id: 7, referenceNumber: 'CASE-3207' } : caseRecord,
    documentRequests: documentRequests === undefined ? [{ id: 5, caseId: 7, status: 'open', description: 'Latest ECG' }] : documentRequests,
    documents: documents === undefined ? [] : documents,
    created: [], copied: [], events: [], audit: [], nextDocumentId: 100,
  };
  writes = [];
  outcome = null;
  const w = (name, fn) => jest.fn(async (arg) => { writes.push(name); if (failOn === name) throw new Error('simulated write failure'); return fn(arg); });
  const tx = {
    $queryRaw: jest.fn(async () => []),
    serviceRequest: { findUnique: jest.fn(async () => (world.request ? { ...world.request } : null)), update: w('serviceRequest.update', () => ({})) },
    case: { findUnique: jest.fn(async () => (world.caseRecord ? { ...world.caseRecord } : null)) },
    documentRequest: {
      findFirst: jest.fn(async ({ where }) => world.documentRequests.find((d) => d.id === where.id && d.caseId === where.caseId && d.status === where.status) || null),
      create: w('documentRequest.create', ({ data }) => { const row = { id: 9, ...data }; world.documentRequests.push(row); return row; }),
      update: w('documentRequest.update', ({ where, data }) => { Object.assign(world.documentRequests.find((d) => d.id === where.id), data); return {}; }),
    },
    requestDocument: {
      findMany: jest.fn(async () => world.documents.map((d) => ({ id: d.id, supersededAt: d.supersededAt || null }))),
      findFirst: jest.fn(async ({ where }) => (world.documents.find((d) => d.id === where.id && d.serviceRequestId === where.serviceRequestId) ? { ...world.documents.find((d) => d.id === where.id) } : null)),
      create: w('requestDocument.create', ({ data }) => { const row = { id: world.nextDocumentId, scanStatus: 'pending', reviewStatus: 'pending', ...data }; world.nextDocumentId += 1; world.created.push(row); world.documents.push(row); return row; }),
      update: w('requestDocument.update', ({ where, data }) => { Object.assign(world.documents.find((d) => d.id === where.id), data); return { ...world.documents.find((d) => d.id === where.id) }; }),
      count: jest.fn(async ({ where }) => world.documents.filter((d) => d.documentRequestId === where.documentRequestId && !d.supersededAt && d.id !== where.id.not && d.reviewStatus !== 'approved').length),
    },
    document: { create: w('document.create', ({ data }) => { world.copied.push(data); return { id: 200 }; }) },
    requestEvent: { create: w('requestEvent.create', ({ data }) => { world.events.push(data); return data; }) },
    auditLog: { create: w('auditLog.create', ({ data }) => { world.audit.push(data); return data; }) },
    bitrixDealDocument: { create: w('bitrixDealDocument.create', () => ({})) },
    integrationOutbox: { create: w('integrationOutbox.create', () => ({})) },
  };
  prisma.$transaction.mockImplementation(async (callback) => {
    const snapshot = JSON.parse(JSON.stringify({ documentRequests: world.documentRequests, documents: world.documents, created: world.created, copied: world.copied, events: world.events, audit: world.audit }));
    const count = writes.length;
    try { const result = await callback(tx); outcome = 'committed'; return result; } catch (err) { outcome = 'rolled back'; Object.assign(world, snapshot); writes.length = count; throw err; }
  });
  return tx;
}

const failure = (promise) => promise.then(() => null, (err) => err);
beforeEach(() => { jest.clearAllMocks(); files.fileProblem.mockResolvedValue(null); });

// ---- the Admin opens a document request ---------------------------------------------------------------------------------------------------
describe('an Admin asks for more documents after the approval', () => {
  const open = (over = {}) => review.openDocumentRequest({ requestId: 61, adminId: 3, description: 'Please send the latest ECG', reason: 'The flight crew needs it', ...over });

  test('creates one open document request on the Case, with its request event and audit entry, in one transaction', async () => {
    setUp({ documentRequests: [] });
    const result = await open();
    expect(outcome).toBe('committed');
    expect(result.documentRequest).toMatchObject({ caseId: 7, description: 'Please send the latest ECG', reason: 'The flight crew needs it', status: 'open', requestedByType: 'admin', requestedById: '3' });
    expect(writes).toEqual(['documentRequest.create', 'requestEvent.create', 'auditLog.create']);
    expect(world.events[0]).toMatchObject({ action: 'document_request_opened', actorType: 'admin', actorId: 3 });
    expect(world.audit[0]).toMatchObject({ action: 'document_request.opened', entityType: 'document_request', caseId: 7 });
    expect(JSON.stringify(world.audit[0])).not.toContain('ECG'); // the text stays on the request, never in the audit trail
  });

  test.each([
    ['a request that is not approved', { request: { id: 61, reviewStatus: 'in_review' } }, 409, 'request_not_approved'],
    ['a request outside the workflow', { request: { id: 61, reviewStatus: null } }, 404, undefined],
    ['a request with no Case', { caseRecord: null }, 409, 'case_missing'],
  ])('refuses %s', async (_name, setup, status, code) => {
    setUp(setup);
    const error = await failure(open());
    expect(error.statusCode).toBe(status);
    if (code) expect(error.publicCode).toBe(code);
    expect(writes).toEqual([]);
  });

  test.each([[undefined], [''], ['ab'], [7], ['x'.repeat(1001)]])('a description of %p is refused before any work', async (description) => {
    setUp();
    expect(await failure(open({ description }))).toMatchObject({ statusCode: 400, publicCode: 'description_required' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('an optional reason is trimmed and kept, a blank one is stored as nothing', async () => {
    setUp({ documentRequests: [] });
    await open({ reason: '   ' });
    expect(world.documentRequests[0].reason).toBeNull();
  });

  test.each(['documentRequest.create', 'requestEvent.create', 'auditLog.create'])('a failure of %s rolls everything back', async (name) => {
    setUp({ documentRequests: [], failOn: name });
    await expect(open()).rejects.toThrow('simulated write failure');
    expect(outcome).toBe('rolled back');
    expect(world.documentRequests).toEqual([]);
  });
});

// ---- the patient uploads ---------------------------------------------------------------------------------------------------------------------
describe('the patient uploads for an open document request', () => {
  const addDocument = (over = {}) => review.addPatientDocument({ userId: 7, requestId: 61, file: { ...upload }, documentRequestId: 5, ...over });

  test('after the approval a document is accepted ONLY for an open document request of the Case, and is linked to it', async () => {
    setUp();
    const document = await addDocument();
    expect(document).toMatchObject({ serviceRequestId: 61, originalName: 'extra.pdf', documentRequestId: 5, uploadedByUserId: 7 });
    expect(world.created).toHaveLength(1);
    expect(writes).toEqual(['requestDocument.create', 'requestEvent.create']);
    expect(world.events[0].action).toBe('document_uploaded');
    expect(writes).not.toContain('serviceRequest.update'); // the approved request stays approved
  });

  test('without a document request id an approved request still refuses uploads, exactly as before', async () => {
    setUp();
    expect(await failure(addDocument({ documentRequestId: undefined }))).toMatchObject({ statusCode: 409, publicCode: 'request_approved' });
    expect(await failure(addDocument({ documentRequestId: '' }))).toMatchObject({ publicCode: 'request_approved' });
    expect(world.created).toEqual([]);
  });

  test.each([
    ['one that is fulfilled', [{ id: 5, caseId: 7, status: 'fulfilled' }]],
    ['one that is cancelled', [{ id: 5, caseId: 7, status: 'cancelled' }]],
    ['one of another Case', [{ id: 5, caseId: 99, status: 'open' }]],
    ['one that does not exist', []],
  ])('refuses %s', async (_name, documentRequests) => {
    setUp({ documentRequests });
    expect(await failure(addDocument())).toMatchObject({ statusCode: 409, publicCode: 'document_request_not_open' });
    expect(world.created).toEqual([]);
  });

  test('a document request id is refused before the approval (nothing to ask yet)', async () => {
    setUp({ request: { id: 61, userId: 7, reviewStatus: 'in_review', submittedAt: new Date() } });
    expect(await failure(addDocument())).toMatchObject({ statusCode: 400, publicCode: 'document_request_not_applicable' });
  });

  test('the request of another patient is "not found"', async () => {
    setUp();
    expect(await failure(addDocument({ userId: 99 }))).toMatchObject({ statusCode: 404 });
    expect(world.created).toEqual([]);
  });

  test('the per-request document limit still applies', async () => {
    setUp({ documents: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, serviceRequestId: 61 })) });
    expect(await failure(addDocument())).toMatchObject({ statusCode: 400, publicCode: 'too_many_documents' });
  });

  test('the new document starts unscanned and unreviewed: it must pass the same scan and review as any other', async () => {
    setUp();
    await addDocument();
    expect(world.created[0]).toMatchObject({ scanStatus: 'pending', reviewStatus: 'pending' });
  });
});

// ---- the Admin reviews it ---------------------------------------------------------------------------------------------------------------------
describe('the Admin reviews a post-Case document', () => {
  const doc = (over = {}) => ({ id: 31, serviceRequestId: 61, documentRequestId: 5, originalName: 'extra.pdf', storageKey: 'k.pdf', sizeBytes: 123, scanStatus: 'clean', reviewStatus: 'pending', supersededAt: null, ...over });
  const decide = (decision, over = {}) => review.reviewDocument({ requestId: 61, documentId: 31, adminId: 3, decision, reason: decision === 'rejected' ? 'Not readable' : undefined, ...over });

  test('approving joins the document to the Case, marks the document request fulfilled, and does NOT share it with Bitrix', async () => {
    setUp({ documents: [doc()] });
    await decide('approved');
    expect(world.copied).toEqual([{ caseId: 7, type: 'Medical Report', name: 'extra.pdf', fileUrl: '/uploads/k.pdf', fileSizeBytes: 123 }]);
    expect(world.documents[0]).toMatchObject({ reviewStatus: 'approved', caseDocumentId: 200 });
    expect(world.documentRequests[0]).toMatchObject({ status: 'fulfilled', resolvedByType: 'admin', resolvedById: '3' });
    expect(world.events.map((e) => e.action)).toEqual(['document_approved', 'document_request_fulfilled']);
    expect(writes).not.toContain('bitrixDealDocument.create'); // review never authorizes sharing
    expect(writes).not.toContain('integrationOutbox.create');
    expect(writes).not.toContain('serviceRequest.update');
  });

  test('the document request stays open while other documents of it are still waiting for a review', async () => {
    setUp({ documents: [doc(), doc({ id: 32, reviewStatus: 'pending' })] });
    await decide('approved');
    expect(world.documentRequests[0].status).toBe('open');
    expect(world.events.map((e) => e.action)).toEqual(['document_approved']);
  });

  test('rejecting records the reason, keeps the request approved, and keeps the document request open for a new upload', async () => {
    setUp({ documents: [doc()] });
    await decide('rejected');
    expect(world.documents[0]).toMatchObject({ reviewStatus: 'rejected', rejectionReason: 'Not readable' });
    expect(world.documentRequests[0].status).toBe('open');
    expect(writes).not.toContain('serviceRequest.update'); // an approved request is never pushed back to "changes requested"
    expect(world.copied).toEqual([]);
  });

  test('every OTHER document of an approved request still cannot be reviewed (as before)', async () => {
    setUp({ documents: [doc({ documentRequestId: null })] });
    expect(await failure(decide('approved'))).toMatchObject({ statusCode: 409, publicCode: 'request_approved' });
    expect(world.copied).toEqual([]);
  });

  test('a document that is not scanned clean cannot be reviewed, and a missing or altered file blocks the approval', async () => {
    setUp({ documents: [doc({ scanStatus: 'pending' })] });
    expect(await failure(decide('approved'))).toMatchObject({ publicCode: 'document_not_clean' });
    setUp({ documents: [doc()] });
    files.fileProblem.mockResolvedValue({ code: 'file_changed', message: 'The stored file no longer matches what was scanned.' });
    expect(await failure(decide('approved'))).toMatchObject({ statusCode: 409, publicCode: 'file_changed' });
    expect(outcome).toBe('rolled back');
    expect(world.documents[0].reviewStatus).toBe('pending'); // the review decision was rolled back with it
    expect(world.copied).toEqual([]);
  });

  test('a request that has no Case cannot take the document', async () => {
    setUp({ documents: [doc()], caseRecord: null });
    expect(await failure(decide('approved'))).toMatchObject({ publicCode: 'case_missing' });
    expect(world.documents[0].reviewStatus).toBe('pending');
  });

  test.each(['document.create', 'requestDocument.update', 'documentRequest.update'])('a failure of %s rolls the whole review back', async (name) => {
    setUp({ documents: [doc()], failOn: name });
    await expect(decide('approved')).rejects.toThrow('simulated write failure');
    expect(outcome).toBe('rolled back');
    expect(world.documents[0].reviewStatus).toBe('pending');
    expect(world.copied).toEqual([]);
    expect(world.documentRequests[0].status).toBe('open');
  });
});

describe('before the approval nothing changes', () => {
  test('reviewing still works as it did, and a rejection still moves the request to "changes requested"', async () => {
    setUp({ request: { id: 61, userId: 7, reviewStatus: 'in_review', submittedAt: new Date() }, documents: [{ id: 31, serviceRequestId: 61, documentRequestId: null, originalName: 'a.pdf', storageKey: 'k', sizeBytes: 1, scanStatus: 'clean', reviewStatus: 'pending', supersededAt: null }] });
    await review.reviewDocument({ requestId: 61, documentId: 31, adminId: 3, decision: 'rejected', reason: 'Not readable' });
    expect(writes).toContain('serviceRequest.update');
    expect(world.copied).toEqual([]);
  });
});
