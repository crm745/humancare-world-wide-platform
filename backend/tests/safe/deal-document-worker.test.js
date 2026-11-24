/* global describe, test, expect, jest, beforeEach */
// The Deal DOCUMENT worker: attaching Admin-authorized originals to the Deal's Documents field, preserving the files that are
// already there, reconciling uncertain outcomes, revocation, retries and failure handling. No database and no network: an in-memory
// world applies the same lease / fence / ordering rules as the real SQL, and the Bitrix24 API is the in-memory fake (a multiple file
// field that REPLACES its whole list on every update, like Bitrix) with failures injected per test.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const worker = require('../../src/modules/bitrix/deal-document-worker.service');
const realStore = require('../../src/modules/bitrix/deal-document.store');
const harness = require('../../src/modules/bitrix/deal-worker-harness');
const { BitrixDealCallError } = require('../../src/modules/bitrix/bitrix-deal.api');

const { runDealDocumentWorker, RETRY_DELAYS_SECONDS, MAX_ATTEMPTS, RECONCILE_WINDOW_SECONDS, RECONCILE_FIRST_DELAY_SECONDS, REMOTE_NAME_MAX } = worker;
const ENV_ON = { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' };
const DEAL_ID = '4344';
const PDF = Buffer.from('%PDF-1.4 a medical report');
const SHA = 'a'.repeat(64);

// ---- the in-memory world --------------------------------------------------------------------------------------------------------
let now; // ms, the world's clock (also the database clock)
let world;
let api;
let notify;
let log;
let readFile;
let prisma;
let store;
let nextEventId;

const newShare = (over = {}) => ({
  id: 1, dealLinkId: 5, requestDocumentId: 31, caseDocumentId: 41, generation: 1, sha256: SHA, sizeBytes: PDF.length, detectedType: 'pdf',
  shareToken: 'HC-D31G1-aaaaaaaa', status: 'authorized', bitrixFileId: null, fileIdsBefore: null, tryCount: 1, attempts: 0, lastError: null,
  authorizedByAdminId: 3, authorizedAt: new Date(now - 1000), attachedAt: null, revokedByAdminId: null, revokedAt: null, revokeReason: null, ...over,
});
const newDocument = (over = {}) => ({ id: 31, serviceRequestId: 61, originalName: 'report.pdf', storageKey: 'stored.pdf', sizeBytes: PDF.length, sha256: SHA, scanStatus: 'clean', reviewStatus: 'approved', ...over });

function addEvent(over = {}) {
  const event = {
    id: nextEventId, eventType: realStore.ATTACH_EVENT, entityId: '1:attach:1', caseId: 7, status: 'pending', attempts: 0, nextAt: 0, lockedBy: null, lockedUntil: null,
    callStartedAt: null, lastError: null, payload: { shareId: 1, caseId: 7, tryNumber: 1 }, key: `k${nextEventId}`, ...over,
  };
  nextEventId += 1;
  world.events.push(event);
  return event;
}

function makeStore() {
  const due = (e) => e.nextAt <= now && (e.lockedUntil == null || e.lockedUntil <= now);
  const owns = (e, c) => e.status === 'processing' && e.attempts === c.attempts && e.lockedBy === c.workerId && e.lockedUntil > now;
  const byId = (id) => world.events.find((e) => e.id === id);
  return {
    ...realStore, // the pure parts: event type names, keys, entity ids, MANUAL_REVIEW_PREFIX
    recoverExpiredLeases: jest.fn(async (_db, { maxClaims, caseIds }) => {
      for (const e of world.events) {
        if (e.status !== 'processing' || e.lockedUntil > now || (caseIds && !caseIds.includes(e.caseId))) continue;
        if (e.callStartedAt != null) Object.assign(e, { status: 'ambiguous', lastError: 'lease_expired_during_external_call', nextAt: now, lockedBy: null, lockedUntil: null });
        else if (e.attempts >= maxClaims) Object.assign(e, { status: 'failed', lockedBy: null, lockedUntil: null });
        else Object.assign(e, { status: 'pending', nextAt: now, lockedBy: null, lockedUntil: null });
      }
    }),
    findCandidateIds: jest.fn(async (_db, status, limit, scope) => world.events
      .filter((e) => realStore.EVENT_TYPES.includes(e.eventType) && e.status === status && due(e) && !(e.lastError || '').startsWith(realStore.MANUAL_REVIEW_PREFIX)
        && (!scope || scope.caseIds.includes(e.caseId)))
      .slice(0, limit).map((e) => e.id)),
    claim: jest.fn(async (_db, { id, fromStatus, workerId, leaseSeconds }) => {
      const e = byId(id);
      if (!e || e.status !== fromStatus || !due(e)) return null;
      Object.assign(e, { status: 'processing', attempts: e.attempts + 1, lockedBy: workerId, lockedUntil: now + leaseSeconds * 1000 });
      world.order.push(`claim:${id}`);
      return { id, fromStatus, workerId, attempts: e.attempts, caseId: e.caseId, externalCallStartedAt: e.callStartedAt, secondsSinceCall: e.callStartedAt == null ? null : (now - e.callStartedAt) / 1000 };
    }),
    loadEvent: jest.fn(async (_db, id) => { const e = byId(id); return e && { id: e.id, eventType: e.eventType, entityId: e.entityId, caseId: e.caseId, status: e.status, payload: e.payload }; }),
    markExternalCallStarted: jest.fn(async (_db, c, minLeft) => {
      const e = byId(c.id);
      if (!owns(e, c) || e.lockedUntil <= now + minLeft * 1000 || e.callStartedAt != null) return false;
      e.callStartedAt = now;
      world.order.push('call-started-marked');
      return true;
    }),
    writeResult: jest.fn(async (_db, c, { status, lastError = null, delaySeconds = 0 }) => {
      const e = byId(c.id);
      if (!owns(e, c)) return 0;
      Object.assign(e, { status, lastError, nextAt: now + delaySeconds * 1000, lockedBy: null, lockedUntil: null });
      world.order.push(`result:${status}`);
      return 1;
    }),
    acquireFileLease: jest.fn(async (_db, linkId, workerId, seconds) => {
      const l = world.link;
      if (l.fileLockedUntil != null && l.fileLockedUntil > now && l.fileLockedBy !== workerId) return false;
      Object.assign(l, { fileLockedBy: workerId, fileLockedUntil: now + seconds * 1000 });
      world.order.push('lease-acquired');
      return true;
    }),
    releaseFileLease: jest.fn(async (_db, linkId, workerId) => {
      if (world.link.fileLockedBy === workerId) Object.assign(world.link, { fileLockedBy: null, fileLockedUntil: null });
      world.order.push('lease-released');
    }),
  };
}

function makePrisma() {
  const shareOf = (id) => world.shares.get(id);
  const withRelations = (share) => share && ({
    ...share,
    requestDocument: world.documents.get(share.requestDocumentId),
    dealLink: { ...world.link, case: { id: 7, referenceNumber: 'CASE-3207', serviceRequestId: 61, serviceRequest: world.request } },
  });
  const tx = {
    bitrixDealDocument: {
      update: jest.fn(async ({ where, data }) => { world.order.push('share-update'); Object.assign(shareOf(where.id), data); return shareOf(where.id); }),
      findUnique: jest.fn(async ({ where }) => { const s = shareOf(where.id); return s && { status: s.status }; }),
    },
    integrationOutbox: {
      create: jest.fn(async ({ data }) => {
        if (world.events.some((e) => e.key === data.idempotencyKey)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        world.order.push('next-event');
        return addEvent({ ...data, nextAt: data.nextAttemptAt.getTime(), key: data.idempotencyKey, payload: data.payload });
      }),
    },
    auditLog: { create: jest.fn(async ({ data }) => { world.audit.push(data); }) },
  };
  return {
    tx,
    bitrixDealDocument: {
      findUnique: jest.fn(async ({ where }) => withRelations(shareOf(where.id))),
      update: jest.fn(async ({ where, data }) => { world.order.push('share-update'); Object.assign(shareOf(where.id), data); return shareOf(where.id); }),
    },
    integrationOutbox: {
      count: jest.fn(async ({ where }) => world.events.filter((e) => e.eventType === where.eventType && e.entityId.startsWith(where.entityId.startsWith) && e.status === where.status).length),
    },
    // A transaction that really rolls back.
    $transaction: jest.fn(async (callback) => {
      const snapshot = { shares: new Map([...world.shares].map(([k, v]) => [k, { ...v }])), events: world.events.map((e) => ({ ...e })), audit: [...world.audit], order: [...world.order] };
      try { return await callback(tx); } catch (err) {
        world.shares = snapshot.shares; world.events = snapshot.events; world.audit = snapshot.audit; world.order = snapshot.order;
        throw err;
      }
    }),
  };
}

beforeEach(() => {
  now = Date.parse('2026-11-16T10:00:00Z');
  nextEventId = 1;
  world = {
    shares: new Map(), events: [], audit: [], order: [],
    link: { id: 5, caseId: 7, bitrixDealId: DEAL_ID, fileLockedBy: null, fileLockedUntil: null },
    request: { id: 61, serviceKey: 'privatecharter', reviewStatus: 'approved' },
    documents: new Map([[31, newDocument()]]),
  };
  world.shares.set(1, newShare());
  prisma = makePrisma();
  store = makeStore();
  api = harness.makeFakeBitrixApi();
  for (const name of ['getDealFiles', 'updateDealFiles']) api[name] = jest.fn(api[name]);
  api.dealFiles.set(DEAL_ID, ['1001', '1002']); // two files Operations added by hand
  notify = jest.fn(async () => true);
  log = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  readFile = jest.fn(async () => PDF);
});

const run = (extra = {}) => runDealDocumentWorker({ prisma, store, api, env: ENV_ON, log, notify, readFile, workerId: 'worker-A', now: () => now, ...extra });
const share = (id = 1) => world.shares.get(id);
const event = (id) => world.events.find((e) => e.id === id);
const timeout = () => new BitrixDealCallError('ambiguous', 'timeout', 'crm.item.update timed out after 15s');
const refusal = (code, text) => new BitrixDealCallError('definitive', 'bitrix_error', `HTTP 400 ${code}: ${text}`);
const auditActions = () => world.audit.map((a) => a.action);
const eventsOf = (kind) => world.events.filter((e) => e.eventType === kind);

// ---- switches ---------------------------------------------------------------------------------------------------------------------
describe('the switches', () => {
  test.each([
    ['both Bitrix switches off', {}],
    ['only the master switch on', { BITRIX_SYNC_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }],
    ['only the Deal switch on', { BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }],
    ['the review workflow off', { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' }],
  ])('%s: nothing is recovered, claimed or sent', async (_name, env) => {
    addEvent();
    expect(await run({ env })).toEqual({ active: false, claimed: 0 });
    expect(store.recoverExpiredLeases).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(api.getDealFiles).not.toHaveBeenCalled();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(event(1).status).toBe('pending');
  });
});

// ---- attaching ---------------------------------------------------------------------------------------------------------------------
describe('attaching an authorized document', () => {
  test('uploads the ORIGINAL file to the Deal, keeps the existing files, and records the new Bitrix file id', async () => {
    addEvent();
    expect(await run()).toEqual({ active: true, claimed: 1 });
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['1001', '1002', '7000000001']); // Operations' two files kept, ours added last
    expect(share()).toMatchObject({ status: 'attached', bitrixFileId: '7000000001', attempts: 0, lastError: null });
    expect(share().attachedAt).toBeInstanceOf(Date);
    expect(event(1)).toMatchObject({ status: 'completed', lastError: null });
    expect(auditActions()).toEqual(['bitrix.deal.document.attached']);
  });

  test('a clean scan alone is enough: a document whose Admin review is still PENDING is attached (a rejected one never is, see below)', async () => {
    world.documents.set(31, newDocument({ reviewStatus: 'pending' }));
    addEvent();
    expect(await run()).toEqual({ active: true, claimed: 1 });
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['1001', '1002', '7000000001']); // Operations' files kept, ours added
    expect(share()).toMatchObject({ status: 'attached', bitrixFileId: '7000000001', lastError: null });
  });
  test('sends the verified bytes as base64 under the share token, with the extension of the real type', async () => {
    addEvent();
    await run();
    const [dealId, entries] = api.updateDealFiles.mock.calls[0];
    expect(dealId).toBe(DEAL_ID);
    expect(entries.slice(0, 2)).toEqual([{ id: '1001' }, { id: '1002' }]);
    const [name, content] = entries[2].fileData;
    expect(name).toBe('HC-D31G1-aaaaaaaa__report.pdf');
    expect(Buffer.from(content, 'base64').equals(PDF)).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(expect.objectContaining({ id: 31, sha256: SHA })); // the checksum-verified read of the stored original
  });

  test('order: lease, read, evidence BEFORE the call, one update, a second read, then the fenced result and the lease released', async () => {
    addEvent();
    await run();
    expect(world.order).toEqual(['claim:1', 'lease-acquired', 'share-update', 'call-started-marked', 'result:completed', 'share-update', 'lease-released']); // the result and the share update are ONE transaction, fenced first
    expect(api.getDealFiles).toHaveBeenCalledTimes(2);
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
    expect(world.link.fileLockedBy).toBeNull();
  });

  test('records the Deal\'s file ids BEFORE the upload, so a new file can be recognised afterwards', async () => {
    addEvent();
    api.updateDealFiles.mockImplementationOnce(async () => { throw timeout(); });
    await run();
    expect(share().fileIdsBefore).toEqual(['1001', '1002']);
  });

  test('works on a Deal with no files yet', async () => {
    addEvent();
    api.dealFiles.set(DEAL_ID, []);
    await run();
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['7000000001']);
    expect(share().status).toBe('attached');
  });

  test('never writes the HumanCare document or anything but the share, the event and the audit trail', async () => {
    addEvent();
    await run();
    expect(prisma.tx.integrationOutbox.create).not.toHaveBeenCalled(); // a success schedules nothing more
    expect(world.documents.get(31)).toEqual(newDocument());
  });

  test('several documents on one Deal attach one after another and every earlier file stays', async () => {
    world.documents.set(32, newDocument({ id: 32, originalName: 'scan.png' }));
    world.shares.set(2, newShare({ id: 2, requestDocumentId: 32, shareToken: 'HC-D32G1-aaaaaaaa', detectedType: 'png' }));
    addEvent();
    addEvent({ entityId: '2:attach:1', payload: { shareId: 2, caseId: 7, tryNumber: 1 } });
    await run();
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['1001', '1002', '7000000001', '7000000002']);
    expect(share(1).bitrixFileId).toBe('7000000001');
    expect(share(2).bitrixFileId).toBe('7000000002');
    expect(api.updateDealFiles.mock.calls[1][1].slice(0, 3)).toEqual([{ id: '1001' }, { id: '1002' }, { id: '7000000001' }]); // the first share's file is KEPT by the second
    expect(api.updateDealFiles.mock.calls[1][1][3].fileData[0]).toBe('HC-D32G1-aaaaaaaa__scan.png');
  });

  test('the stored file is read and verified BEFORE the Deal file list is read, so the list is fresh at the moment of the update', async () => {
    addEvent();
    await run();
    expect(readFile.mock.invocationCallOrder[0]).toBeLessThan(api.getDealFiles.mock.invocationCallOrder[0]);
    expect(api.getDealFiles.mock.invocationCallOrder[0]).toBeLessThan(api.updateDealFiles.mock.invocationCallOrder[0]);
  });

  test('documented limit: Bitrix replaces the whole list, so a file Operations adds in the instant between our read and our update is replaced', async () => {
    addEvent();
    const original = api.getDealFiles.getMockImplementation();
    api.getDealFiles.mockImplementationOnce(async (dealId) => { const result = await original(dealId); api.dealFiles.set(DEAL_ID, [...api.dealFiles.get(DEAL_ID), '1003']); return result; });
    await run();
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['1001', '1002', '7000000001']);
  });

  test('the remote name is the token plus a safe version of the original name, capped in length', () => {
    expect(worker.remoteFileName({ shareToken: 'HC-D5G1-abcd1234', detectedType: 'pdf' }, 'Rapport médical (final).docx')).toBe('HC-D5G1-abcd1234__Rapport m_dical _final_.pdf');
    expect(worker.remoteFileName({ shareToken: 'HC-D5G1-abcd1234', detectedType: 'jpeg' }, 'photo.JPEG')).toBe('HC-D5G1-abcd1234__photo.jpg');
    expect(worker.remoteFileName({ shareToken: 'HC-D5G1-abcd1234', detectedType: 'png' }, 'x'.repeat(400)).length).toBeLessThanOrEqual(REMOTE_NAME_MAX);
    expect(worker.remoteFileName({ shareToken: 'HC-D5G1-abcd1234', detectedType: 'webp' }, '..').endsWith('.webp')).toBe(true);
  });
});

