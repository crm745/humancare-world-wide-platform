/* global describe, test, expect, beforeEach, afterEach, jest */
// The approval services with the SYSTEM actor (automatic approval) next to the unchanged Admin behaviour.
// No database, no network: same in-memory transaction approach as approve-request.test.js.
jest.mock('../../src/db/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/modules/request-review/request-review.files', () => ({
  ...jest.requireActual('../../src/modules/request-review/request-review.files'),
  fileProblem: jest.fn().mockResolvedValue(null),
}));

const { prisma } = require('../../src/db/prisma');
const { approveRequest, reviewDocument } = require('../../src/modules/request-review/request-review.service');

const inReview = {
  id: 61, userId: 7, referenceNumber: 'REQ-1061', reviewStatus: 'in_review', serviceKey: 'privatecharter', bitrixLeadId: null,
  serviceType: 'Private Charter Air Ambulance Service', patientName: 'Asha Rao', patientAge: 54, patientGender: 'female', patientContact: '+919812345678',
  origin: 'Mumbai, India', destination: 'Dubai, UAE', country: 'IN', careLevel: 'care_icu', description: 'x', urgency: 'urgent_24h',
};
const docRow = { id: 81, serviceRequestId: 61, originalName: 'report.pdf', storageKey: 'stored.pdf', sizeBytes: 5, scanStatus: 'clean', reviewStatus: 'pending', supersededAt: null, documentRequestId: null };

let world; let tx;
function setUp({ request = inReview, documents = [{ ...docRow, reviewStatus: 'approved' }], caseRecord = null, link = null, event = null } = {}) {
  world = { request: { ...request }, documents: documents.map((d) => ({ ...d })), caseRecord, link, event };
  tx = {
    $queryRaw: jest.fn(async () => []),
    serviceRequest: { findUnique: jest.fn(async () => ({ ...world.request })), update: jest.fn(async ({ data }) => { world.request = { ...world.request, ...data }; return { ...world.request }; }) },
    case: {
      findUnique: jest.fn(async () => world.caseRecord),
      create: jest.fn(async ({ data }) => { world.caseRecord = { id: 71, ...data }; return { ...world.caseRecord }; }),
      update: jest.fn(async ({ data }) => { world.caseRecord = { ...world.caseRecord, ...data }; return { ...world.caseRecord }; }),
    },
    requestDocument: {
      findMany: jest.fn(async () => world.documents.map((d) => ({ ...d }))),
      findFirst: jest.fn(async () => ({ ...world.documents[0] })),
      update: jest.fn(async ({ data }) => { world.documents[0] = { ...world.documents[0], ...data }; return { ...world.documents[0] }; }),
    },
    document: { create: jest.fn(async () => ({ id: 91 })) },
    requestEvent: { create: jest.fn(async () => ({})) },
    caseStageEvent: { create: jest.fn(async () => ({})) },
    auditLog: { create: jest.fn(async () => ({})) },
    bitrixDealLink: { findUnique: jest.fn(async () => world.link), create: jest.fn(async ({ data }) => { world.link = { id: 5, bitrixDealId: null, ...data }; return world.link; }) },
    integrationOutbox: { findUnique: jest.fn(async () => world.event), create: jest.fn(async ({ data }) => { world.event = { id: 9, ...data }; return world.event; }) },
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(tx));
}

const savedProfile = process.env.BITRIX_DEAL_PROFILE;
beforeEach(() => { jest.clearAllMocks(); process.env.BITRIX_DEAL_PROFILE = 'actual'; });
afterEach(() => { if (savedProfile === undefined) delete process.env.BITRIX_DEAL_PROFILE; else process.env.BITRIX_DEAL_PROFILE = savedProfile; });

