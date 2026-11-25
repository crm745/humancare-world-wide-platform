/* global describe, test, expect, beforeEach, jest */
// approveRequest: the Admin approval opens the Case (when there is none), copies the approved documents to it, marks the
// request approved, records the approval, and records the Bitrix Deal link and Deal-creation event, all in ONE transaction.
// No database and no network: Prisma is mocked and its $transaction runs the callback against an in-memory world that
// really rolls back when the callback throws.
jest.mock('../../src/db/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/modules/request-review/request-review.files', () => ({
  ...jest.requireActual('../../src/modules/request-review/request-review.files'),
  fileProblem: jest.fn().mockResolvedValue(null), // no file system: the stored files are assumed intact
}));

const { prisma } = require('../../src/db/prisma');
const { approveRequest } = require('../../src/modules/request-review/request-review.service');

let world; // the in-memory database
let writes; // every write, in order
let outcome;

const inReview = {
  id: 61, userId: 7, referenceNumber: 'REQ-1061', reviewStatus: 'in_review', serviceKey: 'privatecharter', bitrixLeadId: null,
  serviceType: 'Private Charter Air Ambulance Service', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female',
  patientContact: '+971501234567', origin: 'Mumbai, India', destination: 'Dubai, UAE', country: 'AE', careLevel: 'care_icu',
  description: 'Needs ICU transfer', urgency: 'urgent_24h',
};
const goodDocument = { id: 81, originalName: 'report.pdf', storageKey: 'stored.pdf', sizeBytes: 5, scanStatus: 'clean', reviewStatus: 'approved' };

function setUp({ request = inReview, documents = [goodDocument], caseRecord = null, link = null, event = null, failOn = null } = {}) {
  world = { request: { ...request }, documents: documents.map((d) => ({ ...d })), caseRecord: caseRecord && { ...caseRecord }, link: link && { ...link }, event: event && { ...event }, nextCaseId: 71 };
  writes = [];
  outcome = null;
  const w = (name, fn) => jest.fn(async (arg) => {
    writes.push(name);
    if (failOn === name) throw new Error('simulated write failure');
    return fn(arg);
  });
  const tx = {
    $queryRaw: jest.fn(async () => []),
    serviceRequest: {
      findUnique: jest.fn(async () => (world.request ? { ...world.request } : null)),
      update: w('serviceRequest.update', ({ data }) => { world.request = { ...world.request, ...data }; return { ...world.request }; }),
    },
    case: {
      findUnique: jest.fn(async () => (world.caseRecord ? { ...world.caseRecord } : null)),
      create: w('case.create', ({ data }) => { world.caseRecord = { id: world.nextCaseId, ...data }; return { ...world.caseRecord }; }),
      update: w('case.update', ({ data }) => { world.caseRecord = { ...world.caseRecord, ...data }; return { ...world.caseRecord }; }),
    },
    requestDocument: { findMany: jest.fn(async () => world.documents.map((d) => ({ ...d }))), update: w('requestDocument.update', () => ({})) },
    document: { create: w('document.create', () => ({ id: 91 })) },
    requestEvent: { create: w('requestEvent.create', ({ data }) => { (world.events = world.events || []).push(data.action); return {}; }) },
    caseStageEvent: { create: w('caseStageEvent.create', () => ({})) },
    auditLog: { create: w('auditLog.create', ({ data }) => { (world.audit = world.audit || []).push(data); return {}; }) },
    bitrixDealLink: {
      findUnique: jest.fn(async () => (world.link ? { ...world.link } : null)),
      create: w('bitrixDealLink.create', ({ data }) => { world.link = { id: 5, bitrixDealId: null, ...data }; return { ...world.link }; }),
    },
    integrationOutbox: {
      findUnique: jest.fn(async () => (world.event ? { ...world.event } : null)),
      create: w('integrationOutbox.create', ({ data }) => { world.event = { id: 9, ...data }; return { ...world.event }; }),
    },
  };
  // A transaction that really rolls back: the world and the write log are restored when the callback throws.
  prisma.$transaction.mockImplementation(async (callback) => {
    const snapshot = JSON.parse(JSON.stringify(world));
    const writeSnapshot = [...writes];
    try {
      const result = await callback(tx);
      outcome = 'committed';
      return result;
    } catch (err) {
      outcome = 'rolled back';
      world = snapshot;
      world.__rolledBackWrites = writes.slice(writeSnapshot.length);
      writes.length = writeSnapshot.length;
      throw err;
    }
  });
  return tx;
}