// ---- eligibility at send time -------------------------------------------------------------------------------------------------------
describe('only what was authorized, still clean, not rejected and unchanged, is sent', () => {
  test.each([
    ['a document that is no longer clean', () => world.documents.set(31, newDocument({ scanStatus: 'infected' })), 'document_not_clean_and_approved'],
    ['a document that is no longer approved', () => world.documents.set(31, newDocument({ reviewStatus: 'rejected' })), 'document_not_clean_and_approved'],
    ['a checksum that changed', () => world.documents.set(31, newDocument({ sha256: 'b'.repeat(64) })), 'checksum_changed'],
    ['a request that is not approved', () => { world.request.reviewStatus = 'in_review'; }, 'request_not_approved'],
  ])('%s: nothing is sent and the share fails for good with an alert', async (_name, change, code) => {
    change();
    addEvent();
    await run();
    expect(api.getDealFiles).not.toHaveBeenCalled();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(share()).toMatchObject({ status: 'failed', lastError: code });
    expect(event(1)).toMatchObject({ status: 'failed', lastError: code });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('[ALERT]'));
  });

  test('a stored file that is missing or altered is a final failure (nothing is sent); an unexpected read error is retried', async () => {
    addEvent();
    readFile.mockRejectedValueOnce(Object.assign(new Error('x'), { publicCode: 'file_changed' }));
    await run();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(share()).toMatchObject({ status: 'failed', lastError: 'file:file_changed' });

    world.shares.set(1, newShare());
    world.events.length = 0;
    addEvent();
    readFile.mockRejectedValueOnce(new Error('EIO'));
    await run();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(share()).toMatchObject({ status: 'authorized', attempts: 1, tryCount: 2, lastError: 'file_read_error' });
    expect(eventsOf(realStore.ATTACH_EVENT)).toHaveLength(2); // a new attempt was scheduled
  });

  test('without a Deal yet nothing is sent, no attempt is used, and the event waits', async () => {
    world.link.bitrixDealId = null;
    addEvent();
    await run();
    expect(api.getDealFiles).not.toHaveBeenCalled();
    expect(share()).toMatchObject({ status: 'authorized', attempts: 0, tryCount: 1 });
    expect(event(1)).toMatchObject({ status: 'pending', lastError: 'waiting_for_deal' });
    expect(event(1).nextAt).toBe(now + 120 * 1000);
    now += 121 * 1000;
    world.link.bitrixDealId = DEAL_ID; // the Deal is created
    await run();
    expect(share().status).toBe('attached');
  });

  test('a Deal that never appears within a day is a final failure', async () => {
    world.link.bitrixDealId = null;
    world.shares.get(1).authorizedAt = new Date(now - 25 * 60 * 60 * 1000);
    addEvent();
    await run();
    expect(share()).toMatchObject({ status: 'failed', lastError: 'deal_not_available' });
  });
});

