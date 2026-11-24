/* global describe, test, expect, jest, beforeEach */
// Single-event Deal dispatch: the event scope in the store, the pre-dispatch checks, the environment requirements, the loop around the EXISTING Deal worker,
// and what the launcher can never do. No database, no network: prisma is a fake that answers by SQL text, and the Deal worker is a stand-in.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const fs = require('fs');
const path = require('path');
const single = require('../../src/modules/bitrix/single-event-dispatch');
const store = require('../../src/modules/bitrix/deal-outbox.store');
const { runDealWorker } = require('../../src/modules/bitrix/deal-worker.service');
const { createDispatcher } = require('../../src/modules/bitrix/queue/dispatcher');

const text = (strings) => strings.join('?').replace(/\s+/g, ' ');
const ENV = {
  BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', BITRIX_DEAL_PROFILE: 'actual', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true',
  BITRIX24_WEBHOOK_URL: 'https://b24-4orefh.bitrix24.in/rest/1/testtoken/', BITRIX_ALLOWED_PORTAL_HOST: 'b24-4orefh.bitrix24.in',
  DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev',
};
const GOOD_ROW = {
  id: 53n, event_type: 'bitrix.deal.create', entity_type: 'case', entity_id: '206', case_id: 206n, status: 'pending', attempts: 0, locked_by: null, external_call_started_at: null,
  idempotency_key: 'bitrix.deal.create:case:206', profile: 'actual', case_reference: 'CASE-1206', service_request_id: 208n, request_reference: 'REQ-1208', review_status: 'approved',
  service_key: 'privatecharter', bitrix_lead_id: null, patient_name: 'E2E-TEST Asha Rao 1122', link_id: 53n, link_profile: 'actual', bitrix_deal_id: null,
};
const ARGS = ['--event-id', '53', '--case-reference', 'CASE-1206', '--request-reference', 'REQ-1208'];
const NAMED = { eventId: 53, caseReference: 'CASE-1206', requestReference: 'REQ-1208' };

// A fake database that answers by the text of the statement and keeps one mutable event row.
function fakeDb({ row = { ...GOOD_ROW }, database = 'humancare_dev', sameCount = 1, others = 0 } = {}) {
  const db = { row, state: { status: 'pending', attempts: 0, last_error: null, next_attempt_at: null, external_call_started_at: null, bitrix_deal_id: null, category_id: null, stage_id: null, link_profile: 'actual', sync_status: 'pending' }, others, queries: [] };
  db.$queryRaw = jest.fn(async (strings, ...values) => {
    const sql = text(strings);
    db.queries.push({ sql, values });
    if (sql.includes('SELECT DATABASE()')) return [{ db: database }];
    if (sql.includes('LEFT JOIN cases c') && sql.includes('WHERE o.id =')) return db.row ? [db.row] : [];
    if (sql.includes('COUNT(*) AS c FROM integration_outbox WHERE case_id')) return [{ c: BigInt(sameCount) }];
    if (sql.includes('SELECT o.status, o.attempts, o.last_error')) return [db.state];
    if (sql.includes('WHERE id <>')) return [{ c: BigInt(db.others) }];
    throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
  });
  return db;
}
const writesIn = (db) => db.queries.filter((q) => /\b(INSERT|UPDATE|DELETE)\b/i.test(q.sql));

