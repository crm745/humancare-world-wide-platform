/* global describe, test, expect, jest, beforeEach */
// The scoped single-Deal detection runner (modules/bitrix/single-deal-detect.js and src/bitrix-deal-detect-worker.js). No database, no network, no Bitrix: the Prisma
// client has NO write methods at all (any write attempt throws), the Bitrix client is a spy, and the inbox and reconcile passes are either spies or the real
// reconcileDeals() run against the fake. Every id, token and host is fake.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() }));

const fs = require('fs');
const path = require('path');
const detect = require('../../src/modules/bitrix/single-deal-detect');
const { reconcileDeals } = require('../../src/modules/bitrix/deal-reconcile.service');
const { ACTUAL_FIELD } = require('../../src/modules/bitrix/bitrix-profiles');

const ENV = {
  NODE_ENV: 'development', DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev',
  BITRIX_DEAL_PROFILE: 'actual', BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true',
};
const ARGS = ['--deal-id', '5001', '--case-id', '300', '--case-reference', 'CASE-1300', '--expect-stage', 'UC_R55CKV'];
let state; let prisma; let api; let log; let databaseName;

const makeLink = (over = {}) => ({
  id: 1, caseId: 300, bitrixDealId: '5001', profile: 'actual', categoryId: '0', stageId: 'NEW', externalModifiedAt: new Date('2030-01-02T09:00:00Z'), lastAttemptAt: null, syncStatus: 'synced',
  case: {
    id: 300, referenceNumber: 'CASE-1300', status: 'in_progress', charterStage: 'new', stageVersion: 1, serviceRequestId: 900,
    serviceRequest: { id: 900, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null, userId: 55 },
  },
  ...over,
});
const makeDeal = (over = {}) => ({ ID: '5001', CATEGORY_ID: '0', STAGE_ID: 'UC_R55CKV', DATE_MODIFY: '2030-01-02T10:00:00+00:00', [ACTUAL_FIELD.CASE_REFERENCE]: 'CASE-1300', ...over });

beforeEach(() => {
  databaseName = 'humancare_dev';
  log = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  state = {
    link: makeLink(),
    others: { inbox: [{ id: 10, entityId: '7777', status: 'received', attempts: 0 }], outbox: [{ id: 20, caseId: 999, status: 'pending', attempts: 0 }], links: [{ id: 2, bitrixDealId: '7777', stageId: 'NEW' }] },
    mine: [{ id: 11, entityId: '5001', status: 'received' }], pendingQuotationEvents: 1, deal: makeDeal(),
  };
  // Read methods only. A write (create / update / updateMany / $executeRaw) is a TypeError, so "nothing is written" is proved, not assumed.
  prisma = {
    $queryRaw: jest.fn(async () => [{ db: databaseName }]),
    bitrixDealLink: {
      findUnique: jest.fn(async ({ where }) => (state.link && state.link.bitrixDealId === where.bitrixDealId ? state.link : null)),
      findMany: jest.fn(async ({ where }) => (where && where.OR ? state.others.links : [])),
    },
    integrationInbox: { findMany: jest.fn(async ({ where }) => (where && where.OR ? state.others.inbox : state.mine.filter((r) => r.entityId === where.entityId && r.status === where.status))) },
    integrationOutbox: { findMany: jest.fn(async () => state.others.outbox), count: jest.fn(async () => state.pendingQuotationEvents) },
  };
  api = { getDeal: jest.fn(async () => ({ status: 'ok', deal: state.deal })) };
});

const run = (argv = ARGS, extra = {}) => detect.runCli({ argv, env: ENV, prisma, api, log, deps: extra.deps, ...(extra.env ? { env: extra.env } : {}) });
const out = () => [...log.log.mock.calls, ...log.error.mock.calls].map((c) => c.join(' ')).join('\n');
const refusedWith = async (argv, code, extra) => {
  expect(await run(argv, extra)).toBe(1);
  expect(out()).toContain(code);
};
const fakeBase = () => ({ findDueIds: jest.fn(async () => [10, 11, 12]), claim: jest.fn(async (_db, { id }) => ({ id })), recoverExpiredLeases: jest.fn(async () => ({ failed: 5, again: 5 })), writeResult: jest.fn() });

