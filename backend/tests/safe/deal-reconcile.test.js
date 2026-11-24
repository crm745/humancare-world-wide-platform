/* global describe, test, expect, jest, beforeEach */
// The reconciliation sweep for missed Bitrix24 Deal webhooks. No database, no network: Prisma and the Bitrix client
// are fakes. The sweep never changes a Case; it only stores inbox events for the normal processor.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const { reconcileDeals, BATCH_SIZE, MIN_RECHECK_MINUTES, MAX_CONSECUTIVE_FAILURES, identityOf } = require('../../src/modules/bitrix/deal-reconcile.service');
const job = require('../../src/jobs/bitrix-deal-reconcile.job');

const ENV_ON = { BITRIX_DEAL_PROFILE: 'test', BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' };
const REF_FIELD = 'UF_CRM_1794548440549';
const NOW = Date.UTC(2030, 0, 10, 12, 0, 0);

const mkLink = (n, over = {}) => ({
  id: n, caseId: 100 + n, bitrixDealId: String(5000 + n), stageId: 'C38:NEW', externalModifiedAt: new Date('2030-01-01T00:00:00Z'), lastAttemptAt: null,
  case: { id: 100 + n, referenceNumber: `HC-PC-${n}`, serviceRequestId: n, serviceRequest: { id: n, serviceKey: 'privatecharter', reviewStatus: 'in_review', bitrixLeadId: null } },
  ...over,
});
const mkDeal = (link, over = {}) => ({ ID: link.bitrixDealId, CATEGORY_ID: '38', STAGE_ID: 'C38:EXECUTING', DATE_MODIFY: '2030-01-05T10:00:00+00:00', [REF_FIELD]: link.case.referenceNumber, ...over });

let links; let queued; let prisma; let api; let log;
const run = (extra = {}) => reconcileDeals({ prisma, api, env: ENV_ON, log, now: () => NOW, ...extra });

beforeEach(() => {
  links = [mkLink(1)]; queued = new Set();
  prisma = {
    bitrixDealLink: { findMany: jest.fn(async () => links), update: jest.fn(async () => ({})) },
    integrationInbox: {
      create: jest.fn(async ({ data }) => {
        if (queued.has(data.externalEventId)) throw Object.assign(new Error('dup'), { code: 'P2002' });
        queued.add(data.externalEventId);
      }),
    },
  };
  log = { warn: jest.fn(), error: jest.fn() };
  api = { getDeal: jest.fn(async (id) => ({ status: 'ok', deal: mkDeal(links.find((l) => l.bitrixDealId === id)) })) };
});

describe('switches', () => {
  test.each([[{}], [{ BITRIX_SYNC_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }], [{ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' }]])('%j: no query, no read, no event', async (env) => {
    expect(await run({ env })).toEqual({ active: false, checked: 0, queued: 0 });
    expect(prisma.bitrixDealLink.findMany).not.toHaveBeenCalled();
    expect(api.getDeal).not.toHaveBeenCalled();
  });
});

describe('what it considers', () => {
  test('only linked, open, Private Charter, workflow, Lead-free Cases not checked recently; oldest check first; bounded', async () => {
    await run();
    const query = prisma.bitrixDealLink.findMany.mock.calls[0][0];
    expect(query.where.bitrixDealId).toEqual({ not: null });
    // Only the active profile's links (a link with no stamp reads as test), and only those not checked recently.
    expect(query.where.AND).toEqual([
      { OR: [{ profile: null }, { profile: 'test' }] },
      { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: new Date(NOW - MIN_RECHECK_MINUTES * 60 * 1000) } }] },
    ]);
    expect(query.where.case.is.status).toEqual({ notIn: ['completed', 'cancelled'] });
    expect(query.where.case.is.serviceRequest.is).toEqual({ serviceKey: 'privatecharter', reviewStatus: { not: null }, bitrixLeadId: null });
    expect(query.orderBy).toEqual({ lastAttemptAt: 'asc' });
    expect(query.take).toBe(BATCH_SIZE);
    expect(BATCH_SIZE).toBe(10);
    expect(MIN_RECHECK_MINUTES).toBe(15);
  });
  test('the job is slow: every 10 minutes, never on start', () => {
    expect(job).toMatchObject({ name: 'bitrix-deal-reconcile', intervalMs: 10 * 60 * 1000, runOnStart: false });
  });
  test('an ineligible Case that slipped through is skipped without asking Bitrix', async () => {
    links[0].case.serviceRequest.serviceKey = 'ground';
    expect(await run()).toMatchObject({ checked: 1, queued: 0 });
    expect(api.getDeal).not.toHaveBeenCalled();
  });
});