// ---- duplicate prevention -------------------------------------------------------------------------------------------------------------
describe('duplicates are prevented', () => {
  test('an attached share is never uploaded again (the same event delivered twice, or an extra event)', async () => {
    addEvent();
    await run();
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
    addEvent({ entityId: '1:attach:9', payload: { shareId: 1, caseId: 7, tryNumber: 1 } });
    await run();
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['1001', '1002', '7000000001']);
    expect(event(2)).toMatchObject({ status: 'completed', lastError: 'share_attached' });
  });

  test('an event of an older attempt does nothing once a newer attempt exists', async () => {
    world.shares.set(1, newShare({ tryCount: 2 }));
    addEvent(); // payload.tryNumber = 1
    await run();
    expect(api.getDealFiles).not.toHaveBeenCalled();
    expect(event(1)).toMatchObject({ status: 'completed', lastError: 'superseded_event' });
  });

  test('a share that was revoked before the upload is never uploaded', async () => {
    world.shares.set(1, newShare({ status: 'revoking', tryCount: 2 }));
    addEvent(); // the old attach event, tryNumber 1
    await run();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(event(1).status).toBe('completed');
  });

  test('two workers cannot update one Deal at the same time: the second waits', async () => {
    world.link.fileLockedBy = 'worker-B';
    world.link.fileLockedUntil = now + 60 * 1000;
    addEvent();
    await run();
    expect(api.getDealFiles).not.toHaveBeenCalled();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(event(1)).toMatchObject({ status: 'pending', lastError: 'deal_files_busy' });
    expect(share()).toMatchObject({ status: 'authorized', attempts: 0 });
    now += 61 * 1000;
    await run();
    expect(share().status).toBe('attached');
  });

  test('the database refuses a second event with the same key, so one attempt can never be queued twice', async () => {
    addEvent({ key: 'dup' });
    await expect(prisma.tx.integrationOutbox.create({ data: { idempotencyKey: 'dup', payload: {}, nextAttemptAt: new Date(now) } })).rejects.toMatchObject({ code: 'P2002' });
  });
});