beforeEach(() => jest.clearAllMocks());

describe('approving a request that has no Case yet (the normal case now)', () => {
  test('creates exactly one Case, one Deal link and one Deal event, with the approval recorded, in one transaction', async () => {
    const tx = setUp();
    const result = await approveRequest({ requestId: 61, adminId: 3 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('committed');
    expect(result.alreadyApproved).toBe(false);
    expect(result.case).toMatchObject({ id: 71, serviceRequestId: 61, referenceNumber: 'CASE-1071' });
    expect(result.request.reviewStatus).toBe('approved');
    expect(writes).toEqual([
      'case.create', 'case.update', 'caseStageEvent.create', 'auditLog.create',
      'document.create', 'requestDocument.update', 'serviceRequest.update',
      'requestEvent.create', 'requestEvent.create', 'bitrixDealLink.create', 'integrationOutbox.create',
    ]);
    expect(writes.filter((n) => n === 'case.create')).toHaveLength(1);
    expect(writes.filter((n) => n === 'bitrixDealLink.create')).toHaveLength(1);
    expect(writes.filter((n) => n === 'integrationOutbox.create')).toHaveLength(1);
    expect(world.events).toEqual(['request_approved', 'case_created']);
    expect(tx.case.create.mock.calls[0][0].data).toMatchObject({ serviceRequestId: 61, status: 'submitted', charterStage: 'patient_details', stageVersion: 0 });
  });

  test('the Deal link and event are tied to the new Case, with the permanent per-Case key, and nothing is sent', async () => {
    const tx = setUp();
    await approveRequest({ requestId: 61, adminId: 3 });
    expect(tx.bitrixDealLink.create).toHaveBeenCalledWith({ data: { caseId: 71, syncStatus: 'pending' } });
    expect(tx.integrationOutbox.create.mock.calls[0][0].data).toMatchObject({
      eventType: 'bitrix.deal.create', entityType: 'case', entityId: '71', caseId: 71, idempotencyKey: 'bitrix.deal.create:case:71', status: 'pending',
      payload: { caseId: 71, serviceRequestId: 61 },
    });
  });

  test('the Case AuditLog entry names the Admin, the approval and the correlation, with identifiers only', async () => {
    setUp();
    await approveRequest({ requestId: 61, adminId: 3 });
    const entry = world.audit[0];
    expect(entry).toMatchObject({
      caseId: 71, entityType: 'case', entityId: '71', action: 'case.created', actorType: 'admin', actorId: '3',
      source: 'admin_portal', reasonCode: 'request_approved', correlationId: 'request:61', idempotencyKey: 'case.created:request:61',
    });
    const text = JSON.stringify(entry);
    for (const secret of ['Maria', 'Fernandez', '971501234567', 'ICU', 'Mumbai', 'Dubai', '@', 'http', 'token', 'password']) expect(text).not.toContain(secret);
  });

  test('a repeated approval returns the same Case and writes nothing, so nothing is doubled', async () => {
    setUp();
    const first = await approveRequest({ requestId: 61, adminId: 3 });
    const before = writes.length;
    const second = await approveRequest({ requestId: 61, adminId: 3 });
    const third = await approveRequest({ requestId: 61, adminId: 4 });
    expect(second.alreadyApproved).toBe(true);
    expect(third.alreadyApproved).toBe(true);
    expect(second.case.id).toBe(first.case.id);
    expect(third.case.id).toBe(first.case.id);
    expect(writes).toHaveLength(before);
    expect(writes.filter((n) => n === 'case.create')).toHaveLength(1);
    expect(writes.filter((n) => n === 'integrationOutbox.create')).toHaveLength(1);
  });

  test.each([
    'case.create', 'case.update', 'caseStageEvent.create', 'auditLog.create', 'document.create', 'requestDocument.update',
    'serviceRequest.update', 'requestEvent.create', 'bitrixDealLink.create', 'integrationOutbox.create',
  ])('a failure of %s rolls everything back: no Case, no link, no event, the request is still in review', async (name) => {
    setUp({ failOn: name });
    await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toThrow('simulated write failure');
    expect(outcome).toBe('rolled back');
    expect(writes).toEqual([]);
    expect(world.caseRecord).toBeNull();
    expect(world.link).toBeNull();
    expect(world.event).toBeNull();
    expect(world.request.reviewStatus).toBe('in_review');
    expect(world.events).toBeUndefined();
  });

  test('after a rolled-back approval the retry succeeds and still creates exactly one of each', async () => {
    setUp({ failOn: 'integrationOutbox.create' });
    await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toThrow('simulated write failure');
    const retry = setUp(); // same request, healthy database
    const result = await approveRequest({ requestId: 61, adminId: 3 });
    expect(result.alreadyApproved).toBe(false);
    expect(retry.case.create).toHaveBeenCalledTimes(1);
    expect(retry.integrationOutbox.create).toHaveBeenCalledTimes(1);
  });
});

describe('approving a request that already has a Case (one opened at submission by an earlier version)', () => {
  const oldCase = { id: 71, serviceRequestId: 61, referenceNumber: 'CASE-1071' };

  test('reuses the Case, never creates another, and creates the missing Deal link and event once', async () => {
    setUp({ caseRecord: oldCase, link: { id: 5, caseId: 71, bitrixDealId: null, syncStatus: 'pending' } });
    const result = await approveRequest({ requestId: 61, adminId: 3 });
    expect(result.case.id).toBe(71);
    expect(writes).not.toContain('case.create');
    expect(writes).not.toContain('bitrixDealLink.create'); // the link was there
    expect(writes.filter((n) => n === 'integrationOutbox.create')).toHaveLength(1);
    expect(world.events).toEqual(['request_approved']); // no second "case created" record
  });

  test('a Case with its link and event already recorded gets nothing new, and nothing fails', async () => {
    const event = { id: 9, idempotencyKey: 'bitrix.deal.create:case:71', status: 'pending' };
    setUp({ caseRecord: oldCase, link: { id: 5, caseId: 71, bitrixDealId: null, syncStatus: 'pending' }, event });
    await approveRequest({ requestId: 61, adminId: 3 });
    expect(writes).not.toContain('bitrixDealLink.create');
    expect(writes).not.toContain('integrationOutbox.create');
    expect(outcome).toBe('committed');
  });

  test('a Case whose Deal already exists (an older draft that got one) is approved without a new link or event', async () => {
    setUp({
      request: { ...inReview, reviewStatus: 'in_review' }, caseRecord: oldCase,
      link: { id: 5, caseId: 71, bitrixDealId: '4340', syncStatus: 'synced' },
      event: { id: 9, idempotencyKey: 'bitrix.deal.create:case:71', status: 'completed' },
    });
    await approveRequest({ requestId: 61, adminId: 3 });
    expect(writes).not.toContain('bitrixDealLink.create');
    expect(writes).not.toContain('integrationOutbox.create');
    expect(world.link.bitrixDealId).toBe('4340');
  });

  test('an existing failed event is never recreated or reset', async () => {
    const event = { id: 9, idempotencyKey: 'bitrix.deal.create:case:71', status: 'failed', lastError: 'mapping:x' };
    setUp({ caseRecord: oldCase, link: { id: 5, caseId: 71, bitrixDealId: null, syncStatus: 'error' }, event });
    await approveRequest({ requestId: 61, adminId: 3 });
    expect(writes).not.toContain('integrationOutbox.create');
    expect(world.event.status).toBe('failed');
  });
});

describe('the existing review rules still decide whether a request can be approved', () => {
  test('missing documents block the approval, with nothing written and no Case', async () => {
    setUp({ documents: [] });
    const error = await approveRequest({ requestId: 61, adminId: 3 }).catch((err) => err);
    expect(error.statusCode).toBe(409);
    expect(error.publicCode).toBe('approval_blocked');
    expect(error.blockers.map((b) => b.code)).toEqual(['no_documents']);
    expect(writes).toEqual([]);
    expect(world.caseRecord).toBeNull();
  });

  test('an unreviewed document blocks the approval and nothing is created', async () => {
    setUp({ documents: [{ ...goodDocument, reviewStatus: 'pending' }] });
    await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toMatchObject({ publicCode: 'approval_blocked' });
    expect(writes).toEqual([]);
  });

  test('a rejected document blocks the approval and nothing is created', async () => {
    setUp({ documents: [{ ...goodDocument, reviewStatus: 'rejected' }] });
    await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toMatchObject({ publicCode: 'approval_blocked' });
    expect(writes).toEqual([]);
  });

  test.each(['awaiting_documents', 'changes_requested'])('a request that is %s cannot be approved, and nothing is created', async (reviewStatus) => {
    setUp({ request: { ...inReview, reviewStatus } });
    await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toMatchObject({ publicCode: 'approval_blocked' });
    expect(writes).toEqual([]);
    expect(world.caseRecord).toBeNull();
    expect(world.link).toBeNull();
  });

  test('a request outside the review workflow (NULL status) is still simply "not found"', async () => {
    setUp({ request: { ...inReview, reviewStatus: null } });
    await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toMatchObject({ statusCode: 404 });
    expect(writes).toEqual([]);
  });

  test('a request that is not Private Charter cannot get a Case or Deal event from the approval: it fails and rolls back', async () => {
    setUp({ request: { ...inReview, serviceKey: 'ground' } });
    await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toThrow(/only Private Charter/);
    expect(outcome).toBe('rolled back');
    expect(world.caseRecord).toBeNull();
    expect(world.event).toBeNull();
  });
});

// Legacy document scan protection: the copy in `documents` inherits the source's scan record, but only a CONFIRMED one.
describe('the document copied into the Case', () => {
  const scannedAt = new Date('2030-01-01T10:00:00Z');
  const digest = 'a'.repeat(64);

  test('a clean, checksummed source passes its scan record (digest, status, engine, time) to the copy', async () => {
    const tx = setUp({ request: inReview, documents: [{ ...goodDocument, sha256: digest, scanEngine: 'clamav', scannedAt }] });
    await approveRequest({ requestId: 61, adminId: 3 });
    expect(tx.document.create.mock.calls[0][0].data).toMatchObject({ caseId: 71, type: 'Medical Report', name: 'report.pdf', fileUrl: '/uploads/stored.pdf', sha256: digest, scanStatus: 'clean', scanEngine: 'clamav', scannedAt });
  });

  test('a source without the digest or the engine is copied with NO scan record (NULL = not clean), never as a clean legacy document', async () => {
    for (const source of [{ ...goodDocument }, { ...goodDocument, sha256: digest }, { ...goodDocument, scanEngine: 'clamav' }]) {
      const tx = setUp({ request: inReview, documents: [source] });
      await approveRequest({ requestId: 61, adminId: 3 });
      const data = tx.document.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('scanStatus');
      expect(data).not.toHaveProperty('sha256');
    }
  });

  test('a source that is not clean cannot be approved at all, so no copy is ever made from it', async () => {
    for (const scanStatus of ['pending', 'error', 'infected', 'failed']) {
      const tx = setUp({ request: inReview, documents: [{ ...goodDocument, scanStatus, sha256: digest, scanEngine: 'clamav' }] });
      await expect(approveRequest({ requestId: 61, adminId: 3 })).rejects.toMatchObject({ publicCode: 'approval_blocked' });
      expect(tx.document.create).not.toHaveBeenCalled();
    }
  });
});