describe('what it queues', () => {
  test('a Deal whose stage changed since the last applied state becomes ONE inbox event for the normal processor', async () => {
    expect(await run()).toEqual({ active: true, checked: 1, queued: 1 });
    const data = prisma.integrationInbox.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ source: 'bitrix24', eventType: 'ONCRMDEALUPDATE', entityType: 'deal', entityId: '5001', status: 'received', payload: { event: 'RECONCILE', dealId: '5001', ts: '2030-01-05T10:00:00.000Z' } });
    expect(data.externalEventId).toBe(identityOf('5001', 'C38:EXECUTING', '2030-01-05T10:00:00.000Z'));
    expect(JSON.stringify(data)).not.toMatch(/HC-PC|Asha/);
  });
  test('an unchanged Deal queues nothing', async () => {
    links[0].stageId = 'C38:EXECUTING';
    links[0].externalModifiedAt = new Date('2030-01-05T10:00:00Z');
    expect(await run()).toMatchObject({ checked: 1, queued: 0 });
    expect(prisma.integrationInbox.create).not.toHaveBeenCalled();
  });
  test('repeated passes over the same change store one event', async () => {
    await run(); await run(); await run();
    expect(queued.size).toBe(1);
  });
  test('a new change to the Deal (new modified time) is a new event', async () => {
    await run();
    api.getDeal.mockResolvedValue({ status: 'ok', deal: mkDeal(links[0], { DATE_MODIFY: '2030-01-06T10:00:00+00:00' }) });
    await run();
    expect(queued.size).toBe(2);
  });
  test('a link with no recorded modified time (an adopted Deal) is queued once so the processor can settle it', async () => {
    links[0].externalModifiedAt = null; links[0].stageId = 'C38:EXECUTING';
    expect((await run()).queued).toBe(1);
  });
  test('an unknown stage is still queued: the processor quarantines it (and a repeat is not queued again)', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: mkDeal(links[0], { STAGE_ID: 'C38:UC_1PK4XX' }) });
    await run(); await run();
    expect(queued.size).toBe(1);
  });
});

describe('verification before anything is queued', () => {
  test.each([
    ['another Deal ID', { ID: '9' }], ['another category', { CATEGORY_ID: '12' }], ['another reference', { [REF_FIELD]: 'HC-PC-OTHER' }],
    ['no modified time', { DATE_MODIFY: undefined }], ['an unreadable modified time', { DATE_MODIFY: 'later' }],
  ])('%s: nothing is queued', async (_name, over) => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: mkDeal(links[0], over) });
    expect(await run()).toMatchObject({ checked: 1, queued: 0 });
    expect(prisma.integrationInbox.create).not.toHaveBeenCalled();
  });
  test('a Deal Bitrix cannot find is not queued', async () => {
    api.getDeal.mockResolvedValue({ status: 'not_found' });
    expect((await run()).queued).toBe(0);
  });
});

describe('bounded and gentle', () => {
  test('every link looked at is marked, so none is checked again within the window and a failing one cannot starve the rest', async () => {
    api.getDeal.mockResolvedValue({ status: 'uncertain', reason: 'timeout' });
    await run();
    expect(prisma.bitrixDealLink.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { lastAttemptAt: new Date(NOW) } });
  });
  test('at most one read per link and never more than a batch', async () => {
    links = Array.from({ length: BATCH_SIZE }, (_, i) => mkLink(i + 1));
    await run();
    expect(api.getDeal).toHaveBeenCalledTimes(BATCH_SIZE);
  });
  test('after consecutive failed reads the pass stops (Bitrix is unreachable)', async () => {
    links = Array.from({ length: BATCH_SIZE }, (_, i) => mkLink(i + 1));
    api.getDeal.mockResolvedValue({ status: 'uncertain', reason: 'timeout' });
    const result = await run();
    expect(api.getDeal).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
    expect(result.checked).toBe(MAX_CONSECUTIVE_FAILURES);
  });
  test('a success resets the failure count', async () => {
    links = Array.from({ length: 6 }, (_, i) => mkLink(i + 1));
    let n = 0;
    api.getDeal.mockImplementation(async (id) => (++n % 3 === 0 ? { status: 'ok', deal: mkDeal(links.find((l) => l.bitrixDealId === id)) } : { status: 'uncertain', reason: 'timeout' }));
    await run();
    expect(api.getDeal).toHaveBeenCalledTimes(6);
  });
  test('it never writes a Case, creates a Deal, Lead or Case, or touches anything but the link marker and the inbox', async () => {
    expect(Object.keys(api)).toEqual(['getDeal']);
    expect(Object.keys(prisma).sort()).toEqual(['bitrixDealLink', 'integrationInbox']);
    expect(Object.keys(prisma.bitrixDealLink).sort()).toEqual(['findMany', 'update']);
  });
  test('logs hold only the Deal ID and a code', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: mkDeal(links[0], { [REF_FIELD]: 'x', TITLE: 'Asha Rao' }) });
    await run();
    expect(log.warn.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/Asha|HC-PC/);
  });
});