describe('approveRequest with the system actor', () => {
  test('records the approval, the Case and its audit entry as the SYSTEM (no admin id), and creates the actual-profile Deal event', async () => {
    setUp();
    const result = await approveRequest({ requestId: 61, adminId: null, actorType: 'system' });
    expect(result.alreadyApproved).toBe(false);
    const events = tx.requestEvent.create.mock.calls.map((c) => c[0].data);
    expect(events.map((e) => e.action)).toEqual(['request_approved', 'case_created']);
    for (const e of events) expect(e).toMatchObject({ actorType: 'system', actorId: null });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'case.created', actorType: 'system', source: 'system', reasonCode: 'request_auto_approved' });
    expect(tx.integrationOutbox.create).toHaveBeenCalledTimes(1);
    expect(tx.integrationOutbox.create.mock.calls[0][0].data).toMatchObject({
      eventType: 'bitrix.deal.create', idempotencyKey: 'bitrix.deal.create:case:71', status: 'pending', payload: { caseId: 71, serviceRequestId: 61, profile: 'actual' },
    });
  });

  test('an Admin approval is unchanged: admin actor, admin id, admin_portal source', async () => {
    setUp();
    await approveRequest({ requestId: 61, adminId: 3 });
    const events = tx.requestEvent.create.mock.calls.map((c) => c[0].data);
    for (const e of events) expect(e).toMatchObject({ actorType: 'admin', actorId: 3 });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({ actorType: 'admin', actorId: '3', source: 'admin_portal', reasonCode: 'request_approved' });
  });

  test('approving twice (automatic, then again) creates no second Case, link or Deal event and writes nothing', async () => {
    setUp();
    await approveRequest({ requestId: 61, adminId: null, actorType: 'system' });
    const writesAfterFirst = [tx.case.create, tx.bitrixDealLink.create, tx.integrationOutbox.create, tx.requestEvent.create].map((m) => m.mock.calls.length);
    const second = await approveRequest({ requestId: 61, adminId: null, actorType: 'system' });
    expect(second.alreadyApproved).toBe(true);
    expect([tx.case.create, tx.bitrixDealLink.create, tx.integrationOutbox.create, tx.requestEvent.create].map((m) => m.mock.calls.length)).toEqual(writesAfterFirst);
    // and an Admin approving afterwards is equally a no-op
    expect((await approveRequest({ requestId: 61, adminId: 3 })).alreadyApproved).toBe(true);
  });

  test('a rejected or unscanned document still blocks the system exactly as it blocks an Admin, and nothing is written', async () => {
    for (const bad of [{ reviewStatus: 'rejected' }, { scanStatus: 'pending' }, { scanStatus: 'infected' }]) {
      setUp({ documents: [{ ...docRow, reviewStatus: 'approved', ...bad }] });
      await expect(approveRequest({ requestId: 61, adminId: null, actorType: 'system' })).rejects.toMatchObject({ publicCode: 'approval_blocked' });
      expect(tx.case.create).not.toHaveBeenCalled();
      expect(tx.integrationOutbox.create).not.toHaveBeenCalled();
    }
  });
});

describe('reviewDocument with the system actor', () => {
  test('approves a clean pending document, recorded as the system with no admin id', async () => {
    setUp({ documents: [{ ...docRow }] });
    tx.serviceRequest.findUnique.mockResolvedValue({ ...inReview });
    await reviewDocument({ requestId: 61, documentId: 81, adminId: null, decision: 'approved', actorType: 'system' });
    expect(tx.requestDocument.update.mock.calls[0][0].data).toMatchObject({ reviewStatus: 'approved', reviewedByAdminId: null });
    expect(tx.requestEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'document_approved', actorType: 'system', actorId: null });
  });

  test('an Admin review still records the admin', async () => {
    setUp({ documents: [{ ...docRow }] });
    await reviewDocument({ requestId: 61, documentId: 81, adminId: 3, decision: 'approved' });
    expect(tx.requestDocument.update.mock.calls[0][0].data).toMatchObject({ reviewedByAdminId: 3 });
    expect(tx.requestEvent.create.mock.calls[0][0].data).toMatchObject({ actorType: 'admin', actorId: 3 });
  });

  test('an unclean document cannot be approved by the system either', async () => {
    setUp({ documents: [{ ...docRow, scanStatus: 'pending' }] });
    await expect(reviewDocument({ requestId: 61, documentId: 81, adminId: null, decision: 'approved', actorType: 'system' })).rejects.toMatchObject({ publicCode: 'document_not_clean' });
    expect(tx.requestDocument.update).not.toHaveBeenCalled();
  });
});