// ---- uncertain outcomes (timeouts) ------------------------------------------------------------------------------------------------------
describe('a timeout or lost answer is reconciled by reading the Deal, never by uploading again', () => {
  // The update reached Bitrix (the file IS on the Deal) but the answer was lost.
  const landedButLost = () => {
    const apply = api.updateDealFiles.getMockImplementation();
    api.updateDealFiles.mockImplementationOnce(async (...args) => { await apply(...args); throw timeout(); });
  };

  test('is recorded as ambiguous with the evidence kept, and the share is not uploaded again', async () => {
    addEvent();
    api.updateDealFiles.mockRejectedValueOnce(timeout());
    await run();
    expect(event(1)).toMatchObject({ status: 'ambiguous', callStartedAt: now });
    expect(event(1).nextAt).toBe(now + RECONCILE_FIRST_DELAY_SECONDS * 1000);
    expect(share()).toMatchObject({ status: 'ambiguous', fileIdsBefore: ['1001', '1002'] });
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
  });

  test('when the file did arrive, the next pass ADOPTS it: one new file since the recorded list, and no second upload', async () => {
    addEvent();
    landedButLost();
    await run();
    now += (RECONCILE_FIRST_DELAY_SECONDS + 1) * 1000;
    await run();
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['1001', '1002', '7000000001']); // exactly one copy
    expect(share()).toMatchObject({ status: 'attached', bitrixFileId: '7000000001' });
    expect(event(1).status).toBe('completed');
    expect(auditActions()).toContain('bitrix.deal.document.attached');
    expect(world.audit.find((a) => a.action === 'bitrix.deal.document.attached').reasonCode).toBe('adopted_after_uncertain_attempt');
  });

  test('when nothing has arrived yet it keeps looking (read only) until the waiting period ends', async () => {
    addEvent();
    api.updateDealFiles.mockRejectedValueOnce(timeout());
    await run();
    for (let i = 0; i < 3; i += 1) {
      now += 10 * 60 * 1000 + 1000;
      if (now - event(1).callStartedAt >= RECONCILE_WINDOW_SECONDS * 1000) break;
      await run();
      expect(event(1)).toMatchObject({ status: 'ambiguous', lastError: 'reconciling:not_visible_yet' });
    }
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1); // never repeated while reconciling
  });

  test('after the waiting period with nothing found the attempt counts as failed and a NEW attempt is scheduled', async () => {
    addEvent();
    api.updateDealFiles.mockRejectedValueOnce(timeout());
    await run();
    now += (RECONCILE_WINDOW_SECONDS + 5) * 1000;
    await run();
    expect(event(1)).toMatchObject({ status: 'completed', lastError: 'not_landed_after_waiting_period' });
    expect(share()).toMatchObject({ attempts: 1, tryCount: 2, status: 'authorized' });
    expect(event(2)).toMatchObject({ eventType: realStore.ATTACH_EVENT, status: 'pending', entityId: '1:attach:2', key: 'bitrix.deal.document.attach:share:1:try:2', payload: { shareId: 1, caseId: 7, tryNumber: 2 } });
    expect(event(2).nextAt).toBe(now + RETRY_DELAYS_SECONDS[0] * 1000);
  });

  test('several new files since the recorded list (Operations may have added one) is NOT guessed: manual review, nothing removed or uploaded', async () => {
    addEvent();
    landedButLost();
    await run();
    api.dealFiles.set(DEAL_ID, [...api.dealFiles.get(DEAL_ID), '1003']); // Operations added another file meanwhile
    now += (RECONCILE_FIRST_DELAY_SECONDS + 1) * 1000;
    await run();
    expect(event(1)).toMatchObject({ status: 'ambiguous' });
    expect(event(1).lastError).toMatch(/^manual_review_required:several_new_files/);
    expect(share()).toMatchObject({ status: 'ambiguous', bitrixFileId: null });
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(auditActions()).toContain('bitrix.deal.document.manual_review_required');
    now += 3 * 60 * 60 * 1000;
    await run(); // the worker never offers a manual-review event again
    expect(event(1).status).toBe('ambiguous');
    expect(api.getDealFiles).toHaveBeenCalledTimes(2); // the upload attempt's read and the one reconciliation read; nothing after the review marker
  });

  test('reconciling: a prior file is gone and one "new" id appeared (it may be that file re-created): NOT adopted, manual review, nothing uploaded', async () => {
    addEvent();
    landedButLost();
    await run();
    api.dealFiles.set(DEAL_ID, ['1001', '7000000001']); // 1002 vanished
    now += (RECONCILE_FIRST_DELAY_SECONDS + 1) * 1000;
    await run();
    expect(event(1)).toMatchObject({ status: 'ambiguous' });
    expect(event(1).lastError).toMatch(/^manual_review_required:existing_files_changed/);
    expect(share()).toMatchObject({ status: 'ambiguous', bitrixFileId: null });
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
    expect(world.audit.some((a) => a.action === 'bitrix.deal.document.attached')).toBe(false);
  });

  test('reconciling: a person\'s explicit confirmation of exactly that id adopts it even though a prior id changed (nothing uploaded)', async () => {
    addEvent();
    landedButLost();
    await run();
    api.dealFiles.set(DEAL_ID, ['1001', '7000000001']);
    now += (RECONCILE_FIRST_DELAY_SECONDS + 1) * 1000;
    await run({ confirmedFileIds: { 1: '7000000001' } });
    expect(share()).toMatchObject({ status: 'attached', bitrixFileId: '7000000001' });
    expect(event(1).status).toBe('completed');
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
    // The audit trail says it was a person's confirmation with a prior file missing: never the plain "adopted" reason.
    expect(world.audit.find((a) => a.action === 'bitrix.deal.document.attached')).toMatchObject({ reasonCode: 'adopted_confirmed_by_person', afterData: { bitrixFileId: '7000000001', shareId: 1 } });
    expect(world.audit.find((a) => a.action === 'bitrix.deal.document.existing_files_missing')).toMatchObject({ reasonCode: 'confirmed_missing_1' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('existing files are missing') }));
  });

  test('reconciling: a confirmation does not change a normal adoption (nothing missing): still the plain adoption reason, no extra entry, no alert', async () => {
    addEvent();
    landedButLost();
    await run();
    now += (RECONCILE_FIRST_DELAY_SECONDS + 1) * 1000;
    await run({ confirmedFileIds: { 1: '7000000001' } });
    expect(world.audit.find((a) => a.action === 'bitrix.deal.document.attached').reasonCode).toBe('adopted_after_uncertain_attempt');
    expect(auditActions()).not.toContain('bitrix.deal.document.existing_files_missing');
    expect(notify).not.toHaveBeenCalled();
  });

  test.each([
    ['another id', { 1: '7000000555' }, ['1001', '7000000001']],
    ['another share', { 2: '7000000001' }, ['1001', '7000000001']],
    ['several new ids', { 1: '7000000001' }, ['1001', '7000000001', '7000000002']],
  ])('reconciling: a confirmation for %s does not adopt anything', async (_name, confirmed, files) => {
    addEvent();
    landedButLost();
    await run();
    api.dealFiles.set(DEAL_ID, files);
    now += (RECONCILE_FIRST_DELAY_SECONDS + 1) * 1000;
    await run({ confirmedFileIds: confirmed });
    expect(share()).toMatchObject({ status: 'ambiguous', bitrixFileId: null });
    expect(event(1).lastError).toMatch(/^manual_review_required:/);
  });

  test('a lost answer after a successful verification read still ends attached (the verify read finds the file)', async () => {
    addEvent();
    api.updateDealFiles.mockImplementationOnce(async (dealId, entries) => { api.dealFiles.set(dealId, entries.map((e) => e.id || '7000000001')); return { ok: true }; });
    await run();
    expect(share().status).toBe('attached');
  });

  test('a failed verification read after a good update is ambiguous, not a failure (it will be reconciled)', async () => {
    addEvent();
    const original = api.getDealFiles.getMockImplementation();
    api.getDealFiles.mockImplementationOnce(original).mockResolvedValueOnce({ status: 'uncertain', reason: 'timeout' });
    await run();
    expect(event(1).status).toBe('ambiguous');
    expect(share().status).toBe('ambiguous');
  });

  test('an answer that is not the documented one (even if Bitrix may have applied it) is ambiguous, never attached, until a LATER independent read reconciles it', async () => {
    addEvent();
    api.updateDealFiles.mockImplementationOnce(async (dealId, entries) => {
      api.dealFiles.set(dealId, entries.map((e) => e.id || '7000000001')); // applied
      throw new BitrixDealCallError('ambiguous', 'unexpected_result');
    });
    await run();
    expect(share()).toMatchObject({ status: 'ambiguous', bitrixFileId: null, attachedAt: null });
    expect(event(1)).toMatchObject({ status: 'ambiguous', callStartedAt: now });
    expect(world.audit.some((a) => a.action === 'bitrix.deal.document.attached')).toBe(false);
    expect(api.getDealFiles).toHaveBeenCalledTimes(1); // no verification read is used to promote it in the same attempt
    now += (RECONCILE_FIRST_DELAY_SECONDS + 1) * 1000;
    await run(); // only now, a separate reconciliation read finds exactly one new id with every prior id intact
    expect(share()).toMatchObject({ status: 'attached', bitrixFileId: '7000000001' });
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
  });

  test('an unexpected error during the call is also ambiguous', async () => {
    addEvent();
    api.updateDealFiles.mockRejectedValueOnce(new TypeError('boom'));
    await run();
    expect(event(1).status).toBe('ambiguous');
  });

  test('an uncertain upload that already holds the new file is adopted by a later fresh read too: the Deal never gets two copies', async () => {
    addEvent();
    landedButLost();
    await run();
    now += (RECONCILE_FIRST_DELAY_SECONDS + 1) * 1000;
    await run();
    now += 24 * 60 * 60 * 1000;
    await run();
    expect(api.dealFiles.get(DEAL_ID).filter((id) => id.startsWith('7000'))).toHaveLength(1);
  });
});