describe('arguments', () => {
  test('all three identifiers are mandatory; --execute and --max-minutes are optional', () => {
    expect(single.parseArgs(ARGS)).toEqual({ ...NAMED, execute: false, maxMinutes: 6 });
    expect(single.parseArgs([...ARGS, '--execute', '--max-minutes', '10'])).toEqual({ ...NAMED, execute: true, maxMinutes: 10 });
    expect(single.parseArgs(ARGS.slice(2))).toEqual({ error: 'event_id_required' });
    expect(single.parseArgs(['--event-id', '53', '--request-reference', 'REQ-1208'])).toEqual({ error: 'case_reference_required' });
    expect(single.parseArgs(['--event-id', '53', '--case-reference', 'CASE-1206'])).toEqual({ error: 'request_reference_required' });
    expect(single.parseArgs([])).toEqual({ error: 'event_id_required' });
  });

  test.each([
    [['--event-id', '0', '--case-reference', 'CASE-1', '--request-reference', 'REQ-1'], 'event_id_required'],
    [['--event-id', '5x', '--case-reference', 'CASE-1', '--request-reference', 'REQ-1'], 'event_id_required'],
    [['--event-id', '53,2', '--case-reference', 'CASE-1', '--request-reference', 'REQ-1'], 'event_id_required'], // never a list
    [['--event-id', '53', '--case-reference', 'case-1206', '--request-reference', 'REQ-1208'], 'case_reference_required'],
    [['--event-id', '53', '--case-reference', 'CASE-1206', '--request-reference', 'REQ-1208 ; x'], 'request_reference_required'],
    [[...ARGS, '--force'], 'unknown_option'],
    [[...ARGS, '--profile', 'test'], 'unknown_option'], // the profile is not an option: it is always the event's own, and must be actual
    [[...ARGS, '--max-minutes', '0'], 'max_minutes_invalid'],
    [[...ARGS, '--max-minutes', '31'], 'max_minutes_invalid'],
    [[...ARGS, '--max-minutes'], 'missing_value'],
  ])('%j is refused (%s)', (argv, error) => {
    expect(single.parseArgs(argv)).toEqual({ error });
  });
});

