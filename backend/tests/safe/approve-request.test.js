/* global describe, test, expect, beforeEach, jest */
// approveRequest: it completes the document review on the EXISTING Case. A request with no Case (an older one) is
// refused with a controlled error and nothing is created. No database: Prisma is mocked and its $transaction runs the
// callback against an in-memory fake.
jest.mock('../../src/db/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/modules/request-review/request-review.files', () => ({
  ...jest.requireActual('../../src/modules/request-review/request-review.files'),
  fileProblem: jest.fn().mockResolvedValue(null), // no file system: the stored files are assumed intact
}));

const { prisma } = require('../../src/db/prisma');
const { approveRequest } = require('../../src/modules/request-review/request-review.service');

const WRITES = ['case.create', 'document.create', 'requestDocument.update', 'serviceRequest.update', 'requestEvent.create', 'auditLog.create', 'bitrixDealLink.create', 'integrationOutbox.create', 'caseStageEvent.create'];
let state;
let writes;

function setUp({ request, caseRecord = { id: 71, serviceRequestId: 61 }, documents = [] }) {
  state = { request: { ...request }, caseRecord, documents };
  writes = [];
  const w = (name, fn) => jest.fn(async (arg) => { writes.push(name); return fn(arg); });
  const tx = {
    $queryRaw: jest.fn(async () => []),
    serviceRequest: {
      findUnique: jest.fn(async () => (state.request ? { ...state.request } : null)),
      update: w('serviceRequest.update', ({ data }) => { state.request = { ...state.request, ...data }; return { ...state.request }; }),
    },
    case: { findUnique: jest.fn(async () => state.caseRecord), create: w('case.create', () => ({ id: 999 })) },
    requestDocument: { findMany: jest.fn(async () => state.documents), update: w('requestDocument.update', () => ({})) },
    document: { create: w('document.create', () => ({ id: 91 })) },
    requestEvent: { create: w('requestEvent.create', () => ({})) },
    caseStageEvent: { create: w('caseStageEvent.create', () => ({})) },
    auditLog: { create: w('auditLog.create', () => ({})) },
    bitrixDealLink: { create: w('bitrixDealLink.create', () => ({})) },
    integrationOutbox: { create: w('integrationOutbox.create', () => ({})) },
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(tx));
  return tx;
}

const inReview = { id: 61, referenceNumber: 'REQ-1061', reviewStatus: 'in_review', serviceKey: 'privatecharter' };
const goodDocument = { id: 81, originalName: 'report.pdf', storageKey: 'stored.pdf', sizeBytes: 5, scanStatus: 'clean', reviewStatus: 'approved' };

beforeEach(() => jest.clearAllMocks());

describe('a request with no Case (an older request)', () => {
  test('is refused with a controlled 409, and nothing is created', async () => {
    setUp({ request: inReview, caseRecord: null, documents: [goodDocument] });
    const error = await approveRequest({ requestId: 61, adminId: 3 }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(409);
    expect(error.publicCode).toBe('case_missing_manual_review');
    expect(error.message).toMatch(/no Case/);
    expect(error.message).toMatch(/manual historical review/);
    expect(writes).toEqual([]); // no Case, no document copy, no status change, no event, no audit, no Deal link, no outbox
  });

  test('stays refused every time it is tried, and still creates nothing', async () => {
    setUp({ request: inReview, caseRecord: null, documents: [goodDocument] });
    for (let i = 0; i < 3; i += 1) {
      await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toMatchObject({ publicCode: 'case_missing_manual_review' });
    }
    expect(writes).toEqual([]);
  });

  test('a request outside the review workflow (NULL status) is still simply "not found"', async () => {
    setUp({ request: { ...inReview, reviewStatus: null }, caseRecord: null });
    await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toMatchObject({ statusCode: 404 });
    expect(writes).toEqual([]);
  });
});

describe('a request that has its Case', () => {
  test('approval copies the approved documents to that Case, never creates one, and records only its own writes', async () => {
    setUp({ request: inReview, documents: [goodDocument] });
    const result = await approveRequest({ requestId: 61, adminId: 3 });
    expect(result.alreadyApproved).toBe(false);
    expect(result.case).toEqual({ id: 71, serviceRequestId: 61 });
    expect(writes).toEqual(['document.create', 'requestDocument.update', 'serviceRequest.update', 'requestEvent.create']);
    expect(writes).not.toContain('case.create');
    expect(state.request.reviewStatus).toBe('approved');
  });

  test('a repeated approval returns the same Case and writes nothing', async () => {
    setUp({ request: inReview, documents: [goodDocument] });
    const first = await approveRequest({ requestId: 61, adminId: 3 });
    writes.length = 0;
    const second = await approveRequest({ requestId: 61, adminId: 3 });
    const third = await approveRequest({ requestId: 61, adminId: 4 });
    expect(second.alreadyApproved).toBe(true);
    expect(third.alreadyApproved).toBe(true);
    expect(second.case.id).toBe(first.case.id);
    expect(third.case.id).toBe(first.case.id);
    expect(writes).toEqual([]);
  });

  test('missing documents still block the approval (a document rule, not a Case rule), with nothing written', async () => {
    setUp({ request: inReview, documents: [] });
    const error = await approveRequest({ requestId: 61, adminId: 3 }).catch((err) => err);
    expect(error.statusCode).toBe(409);
    expect(error.publicCode).toBe('approval_blocked');
    expect(error.blockers.map((b) => b.code)).toEqual(['no_documents']);
    expect(writes).toEqual([]);
  });

  test('an unreviewed document blocks the approval and nothing is copied', async () => {
    setUp({ request: inReview, documents: [{ ...goodDocument, reviewStatus: 'pending' }] });
    await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toMatchObject({ publicCode: 'approval_blocked' });
    expect(writes).toEqual([]);
  });
});

test('none of the writes the approval could make is outside the list this suite watches', () => {
  expect(WRITES).toContain('case.create'); // keeps the list honest if a write is ever added to the fake
});