// ---- verification of the result ---------------------------------------------------------------------------------------------------------
describe('the Deal is read again after every update', () => {
  test('if the file does not show up (the field is wrong or not writable) the share fails for good with an alert', async () => {
    addEvent();
    api.updateDealFiles.mockImplementationOnce(async () => ({ ok: true })); // Bitrix said yes but changed nothing
    await run();
    expect(share()).toMatchObject({ status: 'failed', lastError: 'file_not_visible_after_update' });
    expect(api.getDealFiles).toHaveBeenCalledTimes(3); // first read, verification, and one more look
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('every prior file id still there and exactly one new id: attached with that id', async () => {
    addEvent();
    await run();
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['1001', '1002', '7000000001']);
    expect(share()).toMatchObject({ status: 'attached', bitrixFileId: '7000000001' });
    expect(auditActions()).toEqual(['bitrix.deal.document.attached']);
  });

  test('if a prior file id is gone afterwards nothing is recorded as attached and no id is adopted: manual review with an alert', async () => {
    addEvent();
    api.updateDealFiles.mockImplementationOnce(async (dealId) => { api.dealFiles.set(dealId, ['1001', '7000000001']); return { ok: true }; }); // 1002 vanished
    await run();
    expect(share()).toMatchObject({ status: 'ambiguous', bitrixFileId: null });
    expect(event(1).status).toBe('ambiguous');
    expect(event(1).lastError).toMatch(/^manual_review_required:existing_files_changed/);
    expect(auditActions()).toEqual(['bitrix.deal.document.manual_review_required']);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('a prior file that comes back under a NEW id (the incident) is not mistaken for our upload: the only file on the Deal changes id', async () => {
    api.dealFiles.set(DEAL_ID, ['65608']);
    addEvent();
    api.updateDealFiles.mockImplementationOnce(async (dealId) => { api.dealFiles.set(dealId, ['65616']); return { ok: true }; }); // old file re-created, upload lost
    await run();
    expect(share()).toMatchObject({ status: 'ambiguous', bitrixFileId: null });
    expect(event(1).lastError).toMatch(/^manual_review_required:existing_files_changed/);
    expect(world.audit.some((a) => a.action === 'bitrix.deal.document.attached')).toBe(false);
  });

  test('the manual-review marker stops the worker from offering the event again', async () => {
    addEvent();
    api.updateDealFiles.mockImplementationOnce(async (dealId) => { api.dealFiles.set(dealId, ['1001', '7000000001']); return { ok: true }; });
    await run();
    const reads = api.getDealFiles.mock.calls.length;
    now += 3 * 60 * 60 * 1000;
    await run();
    expect(api.getDealFiles.mock.calls.length).toBe(reads);
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
  });

  test('several new files at once is manual review, not a guess', async () => {
    addEvent();
    api.updateDealFiles.mockImplementationOnce(async (dealId, entries) => { api.dealFiles.set(dealId, [...entries.map((e) => e.id || '7000000001'), '7000000099']); return { ok: true }; });
    await run();
    expect(event(1).lastError).toMatch(/^manual_review_required:several_new_files/);
    expect(share().status).toBe('ambiguous');
  });
});

// ---- retries and failures -------------------------------------------------------------------------------------------------------------------
describe('retries and failure handling', () => {
  test('a rate limit is retried automatically with the delays 1, 5, 15 and 60 minutes, then the share fails for good', async () => {
    addEvent();
    api.updateDealFiles.mockRejectedValue(refusal('QUERY_LIMIT_EXCEEDED', 'Too many requests'));
    let expectedDelay;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await run();
      expectedDelay = RETRY_DELAYS_SECONDS[attempt - 1];
      expect(share()).toMatchObject({ status: 'authorized', attempts: attempt, tryCount: attempt + 1 });
      const scheduled = eventsOf(realStore.ATTACH_EVENT).find((e) => e.payload.tryNumber === attempt + 1);
      expect(scheduled).toMatchObject({ status: 'pending', key: `bitrix.deal.document.attach:share:1:try:${attempt + 1}` });
      expect(scheduled.nextAt).toBe(now + expectedDelay * 1000);
      expect(notify).not.toHaveBeenCalled(); // no alert while retries remain
      now += expectedDelay * 1000 + 1;
    }
    await run(); // the fifth and last attempt
    expect(share()).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, lastError: 'bitrix_error' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(auditActions()).toContain('bitrix.deal.document.failed');
    expect(eventsOf(realStore.ATTACH_EVENT)).toHaveLength(MAX_ATTEMPTS);
    expect(api.updateDealFiles).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  test('a refusal that more attempts cannot fix (a missing field, no permission) fails at once and raises the alert', async () => {
    addEvent();
    api.updateDealFiles.mockRejectedValueOnce(refusal('ERROR_CORE', 'Field is invalid'));
    await run();
    expect(share()).toMatchObject({ status: 'failed', lastError: 'bitrix:bitrix_error', attempts: 1 });
    expect(event(1)).toMatchObject({ status: 'failed', lastError: 'bitrix:bitrix_error' });
    expect(eventsOf(realStore.ATTACH_EVENT)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/\[ALERT\].*attachment failed/));
  });

  test('a failed Deal read is retried; a Deal that does not exist is a final failure', async () => {
    addEvent();
    api.getDealFiles.mockResolvedValueOnce({ status: 'uncertain', reason: 'timeout' });
    await run();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(share()).toMatchObject({ status: 'authorized', attempts: 1, lastError: 'read_failed:timeout' });

    world.shares.set(1, newShare());
    world.events.length = 0;
    addEvent();
    api.getDealFiles.mockResolvedValueOnce({ status: 'not_found' });
    await run();
    expect(share()).toMatchObject({ status: 'failed', lastError: 'deal_not_found' });
  });

  test('the alert text holds identifiers only: no file name, no patient data, no URL or token', async () => {
    addEvent();
    api.updateDealFiles.mockRejectedValueOnce(refusal('ERROR_CORE', 'Field is invalid'));
    await run();
    const { subject, text } = notify.mock.calls[0][0];
    for (const secret of ['report.pdf', 'Asha', 'http', 'token', 'HC-D31', '%PDF']) expect(`${subject} ${text}`).not.toContain(secret);
    expect(text).toContain('CASE-3207');
    for (const entry of world.audit) for (const secret of ['report.pdf', 'Asha', 'http', '%PDF']) expect(JSON.stringify(entry)).not.toContain(secret);
  });

  test('a problem sending the alert never undoes or blocks the failure that is recorded', async () => {
    addEvent();
    notify.mockRejectedValue(new Error('smtp down'));
    api.updateDealFiles.mockRejectedValueOnce(refusal('ERROR_CORE', 'bad'));
    await expect(run()).resolves.toEqual({ active: true, claimed: 1 });
    expect(share().status).toBe('failed');
  });

  test('the result and the next attempt are written together: if the audit entry cannot be written nothing changes', async () => {
    addEvent();
    prisma.tx.auditLog.create.mockRejectedValueOnce(new Error('disk full'));
    await run();
    expect(share().status).toBe('attaching'); // only the evidence written before the call; the result was rolled back
    expect(event(1).status).toBe('processing'); // left for lease recovery
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('left for lease recovery'));
  });

  test('a worker that lost its lease writes nothing (the fence)', async () => {
    addEvent();
    store.writeResult.mockResolvedValueOnce(0);
    await run();
    expect(share().status).toBe('attaching');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('lease lost'));
    expect(world.audit).toEqual([]);
  });

  test('if the lease is too short for the call, no call is made', async () => {
    addEvent();
    store.markExternalCallStarted.mockResolvedValueOnce(false);
    await run();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('lease too short'));
  });

  test('the Admin retry (a new event for a failed share) works like a first attempt', async () => {
    addEvent();
    api.updateDealFiles.mockRejectedValueOnce(refusal('ERROR_CORE', 'bad'));
    await run();
    expect(share().status).toBe('failed');
    // what retryShare does: status back to authorized, a new event with a new key
    world.shares.set(1, { ...share(), status: 'authorized', attempts: 0, tryCount: 2, lastError: null });
    addEvent({ entityId: '1:attach:2', payload: { shareId: 1, caseId: 7, tryNumber: 2 } });
    await run();
    expect(share().status).toBe('attached');
  });
});

