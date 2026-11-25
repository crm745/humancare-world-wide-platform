/* global describe, test, expect, jest, beforeEach, afterEach */
// The actual Air Ambulance profile (Category 0) and the test profile (Category 38) through every Bitrix service: event stamping and
// cross-profile refusal, Deal creation payloads, inbound stage mapping, reconciliation, recovery, the reference lookup and quotation
// synchronization. Safe by construction: no database, no network, no .env; fake prisma, store and Bitrix client.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { ACTUAL_PROFILE, TEST_PROFILE, ACTUAL_STAGES, ACTUAL_FIELD } = require('../../src/modules/bitrix/bitrix-profiles');
const { runDealWorker } = require('../../src/modules/bitrix/deal-worker.service');
const { processInboxEvent } = require('../../src/modules/bitrix/deal-inbox.service');
const { reconcileDeals } = require('../../src/modules/bitrix/deal-reconcile.service');
const { recoverDealEvent, REASON_CODES } = require('../../src/modules/bitrix/deal-recovery.service');
const { processQuotationEvent } = require('../../src/modules/bitrix/quotation-sync.service');
const { detectAndEnqueueQuotationSync } = require('../../src/modules/bitrix/quotation-outbox');
const { ensureDealCreation, enqueueDealCreation } = require('../../src/modules/bitrix/deal-outbox');
const outboxStore = require('../../src/modules/bitrix/deal-outbox.store');
const quotationStore = require('../../src/modules/bitrix/quotation-sync.store');
const inboxStore = require('../../src/modules/bitrix/deal-inbox.store');
const api = require('../../src/modules/bitrix/bitrix-deal.api');