describe('arguments', () => {
  test('readiness only by default; only --once executes; all four values are required', () => {
    expect(detect.parseArgs(ARGS)).toEqual({ execute: false, dealId: '5001', caseId: 300, caseReference: 'CASE-1300', expectStage: 'UC_R55CKV' });
    expect(detect.parseArgs(['--readiness-only', ...ARGS]).execute).toBe(false);
    expect(detect.parseArgs(['--once', ...ARGS]).execute).toBe(true);
  });
  test('both approved stages are accepted, and nothing else', () => {
    for (const stage of ['UC_R55CKV', 'UC_9E9NRI', 'UC_HS6O2F', 'WON']) expect(detect.parseArgs([...ARGS.slice(0, -1), stage]).expectStage).toBe(stage);
    for (const stage of ['UC_CFXC9U', 'LOSE', 'NEW', 'UC_ZSJGIL', 'UC_OTHER', 'won', 'WON ', 'uc_hs6o2f', 'UC_HS6O2F ', 'uc_9e9nri', 'UC_9E9NRI ', 'UC_R55CKV,UC_9E9NRI', '']) {
      expect(() => detect.parseArgs([...ARGS.slice(0, -1), stage])).toThrow(expect.objectContaining({ code: 'expect_stage_not_supported' }));
    }
  });
  test.each([
    [['--case-id', '300', '--case-reference', 'CASE-1300', '--expect-stage', 'UC_R55CKV'], 'deal_id_required'],
    [['--deal-id', '5001', '--case-reference', 'CASE-1300', '--expect-stage', 'UC_R55CKV'], 'case_id_required'],
    [['--deal-id', '5001', '--case-id', '300', '--expect-stage', 'UC_R55CKV'], 'case_reference_required'],
    [['--deal-id', '5001', '--case-id', '300', '--case-reference', 'CASE-1300'], 'expect_stage_required'],
    [['--deal-id', '5001', '--case-id', '300', '--case-reference', 'CASE-1300', '--expect-stage', 'UC_CFXC9U'], 'expect_stage_not_supported'],
    [['--deal-id', '50x1', '--case-id', '300', '--case-reference', 'CASE-1300', '--expect-stage', 'UC_R55CKV'], 'deal_id_required'],
    [['--deal-id', '5001', '--case-id', '0', '--case-reference', 'CASE-1300', '--expect-stage', 'UC_R55CKV'], 'case_id_required'],
    [['--deal-id', '5001', '--case-id', '300', '--case-reference', 'case-1300', '--expect-stage', 'UC_R55CKV'], 'case_reference_required'],
    [[...ARGS, '--all'], 'unknown_argument'], [[...ARGS, '--deal-id', '5002'], 'argument_repeated'], [['--once', '--readiness-only', ...ARGS], 'mode_repeated_or_conflicting'],
  ])('%j is refused (%s)', async (argv, code) => {
    expect(() => detect.parseArgs(argv)).toThrow(expect.objectContaining({ code }));
    await refusedWith(argv, code);
    expect(api.getDeal).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  test('CASE-1206, Case id 206 and Deal 21846 are refused outright, however the rest is spelled', async () => {
    await refusedWith(['--deal-id', '21846', '--case-id', '300', '--case-reference', 'CASE-1300', '--expect-stage', 'UC_R55CKV'], 'target_denied');
    await refusedWith(['--deal-id', '5001', '--case-id', '206', '--case-reference', 'CASE-1300', '--expect-stage', 'UC_R55CKV'], 'target_denied');
    await refusedWith(['--deal-id', '5001', '--case-id', '300', '--case-reference', 'CASE-1206', '--expect-stage', 'UC_R55CKV'], 'target_denied');
    expect(prisma.bitrixDealLink.findUnique).not.toHaveBeenCalled();
    // and again inside the logic, for a caller that bypasses the argument parser
    await expect(detect.runSingleDealDetect({ dealId: '21846', caseId: 300, caseReference: 'CASE-1300', expectStage: 'UC_R55CKV', execute: true }, { prisma, api, env: ENV })).rejects.toMatchObject({ code: 'target_denied' });
    // and a link that really belongs to a denied Case
    state.link = makeLink({ caseId: 206, case: { ...makeLink().case, id: 206, referenceNumber: 'CASE-1206' } });
    await expect(detect.inspect({ prisma, api, env: ENV, target: { dealId: '5001', caseId: 206, caseReference: 'CASE-1206', expectStage: 'UC_R55CKV' }, profile: require('../../src/modules/bitrix/bitrix-profiles').ACTUAL_PROFILE })).rejects.toMatchObject({ code: 'target_denied' });
  });
});

describe('environment: local humancare_dev only', () => {
  test.each([
    [{ NODE_ENV: 'production' }, 'refused_in_production'], [{ NODE_ENV: 'test' }, 'node_env_test'],
    [{ DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }, 'database_not_humancare_dev'], [{ DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }, 'database_host_not_local'],
    [{ DATABASE_URL: undefined }, 'database_url_invalid'],
  ])('%j is refused (%s) before anything is read', async (patch, code) => {
    expect(await run(ARGS, { env: { ...ENV, ...patch } })).toBe(1);
    expect(out()).toContain(code);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(api.getDeal).not.toHaveBeenCalled();
  });
  test('the database SERVER must answer humancare_dev, not only the URL', async () => {
    databaseName = 'humancare_test';
    await refusedWith(ARGS, 'database_not_humancare_dev');
    expect(prisma.bitrixDealLink.findUnique).not.toHaveBeenCalled();
    expect(api.getDeal).not.toHaveBeenCalled();
  });
  test.each([
    [{ BITRIX_DEAL_PROFILE: 'test' }, 'profile_not_actual'], [{ BITRIX_DEAL_PROFILE: undefined }, 'profile_not_actual'],
    [{ BITRIX_QUOTATION_SYNC_ENABLED: 'false' }, 'quotation_sync_inactive'], [{ BITRIX_SYNC_ENABLED: 'false' }, 'bitrix_switches_not_active'],
    [{ PRIVATE_CHARTER_REVIEW_WORKFLOW: 'false' }, 'bitrix_switches_not_active'],
  ])('the process environment %j is refused (%s): wrong profile or switches', async (patch, code) => {
    await refusedWith(ARGS, code, { env: { ...ENV, ...patch } });
    expect(api.getDeal).not.toHaveBeenCalled();
  });
});

describe('identifiers must all agree (nothing is read from Bitrix before the local checks pass)', () => {
  test.each([
    [() => { state.link = null; }, 'deal_not_linked'],
    [() => { state.link = makeLink({ caseId: 301 }); }, 'link_case_mismatch'],
    [() => { state.link = makeLink({ case: { ...makeLink().case, referenceNumber: 'CASE-1301' } }); }, 'case_reference_mismatch'],
    [() => { state.link = makeLink({ case: { ...makeLink().case, id: 301 } }); }, 'case_not_found'],
  ])('mismatch %#: %s', async (arrange, code) => {
    arrange();
    await refusedWith(ARGS, code);
    expect(api.getDeal).not.toHaveBeenCalled();
  });
  test('the live Deal must be exactly this Deal, in this Category, carrying this Case reference', async () => {
    state.deal = makeDeal({ ID: '5002' });
    await refusedWith(ARGS, 'deal_id_mismatch');
    state.deal = makeDeal({ [ACTUAL_FIELD.CASE_REFERENCE]: 'CASE-1301' });
    await refusedWith(ARGS, 'deal_reference_mismatch');
    state.deal = makeDeal({ [ACTUAL_FIELD.CASE_REFERENCE]: undefined });
    await refusedWith(ARGS, 'deal_reference_mismatch');
    state.deal = makeDeal({ DATE_MODIFY: 'not a date' });
    await refusedWith(ARGS, 'deal_modified_time_invalid');
    expect(api.getDeal).toHaveBeenCalledTimes(4);
  });
  test('Bitrix refusing or failing to answer is a refusal with a short code', async () => {
    api.getDeal.mockResolvedValueOnce({ status: 'not_found' });
    await refusedWith(ARGS, 'deal_not_found_in_bitrix');
    api.getDeal.mockResolvedValueOnce({ status: 'uncertain', reason: 'timeout' });
    await refusedWith(ARGS, 'bitrix_read_failed_timeout');
    api.getDeal.mockResolvedValueOnce({ status: 'uncertain', reason: 'https://leak.example/with space' });
    expect(await run()).toBe(1);
    expect(out()).not.toContain('leak.example');
  });
});

describe('profile, Category and eligibility', () => {
  test.each([
    [{ profile: 'test' }, 'link_profile_not_actual'], [{ profile: null }, 'link_profile_not_actual'], [{ profile: 'other' }, 'link_profile_not_actual'],
    [{ categoryId: '38' }, 'link_category_mismatch'], [{ categoryId: null }, 'link_category_mismatch'],
  ])('a link %j is refused (%s)', async (patch, code) => {
    state.link = makeLink(patch);
    await refusedWith(ARGS, code);
    expect(api.getDeal).not.toHaveBeenCalled();
  });
  test('a Deal of Category 38 is refused even when the link says 0', async () => {
    state.deal = makeDeal({ CATEGORY_ID: '38' });
    await refusedWith(ARGS, 'deal_category_mismatch');
  });
  test.each([
    [{ serviceKey: 'commercial' }, 'case_not_private_charter'], [{ serviceKey: 'groundambulance' }, 'case_not_private_charter'],
    [{ reviewStatus: 'in_review' }, 'request_not_approved'], [{ reviewStatus: null }, 'case_not_eligible'], [{ bitrixLeadId: 99 }, 'case_not_eligible'],
  ])('a request %j is not eligible for the actual profile (%s)', async (patch, code) => {
    const base = makeLink();
    state.link = makeLink({ case: { ...base.case, serviceRequest: { ...base.case.serviceRequest, ...patch } } });
    await refusedWith(ARGS, code);
    expect(api.getDeal).not.toHaveBeenCalled();
  });
  test.each(['completed', 'cancelled'])('a %s Case is refused', async (status) => {
    state.link = makeLink({ case: { ...makeLink().case, status } });
    await refusedWith(ARGS, 'case_closed');
  });
});

describe('the stage', () => {
  test.each(['NEW', 'WON', 'LOSE', 'UC_OTHER', undefined])('stage %s is not the confirmed stage UC_R55CKV', async (stage) => {
    state.deal = makeDeal({ STAGE_ID: stage });
    await refusedWith([...ARGS.slice(0, -2), '--once', '--expect-stage', 'UC_R55CKV'], 'expect_stage_mismatch');
  });
  test('the Quoted stage maps to the quotation_ready stage and is not patient-visible', async () => {
    expect(await run()).toBe(0);
    expect(out()).toContain('"charterStage":"quotation_ready"');
    expect(out()).toContain('"patientVisible":false');
  });
  test('the Confirmed stage maps to payment_confirmed, changes no Case status and is not patient-visible', async () => {
    state.deal = makeDeal({ STAGE_ID: 'UC_9E9NRI' });
    expect(await run([...ARGS.slice(0, -1), 'UC_9E9NRI'])).toBe(0);
    expect(out()).toContain('"charterStage":"payment_confirmed"');
    expect(out()).toContain('"caseStatus":null');
    expect(out()).toContain('"patientVisible":false');
    expect(out()).toContain('"stageId":"UC_9E9NRI"');
  });
  test('the Activate stage maps to in_progress, sets the Case status in_progress and is not patient-visible', async () => {
    state.deal = makeDeal({ STAGE_ID: 'UC_HS6O2F' });
    expect(await run([...ARGS.slice(0, -1), 'UC_HS6O2F'])).toBe(0);
    expect(out()).toContain('"charterStage":"in_progress"');
    expect(out()).toContain('"caseStatus":"in_progress"');
    expect(out()).toContain('"patientVisible":false');
    expect(out()).toContain('"stageId":"UC_HS6O2F"');
  });
  test('the Activate stage the operator states must equal the live stage, in readiness and --once', async () => {
    for (const live of ['UC_R55CKV', 'UC_9E9NRI', 'WON', 'NEW']) {
      state.deal = makeDeal({ STAGE_ID: live });
      await refusedWith([...ARGS.slice(0, -1), 'UC_HS6O2F'], 'expect_stage_mismatch');
      await refusedWith(['--once', ...ARGS.slice(0, -1), 'UC_HS6O2F'], 'expect_stage_mismatch');
    }
    state.deal = makeDeal({ STAGE_ID: 'UC_HS6O2F' });
    await refusedWith([...ARGS.slice(0, -1), 'UC_R55CKV'], 'expect_stage_mismatch');
    await refusedWith(['--once', ...ARGS.slice(0, -1), 'UC_9E9NRI'], 'expect_stage_mismatch');
  });
  test('the Case Completed stage maps to completed, sets the Case status completed and is not patient-visible', async () => {
    state.deal = makeDeal({ STAGE_ID: 'WON' });
    expect(await run([...ARGS.slice(0, -1), 'WON'])).toBe(0);
    expect(out()).toContain('"stageId":"WON"');
    expect(out()).toContain('"charterStage":"completed"');
    expect(out()).toContain('"caseStatus":"completed"');
    expect(out()).toContain('"patientVisible":false');
  });
  test('the Case Completed stage the operator states must equal the live stage, in readiness and --once', async () => {
    for (const live of ['UC_R55CKV', 'UC_9E9NRI', 'UC_HS6O2F', 'NEW']) {
      state.deal = makeDeal({ STAGE_ID: live });
      await refusedWith([...ARGS.slice(0, -1), 'WON'], 'expect_stage_mismatch');
      await refusedWith(['--once', ...ARGS.slice(0, -1), 'WON'], 'expect_stage_mismatch');
    }
    state.deal = makeDeal({ STAGE_ID: 'WON' });
    for (const stated of ['UC_R55CKV', 'UC_9E9NRI', 'UC_HS6O2F']) {
      await refusedWith([...ARGS.slice(0, -1), stated], 'expect_stage_mismatch');
      await refusedWith(['--once', ...ARGS.slice(0, -1), stated], 'expect_stage_mismatch');
    }
  });
  test('the stage the operator states must equal the live stage, for BOTH allowed stages', async () => {
    state.deal = makeDeal({ STAGE_ID: 'UC_R55CKV' });
    await refusedWith([...ARGS.slice(0, -1), 'UC_9E9NRI'], 'expect_stage_mismatch');
    state.deal = makeDeal({ STAGE_ID: 'UC_9E9NRI' });
    await refusedWith([...ARGS.slice(0, -1), 'UC_R55CKV'], 'expect_stage_mismatch');
    await refusedWith(['--once', ...ARGS.slice(0, -1), 'UC_R55CKV'], 'expect_stage_mismatch');
    await refusedWith(['--once', ...ARGS.slice(0, -1), 'UC_9E9NRI'].slice(0, -1).concat('UC_R55CKV'), 'expect_stage_mismatch');
  });
  test('a Confirmed-stage Deal is applied with --once like any other: one pinned read, scoped passes, nothing else touched', async () => {
    state.deal = makeDeal({ STAGE_ID: 'UC_9E9NRI' });
    const reconcile = jest.fn(async () => ({ active: true, checked: 1, queued: 1 }));
    const runInbox = jest.fn(async () => ({ active: true, claimed: 1 }));
    expect(await run(['--once', ...ARGS.slice(0, -1), 'UC_9E9NRI'], { deps: { reconcile, runInbox, store: fakeBase() } })).toBe(0);
    expect(api.getDeal).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(runInbox).toHaveBeenCalledTimes(1);
    expect(out()).toContain('"othersUnchanged":true');
  });
  test('the allow-list is exactly the four approved stages, frozen', () => {
    expect(detect.ALLOWED_STAGES).toEqual(['UC_R55CKV', 'UC_9E9NRI', 'UC_HS6O2F', 'WON']);
    expect(Object.isFrozen(detect.ALLOWED_STAGES)).toBe(true);
    expect(detect.REQUIRED_STAGE).toBeUndefined();
  });
});

describe('dry run (the default)', () => {
  test('reads once, verifies everything, and neither reconciles, processes nor writes', async () => {
    const reconcile = jest.fn(); const runInbox = jest.fn();
    expect(await run(ARGS, { deps: { reconcile, runInbox } })).toBe(0);
    expect(api.getDeal).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(runInbox).not.toHaveBeenCalled();
    expect(out()).toMatch(/READY \(readiness only: nothing was written\)/);
  });
  test('--once is needed to execute; an unchanged Deal queues nothing', async () => {
    state.link = makeLink({ stageId: 'UC_R55CKV', externalModifiedAt: new Date('2030-01-02T10:00:00Z') });
    const reconcile = jest.fn(); const runInbox = jest.fn();
    expect(await run(['--once', ...ARGS], { deps: { reconcile, runInbox } })).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
    expect(out()).toContain('nothingToApply');
  });
});

describe('--once: one pinned Bitrix read and a scope that reaches only this Deal', () => {
  const runOnce = (deps) => run(['--once', ...ARGS], { deps });
  test('the real reconcile and a scoped inbox pass run once each; push is suppressed; others are unchanged', async () => {
    const reconcile = jest.fn(async () => ({ active: true, checked: 1, queued: 1 }));
    const runInbox = jest.fn(async () => ({ active: true, claimed: 1 }));
    expect(await runOnce({ reconcile, runInbox, store: fakeBase() })).toBe(0);
    expect(api.getDeal).toHaveBeenCalledTimes(1); // the ONE real Bitrix read
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(runInbox).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][0].scope).toEqual({ dealId: '5001', ignoreRecheck: true });
    // push deliveries: the inbox gets the explicit no-op enqueue (and no legacy "push" option), so the detection queues no delivery row
    const given = runInbox.mock.calls[0][0];
    expect(given.enqueuePush).toBe(require('../../src/modules/notifications/push-delivery-enqueue').suppressedEnqueuePush);
    expect(given).not.toHaveProperty('push');
    expect(await given.enqueuePush({}, { id: 9 })).toMatchObject({ enqueued: 0, alreadyQueued: 0, skipped: 'suppressed' });
    expect(out()).toContain('"othersUnchanged":true');
    expect(out()).toContain('"quotationEventsPending":1');
  });
  test('the pinned client answers only for this Deal id, from an immutable snapshot, and has no other method', async () => {
    let pinned;
    await runOnce({ reconcile: jest.fn(async (o) => { pinned = o.api; return {}; }), runInbox: jest.fn(async () => ({})), store: fakeBase() });
    expect(Object.keys(pinned)).toEqual(['getDeal']);
    expect((await pinned.getDeal('5001')).status).toBe('ok');
    expect(await pinned.getDeal('5002')).toEqual({ status: 'uncertain', reason: 'out_of_scope' });
    expect(await pinned.getDeal('21846')).toEqual({ status: 'uncertain', reason: 'out_of_scope' });
    const a = await pinned.getDeal('5001'); a.deal.STAGE_ID = 'WON';
    expect((await pinned.getDeal('5001')).deal.STAGE_ID).toBe('UC_R55CKV'); // a caller cannot change what was verified
    state.deal = makeDeal({ STAGE_ID: 'WON' }); // nor can a later move in Bitrix
    expect((await pinned.getDeal('5001')).deal.STAGE_ID).toBe('UC_R55CKV');
    expect(pinned.createDeal).toBeUndefined();
    expect(pinned.updateDealFiles).toBeUndefined();
    expect(api.getDeal).toHaveBeenCalledTimes(1);
  });
  test('the scoped inbox store offers only this Deal\'s rows, claims nothing else and never recovers a lease', async () => {
    const base = fakeBase();
    const store = detect.scopedStore(base, '5001');
    expect(await store.findDueIds(prisma, 10, 'actual')).toEqual([11]); // 10 and 12 are due in the table but are not this Deal's
    expect(base.findDueIds).toHaveBeenCalledWith(prisma, 1000, 'actual');
    expect(await store.claim(prisma, { id: 10, workerId: 'w' })).toBeNull(); // another Deal's row
    expect(await store.claim(prisma, { id: 12, workerId: 'w' })).toBeNull(); // never offered
    expect(base.claim).not.toHaveBeenCalled();
    expect(await store.claim(prisma, { id: 11, workerId: 'w' })).toEqual({ id: 11 });
    expect(base.claim).toHaveBeenCalledTimes(1);
    expect(await store.recoverExpiredLeases(prisma, { maxAttempts: 8 })).toEqual({ failed: 0, again: 0 });
    expect(base.recoverExpiredLeases).not.toHaveBeenCalled();
  });
  test('the inbox pass cannot recover a lease or claim an unrelated row, whatever it asks for', async () => {
    const base = fakeBase();
    const runInbox = jest.fn(async ({ store }) => {
      await store.recoverExpiredLeases(prisma, { maxAttempts: 8 });
      const ids = await store.findDueIds(prisma, 10, 'actual');
      for (const id of [10, 11, 12]) await store.claim(prisma, { id, workerId: 'w' });
      return { claimed: ids.length };
    });
    expect(await runOnce({ reconcile: jest.fn(async () => ({})), runInbox, store: base })).toBe(0);
    expect(base.recoverExpiredLeases).not.toHaveBeenCalled();
    expect(base.claim.mock.calls.map((c) => c[1].id)).toEqual([11]);
  });
  test('the REAL reconcileDeals, given the scope and the pinned client, reads only this Deal and queues one inbox row', async () => {
    const created = []; const updated = []; const readIds = [];
    const dealPrisma = {
      ...prisma,
      bitrixDealLink: { ...prisma.bitrixDealLink, findMany: jest.fn(async () => [state.link]), update: jest.fn(async ({ where, data }) => { updated.push([where.id, Object.keys(data)]); }) },
      integrationInbox: { ...prisma.integrationInbox, create: jest.fn(async ({ data }) => { created.push(data); }) },
    };
    let queued;
    const wrapReconcile = async (options) => {
      const spied = { getDeal: async (id, o) => { readIds.push(String(id)); return options.api.getDeal(id, o); } };
      queued = await reconcileDeals({ ...options, api: spied, prisma: dealPrisma });
      return queued;
    };
    expect(await runOnce({ reconcile: wrapReconcile, runInbox: jest.fn(async () => ({ claimed: 0 })), store: fakeBase() })).toBe(0);
    expect(dealPrisma.bitrixDealLink.findMany.mock.calls[0][0]).toMatchObject({ where: { bitrixDealId: '5001' }, take: 1 });
    expect(readIds).toEqual(['5001']);
    expect(queued).toMatchObject({ checked: 1, queued: 1 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ source: 'bitrix24', eventType: 'ONCRMDEALUPDATE', entityType: 'deal', entityId: '5001', status: 'received' });
    expect(updated).toEqual([[1, ['lastAttemptAt']]]);
  });
});