// ---- revocation ----------------------------------------------------------------------------------------------------------------------------
describe('revoking a share', () => {
  const attached = (over = {}) => world.shares.set(1, newShare({ status: 'revoking', bitrixFileId: '7000000001', fileIdsBefore: ['1001', '1002'], tryCount: 2, revokedByAdminId: 3, revokeReason: 'sent by mistake', ...over }));
  const removeEvent = (over = {}) => addEvent({ eventType: realStore.REMOVE_EVENT, entityId: '1:remove:2', payload: { shareId: 1, caseId: 7, tryNumber: 2 }, ...over });

  test('removes ONLY our file from the Deal, keeps every other file, and marks the share revoked', async () => {
    attached();
    api.dealFiles.set(DEAL_ID, ['1001', '7000000001', '1002']); // Operations files on both sides of ours
    removeEvent();
    await run();
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['1001', '1002']);
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
    expect(api.updateDealFiles.mock.calls[0][1]).toEqual([{ id: '1001' }, { id: '1002' }]);
    expect(share()).toMatchObject({ status: 'revoked', bitrixFileId: '7000000001', lastError: null });
    expect(share().revokedAt).toBeInstanceOf(Date);
    expect(share().revokedByAdminId).toBe(3); // who revoked and why stay on the record
    expect(share().revokeReason).toBe('sent by mistake');
    expect(event(1)).toMatchObject({ status: 'completed' });
    expect(auditActions()).toEqual(['bitrix.deal.document.revoked']);
  });

  test('the HumanCare original, its checksum and its review are untouched, and the file is never read or deleted', async () => {
    attached();
    api.dealFiles.set(DEAL_ID, ['7000000001']);
    removeEvent();
    await run();
    expect(world.documents.get(31)).toEqual(newDocument());
    expect(readFile).not.toHaveBeenCalled();
  });

  test('Operations is told that a previously shared document was removed', async () => {
    attached();
    api.dealFiles.set(DEAL_ID, ['1001', '7000000001']);
    removeEvent();
    await run();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].subject).toMatch(/document removed from the Deal/);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('[ALERT]'));
  });

  test('when ours is the only file the empty list is sent (the read proved it), and the Deal ends empty', async () => {
    attached();
    api.dealFiles.set(DEAL_ID, ['7000000001']);
    removeEvent();
    await run();
    expect(api.updateDealFiles.mock.calls[0][1]).toEqual([]);
    expect(api.updateDealFiles.mock.calls[0][2]).toMatchObject({ allowEmpty: true });
    expect(share().status).toBe('revoked');
  });

  test('a file that is already gone from the Deal needs no update: revoked', async () => {
    attached();
    api.dealFiles.set(DEAL_ID, ['1001', '1002']);
    removeEvent();
    await run();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(share().status).toBe('revoked');
    expect(world.audit[0].reasonCode).toBe('already_absent');
  });

  test('a share that was never sent is revoked without touching Bitrix at all', async () => {
    world.shares.set(1, newShare({ status: 'revoking', tryCount: 2 }));
    removeEvent();
    await run();
    expect(api.getDealFiles).not.toHaveBeenCalled();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(share().status).toBe('revoked');
    expect(notify).not.toHaveBeenCalled(); // nothing was ever shared, so nothing was removed
  });

  test('after an uncertain upload nothing is removed unless no new file exists: a person decides which file is ours', async () => {
    world.shares.set(1, newShare({ status: 'revoking', tryCount: 2, fileIdsBefore: ['1001', '1002'] }));
    api.dealFiles.set(DEAL_ID, ['1001', '1002', '7000000001']);
    removeEvent();
    await run();
    expect(api.updateDealFiles).not.toHaveBeenCalled();
    expect(event(1).lastError).toMatch(/^manual_review_required:file_not_identified/);
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['1001', '1002', '7000000001']); // Operations' files and the unknown one are all untouched
    expect(notify).toHaveBeenCalledTimes(1);

    world.shares.set(1, newShare({ status: 'revoking', tryCount: 2, fileIdsBefore: ['1001', '1002'] }));
    api.dealFiles.set(DEAL_ID, ['1001', '1002']);
    removeEvent({ entityId: '1:remove:3' });
    await run();
    expect(share().status).toBe('revoked'); // the upload never arrived
  });

  test('waits while an attach attempt of the same share is running', async () => {
    attached();
    addEvent({ status: 'processing', lockedBy: 'worker-B', lockedUntil: now + 60000, attempts: 1 }); // the attach event
    removeEvent();
    await run();
    expect(api.getDealFiles).not.toHaveBeenCalled();
    expect(event(2)).toMatchObject({ status: 'pending', lastError: 'attach_in_progress' });
  });

  test('a removal that is not confirmed is retried, and after the last attempt becomes "revoke_failed" with an alert', async () => {
    attached();
    api.dealFiles.set(DEAL_ID, ['1001', '7000000001']);
    api.updateDealFiles.mockImplementation(async () => ({ ok: true })); // Bitrix accepts but the file stays
    removeEvent();
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await run();
      expect(share()).toMatchObject({ status: 'revoking', attempts: attempt, lastError: 'removal_not_confirmed' });
      now += RETRY_DELAYS_SECONDS[attempt - 1] * 1000 + 1;
    }
    await run();
    expect(share()).toMatchObject({ status: 'revoke_failed', attempts: MAX_ATTEMPTS });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].subject).toMatch(/removal failed/);
    expect(world.documents.get(31)).toEqual(newDocument());
  });

  test('a timeout while removing is reconciled by reading: gone -> revoked, never a second blind update', async () => {
    attached();
    api.dealFiles.set(DEAL_ID, ['1001', '7000000001']);
    const apply = api.updateDealFiles.getMockImplementation();
    api.updateDealFiles.mockImplementationOnce(async (...args) => { await apply(...args); throw timeout(); });
    removeEvent();
    await run();
    expect(event(1).status).toBe('ambiguous');
    expect(share().status).toBe('revoking');
    now += (RECONCILE_FIRST_DELAY_SECONDS + 1) * 1000;
    await run();
    expect(api.updateDealFiles).toHaveBeenCalledTimes(1);
    expect(share().status).toBe('revoked');
  });

  test('a revoke that arrives while the attach is still running is never overwritten by the attach result', async () => {
    addEvent();
    // The Admin revokes (status revoking, tryCount 2) after the attach attempt started but before it recorded its result.
    const original = api.updateDealFiles.getMockImplementation();
    api.updateDealFiles.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      Object.assign(world.shares.get(1), { status: 'revoking', tryCount: 2 });
      return result;
    });
    await run();
    expect(share().status).toBe('revoking'); // the revocation stands
    expect(share().bitrixFileId).toBe('7000000001'); // and the file we added is known, so the removal can find it
    removeEvent();
    await run();
    expect(share().status).toBe('revoked');
    expect(api.dealFiles.get(DEAL_ID)).toEqual(['1001', '1002']);
  });

  test('a revoked share can be authorized again later as a new generation without touching the old one', async () => {
    world.shares.set(1, newShare({ status: 'revoked', bitrixFileId: '6999999999' }));
    world.shares.set(2, newShare({ id: 2, generation: 2, shareToken: 'HC-D31G2-aaaaaaaa' }));
    addEvent({ entityId: '2:attach:1', payload: { shareId: 2, caseId: 7, tryNumber: 1 } });
    api.dealFiles.set(DEAL_ID, ['1001', '1002']);
    await run();
    expect(share(2).status).toBe('attached');
    expect(share(1)).toMatchObject({ status: 'revoked', bitrixFileId: '6999999999' });
    expect(share(2).bitrixFileId).not.toBe(share(1).bitrixFileId);
  });
});