const REF = 'HC-PC-000123';
const SWITCHES = { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' };
const ENV_ACTUAL = { ...SWITCHES, BITRIX_DEAL_PROFILE: 'actual' };
const ENV_TEST = { ...SWITCHES, BITRIX_DEAL_PROFILE: 'test' };
const quiet = () => ({ warn: jest.fn(), error: jest.fn(), log: jest.fn(), info: jest.fn() });

// ================================================================ Deal creation (worker) ======================================================
function requestRow(over = {}) {
  return {
    id: 3, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null, patientName: 'Asha Rao', patientAge: 54, patientGender: 'female',
    patientContact: '+919812345678', travelType: 'patient_transfer', origin: 'Mumbai, Maharashtra, India', destination: 'Smallville', description: 'Post-angioplasty.',
    criticalLevel: 'icu,ecmo', oxygenRequired: true, oxygenFlowLpm: 4, country: 'IN', preferredDate: new Date('2030-03-05T00:00:00Z'), ...over,
  };
}

function workerWorld({ payload, link = {}, fromStatus = 'pending', callStarted = null, request = {} }) {
  const state = { linkUpdates: [], results: [], audit: [] };
  const tx = {
    bitrixDealLink: { update: jest.fn(async ({ data }) => { state.linkUpdates.push(data); }) },
    auditLog: { create: jest.fn(async ({ data }) => { state.audit.push(data); }) },
  };
  const prisma = {
    $transaction: jest.fn(async (callback) => callback(tx)),
    case: {
      findUnique: jest.fn(async () => ({
        id: 7, referenceNumber: REF, serviceRequestId: 3, patientName: 'Asha Rao', serviceRequest: requestRow(request),
        bitrixDealLink: { id: 1, caseId: 7, bitrixDealId: null, ...link },
      })),
    },
  };
  const claimObject = { id: 1, fromStatus, workerId: 'w', attempts: 1, caseId: 7, externalCallStartedAt: callStarted, secondsSinceCall: callStarted == null ? null : 10, payload };
  const store = {
    MANUAL_REVIEW_PREFIX: outboxStore.MANUAL_REVIEW_PREFIX,
    recoverExpiredLeases: jest.fn(async () => undefined),
    findCandidateIds: jest.fn(async (_db, status) => (status === fromStatus ? [1] : [])),
    claim: jest.fn(async () => ({ ...claimObject })),
    markExternalCallStarted: jest.fn(async () => true),
    writeResult: jest.fn(async (_db, _claim, result) => { state.results.push(result); return 1; }),
  };
  const bitrix = {
    createDeal: jest.fn(async () => ({ dealId: '48213' })),
    findDealsByReference: jest.fn(async () => ({ status: 'single', dealIds: ['48213'], stageId: 'NEW' })),
  };
  return { prisma, store, bitrix, state };
}

const runWorker = (world, env) => runDealWorker({ prisma: world.prisma, store: world.store, api: world.bitrix, env, log: quiet(), workerId: 'w', reportFailures: async () => 0 });

describe('Deal creation: the profile selects category, stage and field mapping', () => {
  test('the actual profile creates a Category 0 Deal from the Private Charter fields and links it as actual', async () => {
    const world = workerWorld({ payload: { caseId: 7, profile: 'actual' }, link: { profile: 'actual' } });
    expect(await runWorker(world, ENV_ACTUAL)).toEqual({ active: true, claimed: 1 });
    expect(world.bitrix.createDeal).toHaveBeenCalledTimes(1);
    const [fields] = world.bitrix.createDeal.mock.calls[0];
    expect(fields).toMatchObject({
      TITLE: REF, CATEGORY_ID: 0, STAGE_ID: 'NEW', [ACTUAL_FIELD.CASE_REFERENCE]: REF, [ACTUAL_FIELD.PATIENT_NAME]: 'Asha Rao', [ACTUAL_FIELD.GENDER]: 6040, [ACTUAL_FIELD.TRAVEL_TYPE]: 6044,
      [ACTUAL_FIELD.CRITICAL_LEVEL]: [6048, 6054], [ACTUAL_FIELD.OXYGEN_REQUIRED]: 6056, [ACTUAL_FIELD.OXYGEN_FLOW_LPM]: 4,
      [ACTUAL_FIELD.ORIGIN_CITY]: 'Mumbai, Maharashtra, India', [ACTUAL_FIELD.DESTINATION_CITY]: 'Smallville',
    });
    expect(fields).not.toHaveProperty(ACTUAL_FIELD.MEDICAL_REPORT);
    expect(fields).not.toHaveProperty('UF_CRM_1794548440549'); // no test-pipeline field
    expect(world.state.linkUpdates[0]).toMatchObject({ bitrixDealId: '48213', categoryId: '0', profile: 'actual', stageId: 'NEW', syncStatus: 'synced' });
  });

  test('the test profile still creates the Category 38 Deal, now stamped as test', async () => {
    const world = workerWorld({ payload: { caseId: 7, profile: 'test' }, link: { profile: 'test' } });
    await runWorker(world, ENV_TEST);
    const [fields] = world.bitrix.createDeal.mock.calls[0];
    expect(fields).toMatchObject({ TITLE: REF, CATEGORY_ID: 38, STAGE_ID: 'C38:NEW', UF_CRM_1794548440549: REF });
    for (const id of Object.values(ACTUAL_FIELD)) expect(fields).not.toHaveProperty(id);
    expect(world.state.linkUpdates[0]).toMatchObject({ bitrixDealId: '48213', categoryId: '38', profile: 'test', stageId: 'C38:NEW' });
  });

  test('a legacy event and link (no stamp) are test records and are created on the test pipeline only', async () => {
    const world = workerWorld({ payload: { caseId: 7 }, link: {} });
    await runWorker(world, ENV_TEST);
    expect(world.bitrix.createDeal.mock.calls[0][0].CATEGORY_ID).toBe(38);
    const actual = workerWorld({ payload: { caseId: 7 }, link: {} });
    await runWorker(actual, ENV_ACTUAL);
    expect(actual.bitrix.createDeal).not.toHaveBeenCalled();
  });

  test('an actual request that cannot be mapped fails before any Bitrix call', async () => {
    const world = workerWorld({ payload: { caseId: 7, profile: 'actual' }, link: { profile: 'actual' }, request: { patientGender: 'unknown' } });
    await runWorker(world, ENV_ACTUAL);
    expect(world.bitrix.createDeal).not.toHaveBeenCalled();
    expect(world.state.results[0]).toMatchObject({ status: 'failed', lastError: 'mapping:gender_unknown' });
  });

  test('a Commercial Charter request is never built for the actual pipeline', async () => {
    const world = workerWorld({ payload: { caseId: 7, profile: 'actual' }, link: { profile: 'actual' }, request: { serviceKey: 'commercialair_stretcher' } });
    await runWorker(world, ENV_ACTUAL);
    expect(world.bitrix.createDeal).not.toHaveBeenCalled();
  });
});

describe('cross-profile rejection (worker)', () => {
  test.each([
    ['a test-stamped event under the actual profile', { caseId: 7, profile: 'test' }, {}, ENV_ACTUAL],
    ['an actual-stamped event under the test profile', { caseId: 7, profile: 'actual' }, {}, ENV_TEST],
    ['an actual event whose Case link belongs to the test profile', { caseId: 7, profile: 'actual' }, { profile: 'test' }, ENV_ACTUAL],
    ['a test event whose Case link belongs to the actual profile', { caseId: 7, profile: 'test' }, { profile: 'actual' }, ENV_TEST],
    ['an event with an unknown profile stamp', { caseId: 7, profile: 'staging' }, {}, ENV_TEST],
    ['no profile configured at all', { caseId: 7, profile: 'test' }, { profile: 'test' }, SWITCHES],
  ])('%s sends nothing', async (_name, payload, link, env) => {
    const world = workerWorld({ payload, link });
    await runWorker(world, env);
    expect(world.bitrix.createDeal).not.toHaveBeenCalled();
    expect(world.bitrix.findDealsByReference).not.toHaveBeenCalled();
    expect(world.state.results).toEqual([]);
  });
});

describe('reconciliation after an uncertain create looks only in the profile\'s own pipeline', () => {
  test('actual: the lookup carries the actual category and the dedicated Case Reference field, and the Deal is linked as actual', async () => {
    const world = workerWorld({ payload: { caseId: 7, profile: 'actual' }, link: { profile: 'actual' }, fromStatus: 'ambiguous', callStarted: 1 });
    await runWorker(world, ENV_ACTUAL);
    expect(world.bitrix.findDealsByReference).toHaveBeenCalledWith(REF, { env: ENV_ACTUAL, profile: ACTUAL_PROFILE });
    expect(world.bitrix.createDeal).not.toHaveBeenCalled();
    expect(world.state.linkUpdates[0]).toMatchObject({ bitrixDealId: '48213', categoryId: '0', profile: 'actual' });
  });
  test('test: the lookup call is exactly what it always was', async () => {
    const world = workerWorld({ payload: { caseId: 7, profile: 'test' }, link: { profile: 'test' }, fromStatus: 'ambiguous', callStarted: 1 });
    await runWorker(world, ENV_TEST);
    expect(world.bitrix.findDealsByReference).toHaveBeenCalledWith(REF, { env: ENV_TEST });
  });
});

// ================================================================ the reference lookup (client) =================================================
describe('findDealsByReference: profile-specific category and reference field, no cross-profile matches', () => {
  const env = { ...SWITCHES, BITRIX24_WEBHOOK_URL: 'https://fake-bitrix.invalid/rest/1/FAKE_TOKEN/' };
  const reply = (body) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
  const fetching = (result) => { const bodies = []; const fetchImpl = jest.fn(async (_u, init) => { bodies.push(JSON.parse(init.body)); return reply({ result }); }); return { bodies, fetchImpl }; };

  test('actual: filters Category 0 on the exact Case Reference field and verifies what comes back', async () => {
    const { bodies, fetchImpl } = fetching([{ ID: '555', CATEGORY_ID: '0', STAGE_ID: 'UC_R55CKV', UF_CRM_1795176618: REF }]);
    expect(await api.findDealsByReference(REF, { env, fetchImpl, profile: ACTUAL_PROFILE })).toEqual({ status: 'single', dealIds: ['555'], stageId: 'UC_R55CKV' });
    expect(bodies[0].filter).toEqual({ CATEGORY_ID: 0, '=UF_CRM_1795176618': REF });
    expect(bodies[0].select).toEqual(['ID', 'CATEGORY_ID', 'STAGE_ID', 'UF_CRM_1795176618']);
  });
  test('actual: a Deal of the test pipeline is never matched, even with the same reference', async () => {
    const { fetchImpl } = fetching([{ ID: '9', CATEGORY_ID: '38', STAGE_ID: 'C38:NEW', UF_CRM_1795176618: REF, UF_CRM_1794548440549: REF }]);
    expect(await api.findDealsByReference(REF, { env, fetchImpl, profile: ACTUAL_PROFILE })).toMatchObject({ status: 'uncertain', reason: 'filter_not_honoured' });
  });
  test('test: a Category 0 Deal is never matched either, and the default call is the unchanged Category 38 lookup', async () => {
    const other = fetching([{ ID: '555', CATEGORY_ID: '0', STAGE_ID: 'NEW', UF_CRM_1795176618: REF }]);
    expect(await api.findDealsByReference(REF, { env, fetchImpl: other.fetchImpl })).toMatchObject({ status: 'uncertain', reason: 'filter_not_honoured' });
    expect(other.bodies[0].filter).toEqual({ CATEGORY_ID: 38, '=UF_CRM_1794548440549': REF });
    const own = fetching([{ ID: '9', CATEGORY_ID: '38', STAGE_ID: 'C38:NEW', UF_CRM_1794548440549: REF }]);
    expect(await api.findDealsByReference(REF, { env, fetchImpl: own.fetchImpl })).toEqual({ status: 'single', dealIds: ['9'], stageId: 'C38:NEW' });
  });
  test('an unusable profile is refused without a call', async () => {
    const { fetchImpl } = fetching([]);
    for (const profile of [{ categoryId: '0', referenceField: 'UF_CRM_1795176618' }, { categoryId: -1, referenceField: 'UF_CRM_1795176618' }, { categoryId: 0, referenceField: 'TITLE' }, { categoryId: 0, referenceField: 'x; DROP' }, { categoryId: 0 }]) {
      expect(await api.findDealsByReference(REF, { env, fetchImpl, profile })).toMatchObject({ status: 'uncertain', reason: 'profile_invalid' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ================================================================ inbound stage processing ======================================================
function inboxWorld({ env = ENV_ACTUAL, linkProfile = 'actual', deal = {}, caseStatus = 'submitted', caseStage = null }) {
  const caseRecord = {
    id: 7, referenceNumber: REF, status: caseStatus, serviceRequestId: 3,
    serviceRequest: { id: 3, userId: 9, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null },
  };
  const link = { id: 1, caseId: 7, bitrixDealId: '555', profile: linkProfile, stageId: null, externalModifiedAt: null, case: caseRecord };
  const state = { notifications: [], caseUpdates: [], requestUpdates: [], stageEvents: [], results: [], audit: [], linkUpdates: [] };
  const tx = {
    $queryRaw: jest.fn(async () => [{ id: 7, status: caseStatus, charter_stage: caseStage, stage_version: 3 }]),
    bitrixDealLink: { findUnique: jest.fn(async () => link), update: jest.fn(async ({ data }) => { state.linkUpdates.push(data); }) },
    caseStageEvent: { findFirst: jest.fn(async () => null), create: jest.fn(async ({ data }) => { const row = { id: state.stageEvents.length + 1, ...data }; state.stageEvents.push(row); return { ...row }; }) },
    // findUnique / user / notification.findUnique: what the central notification core reads through the same transaction client.
    case: { updateMany: jest.fn(async ({ data }) => { state.caseUpdates.push(data); return { count: 1 }; }), findUnique: jest.fn(async ({ where }) => (where.id === caseRecord.id ? { id: caseRecord.id, serviceRequestId: caseRecord.serviceRequestId } : null)) },
    serviceRequest: {
      update: jest.fn(async ({ data }) => { state.requestUpdates.push(data); }),
      findUnique: jest.fn(async ({ where }) => (where.id === caseRecord.serviceRequest.id ? { id: caseRecord.serviceRequest.id, userId: caseRecord.serviceRequest.userId } : null)),
    },
    user: { findUnique: jest.fn(async ({ where }) => (where.id === caseRecord.serviceRequest.userId ? { id: where.id } : null)) },
    notification: {
      findUnique: jest.fn(async ({ where }) => state.notifications.find((n) => n.idempotencyKey === where.idempotencyKey) || null),
      create: jest.fn(async ({ data }) => { const row = { id: state.notifications.length + 1, ...data }; state.notifications.push(row); return { ...row }; }),
    },
    auditLog: { create: jest.fn(async ({ data }) => { state.audit.push(data); }) },
  };
  const prisma = {
    $transaction: jest.fn(async (callback) => callback(tx)), bitrixDealLink: { findUnique: jest.fn(async () => link) },
    user: { findUnique: jest.fn(async () => ({ pushToken: null })) },
  };
  const store = { writeResult: jest.fn(async (_db, _claim, result) => { state.results.push(result); return 1; }) };
  const bitrix = {
    getDeal: jest.fn(async () => ({
      status: 'ok', deal: { ID: '555', CATEGORY_ID: '0', UF_CRM_1795176618: REF, STAGE_ID: 'UC_R55CKV', DATE_MODIFY: '2030-01-10T10:00:00+05:30', ...deal },
    })),
  };
  const ctx = { prisma, store, api: bitrix, env, log: quiet(), enqueuePush: jest.fn(async () => ({ enqueued: 0, alreadyQueued: 0, skipped: 'no_active_devices' })), lostReasonField: 'UF_CRM_1788858985323', workerId: 'w' };
  return { ctx, tx, state, bitrix, store };
}
const claim = { id: 1, dealId: '555', attempts: 1, occurredAt: null, workerId: 'w' };

describe('inbound stage processing: the five actual stages', () => {
  test.each([
    ['NEW', 'patient_details', 'submitted', 'submitted', 'Request Received'],
    ['UC_R55CKV', 'quotation_ready', 'submitted', null, 'Quotation Ready'],
    ['UC_9E9NRI', 'payment_confirmed', 'submitted', null, 'Payment Confirmed'],
    ['UC_HS6O2F', 'in_progress', 'in_progress', 'in_progress', 'Service In Progress'],
    ['WON', 'completed', 'completed', 'completed', 'Completed'],
  ])('%s updates the Case stage to %s (status %s, request status %s) without notifying the patient', async (stageId, key, caseStatus, requestStatus, mobileLabel) => {
    const world = inboxWorld({ deal: { STAGE_ID: stageId }, caseStatus: 'submitted', caseStage: 'earlier_stage' });
    const outcome = await processInboxEvent(world.ctx, claim);
    expect(outcome).toMatchObject({ result: 'applied', stage: key });
    expect(ACTUAL_STAGES[stageId].mobileLabel).toBe(mobileLabel);
    expect(world.state.caseUpdates[0]).toMatchObject({ charterStage: key, status: caseStatus });
    expect(world.state.stageEvents[0]).toMatchObject({ stage: key, source: 'bitrix_webhook', reasonCode: `bitrix:${stageId}` });
    expect(world.state.requestUpdates.map((u) => u.status)).toEqual(requestStatus ? [requestStatus] : []);
    expect(world.state.linkUpdates[0]).toMatchObject({ stageId });
    expect(world.tx.notification.create).not.toHaveBeenCalled(); // no patient notification until approved
    expect(world.ctx.enqueuePush).not.toHaveBeenCalled();
  });
  test('Case Completed closes the Case (closedAt is set)', async () => {
    const world = inboxWorld({ deal: { STAGE_ID: 'WON' }, caseStage: 'in_progress', caseStatus: 'in_progress' });
    await processInboxEvent(world.ctx, claim);
    expect(world.state.caseUpdates[0].closedAt).toBeInstanceOf(Date);
  });
  test('the existing Case status rules hold: a completed Case is never reopened by an actual stage', async () => {
    const world = inboxWorld({ deal: { STAGE_ID: 'UC_HS6O2F' }, caseStatus: 'completed', caseStage: 'completed' });
    expect(await processInboxEvent(world.ctx, claim)).toMatchObject({ result: 'quarantined', code: 'case_already_closed' });
    expect(world.tx.case.updateMany).not.toHaveBeenCalled();
  });
  test('the same stage again changes nothing', async () => {
    const world = inboxWorld({ deal: { STAGE_ID: 'UC_R55CKV' }, caseStatus: 'submitted', caseStage: 'quotation_ready' });
    expect(await processInboxEvent(world.ctx, claim)).toMatchObject({ result: 'ignored', code: 'no_change' });
    expect(world.tx.case.updateMany).not.toHaveBeenCalled();
  });
});

describe('inbound stage processing: what is quarantined, never applied', () => {
  const quarantined = async (over, code) => {
    const world = inboxWorld(over);
    await processInboxEvent(world.ctx, claim);
    expect(world.state.results[0]).toMatchObject({ status: 'ignored', lastError: `quarantined:${code}` });
    expect(world.tx.case.updateMany).not.toHaveBeenCalled();
    expect(world.tx.notification.create).not.toHaveBeenCalled();
  };
  test.each([['UC_CFXC9U'], ['LOSE'], ['UC_ZSJGIL']])('%s (not a workflow stage)', (stageId) => quarantined({ deal: { STAGE_ID: stageId } }, 'non_workflow_stage'));
  test('a test-pipeline stage id on an actual Deal', () => quarantined({ deal: { STAGE_ID: 'C38:WON' } }, 'unknown_stage'));
  test('a Deal of the test pipeline (category 38) behind an actual link', () => quarantined({ deal: { CATEGORY_ID: '38' } }, 'category_mismatch'));
  test("a Deal whose Case Reference field is not this Case's reference", () => quarantined({ deal: { UF_CRM_1795176618: 'HC-PC-999999' } }, 'reference_mismatch'));
  test('a Deal that only carries the TEST reference field is not this Case\'s actual Deal', () => quarantined({ deal: { UF_CRM_1795176618: undefined, UF_CRM_1794548440549: REF } }, 'reference_mismatch'));
});

describe('inbound stage processing: cross-profile', () => {
  test('a Deal link of the test profile is not touched by the actual processor: nothing is read or written', async () => {
    const world = inboxWorld({ linkProfile: 'test' });
    expect(await processInboxEvent(world.ctx, claim)).toBe(false);
    expect(world.bitrix.getDeal).not.toHaveBeenCalled();
    expect(world.store.writeResult).not.toHaveBeenCalled();
  });
  test('a Deal link of the actual profile is not touched by the test processor', async () => {
    const world = inboxWorld({ env: ENV_TEST, linkProfile: 'actual' });
    expect(await processInboxEvent(world.ctx, claim)).toBe(false);
    expect(world.bitrix.getDeal).not.toHaveBeenCalled();
  });
  test('an unstamped (legacy) link is a test link: refused by the actual processor, handled by the test processor', async () => {
    const legacyActual = inboxWorld({ linkProfile: null });
    expect(await processInboxEvent(legacyActual.ctx, claim)).toBe(false);
    const legacyTest = inboxWorld({ env: ENV_TEST, linkProfile: null, deal: { CATEGORY_ID: '38', UF_CRM_1795176618: undefined, UF_CRM_1794548440549: REF, STAGE_ID: 'C38:NEW' }, caseStage: 'x' });
    expect(await processInboxEvent(legacyTest.ctx, claim)).toMatchObject({ result: 'applied', stage: 'patient_details' });
  });
  test('with no profile configured nothing is processed', async () => {
    const world = inboxWorld({ env: SWITCHES });
    expect(await processInboxEvent(world.ctx, claim)).toBe(false);
    expect(world.bitrix.getDeal).not.toHaveBeenCalled();
  });
  test('the test pipeline still maps its own stages (regression)', async () => {
    const world = inboxWorld({ env: ENV_TEST, linkProfile: 'test', deal: { CATEGORY_ID: '38', UF_CRM_1795176618: undefined, UF_CRM_1794548440549: REF, STAGE_ID: 'C38:EXECUTING' }, caseStage: 'documentation', caseStatus: 'in_progress' });
    expect(await processInboxEvent(world.ctx, claim)).toMatchObject({ result: 'applied', stage: 'in_progress' });
    expect(world.tx.notification.create).toHaveBeenCalledTimes(1); // the test profile still notifies; the text is the catalogue's, created through the core
    expect(world.ctx.enqueuePush).toHaveBeenCalledWith(world.tx, expect.objectContaining({ recipientId: 9, kind: 'stage_update' })); // its push deliveries are queued through the same transaction client
    expect(world.state.notifications[0]).toMatchObject({ recipientId: 9, kind: 'stage_update', title: 'Your case has been updated', body: 'Your case status has been updated.', caseId: 7, serviceRequestId: 3, idempotencyKey: 'stage_update:patient:9:cse1' });
  });
  test('the inbox store offers only the active profile\'s events', async () => {
    const queried = [];
    const db = { $queryRaw: jest.fn(async (strings, ...values) => { queried.push({ sql: strings.join('?'), values }); return []; }) };
    await inboxStore.findDueIds(db, 10, 'actual');
    expect(queried[0].sql).toContain("COALESCE(l.profile, 'test') = ?");
    expect(queried[0].values).toContain('actual');
    await inboxStore.findDueIds(db, 10); // no profile: the comparison is with NULL, so nothing matches
    expect(queried[1].values).toContain(null);
  });
});

// ================================================================ reconciliation ================================================================
function reconcileWorld({ profile = 'actual', link = {}, deal = {} }) {
  const row = {
    id: 1, bitrixDealId: '555', stageId: 'NEW', externalModifiedAt: new Date('2030-01-01T00:00:00Z'), profile,
    case: { id: 7, referenceNumber: REF, status: 'submitted', serviceRequestId: 3, serviceRequest: { id: 3, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null } }, ...link,
  };
  const prisma = {
    bitrixDealLink: { findMany: jest.fn(async () => [row]), update: jest.fn(async () => undefined) },
    integrationInbox: { create: jest.fn(async () => undefined) },
  };
  const bitrix = { getDeal: jest.fn(async () => ({ status: 'ok', deal: { ID: '555', CATEGORY_ID: '0', UF_CRM_1795176618: REF, STAGE_ID: 'UC_R55CKV', DATE_MODIFY: '2030-01-10T10:00:00+05:30', ...deal } })) };
  return { prisma, bitrix };
}
const reconcile = (world, env) => reconcileDeals({ prisma: world.prisma, api: world.bitrix, env, log: quiet(), now: () => Date.parse('2030-01-10T12:00:00Z') });

describe('reconciliation', () => {
  test('actual: only actual links are selected, and a changed Deal of this profile queues one inbound event', async () => {
    const world = reconcileWorld({});
    expect(await reconcile(world, ENV_ACTUAL)).toEqual({ active: true, checked: 1, queued: 1 });
    expect(world.prisma.bitrixDealLink.findMany.mock.calls[0][0].where.AND[0]).toEqual({ profile: 'actual' });
    expect(world.prisma.integrationInbox.create).toHaveBeenCalledTimes(1);
  });
  test('test: the selection keeps legacy (unstamped) and test links, and nothing else', async () => {
    const world = reconcileWorld({ profile: 'test', deal: { CATEGORY_ID: '38', UF_CRM_1795176618: undefined, UF_CRM_1794548440549: REF, STAGE_ID: 'C38:NEW' } });
    await reconcile(world, ENV_TEST);
    expect(world.prisma.bitrixDealLink.findMany.mock.calls[0][0].where.AND[0]).toEqual({ OR: [{ profile: null }, { profile: 'test' }] });
    expect(world.prisma.integrationInbox.create).toHaveBeenCalledTimes(1);
  });
  test.each([
    ['a Deal of category 38 behind an actual link', { deal: { CATEGORY_ID: '38' } }],
    ['a Deal whose Case Reference field is not the reference', { deal: { UF_CRM_1795176618: 'HC-PC-999999' } }],
    ['a Deal that has only the test reference field', { deal: { UF_CRM_1795176618: undefined, UF_CRM_1794548440549: REF } }],
  ])('%s is never matched', async (_name, over) => {
    const world = reconcileWorld(over);
    expect(await reconcile(world, ENV_ACTUAL)).toEqual({ active: true, checked: 1, queued: 0 });
    expect(world.prisma.integrationInbox.create).not.toHaveBeenCalled();
  });
  test('a link of the other profile is never read, even if a query returned it', async () => {
    const world = reconcileWorld({ profile: 'test' });
    expect(await reconcile(world, ENV_ACTUAL)).toEqual({ active: true, checked: 1, queued: 0 });
    expect(world.bitrix.getDeal).not.toHaveBeenCalled();
  });
  test('with no profile configured nothing is looked at', async () => {
    const world = reconcileWorld({});
    expect(await reconcile(world, SWITCHES)).toEqual({ active: true, checked: 0, queued: 0 });
    expect(world.prisma.bitrixDealLink.findMany).not.toHaveBeenCalled();
  });
});

// ================================================================ recovery ======================================================================
describe('recovery', () => {
  const STOP = new Error('stop after the lookup');
  const actor = { id: 1, role: 'superadmin' };
  function recoveryWorld(payload) {
    return {
      prisma: {
        integrationOutbox: { findUnique: jest.fn(async () => ({ id: 1, eventType: 'bitrix.deal.create', caseId: 7, payload })) },
        case: { findUnique: jest.fn(async () => ({ referenceNumber: REF })) },
        $transaction: jest.fn(async () => { throw STOP; }),
      },
      bitrix: { findDealsByReference: jest.fn(async () => ({ status: 'none', dealIds: [] })) },
    };
  }
  const recover = (world, env, mode = 'confirm_no_deal') => recoverDealEvent({ prisma: world.prisma, api: world.bitrix, env, actor, caseId: 7, eventId: 1, mode, reasonCode: REASON_CODES[0], dealId: '555' });
  const codeOf = async (promise) => { try { await promise; return null; } catch (err) { return err.code || err.message; } };

  test('actual: the Deal lookup uses the actual category and the dedicated Case Reference field', async () => {
    const world = recoveryWorld({ caseId: 7, profile: 'actual' });
    expect(await codeOf(recover(world, ENV_ACTUAL))).toBe(STOP.message);
    expect(world.bitrix.findDealsByReference).toHaveBeenCalledWith(REF, { env: ENV_ACTUAL, profile: ACTUAL_PROFILE });
  });
  test('test: the lookup is the unchanged one', async () => {
    const world = recoveryWorld({ caseId: 7, profile: 'test' });
    await codeOf(recover(world, ENV_TEST));
    expect(world.bitrix.findDealsByReference).toHaveBeenCalledWith(REF, { env: ENV_TEST });
  });
  test.each([
    ['a test event under the actual profile', { caseId: 7, profile: 'test' }, ENV_ACTUAL],
    ['an actual event under the test profile', { caseId: 7, profile: 'actual' }, ENV_TEST],
    ['a legacy (unstamped) event under the actual profile', { caseId: 7 }, ENV_ACTUAL],
  ])('%s is refused before Bitrix is contacted', async (_name, payload, env) => {
    const world = recoveryWorld(payload);
    expect(await codeOf(recover(world, env, 'adopt_deal'))).toBe('profile_mismatch');
    expect(world.bitrix.findDealsByReference).not.toHaveBeenCalled();
  });
  test('with no profile configured it is refused', async () => {
    const world = recoveryWorld({ caseId: 7, profile: 'test' });
    expect(await codeOf(recover(world, SWITCHES))).toBe('profile_not_configured');
    expect(world.bitrix.findDealsByReference).not.toHaveBeenCalled();
  });
});

// ================================================================ quotation synchronization =====================================================
describe('quotation synchronization', () => {
  const dealWithFile = { ID: '555', STAGE_ID: 'C38:NEW', UF_CRM_1794985313: { id: '65834' }, UF_CRM_6A3399F56ECFF: '1000|USD', UF_CRM_6A23F4E86AA45: 'USD' };
  const detectDb = () => ({
    caseQuotation: { findFirst: jest.fn(async () => null) },
    integrationOutbox: { create: jest.fn(async () => ({})) },
  });
  test('the test profile queues the sync and stamps the event', async () => {
    const db = detectDb();
    expect(await detectAndEnqueueQuotationSync(db, { id: 7 }, dealWithFile, TEST_PROFILE)).toEqual({ queued: true, reason: 'queued' });
    expect(db.integrationOutbox.create.mock.calls[0][0].data.payload).toMatchObject({ caseId: 7, dealId: '555', profile: 'test' });
  });
  test('without a profile (the original call) the behaviour and payload are unchanged', async () => {
    const db = detectDb();
    await detectAndEnqueueQuotationSync(db, { id: 7 }, dealWithFile);
    expect(db.integrationOutbox.create.mock.calls[0][0].data.payload).toEqual({ caseId: 7, dealId: '555', fileId: '65834' });
  });
  test('the test pipeline\'s closed stages still queue nothing', async () => {
    const db = detectDb();
    expect(await detectAndEnqueueQuotationSync(db, { id: 7 }, { ...dealWithFile, STAGE_ID: 'C38:WON' }, TEST_PROFILE)).toEqual({ queued: false, reason: 'deal_closed' });
  });
  function syncWorld(linkProfile) {
    const results = [];
    const tx = { auditLog: { create: jest.fn(async () => undefined) } };
    const caseRecord = { id: 7, referenceNumber: REF, status: 'submitted', serviceRequestId: 3, serviceRequest: { id: 3, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null } };
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(tx)),
      bitrixDealLink: { findUnique: jest.fn(async () => ({ id: 1, caseId: 7, bitrixDealId: '555', profile: linkProfile, case: caseRecord })) },
    };
    const store = { writeResult: jest.fn(async (_db, _claim, result) => { results.push(result); return 1; }) };
    const bitrix = { getDeal: jest.fn(), getDealFileField: jest.fn(), downloadBitrixFile: jest.fn() };
    return { prisma, store, bitrix, results };
  }
  const syncClaim = { id: 5, caseId: 7, dealId: '555', attempts: 1, workerId: 'w' };
  const ENV_Q_ACTUAL = { ...ENV_ACTUAL, BITRIX_QUOTATION_SYNC_ENABLED: 'true' };

  test('a link of the other profile is never read, in either direction', async () => {
    for (const [env, linkProfile] of [[ENV_Q_ACTUAL, 'test'], [{ ...ENV_TEST, BITRIX_QUOTATION_SYNC_ENABLED: 'true' }, 'actual'], [{ ...SWITCHES, BITRIX_QUOTATION_SYNC_ENABLED: 'true' }, 'test']]) {
      const world = syncWorld(linkProfile);
      const outcome = await processQuotationEvent({ prisma: world.prisma, store: world.store, api: world.bitrix, env, log: quiet(), workerId: 'w' }, syncClaim);
      expect(outcome.outcome).toMatch(/profile_not_configured|link_profile_mismatch/);
      expect(world.bitrix.getDeal).not.toHaveBeenCalled();
      expect(world.results).toEqual([]);
    }
  });
  test('the quotation stores offer only the active profile\'s events', async () => {
    const db = { $queryRawUnsafe: jest.fn(async () => []) };
    await quotationStore.findCandidateIds(db, 5, undefined, 'actual');
    const [sql, ...params] = db.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.profile')), 'test') = ?");
    expect(params).toContain('actual');
  });
});

// ================================================================ stamping and the migration ====================================================
describe('event and link stamping', () => {
  let saved;
  beforeEach(() => { saved = process.env.BITRIX_DEAL_PROFILE; });
  afterEach(() => { if (saved === undefined) delete process.env.BITRIX_DEAL_PROFILE; else process.env.BITRIX_DEAL_PROFILE = saved; });
  const caseRecord = { id: 7, serviceRequestId: 3 };
  const request = { id: 3, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null };
  const txFake = () => ({
    bitrixDealLink: { findUnique: jest.fn(async () => null), create: jest.fn(async ({ data }) => ({ id: 1, ...data })) },
    integrationOutbox: { findUnique: jest.fn(async () => null), create: jest.fn(async ({ data }) => ({ id: 2, ...data })) },
  });

  test.each(['actual', 'test'])('under the %s profile the new link and the new event carry that profile', async (name) => {
    process.env.BITRIX_DEAL_PROFILE = name;
    const approval = txFake();
    await ensureDealCreation(approval, caseRecord, request);
    expect(approval.bitrixDealLink.create.mock.calls[0][0].data).toEqual({ caseId: 7, syncStatus: 'pending', profile: name });
    expect(approval.integrationOutbox.create.mock.calls[0][0].data.payload).toEqual({ caseId: 7, serviceRequestId: 3, profile: name });
    const direct = txFake();
    await enqueueDealCreation(direct, caseRecord, request);
    expect(direct.bitrixDealLink.create.mock.calls[0][0].data.profile).toBe(name);
    expect(direct.integrationOutbox.create.mock.calls[0][0].data.payload.profile).toBe(name);
  });
  test('with no profile configured nothing is stamped, so the record reads as a test record and never as an actual one', async () => {
    delete process.env.BITRIX_DEAL_PROFILE;
    const approval = txFake();
    await ensureDealCreation(approval, caseRecord, request);
    expect(approval.bitrixDealLink.create.mock.calls[0][0].data).toEqual({ caseId: 7, syncStatus: 'pending' });
    expect(approval.integrationOutbox.create.mock.calls[0][0].data.payload).toEqual({ caseId: 7, serviceRequestId: 3 });
  });
  test('an unknown profile name is not stamped either', async () => {
    process.env.BITRIX_DEAL_PROFILE = 'production';
    const approval = txFake();
    await ensureDealCreation(approval, caseRecord, request);
    expect(approval.bitrixDealLink.create.mock.calls[0][0].data).not.toHaveProperty('profile');
  });
  test('the deal outbox store offers only the active profile\'s events (and nothing when none is configured)', async () => {
    const queried = [];
    const db = { $queryRaw: jest.fn(async (strings, ...values) => { queried.push({ sql: strings.join('?'), values }); return []; }) };
    await outboxStore.findCandidateIds(db, 'pending', 5, undefined, 'actual');
    expect(queried[0].sql).toContain("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.profile')), 'test') = ?");
    expect(queried[0].values).toContain('actual');
    await outboxStore.findCandidateIds(db, 'pending', 5);
    expect(queried[1].values).toContain(null);
  });
  test('the migration adds the column and marks every existing record as TEST, never as actual', () => {
    const dir = path.join(__dirname, '../../prisma/migrations/20261120120000_bitrix_deal_link_profile');
    const sql = fs.readFileSync(path.join(dir, 'migration.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE `bitrix_deal_links` ADD COLUMN `profile` VARCHAR\(16\) NULL/);
    expect(sql).toMatch(/UPDATE `bitrix_deal_links` SET `profile` = 'test' WHERE `profile` IS NULL/);
    expect(sql).toMatch(/JSON_SET\(`payload`, '\$\.profile', 'test'\)/);
    expect(sql).not.toMatch(/'actual'/);
    expect(fs.readFileSync(path.join(dir, 'down.sql'), 'utf8')).toMatch(/DROP COLUMN `profile`/);
    expect(fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8')).toMatch(/profile\s+String\?\s+@db\.VarChar\(16\)/);
  });
});

// ================================================================ the dedicated Case Reference field ============================================
describe('the actual profile\'s dedicated Case Reference field', () => {
  const { referenceFieldOf } = require('../../src/modules/bitrix/bitrix-profiles');
  const { dealProblem } = require('../../src/modules/bitrix/bitrix-profile-runtime');
  const { buildActualPrivateCharterFields } = require('../../src/modules/bitrix/bitrix-deal-actual');

  test('UF_CRM_1795176618 is the actual reference field; the test profile keeps UF_CRM_1794548440549', () => {
    expect(ACTUAL_FIELD.CASE_REFERENCE).toBe('UF_CRM_1795176618');
    expect(ACTUAL_PROFILE.referenceField).toBe('UF_CRM_1795176618');
    expect(TEST_PROFILE.referenceField).toBe('UF_CRM_1794548440549');
    expect(referenceFieldOf(ACTUAL_PROFILE)).toBe('UF_CRM_1795176618');
    expect(referenceFieldOf(TEST_PROFILE)).toBe('UF_CRM_1794548440549');
  });
  test('a missing or invalid reference field is never usable (the Deal title is not accepted)', () => {
    for (const referenceField of [undefined, null, '', 'TITLE', 'title', 'UF_CRM', 'UF_CRM_x y', 7]) {
      expect(referenceFieldOf({ ...ACTUAL_PROFILE, referenceField })).toBeNull();
    }
    expect(referenceFieldOf(null)).toBeNull();
    expect(referenceFieldOf({})).toBeNull();
  });
  test('creation writes the exact Case reference into the field, and nothing is written there for a reference with spaces', () => {
    const fields = buildActualPrivateCharterFields({ referenceNumber: REF }, requestRow(), undefined);
    expect(fields[ACTUAL_FIELD.CASE_REFERENCE]).toBe(REF);
    expect(Object.keys(fields)).not.toContain('UF_CRM_1794548440549');
    expect(() => buildActualPrivateCharterFields({ referenceNumber: ` ${REF}` }, requestRow())).toThrow(/whitespace/);
    expect(() => buildActualPrivateCharterFields({ referenceNumber: '' }, requestRow())).toThrow(/reference/i);
  });
  test('the Deal check reads the dedicated field only: the title or the test field never satisfies it', () => {
    const deal = { ID: '555', CATEGORY_ID: '0' };
    expect(dealProblem(ACTUAL_PROFILE, { ...deal, UF_CRM_1795176618: REF }, '555', REF)).toBeNull();
    expect(dealProblem(ACTUAL_PROFILE, { ...deal, TITLE: REF }, '555', REF)).toBe('reference_mismatch');
    expect(dealProblem(ACTUAL_PROFILE, { ...deal, UF_CRM_1794548440549: REF }, '555', REF)).toBe('reference_mismatch');
    expect(dealProblem(ACTUAL_PROFILE, { ...deal, UF_CRM_1795176618: `${REF} ` }, '555', REF)).toBe('reference_mismatch');
    // a profile with a missing/invalid field is refused outright, even for a Deal that carries the title
    for (const referenceField of [undefined, 'TITLE']) {
      expect(dealProblem({ ...ACTUAL_PROFILE, referenceField }, { ...deal, TITLE: REF }, '555', REF)).toBe('reference_field_not_configured');
    }
  });
  test('the test profile\'s check is unchanged', () => {
    expect(dealProblem(TEST_PROFILE, { ID: '9', CATEGORY_ID: '38', UF_CRM_1794548440549: REF }, '9', REF)).toBeNull();
    expect(dealProblem(TEST_PROFILE, { ID: '9', CATEGORY_ID: '38', UF_CRM_1795176618: REF }, '9', REF)).toBe('reference_mismatch');
  });
  test('the title-only Deal is never matched by lookup, inbound or reconcile', async () => {
    const env = { ...SWITCHES, BITRIX24_WEBHOOK_URL: 'https://fake-bitrix.invalid/rest/1/FAKE_TOKEN/' };
    const fetchImpl = jest.fn(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ result: [{ ID: '555', CATEGORY_ID: '0', STAGE_ID: 'NEW', TITLE: REF }] }) }));
    expect(await api.findDealsByReference(REF, { env, fetchImpl, profile: ACTUAL_PROFILE })).toMatchObject({ status: 'uncertain', reason: 'filter_not_honoured' });
    const inbound = inboxWorld({ deal: { UF_CRM_1795176618: undefined, TITLE: REF } });
    await processInboxEvent(inbound.ctx, claim);
    expect(inbound.state.results[0]).toMatchObject({ status: 'ignored', lastError: 'quarantined:reference_mismatch' });
    const sweep = reconcileWorld({ deal: { UF_CRM_1795176618: undefined, TITLE: REF } });
    expect(await reconcile(sweep, ENV_ACTUAL)).toEqual({ active: true, checked: 1, queued: 0 });
  });
  test('the lookup refuses the title as a reference field, without a call', async () => {
    const fetchImpl = jest.fn();
    const env = { ...SWITCHES, BITRIX24_WEBHOOK_URL: 'https://fake-bitrix.invalid/rest/1/FAKE_TOKEN/' };
    expect(await api.findDealsByReference(REF, { env, fetchImpl, profile: { categoryId: 0, referenceField: 'TITLE' } })).toMatchObject({ status: 'uncertain', reason: 'profile_invalid' });
    expect(await api.findDealsByReference(REF, { env, fetchImpl, profile: { categoryId: 0 } })).toMatchObject({ reason: 'profile_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// A profile whose reference field has gone missing: every service must refuse and send/read nothing. The profile module is replaced (in an
// isolated module registry) by one whose actual profile has a bad field, so the real services run against it.
describe('missing or invalid actual reference field: fail closed everywhere, no fallback to the title', () => {
  const real = require('../../src/modules/bitrix/bitrix-profiles');
  const services = (referenceField) => {
    let loaded;
    jest.isolateModules(() => {
      const broken = Object.freeze({ ...real.ACTUAL_PROFILE, referenceField });
      jest.doMock('../../src/modules/bitrix/bitrix-profiles', () => ({
        ...real, ACTUAL_PROFILE: broken, PROFILES: { ...real.PROFILES, actual: broken },
        resolveProfile: (env) => (env && env.BITRIX_DEAL_PROFILE === 'actual' ? broken : real.resolveProfile(env)),
      }));
      loaded = {
        worker: require('../../src/modules/bitrix/deal-worker.service'),
        inbox: require('../../src/modules/bitrix/deal-inbox.service'),
        reconcile: require('../../src/modules/bitrix/deal-reconcile.service'),
        recovery: require('../../src/modules/bitrix/deal-recovery.service'),
      };
    });
    jest.dontMock('../../src/modules/bitrix/bitrix-profiles');
    return loaded;
  };

  test.each([['TITLE'], [undefined], [''], ['not_a_field']])('with referenceField %j nothing is created, searched, read or adopted', async (referenceField) => {
    const svc = services(referenceField);

    const worker = workerWorld({ payload: { caseId: 7, profile: 'actual' }, link: { profile: 'actual' } });
    await svc.worker.runDealWorker({ prisma: worker.prisma, store: worker.store, api: worker.bitrix, env: ENV_ACTUAL, log: quiet(), workerId: 'w', reportFailures: async () => 0 });
    expect(worker.bitrix.createDeal).not.toHaveBeenCalled();
    expect(worker.bitrix.findDealsByReference).not.toHaveBeenCalled();
    expect(worker.state.results).toEqual([]);

    const sweep = reconcileWorld({});
    expect(await svc.reconcile.reconcileDeals({ prisma: sweep.prisma, api: sweep.bitrix, env: ENV_ACTUAL, log: quiet(), now: () => Date.now() })).toEqual({ active: true, checked: 0, queued: 0 });
    expect(sweep.prisma.bitrixDealLink.findMany).not.toHaveBeenCalled();
    expect(sweep.bitrix.getDeal).not.toHaveBeenCalled();

    const inbound = inboxWorld({});
    await svc.inbox.processInboxEvent(inbound.ctx, claim);
    expect(inbound.state.results[0]).toMatchObject({ status: 'ignored', lastError: 'quarantined:reference_field_not_configured' });
    expect(inbound.tx.case.updateMany).not.toHaveBeenCalled();

    const recoveryPrisma = {
      integrationOutbox: { findUnique: jest.fn(async () => ({ id: 1, eventType: 'bitrix.deal.create', caseId: 7, payload: { caseId: 7, profile: 'actual' } })) },
      case: { findUnique: jest.fn(async () => ({ referenceNumber: REF })) },
      $transaction: jest.fn(),
    };
    const recoveryApi = { findDealsByReference: jest.fn() };
    await expect(svc.recovery.recoverDealEvent({
      prisma: recoveryPrisma, api: recoveryApi, env: ENV_ACTUAL, actor: { id: 1, role: 'superadmin' }, caseId: 7, eventId: 1, mode: 'confirm_no_deal', reasonCode: svc.recovery.REASON_CODES[0], dealId: '555',
    })).rejects.toMatchObject({ code: 'reference_field_not_configured' });
    expect(recoveryApi.findDealsByReference).not.toHaveBeenCalled();
    expect(recoveryPrisma.$transaction).not.toHaveBeenCalled();
  });

  test('the test profile is unaffected by a broken actual profile', async () => {
    const svc = services('TITLE');
    const world = workerWorld({ payload: { caseId: 7, profile: 'test' }, link: { profile: 'test' } });
    await svc.worker.runDealWorker({ prisma: world.prisma, store: world.store, api: world.bitrix, env: ENV_TEST, log: quiet(), workerId: 'w', reportFailures: async () => 0 });
    expect(world.bitrix.createDeal.mock.calls[0][0]).toMatchObject({ CATEGORY_ID: 38, UF_CRM_1794548440549: REF });
  });
});