describe('the event scope in the store (what guarantees only the named event is offered or recovered)', () => {
  test('normalizeEventIds: positive whole ids only, never "everything", and only together with a Case scope', () => {
    expect(store.normalizeEventIds(undefined, null)).toBeNull();
    expect(store.normalizeEventIds([53, 53], [206])).toEqual([53]);
    for (const bad of [[], [0], [-1], [1.5], ['53'], [null], 'x', { 0: 1 }, Array.from({ length: 51 }, (_, i) => i + 1)]) expect(() => store.normalizeEventIds(bad, [206])).toThrow(/event scope needs/);
    expect(() => store.normalizeEventIds([53], null)).toThrow(/only valid together with a Case scope/);
  });

  test('candidates: the scoped statement gains "AND o.id IN (...)" before ORDER BY, with the ids bound after the Case ids; the synthetic exclusion stays', async () => {
    const db = { $queryRawUnsafe: jest.fn(async () => [{ id: 53n }]), $queryRaw: jest.fn() };
    expect(await store.findCandidateIds(db, 'pending', 5, { caseIds: [206], eventIds: [53] }, 'actual')).toEqual([53]);
    expect(db.$queryRaw).not.toHaveBeenCalled(); // the unscoped statement is never used
    const [sql, ...params] = db.$queryRawUnsafe.mock.calls[0];
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('AND o.case_id IN (?)');
    expect(flat).toContain('AND o.id IN (?) ORDER BY o.id');
    expect(flat).toContain('AND sr.patient_name NOT LIKE ?');
    expect(params).toEqual(['bitrix.deal.create', 'case', 'pending', 'privatecharter', 'manual_review_required%', 'actual', 'ZZ-SYNTHETIC%', 206, 53, 5]);
  });

  test('without an event scope the scoped statement is exactly what it was', async () => {
    const db = { $queryRawUnsafe: jest.fn(async () => []), $queryRaw: jest.fn() };
    await store.findCandidateIds(db, 'pending', 5, { caseIds: [206] }, 'actual');
    const [sql, ...params] = db.$queryRawUnsafe.mock.calls[0];
    expect(sql.replace(/\s+/g, ' ')).not.toContain('o.id IN');
    expect(params).toEqual(['bitrix.deal.create', 'case', 'pending', 'privatecharter', 'manual_review_required%', 'actual', 'ZZ-SYNTHETIC%', 206, 5]);
  });

  test('an event scope alone, or a malformed one, is refused before any query', async () => {
    const db = { $queryRawUnsafe: jest.fn(), $queryRaw: jest.fn() };
    await expect(store.findCandidateIds(db, 'pending', 5, { eventIds: [53] }, 'actual')).rejects.toThrow(/only valid together/);
    await expect(store.findCandidateIds(db, 'pending', 5, { caseIds: [206], eventIds: [] }, 'actual')).rejects.toThrow(/event scope needs/);
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  test('lease recovery is narrowed to the same event: its three UPDATEs carry "AND id IN (...)" and the event id', async () => {
    const executed = [];
    const db = { $executeRawUnsafe: jest.fn(async (sql, ...v) => { executed.push({ sql: sql.replace(/\s+/g, ' '), v }); return 0; }), $executeRaw: jest.fn() };
    await store.recoverExpiredLeases(db, { maxClaims: 10, caseIds: [206], eventIds: [53] });
    expect(db.$executeRaw).not.toHaveBeenCalled(); // never the unscoped (whole-table) recovery
    expect(executed).toHaveLength(3);
    for (const e of executed) { expect(e.sql).toContain('case_id IN (?) AND id IN (?)'); expect(e.v).toEqual(expect.arrayContaining(['bitrix.deal.create', 206, 53])); }
    // and without an event scope it is unchanged
    executed.length = 0;
    await store.recoverExpiredLeases(db, { maxClaims: 10, caseIds: [206] });
    for (const e of executed) expect(e.sql).not.toContain('AND id IN');
  });

  test('the EXISTING Deal worker hands the whole scope (Case AND event) to the store, for candidates and for recovery', async () => {
    const fake = {
      MANUAL_REVIEW_PREFIX: store.MANUAL_REVIEW_PREFIX,
      recoverExpiredLeases: jest.fn(async () => undefined), findCandidateIds: jest.fn(async () => []), claim: jest.fn(),
    };
    const scope = { caseIds: [206], eventIds: [53] };
    await runDealWorker({ prisma: {}, store: fake, env: ENV, log: console, scope, gateway: createDispatcher(), reportFailures: async () => 0 });
    expect(fake.recoverExpiredLeases).toHaveBeenCalledWith({}, expect.objectContaining({ caseIds: [206], eventIds: [53] }));
    expect(fake.findCandidateIds.mock.calls.map((c) => c[3])).toEqual([scope, scope]); // pending and ambiguous passes, same scope
    expect(fake.claim).not.toHaveBeenCalled();
  });
});

describe('inspectTarget: the event must be exactly what the operator says', () => {
  const inspect = (db, env = ENV, args = NAMED) => single.inspectTarget({ prisma: db, env, ...args });

  test('REQ-1208 / CASE-1206 / event 53 as they are in humancare_dev: ok, with no write', async () => {
    const db = fakeDb();
    const r = await inspect(db);
    expect(r).toMatchObject({ ok: true, problems: [], alreadyDispatched: false, target: { eventId: 53, caseId: 206, caseReference: 'CASE-1206', requestId: 208, requestReference: 'REQ-1208', profile: 'actual', status: 'pending' } });
    expect(writesIn(db)).toEqual([]);
  });

  test.each([
    ['an event of another type', { event_type: 'bitrix.quotation.sync' }, 'event_type_mismatch'],
    ['an entity that is not this Case', { entity_id: '207' }, 'entity_mismatch'],
    ['a different Case reference', { case_reference: 'CASE-1207' }, 'case_reference_mismatch'],
    ['a different request reference', { request_reference: 'REQ-1207' }, 'request_reference_mismatch'],
    ['an unstamped (legacy / test) event', { profile: null }, 'event_profile_not_actual'],
    ['a test-stamped event', { profile: 'test' }, 'event_profile_not_actual'],
    ['a link of the other profile', { link_profile: 'test' }, 'link_profile_not_actual'],
    ['an idempotency key of another Case', { idempotency_key: 'bitrix.deal.create:case:158' }, 'idempotency_key_mismatch'],
    ['an event being processed', { status: 'processing' }, 'event_not_pending'],
    ['a failed event', { status: 'failed' }, 'event_not_pending'],
    ['an ambiguous event', { status: 'ambiguous' }, 'event_not_pending'],
    ['an event with an attempt already', { attempts: 1 }, 'event_already_attempted'],
    ['a locked event', { locked_by: 'worker-A' }, 'event_locked'],
    ['an event with call evidence', { external_call_started_at: new Date() }, 'call_already_started'],
    ['a request that is not approved', { review_status: 'in_review' }, 'request_not_approved'],
    ['a service other than Private Charter', { service_key: 'air' }, 'not_private_charter'],
    ['a request that has a legacy Lead', { bitrix_lead_id: 99 }, 'request_has_lead'],
    ['a Case without a Deal link', { link_id: null }, 'deal_link_missing'],
    ['the synthetic identity (REQ-1157 shape)', { patient_name: 'ZZ-SYNTHETIC Run B' }, 'synthetic_identity'],
  ])('refused: %s', async (_n, override, code) => {
    expect(await inspect(fakeDb({ row: { ...GOOD_ROW, ...override } }))).toMatchObject({ ok: false, alreadyDispatched: false, problems: [code] });
  });

  test('refused: the Case (or its idempotency key) has another outbox event', async () => {
    expect((await inspect(fakeDb({ sameCount: 2 }))).problems).toEqual(['case_has_other_events']);
  });

  test('refused: an unknown event id', async () => {
    expect(await inspect(fakeDb({ row: null }))).toMatchObject({ ok: false, problems: ['event_not_found'] });
  });

  test('refused: the database is not humancare_dev (checked by the server itself), or not on a loopback host', async () => {
    expect((await inspect(fakeDb({ database: 'humancare_test' }))).problems).toEqual(['database_not_humancare_dev']);
    expect((await inspect(fakeDb({ database: 'humancare' }))).problems).toEqual(['database_not_humancare_dev']);
    expect((await inspect(fakeDb(), { ...ENV, DATABASE_URL: 'mysql://u:p@db.example.com/humancare_dev' })).problems).toEqual(['database_not_loopback']);
    const db = fakeDb({ database: 'humancare_test' });
    await inspect(db);
    expect(db.queries.some((q) => q.sql.includes('integration_outbox'))).toBe(false); // refused before the event is even read
  });

  test('duplicate dispatch is prevented: a completed event, or a link that already holds a Deal ID, is reported as already dispatched', async () => {
    expect(await inspect(fakeDb({ row: { ...GOOD_ROW, status: 'completed' } }))).toMatchObject({ ok: false, alreadyDispatched: true, problems: ['already_dispatched'] });
    expect(await inspect(fakeDb({ row: { ...GOOD_ROW, bitrix_deal_id: '48213' } }))).toMatchObject({ ok: false, alreadyDispatched: true });
  });
});

describe('environmentProblems', () => {
  test('the Deal-worker environment is accepted', () => { expect(single.environmentProblems(ENV)).toEqual([]); });

  test.each([
    ['production', { NODE_ENV: 'production' }, 'production_refused'],
    ['master switch off', { BITRIX_SYNC_ENABLED: 'false' }, 'bitrix_switches_not_both_true'],
    ['Deal switch off', { BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'false' }, 'bitrix_switches_not_both_true'],
    ['no profile', { BITRIX_DEAL_PROFILE: undefined }, 'bitrix_deal_profile_not_actual'],
    ['the test profile', { BITRIX_DEAL_PROFILE: 'test' }, 'bitrix_deal_profile_not_actual'],
    ['review workflow off', { PRIVATE_CHARTER_REVIEW_WORKFLOW: 'false' }, 'review_workflow_not_true'],
    ['quotation synchronization ON (must be off)', { BITRIX_QUOTATION_SYNC_ENABLED: 'true' }, 'quotation_sync_must_be_off'],
    ['no webhook', { BITRIX24_WEBHOOK_URL: undefined }, 'webhook_not_configured'],
    ['a webhook for another portal', { BITRIX_ALLOWED_PORTAL_HOST: 'other.bitrix24.in' }, 'portal_host_not_allowed'],
  ])('refused: %s', (_n, override, code) => {
    expect(single.environmentProblems({ ...ENV, ...override })).toContain(code);
  });
});

describe('dispatchSingleEvent', () => {
  let db; let runWorker; let gateway; let clock; let sleeps; let log;
  const run = (over = {}) => single.dispatchSingleEvent({ prisma: db, env: ENV, log, gateway, runWorker, now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); clock.t += ms; }, ...NAMED, ...over });
  const complete = () => Object.assign(db.state, { status: 'completed', attempts: 1, bitrix_deal_id: '48213', category_id: '0', stage_id: 'NEW', sync_status: 'synced' });

  beforeEach(() => {
    db = fakeDb();
    clock = { t: 1_000_000 };
    sleeps = [];
    log = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    gateway = createDispatcher();
    runWorker = jest.fn(async () => { complete(); return { active: true, claimed: 1 }; });
  });

  test('DRY RUN (the default): the same checks, no worker pass, no sleep, no write', async () => {
    const r = await run();
    expect(r).toMatchObject({ outcome: 'dry_run', ready: true, environmentProblems: [], otherEventsTouchedBefore: 0, target: { eventId: 53, caseId: 206 } });
    expect(runWorker).not.toHaveBeenCalled();
    expect(writesIn(db)).toEqual([]);
  });

  test('a dry run reports an environment that would be refused, without refusing the preview', async () => {
    const r = await run({ env: { ...ENV, BITRIX_SYNC_ENABLED: 'false', BITRIX_DEAL_PROFILE: undefined } });
    expect(r).toMatchObject({ outcome: 'dry_run', ready: false });
    expect(r.environmentProblems).toEqual(expect.arrayContaining(['bitrix_switches_not_both_true', 'bitrix_deal_profile_not_actual']));
    expect(runWorker).not.toHaveBeenCalled();
  });

  test('EXECUTE: one scoped pass of the EXISTING Deal worker, narrowed to Case 206 and event 53, with the shared gateway; completed with the exact Deal ID at Category 0 / NEW', async () => {
    const r = await run({ execute: true });
    expect(runWorker).toHaveBeenCalledTimes(1);
    const options = runWorker.mock.calls[0][0];
    expect(options.scope).toEqual({ caseIds: [206], eventIds: [53] });
    expect(options.gateway).toBe(gateway); // the ONE shared gateway object it was given
    expect(options.env).toBe(ENV);
    expect(await options.reportFailures()).toBe(0); // it never writes failure alerts about events outside its scope
    expect(r).toMatchObject({ outcome: 'completed', passes: 1, otherEventsTouchedBefore: 0, otherEventsTouchedAfter: 0 });
    expect(r.state).toMatchObject({ status: 'completed', dealId: '48213', categoryId: '0', stageId: 'NEW', syncStatus: 'synced' });
    expect(writesIn(db)).toEqual([]); // this module itself never writes; every write is the Deal worker's, under its lease and fence
  });

  test('EXECUTE refuses, running nothing, when the environment is not a Deal worker\'s or quotation sync is on', async () => {
    for (const env of [{ ...ENV, BITRIX_SYNC_ENABLED: 'false' }, { ...ENV, BITRIX_QUOTATION_SYNC_ENABLED: 'true' }, { ...ENV, BITRIX_DEAL_PROFILE: 'test' }]) {
      const r = await run({ execute: true, env });
      expect(r.outcome).toBe('refused');
      expect(r.problems.length).toBeGreaterThan(0);
    }
    expect(runWorker).not.toHaveBeenCalled();
  });

  test.each([
    ['another Case reference', { caseReference: 'CASE-1158' }],
    ['another request reference', { requestReference: 'REQ-1157' }],
  ])('EXECUTE refuses before any pass when the named references do not match the event: %s', async (_n, override) => {
    const r = await run({ execute: true, ...override });
    expect(r.outcome).toBe('refused');
    expect(runWorker).not.toHaveBeenCalled();
  });

  test('EXECUTE never runs for the synthetic identity (REQ-1157\'s shape), whatever its stamp', async () => {
    db = fakeDb({ row: { ...GOOD_ROW, id: 2n, case_id: 158n, entity_id: '158', idempotency_key: 'bitrix.deal.create:case:158', case_reference: 'CASE-1158', request_reference: 'REQ-1157', patient_name: 'ZZ-SYNTHETIC Run B' } });
    const r = await run({ execute: true, eventId: 2, caseReference: 'CASE-1158', requestReference: 'REQ-1157' });
    expect(r).toMatchObject({ outcome: 'refused', problems: ['synthetic_identity'] });
    expect(runWorker).not.toHaveBeenCalled();
  });

  test('EXECUTE on an event that is already dispatched does nothing (no pass, no call)', async () => {
    db = fakeDb({ row: { ...GOOD_ROW, status: 'completed', bitrix_deal_id: '48213' } });
    expect(await run({ execute: true })).toMatchObject({ outcome: 'already_dispatched' });
    expect(runWorker).not.toHaveBeenCalled();
  });

  test('EXECUTE needs the shared gateway and the worker; without them it refuses', async () => {
    expect((await run({ execute: true, gateway: undefined })).problems).toEqual(['gateway_or_worker_missing']);
    expect((await run({ execute: true, runWorker: undefined })).problems).toEqual(['gateway_or_worker_missing']);
  });

  test('a refusal to retry later: another scoped pass runs only when the Deal worker says it is due, then it completes (no pass is run for any other event)', async () => {
    let call = 0;
    runWorker = jest.fn(async () => {
      call += 1;
      if (call === 1) Object.assign(db.state, { status: 'pending', attempts: 1, last_error: 'retry:blocking:query_limit_exceeded', next_attempt_at: new Date(clock.t + 60_000) });
      else complete();
      return { active: true, claimed: 1 };
    });
    const r = await run({ execute: true });
    expect(r.outcome).toBe('completed');
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([61_000]); // exactly until due (+1s)
    for (const [options] of runWorker.mock.calls) expect(options.scope).toEqual({ caseIds: [206], eventIds: [53] });
  });

  test('an ambiguous timeout is reconciled by the Deal worker on later passes (the launcher never calls Bitrix itself and never creates a Deal)', async () => {
    let call = 0;
    runWorker = jest.fn(async () => {
      call += 1;
      if (call === 1) Object.assign(db.state, { status: 'ambiguous', attempts: 1, last_error: 'Bitrix24 Deal call: timeout', external_call_started_at: new Date(), next_attempt_at: new Date(clock.t + 60_000) });
      else complete(); // the reconciliation found the Deal and adopted it
      return { active: true, claimed: 1 };
    });
    const r = await run({ execute: true });
    expect(r).toMatchObject({ outcome: 'completed', passes: 2 });
    expect(r.state.dealId).toBe('48213');
  });

  test('waits are bounded: never less than 5 s or more than 90 s between passes', async () => {
    let call = 0;
    runWorker = jest.fn(async () => { call += 1; Object.assign(db.state, { status: 'pending', next_attempt_at: new Date(call === 1 ? clock.t - 500_000 : clock.t + 600_000) }); if (call === 3) complete(); return {}; });
    await run({ execute: true });
    expect(sleeps).toEqual([5_000, 90_000]);
  });

  test.each([
    ['failed', { status: 'failed', last_error: 'Bitrix24 Deal call: bitrix_error' }, 'failed'],
    ['manual review', { status: 'ambiguous', last_error: 'manual_review_required:multiple_matching_deals' }, 'manual_review'],
  ])('a terminal state that needs a person stops the loop and is reported: %s', async (_n, state, outcome) => {
    runWorker = jest.fn(async () => { Object.assign(db.state, state); return {}; });
    const r = await run({ execute: true });
    expect(r.outcome).toBe(outcome);
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  test('the loop is bounded in time: after --max-minutes it stops, reports incomplete and leaves the event to the Deal worker', async () => {
    runWorker = jest.fn(async () => { Object.assign(db.state, { status: 'pending', next_attempt_at: new Date(clock.t + 60_000) }); return {}; });
    const r = await run({ execute: true, maxMinutes: 3 });
    expect(r.outcome).toBe('incomplete');
    expect(clock.t - 1_000_000).toBeGreaterThanOrEqual(3 * 60 * 1000);
    expect(runWorker.mock.calls.length).toBeLessThanOrEqual(single.MAX_PASSES);
  });

  test('an event left in "processing" (a lost lease) is reported, never forced', async () => {
    runWorker = jest.fn(async () => { Object.assign(db.state, { status: 'processing' }); return {}; });
    expect((await run({ execute: true })).outcome).toBe('incomplete');
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  test('other events touched are measured before and after (a non-zero "after" would show something else moved)', async () => {
    db.others = 0;
    runWorker = jest.fn(async () => { db.others = 1; complete(); return {}; });
    const r = await run({ execute: true });
    expect(r).toMatchObject({ otherEventsTouchedBefore: 0, otherEventsTouchedAfter: 1 });
  });
});

describe('what the launcher can never do (by construction)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
  const moduleSource = read('src/modules/bitrix/single-event-dispatch.js');
  const scriptSource = read('scripts/dispatch-deal-event.js');

  test('it does not load the job runner, the job list, the general worker, quotation sync, payments or the synthetic engine', () => {
    for (const source of [moduleSource, scriptSource]) {
      expect(source).not.toMatch(/require\([^)]*(job-runner|jobs\/index|jobs'|\/worker'|worker\.js|quotation|payment|razorpay|invoice|synthetic|document-worker|inbox|reconcile)/i);
    }
  });

  test('it starts no job and no timer of its own beyond the bounded wait between scoped passes', () => {
    expect(moduleSource).not.toMatch(/setInterval|createJobRunner|\.start\(\)/);
    expect(scriptSource).not.toMatch(/setInterval|createJobRunner/);
  });

  test('the module itself never writes: no INSERT / UPDATE / DELETE statement, and no direct Bitrix client', () => {
    expect(moduleSource).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(moduleSource).not.toMatch(/bitrix-deal\.api|createDeal|fetch\(/);
  });

  test('it never changes the environment or .env, and it has no way to skip a check', () => {
    for (const source of [moduleSource, scriptSource]) {
      expect(source).not.toMatch(/process\.env\.[A-Z_]+\s*=[^=]/);
      expect(source).not.toMatch(/writeFile|appendFile/);
    }
    expect(moduleSource).not.toMatch(/--force|--skip|--any/);
  });

  test('the script reuses the existing Deal worker and the shared gateway, and is wired into the package scripts', () => {
    expect(scriptSource).toMatch(/require\('\.\.\/src\/modules\/bitrix\/deal-worker\.service'\)/);
    expect(scriptSource).toMatch(/sharedDispatcher\(\)/);
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['dispatch:deal-event']).toBe('node scripts/dispatch-deal-event.js');
  });
});