// ---- scope and isolation --------------------------------------------------------------------------------------------------------------------
describe('scope and isolation', () => {
  test('a scoped pass handles only the named Cases\' document events', async () => {
    world.shares.set(2, newShare({ id: 2, requestDocumentId: 32, shareToken: 'HC-D32G1-aaaaaaaa' }));
    world.documents.set(32, newDocument({ id: 32 }));
    addEvent({ caseId: 7 });
    addEvent({ caseId: 8, entityId: '2:attach:1', payload: { shareId: 2, caseId: 8, tryNumber: 1 } });
    await run({ scope: { caseIds: [7] } });
    expect(share(1).status).toBe('attached');
    expect(share(2).status).toBe('authorized');
    expect(event(2)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(store.recoverExpiredLeases).toHaveBeenCalledWith(prisma, expect.objectContaining({ caseIds: [7] }));
    for (const call of store.findCandidateIds.mock.calls) expect(call[3]).toEqual({ caseIds: [7] });
  });

  test('Deal-creation events are never offered or touched by the document worker', async () => {
    addEvent({ eventType: 'bitrix.deal.create', entityType: 'case', entityId: '7', payload: { caseId: 7 } });
    await run();
    expect(event(1)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(api.getDealFiles).not.toHaveBeenCalled();
  });

  test('an unknown share or event type is a final failure of that event only', async () => {
    addEvent({ payload: { shareId: 999, caseId: 7, tryNumber: 1 } });
    await run();
    expect(event(1)).toMatchObject({ status: 'failed', lastError: 'share_missing' });
  });

  test('the worker never contacts Bitrix itself when the injected API is the fake (no network)', async () => {
    addEvent();
    await run();
    expect(api.isFake).toBe(true);
    expect(api.calls.map((c) => c.method)).toEqual(['crm.item.get', 'crm.item.update', 'crm.item.get']);
  });
});
