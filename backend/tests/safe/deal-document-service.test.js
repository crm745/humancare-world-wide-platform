/* global describe, test, expect, jest, beforeEach */
// The Admin side of document sharing (deal-document.service.js): explicit authorization of each document, revocation, retry and the
// Admin-visible status. No database: Prisma is mocked and its $transaction runs the callback against an in-memory world that really
// rolls back. The stored file is read through an injected reader; nothing calls Bitrix.
jest.mock('../../src/db/prisma', () => ({ prisma: { $transaction: jest.fn(), bitrixDealDocument: { findMany: jest.fn() } } }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));

const { prisma } = require('../../src/db/prisma');
const service = require('../../src/modules/bitrix/deal-document.service');
const store = require('../../src/modules/bitrix/deal-document.store');

const SHA = 'c'.repeat(64);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x20)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x20)]);

let world;
let writes;
let outcome;
let readFile;

const goodDocument = (over = {}) => ({ id: 31, serviceRequestId: 61, originalName: 'report.pdf', storageKey: 's.pdf', sizeBytes: 100, sha256: SHA, scanStatus: 'clean', reviewStatus: 'approved', supersededAt: null, caseDocumentId: 41, ...over });

function setUp({ request, caseRecord, document, shares = [], failOn = null } = {}) {
  world = {
    request: request === undefined ? { id: 61, serviceKey: 'privatecharter', reviewStatus: 'approved' } : request,
    caseRecord: caseRecord === undefined ? { id: 7, referenceNumber: 'CASE-3207', bitrixDealLink: { id: 5 } } : caseRecord,
    document: document === undefined ? goodDocument() : document,
    shares: shares.map((s) => ({ ...s })), events: [], requestEvents: [], audit: [], nextShareId: 1,
  };
  writes = [];
  outcome = null;
  readFile = jest.fn(async () => PDF);
  const w = (name, fn) => jest.fn(async (arg) => { writes.push(name); if (failOn === name) throw new Error('simulated write failure'); return fn(arg); });
  const tx = {
    $queryRaw: jest.fn(async () => []),
    serviceRequest: { findUnique: jest.fn(async () => (world.request ? { ...world.request } : null)) },
    case: { findUnique: jest.fn(async () => (world.caseRecord ? { ...world.caseRecord } : null)) },
    requestDocument: { findFirst: jest.fn(async ({ where }) => (world.document && world.document.id === where.id && world.document.serviceRequestId === where.serviceRequestId ? { ...world.document } : null)), update: w('requestDocument.update', () => ({})) },
    document: { create: w('document.create', () => ({})), update: w('document.update', () => ({})) },
    bitrixDealDocument: {
      findFirst: jest.fn(async ({ where }) => {
        const found = world.shares.filter((s) => s.dealLinkId === where.dealLinkId && s.requestDocumentId === where.requestDocumentId).sort((a, b) => b.generation - a.generation)[0];
        return found ? { ...found } : null;
      }),
      findUnique: jest.fn(async ({ where }) => { const found = world.shares.find((s) => s.id === where.id); return found ? { ...found } : null; }),
      create: w('bitrixDealDocument.create', ({ data }) => { const row = { id: world.nextShareId, attempts: 0, ...data }; world.nextShareId += 1; world.shares.push(row); return { ...row }; }),
      update: w('bitrixDealDocument.update', ({ where, data }) => { const row = world.shares.find((s) => s.id === where.id); Object.assign(row, data); return { ...row }; }),
    },
    integrationOutbox: { create: w('integrationOutbox.create', ({ data }) => { world.events.push(data); return data; }) },
    requestEvent: { create: w('requestEvent.create', ({ data }) => { world.requestEvents.push(data); return data; }) },
    auditLog: { create: w('auditLog.create', ({ data }) => { world.audit.push(data); return data; }) },
  };
  prisma.$transaction.mockImplementation(async (callback) => {
    const snapshot = JSON.parse(JSON.stringify({ shares: world.shares, events: world.events, requestEvents: world.requestEvents, audit: world.audit, nextShareId: world.nextShareId }));
    const writeCount = writes.length;
    try {
      const result = await callback(tx);
      outcome = 'committed';
      return result;
    } catch (err) {
      outcome = 'rolled back';
      Object.assign(world, snapshot);
      writes.length = writeCount;
      throw err;
    }
  });
  return tx;
}