describe('failure handling', () => {
  const runOnce = (deps) => run(['--once', ...ARGS], { deps });
  test('another row changing during the pass is reported as an alert with exit code 2', async () => {
    const runInbox = jest.fn(async () => { state.others.inbox.push({ id: 99, entityId: '7777', status: 'processing', attempts: 1 }); return { claimed: 1 }; });
    expect(await runOnce({ reconcile: jest.fn(async () => ({})), runInbox, store: fakeBase() })).toBe(2);
    expect(out()).toContain('"othersUnchanged":false');
    expect(out()).toMatch(/ALERT: another inbox row, outbox event or deal link changed/);
  });
  test.each([['inbox', 'links'], ['outbox', 'outbox'], ['links', 'inbox']])('a changed %s row of another Deal or Case is detected', async (kind) => {
    const runInbox = jest.fn(async () => { state.others[kind].push({ id: 500, entityId: '7777', caseId: 999, bitrixDealId: '7777', status: 'x' }); return {}; });
    expect(await runOnce({ reconcile: jest.fn(async () => ({})), runInbox, store: fakeBase() })).toBe(2);
  });
  test('an error in either pass is reported as a short code only (exit 2), never its message', async () => {
    const secret = new Error('Access denied for user u@localhost (password: hunter2) at mysql://u:hunter2@localhost/humancare_dev');
    secret.code = 'P1001';
    expect(await runOnce({ reconcile: jest.fn(async () => { throw secret; }), runInbox: jest.fn(), store: fakeBase() })).toBe(2);
    expect(out()).toContain('failed: P1001');
    expect(out()).not.toMatch(/hunter2|Access denied|mysql:/);
    expect(await runOnce({ reconcile: jest.fn(async () => ({})), runInbox: jest.fn(async () => { throw Object.assign(new Error('boom password=x'), { name: 'PrismaClientInitializationError' }); }), store: fakeBase() })).toBe(2);
    expect(out()).toContain('PrismaClientInitializationError');
    expect(out()).not.toContain('password=x');
  });
  test('a refusal writes nothing and runs neither pass', async () => {
    state.deal = makeDeal({ STAGE_ID: 'WON' });
    const reconcile = jest.fn(); const runInbox = jest.fn();
    expect(await runOnce({ reconcile, runInbox, store: fakeBase() })).toBe(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(runInbox).not.toHaveBeenCalled();
  });
});

describe('isolation: no worker, no job registry, no timers', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
  const code = (rel) => read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const FILES = ['src/modules/bitrix/single-deal-detect.js', 'src/bitrix-deal-detect-worker.js'];
  test('neither file requires the job list, the general worker, a job runner or a timer, and nothing sends to Bitrix or touches payments', () => {
    for (const file of FILES) {
      for (const forbidden of [/jobs[\\/]index/, /require\(['"]\.\/worker['"]\)/, /job-runner/, /createJobRunner/, /setInterval/, /setTimeout/, /createDeal|updateDeal|crm\.deal\.(add|update)|crm\.item\.(add|update)/, /razorpay|invoice|payment/i]) {
        expect({ file, hit: forbidden.test(code(file)) }).toEqual({ file, hit: false });
      }
    }
  });
  test('dotenv is read only inside main(), and the entry file loads no job file when required', () => {
    expect(code('src/bitrix-deal-detect-worker.js').split('async function main')[0]).not.toMatch(/dotenv/);
    expect(code('src/bitrix-deal-detect-worker.js')).toMatch(/async function main[\s\S]*dotenv/);
    expect(code('src/modules/bitrix/single-deal-detect.js')).not.toMatch(/dotenv/);
    require('../../src/bitrix-deal-detect-worker');
    const loaded = Object.keys(require.cache).map((k) => k.replace(/\\/g, '/'));
    expect(loaded.filter((k) => /\/src\/jobs\//.test(k))).toEqual([]);
    expect(loaded.filter((k) => /\/src\/worker\.js$/.test(k))).toEqual([]);
  });
  test('it reuses the existing detection code and adds no detection rule of its own', () => {
    const text = code('src/modules/bitrix/single-deal-detect.js');
    expect(text).toMatch(/require\('\.\/deal-reconcile\.service'\)\.reconcileDeals/);
    expect(text).toMatch(/require\('\.\/deal-inbox\.service'\)\.runInboxWorker/);
    expect(text).not.toMatch(/detectAndEnqueueQuotationSync|caseStageEvent|prisma\.\w+\.(create|update|updateMany|upsert|delete)|\$executeRaw/);
  });
});