const authorize = (over = {}) => service.authorizeShare({ requestId: 61, documentId: 31, adminId: 3, readFile, ...over });
const failure = async (promise) => promise.then(() => null, (err) => err);

beforeEach(() => jest.clearAllMocks());

// ---- authorize ----------------------------------------------------------------------------------------------------------------------
describe('authorizing a document to be shared', () => {
  test('creates the share, its attach event, the request event and the audit entry in one transaction', async () => {
    setUp();
    const result = await authorize();
    expect(outcome).toBe('committed');
    expect(result.alreadyAuthorized).toBe(false);
    expect(writes).toEqual(['bitrixDealDocument.create', 'integrationOutbox.create', 'requestEvent.create', 'auditLog.create']);
    expect(world.shares[0]).toMatchObject({
      dealLinkId: 5, requestDocumentId: 31, caseDocumentId: 41, generation: 1, sha256: SHA, sizeBytes: 100, detectedType: 'pdf',
      shareToken: `HC-D31G1-${SHA.slice(0, 8)}`, status: 'authorized', tryCount: 1, authorizedByAdminId: 3,
    });
    expect(world.events[0]).toMatchObject({
      eventType: store.ATTACH_EVENT, entityType: store.ENTITY_TYPE, entityId: '1:attach:1', caseId: 7, status: 'pending',
      idempotencyKey: 'bitrix.deal.document.attach:share:1:try:1', payload: { shareId: 1, caseId: 7, tryNumber: 1 },
    });
    expect(world.requestEvents[0]).toMatchObject({ serviceRequestId: 61, documentId: 31, action: 'document_share_authorized', actorType: 'admin', actorId: 3 });
    expect(world.audit[0]).toMatchObject({ action: 'bitrix.deal.document.authorized', actorType: 'admin', actorId: '3', source: 'admin_portal', caseId: 7, entityType: 'bitrix_deal_document' });
  });

  test('document REVIEW and sharing authorization stay separate: authorizing never changes the review, the document or the Case', async () => {
    setUp();
    await authorize();
    expect(writes).not.toContain('requestDocument.update');
    expect(writes).not.toContain('document.create');
    expect(writes).not.toContain('document.update');
    expect(world.document).toEqual(goodDocument());
  });

  test('nothing is shared by approval or review: only this explicit call creates a share (there is no automatic path)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'request-review', 'request-review.service.js'), 'utf8');
    expect(source).not.toMatch(/authorizeShare|bitrixDealDocument\.create|document\.attach/);
  });

  test('the audit entry holds identifiers only, never a file name, a checksum or patient data', async () => {
    setUp();
    await authorize();
    const text = JSON.stringify(world.audit[0]);
    for (const secret of ['report.pdf', SHA, 'Asha', 'http', '%PDF']) expect(text).not.toContain(secret);
  });

  test.each([
    ['JPEG', JPEG, 'jpeg'],
    ['PDF', PDF, 'pdf'],
  ])('the type comes from the file\'s own bytes (%s)', async (_name, bytes, type) => {
    setUp();
    readFile.mockResolvedValue(bytes);
    await authorize();
    expect(world.shares[0].detectedType).toBe(type);
  });

  test.each([
    ['not scanned clean', { scanStatus: 'infected' }, 'document_not_clean'],
    ['still waiting for its scan', { scanStatus: 'pending' }, 'document_not_clean'],
    ['not approved', { reviewStatus: 'pending' }, 'document_not_approved'],
    ['rejected', { reviewStatus: 'rejected' }, 'document_not_approved'],
    ['replaced by a newer one', { supersededAt: new Date() }, 'document_superseded'],
    ['not copied to the Case', { caseDocumentId: null }, 'not_in_case'],
  ])('refuses a document that is %s, and writes nothing', async (_name, change, code) => {
    setUp({ document: goodDocument(change) });
    const error = await failure(authorize());
    expect(error).toMatchObject({ statusCode: 409, publicCode: code });
    expect(writes).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  test('refuses a file that is not a PDF or an image, whatever its name or declared type says (a Word file named .pdf)', async () => {
    setUp({ document: goodDocument({ originalName: 'looks-like.pdf', mimeType: 'application/pdf' }) });
    readFile.mockResolvedValue(DOCX);
    expect(await failure(authorize())).toMatchObject({ statusCode: 409, publicCode: 'unsupported_type' });
    expect(writes).toEqual([]);
    readFile.mockResolvedValue(Buffer.from('plain text that says %PDF-1.4 later on'));
    expect(await failure(authorize())).toMatchObject({ publicCode: 'unsupported_type' });
  });

  test('a stored file that is missing or no longer matches its checksum is refused (the verified reader says so)', async () => {
    setUp();
    readFile.mockRejectedValue(Object.assign(new Error('The stored file is missing.'), { statusCode: 404, publicCode: 'file_missing' }));
    expect(await failure(authorize())).toMatchObject({ statusCode: 404, publicCode: 'file_missing' });
    expect(writes).toEqual([]);
  });

  test.each([
    ['a request that is not approved', { request: { id: 61, serviceKey: 'privatecharter', reviewStatus: 'in_review' } }, 409, 'request_not_approved'],
    ['a request outside the workflow', { request: { id: 61, serviceKey: 'privatecharter', reviewStatus: null } }, 404, undefined],
    ['another service', { request: { id: 61, serviceKey: 'ground', reviewStatus: 'approved' } }, 404, undefined],
    ['a request that does not exist', { request: null }, 404, undefined],
    ['no Case yet', { caseRecord: null }, 409, 'no_deal_link'],
    ['no Deal link yet', { caseRecord: { id: 7, referenceNumber: 'CASE-3207', bitrixDealLink: null } }, 409, 'no_deal_link'],
    ['a document of another request', { document: goodDocument({ serviceRequestId: 99 }) }, 404, undefined],
  ])('refuses %s', async (_name, setup, status, code) => {
    setUp(setup);
    const error = await failure(authorize());
    expect(error.statusCode).toBe(status);
    if (code) expect(error.publicCode).toBe(code);
    expect(writes).toEqual([]);
  });

  test('is idempotent: an active share is returned as it is, with no second share and no second event', async () => {
    setUp();
    const first = await authorize();
    const writesBefore = writes.length;
    const again = await authorize();
    expect(again.alreadyAuthorized).toBe(true);
    expect(again.share.id).toBe(first.share.id);
    expect(writes).toHaveLength(writesBefore);
    expect(world.shares).toHaveLength(1);
    expect(world.events).toHaveLength(1);
  });

  test.each(['authorized', 'attaching', 'attached', 'ambiguous', 'failed', 'revoking', 'revoke_failed'])('a %s share blocks a second authorization (no duplicate attachment)', async (status) => {
    setUp({ shares: [{ id: 1, dealLinkId: 5, requestDocumentId: 31, generation: 1, status }] });
    const result = await authorize();
    expect(result.alreadyAuthorized).toBe(true);
    expect(world.shares).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  test('after a revocation the document can be authorized again as a NEW generation (new token, new event), the old share untouched', async () => {
    setUp({ shares: [{ id: 1, dealLinkId: 5, requestDocumentId: 31, generation: 1, status: 'revoked', bitrixFileId: '501' }] });
    const result = await authorize();
    expect(result.alreadyAuthorized).toBe(false);
    expect(world.shares).toHaveLength(2);
    expect(world.shares[0]).toMatchObject({ id: 1, status: 'revoked', bitrixFileId: '501' });
    expect(world.shares[1]).toMatchObject({ generation: 2, shareToken: `HC-D31G2-${SHA.slice(0, 8)}`, status: 'authorized' });
    expect(world.events[0].entityId).toBe(`${world.shares[1].id}:attach:1`);
  });

  test.each(['bitrixDealDocument.create', 'integrationOutbox.create', 'requestEvent.create', 'auditLog.create'])('a failure of %s rolls everything back: no share, no event', async (name) => {
    setUp({ failOn: name });
    await expect(authorize()).rejects.toThrow('simulated write failure');
    expect(outcome).toBe('rolled back');
    expect(world.shares).toEqual([]);
    expect(world.events).toEqual([]);
    expect(world.requestEvents).toEqual([]);
    expect(world.audit).toEqual([]);
  });

  test('invalid ids are refused before any database work', async () => {
    setUp();
    expect(await failure(service.authorizeShare({ requestId: 'x', documentId: 31, adminId: 3, readFile }))).toMatchObject({ statusCode: 400 });
    expect(await failure(service.authorizeShare({ requestId: 61, documentId: 0, adminId: 3, readFile }))).toMatchObject({ statusCode: 400 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ---- revoke ------------------------------------------------------------------------------------------------------------------------------
describe('revoking a share', () => {
  const attached = (over = {}) => ({ id: 1, dealLinkId: 5, requestDocumentId: 31, generation: 1, status: 'attached', bitrixFileId: '501', tryCount: 1, attempts: 0, ...over });
  const revoke = (over = {}) => service.revokeShare({ requestId: 61, shareId: 1, adminId: 4, reason: 'Sent to the wrong case', ...over });

  test('marks the share revoking and queues ONE removal event; the document, the review and the original are untouched', async () => {
    setUp({ shares: [attached()] });
    const result = await revoke();
    expect(result.alreadyRevoked).toBe(false);
    expect(world.shares[0]).toMatchObject({ status: 'revoking', revokedByAdminId: 4, revokeReason: 'Sent to the wrong case', attempts: 0, tryCount: 2, lastError: null, bitrixFileId: '501' });
    expect(world.events).toHaveLength(1);
    expect(world.events[0]).toMatchObject({ eventType: store.REMOVE_EVENT, entityId: '1:remove:2', idempotencyKey: 'bitrix.deal.document.remove:share:1:try:2', payload: { shareId: 1, caseId: 7, tryNumber: 2 } });
    expect(writes).toEqual(['bitrixDealDocument.update', 'integrationOutbox.create', 'requestEvent.create', 'auditLog.create']);
    for (const forbidden of ['requestDocument.update', 'document.create', 'document.update']) expect(writes).not.toContain(forbidden);
    expect(world.document).toEqual(goodDocument());
  });

  test('keeps the history: who revoked it, why, and an audit entry and a request event', async () => {
    setUp({ shares: [attached()] });
    await revoke();
    expect(world.requestEvents[0]).toMatchObject({ action: 'document_share_revoked', actorType: 'admin', actorId: 4, documentId: 31 });
    expect(world.audit[0]).toMatchObject({ action: 'bitrix.deal.document.revocation_requested', actorId: '4', reasonCode: 'share_revoked' });
    expect(JSON.stringify(world.audit[0])).not.toContain('Sent to the wrong case'); // the audit trail holds codes, the reason stays on the share
  });

  test.each([[undefined], [''], ['  '], ['ab'], [5], ['x'.repeat(1001)]])('a reason of %p is refused and nothing changes', async (reason) => {
    setUp({ shares: [attached()] });
    expect(await failure(revoke({ reason }))).toMatchObject({ statusCode: 400, publicCode: 'reason_required' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test.each(['authorized', 'attaching', 'attached', 'ambiguous', 'failed'])('a %s share can be revoked', async (status) => {
    setUp({ shares: [attached({ status })] });
    expect((await revoke()).alreadyRevoked).toBe(false);
    expect(world.shares[0].status).toBe('revoking');
  });

  test.each(['revoking', 'revoked'])('revoking a %s share again is idempotent: no second event', async (status) => {
    setUp({ shares: [attached({ status })] });
    const result = await revoke();
    expect(result.alreadyRevoked).toBe(true);
    expect(world.events).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('a share whose removal failed must be retried, not revoked again', async () => {
    setUp({ shares: [attached({ status: 'revoke_failed' })] });
    expect(await failure(revoke())).toMatchObject({ statusCode: 409, publicCode: 'share_not_revocable' });
  });

  test('a share of another Deal or request is "not found"', async () => {
    setUp({ shares: [attached({ dealLinkId: 99 })] });
    expect(await failure(revoke())).toMatchObject({ statusCode: 404 });
    setUp({ shares: [] });
    expect(await failure(revoke())).toMatchObject({ statusCode: 404 });
  });

  test.each(['bitrixDealDocument.update', 'integrationOutbox.create', 'requestEvent.create', 'auditLog.create'])('a failure of %s rolls the revocation back entirely', async (name) => {
    setUp({ shares: [attached()], failOn: name });
    await expect(revoke()).rejects.toThrow('simulated write failure');
    expect(world.shares[0]).toMatchObject({ status: 'attached', tryCount: 1 });
    expect(world.events).toEqual([]);
  });
});

// ---- retry -------------------------------------------------------------------------------------------------------------------------------
describe('retrying a failed share (the Admin side of the escalation)', () => {
  const failed = (over = {}) => ({ id: 1, dealLinkId: 5, requestDocumentId: 31, generation: 1, status: 'failed', tryCount: 3, attempts: 5, lastError: 'bitrix:bitrix_error', ...over });
  const retry = () => service.retryShare({ requestId: 61, shareId: 1, adminId: 3 });

  test('a failed attachment goes back to authorized with a NEW event (new key) and fresh attempts', async () => {
    setUp({ shares: [failed()] });
    await retry();
    expect(world.shares[0]).toMatchObject({ status: 'authorized', attempts: 0, tryCount: 4, lastError: null });
    expect(world.events[0]).toMatchObject({ eventType: store.ATTACH_EVENT, idempotencyKey: 'bitrix.deal.document.attach:share:1:try:4', payload: { shareId: 1, caseId: 7, tryNumber: 4 } });
    expect(world.requestEvents[0].action).toBe('document_share_retried');
    expect(world.audit[0].action).toBe('bitrix.deal.document.retried');
  });

  test('a failed removal goes back to revoking with a new removal event', async () => {
    setUp({ shares: [failed({ status: 'revoke_failed', bitrixFileId: '501' })] });
    await retry();
    expect(world.shares[0]).toMatchObject({ status: 'revoking', attempts: 0, tryCount: 4 });
    expect(world.events[0]).toMatchObject({ eventType: store.REMOVE_EVENT, idempotencyKey: 'bitrix.deal.document.remove:share:1:try:4' });
  });

  test.each(['authorized', 'attaching', 'attached', 'ambiguous', 'revoking', 'revoked'])('a %s share cannot be retried (no duplicate work)', async (status) => {
    setUp({ shares: [failed({ status })] });
    expect(await failure(retry())).toMatchObject({ statusCode: 409, publicCode: 'share_not_retryable' });
    expect(writes).toEqual([]);
  });

  test('a failure while retrying rolls everything back', async () => {
    setUp({ shares: [failed()], failOn: 'integrationOutbox.create' });
    await expect(retry()).rejects.toThrow('simulated write failure');
    expect(world.shares[0].status).toBe('failed');
  });
});

// ---- list ----------------------------------------------------------------------------------------------------------------------------------
describe('the Admin-visible status', () => {
  test('lists the shares with their status, attempts and last error, and marks the ones that need a person', async () => {
    prisma.bitrixDealDocument.findMany.mockResolvedValue([
      { id: 1, status: 'attached', attempts: 0, lastError: null },
      { id: 2, status: 'failed', attempts: 5, lastError: 'bitrix:bitrix_error' },
      { id: 3, status: 'revoke_failed', attempts: 5, lastError: 'removal_not_confirmed' },
      { id: 4, status: 'ambiguous', attempts: 0, lastError: 'manual_review_required:several_new_files' },
      { id: 5, status: 'authorized', attempts: 1, lastError: 'read_failed:timeout' },
    ]);
    const shares = await service.listShares(61);
    expect(shares.map((s) => [s.id, s.needsAttention])).toEqual([[1, false], [2, true], [3, true], [4, true], [5, false]]);
    expect(prisma.bitrixDealDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { dealLink: { case: { serviceRequestId: 61 } } }, orderBy: { id: 'asc' } }));
  });

  test('never exposes the checksum or the visible token', () => {
    for (const hidden of ['sha256', 'shareToken', 'fileIdsBefore']) expect(service.SHARE_SELECT).not.toHaveProperty(hidden);
    for (const shown of ['status', 'attempts', 'lastError', 'bitrixFileId', 'revokeReason', 'generation']) expect(service.SHARE_SELECT[shown]).toBe(true);
  });
});
