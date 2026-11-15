/* global describe, test, expect, jest, beforeEach */
// The Deal worker. No database and no network. The worker is driven against an in-memory store that applies the
// same rules as the real SQL (database clock, lease, fence, per-Case ordering), a mocked Prisma transaction and a
// mocked Bitrix Deal API. The real store's SQL is checked separately at the bottom (text of the statements).
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const worker = require('../../src/modules/bitrix/deal-worker.service');
const realStore = require('../../src/modules/bitrix/deal-outbox.store');
const { BitrixDealCallError } = require('../../src/modules/bitrix/bitrix-deal.api');

const { runDealWorker, LEASE_SECONDS, RECONCILE_FIRST_DELAY_SECONDS, RECONCILE_INTERVAL_SECONDS, RECONCILIATION_WINDOW_SECONDS } = worker;
const ENV_ON = { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' };
const REF = 'HC-PC-000123';

// ---- in-memory world ----------------------------------------------------------------------------------------------
let clock; // the DATABASE clock, in seconds
let events;
let order; // every observable step, in order
let linkRow;
let auditRows;
let caseRow;

const newEvent = (over = {}) => ({
  id: 1, caseId: 7, entityId: '7', status: 'pending', attempts: 0, nextAt: 0, lockedBy: null, lockedUntil: null,
  callStartedAt: null, lastError: null, ...over,
});

function makeStore() {
  const due = (e) => e.nextAt <= clock && (e.lockedUntil == null || e.lockedUntil <= clock);
  const owns = (e, c) => e.status === 'processing' && e.attempts === c.attempts && e.lockedBy === c.workerId && e.lockedUntil > clock;
  return {
    MANUAL_REVIEW_PREFIX: realStore.MANUAL_REVIEW_PREFIX,
    recoverExpiredLeases: jest.fn(async (_db, { maxClaims }) => {
      for (const e of events) {
        if (e.status !== 'processing' || e.lockedUntil > clock) continue;
        if (e.callStartedAt != null) Object.assign(e, { status: 'ambiguous', lastError: 'lease_expired_during_external_call', nextAt: clock, lockedBy: null, lockedUntil: null });
        else if (e.attempts >= maxClaims) Object.assign(e, { status: 'failed', lockedBy: null, lockedUntil: null });
        else Object.assign(e, { status: 'pending', nextAt: clock, lockedBy: null, lockedUntil: null });
      }
    }),
    findCandidateIds: jest.fn(async (_db, status, limit) => events
      .filter((e) => e.status === status && due(e) && !(e.lastError || '').startsWith(realStore.MANUAL_REVIEW_PREFIX))
      .slice(0, limit).map((e) => e.id)),
    claim: jest.fn(async (_db, { id, fromStatus, workerId, leaseSeconds }) => {
      const e = events.find((x) => x.id === id);
      if (!e || e.status !== fromStatus || !due(e)) return null;
      if (events.some((x) => x.caseId === e.caseId && x.id < e.id && x.status !== 'completed')) return null; // ordering
      Object.assign(e, { status: 'processing', attempts: e.attempts + 1, lockedBy: workerId, lockedUntil: clock + leaseSeconds });
      order.push(`claim:${id}`);
      return { id, fromStatus, workerId, attempts: e.attempts, caseId: e.caseId, externalCallStartedAt: e.callStartedAt, secondsSinceCall: e.callStartedAt == null ? null : clock - e.callStartedAt };
    }),
    markExternalCallStarted: jest.fn(async (_db, c, minLeft) => {
      const e = events.find((x) => x.id === c.id);
      if (!owns(e, c) || e.lockedUntil <= clock + minLeft || e.callStartedAt != null) return false;
      e.callStartedAt = clock;
      order.push('call-started-marked');
      return true;
    }),
    writeResult: jest.fn(async (_db, c, { status, lastError = null, delaySeconds = 0 }) => {
      const e = events.find((x) => x.id === c.id);
      if (!owns(e, c)) return 0;
      Object.assign(e, { status, lastError, nextAt: clock + delaySeconds, lockedBy: null, lockedUntil: null });
      order.push(`result:${status}`);
      return 1;
    }),
  };
}

function makePrisma() {
  const tx = {
    bitrixDealLink: { update: jest.fn(async ({ data }) => { order.push('link-update'); linkRow = { ...linkRow, ...data }; }) },
    auditLog: { create: jest.fn(async ({ data }) => { auditRows.push(data); }) },
  };
  return {
    tx,
    // A transaction that really rolls back: writes made before a throw are undone.
    $transaction: jest.fn(async (callback) => {
      const snapshot = { events: events.map((e) => ({ ...e })), linkRow: { ...linkRow }, audit: [...auditRows], order: [...order] };
      try { return await callback(tx); } catch (err) {
        events = snapshot.events; linkRow = snapshot.linkRow; auditRows = snapshot.audit; order = snapshot.order;
        throw err;
      }
    }),
    case: { findUnique: jest.fn(async () => (caseRow ? { ...caseRow, bitrixDealLink: linkRow } : null)) },
  };
}

const goodCase = () => ({
  id: 7, referenceNumber: REF, serviceRequestId: 3, patientName: 'Asha Rao',
  serviceRequest: {
    id: 3, serviceKey: 'privatecharter', reviewStatus: 'in_review', bitrixLeadId: null, patientName: 'Asha Rao', patientContact: '+971501234567',
    preferredDate: new Date('2030-03-05T00:00:00Z'), careLevel: 'care_icu', mobility: 'walking', equipCardiacMonitor: false, urgency: 'planned',
  },
});

let prisma; let store; let api; let log; let reportFailures;
const run = (extra = {}) => runDealWorker({ prisma, store, api, env: ENV_ON, log, workerId: 'worker-A', reportFailures, ...extra });
const call = (n) => api.createDeal.mock.calls[n];

beforeEach(() => {
  clock = 1000; events = [newEvent()]; order = []; auditRows = [];
  linkRow = { id: 1, caseId: 7, bitrixDealId: null, syncStatus: 'pending', stageId: null };
  caseRow = goodCase();
  prisma = makePrisma();
  store = makeStore();
  log = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  reportFailures = jest.fn(async () => 0);
  api = {
    createDeal: jest.fn(async () => { order.push('bitrix:create'); return { dealId: '48213' }; }),
    findDealsByReference: jest.fn(async () => { order.push('bitrix:search'); return { status: 'none', dealIds: [] }; }),
  };
});

// ---- switches -----------------------------------------------------------------------------------------------------
describe('the switches', () => {
  test.each([
    ['both Bitrix switches off', {}],
    ['only the master switch on', { BITRIX_SYNC_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }],
    ['only the Deal switch on', { BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }],
    ['both Bitrix switches on, review workflow off', { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' }],
    ['a switch that is not exactly "true"', { ...ENV_ON, BITRIX_SYNC_ENABLED: 'TRUE' }],
  ])('%s: nothing is recovered, claimed or sent', async (_name, env) => {
    expect(await run({ env })).toEqual({ active: false, claimed: 0 });
    expect(store.recoverExpiredLeases).not.toHaveBeenCalled();
    expect(store.findCandidateIds).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(api.createDeal).not.toHaveBeenCalled();
    expect(events[0].status).toBe('pending');
  });

  test('all switches on: the event is claimed and processed, and failure alerts are checked once', async () => {
    expect(await run()).toEqual({ active: true, claimed: 1 });
    expect(events[0].status).toBe('completed');
    expect(reportFailures).toHaveBeenCalledTimes(1);
  });

  test('switches off: no alert check either', async () => {
    await run({ env: {} });
    expect(reportFailures).not.toHaveBeenCalled();
  });

  test('a problem while writing alerts never stops the pass', async () => {
    reportFailures.mockRejectedValue(new Error('db down'));
    await expect(run()).resolves.toEqual({ active: true, claimed: 1 });
    expect(events[0].status).toBe('completed');
  });
});

// ---- success ------------------------------------------------------------------------------------------------------
describe('a successful Deal creation', () => {
  test('marks the call started BEFORE calling Bitrix, calls once, then records the result', async () => {
    await run();
    expect(order).toEqual(['claim:1', 'call-started-marked', 'bitrix:create', 'result:completed', 'link-update']);
    expect(api.createDeal).toHaveBeenCalledTimes(1);
  });

  test('sends the Category 38 payload built from the Case', async () => {
    await run();
    const [fields, options] = call(0);
    expect(fields).toMatchObject({ CATEGORY_ID: 38, STAGE_ID: 'C38:NEW', SOURCE_ID: 'UC_0AYN3R', TITLE: REF, UF_CRM_1794548440549: REF, UF_CRM_6A2FB92FE1881: [2844] });
    expect(options.env).toBe(ENV_ON);
  });

  test('stores the exact Deal ID as text on the link and completes the event, with an audit entry, in one transaction', async () => {
    api.createDeal.mockResolvedValue({ dealId: '000048213'.replace(/^0+/, '') });
    await run();
    expect(events[0]).toMatchObject({ status: 'completed', lockedBy: null, lockedUntil: null, lastError: null });
    expect(linkRow).toMatchObject({ bitrixDealId: '48213', categoryId: '38', stageId: 'C38:NEW', syncStatus: 'synced', lastError: null });
    expect(typeof linkRow.bitrixDealId).toBe('string');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: 'bitrix.deal.linked', entityType: 'bitrix_deal_link', caseId: 7, actorType: 'system' });
    expect(auditRows[0].afterData).toEqual({ caseId: 7, caseReference: REF, bitrixDealId: '48213' });
  });

  test('Bitrix is never called inside a database transaction', async () => {
    const inTransaction = [];
    let depth = 0;
    const original = prisma.$transaction.getMockImplementation();
    prisma.$transaction.mockImplementation(async (cb) => { depth += 1; try { return await original(cb); } finally { depth -= 1; } });
    api.createDeal.mockImplementation(async () => { inTransaction.push(depth); return { dealId: '1' }; });
    api.findDealsByReference.mockImplementation(async () => { inTransaction.push(depth); return { status: 'none', dealIds: [] }; });
    await run();
    expect(inTransaction).toEqual([0]);
  });

  test('a completed event is never sent again', async () => {
    await run();
    await run();
    expect(api.createDeal).toHaveBeenCalledTimes(1);
  });

  test('a Case that already has its Deal ID is only completed, never sent again', async () => {
    linkRow.bitrixDealId = '777';
    await run();
    expect(api.createDeal).not.toHaveBeenCalled();
    expect(events[0].status).toBe('completed');
    expect(linkRow.bitrixDealId).toBe('777');
  });
});

// ---- definitive failure -------------------------------------------------------------------------------------------
describe('a definitive Bitrix failure', () => {
  beforeEach(() => { api.createDeal.mockRejectedValue(new BitrixDealCallError('definitive', 'bitrix_error', 'HTTP 400 ERROR_CORE: Field is invalid')); });

  test('is recorded as failed, the link as error, and is not retried automatically', async () => {
    await run();
    expect(events[0]).toMatchObject({ status: 'failed', lockedBy: null });
    expect(events[0].lastError).toMatch(/bitrix_error/);
    expect(linkRow).toMatchObject({ syncStatus: 'error', bitrixDealId: null });
    clock += 100000;
    await run();
    await run();
    expect(api.createDeal).toHaveBeenCalledTimes(1);
    expect(api.findDealsByReference).not.toHaveBeenCalled();
  });
});

describe('a Case that cannot be mapped', () => {
  test('is refused before any marker or call', async () => {
    caseRow.serviceRequest.careLevel = 'care_icu,care_stable';
    await run();
    expect(events[0]).toMatchObject({ status: 'failed', lastError: 'mapping:care_level_not_single' });
    expect(events[0].callStartedAt).toBeNull();
    expect(api.createDeal).not.toHaveBeenCalled();
  });
});

// ---- ambiguous outcomes and reconciliation ------------------------------------------------------------------------
describe('a timeout or lost response', () => {
  beforeEach(() => { api.createDeal.mockRejectedValue(new BitrixDealCallError('ambiguous', 'timeout', 'crm.deal.add timed out after 15s')); });

  test('is recorded as ambiguous with the call evidence kept, and the link stays pending', async () => {
    await run();
    expect(events[0]).toMatchObject({ status: 'ambiguous', callStartedAt: 1000, nextAt: 1000 + RECONCILE_FIRST_DELAY_SECONDS });
    expect(linkRow).toMatchObject({ syncStatus: 'pending', bitrixDealId: null });
  });

  test('an unexpected error during the call is also ambiguous', async () => {
    api.createDeal.mockRejectedValue(new TypeError('boom'));
    await run();
    expect(events[0].status).toBe('ambiguous');
  });

  test('crm.deal.add is NEVER repeated: the next passes only search', async () => {
    await run();
    expect(await run()).toMatchObject({ claimed: 0 }); // not due yet
    clock += RECONCILE_FIRST_DELAY_SECONDS;
    await run();
    clock += RECONCILE_INTERVAL_SECONDS;
    await run();
    expect(api.createDeal).toHaveBeenCalledTimes(1);
    expect(api.findDealsByReference).toHaveBeenCalledWith(REF, { env: ENV_ON });
  });

  test('exactly one matching Deal is adopted with its exact ID, stage and an audit entry', async () => {
    await run();
    clock += RECONCILE_FIRST_DELAY_SECONDS;
    api.findDealsByReference.mockResolvedValue({ status: 'single', dealIds: ['9001'], stageId: 'C38:PREPARATION' });
    await run();
    expect(events[0]).toMatchObject({ status: 'completed', lastError: null });
    expect(linkRow).toMatchObject({ bitrixDealId: '9001', stageId: 'C38:PREPARATION', syncStatus: 'synced' });
    expect(auditRows[0]).toMatchObject({ reasonCode: 'deal_adopted_by_reference' });
    expect(api.createDeal).toHaveBeenCalledTimes(1);
  });

  test('several matching Deals go to manual review, are not adopted and are never deleted', async () => {
    await run();
    clock += RECONCILE_FIRST_DELAY_SECONDS;
    api.findDealsByReference.mockResolvedValue({ status: 'multiple', dealIds: ['9001', '9002'] });
    await run();
    expect(events[0].status).toBe('ambiguous');
    expect(events[0].lastError).toBe('manual_review_required:multiple_matching_deals');
    expect(linkRow).toMatchObject({ syncStatus: 'error', bitrixDealId: null });
    clock += 10 * RECONCILE_INTERVAL_SECONDS;
    await run();
    expect(api.findDealsByReference).toHaveBeenCalledTimes(1); // not offered again
    expect(api.createDeal).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['an empty search', { status: 'none', dealIds: [] }],
    ['an uncertain lookup', { status: 'uncertain', dealIds: [], reason: 'timeout' }],
  ])('%s does not prove that no Deal exists: it keeps waiting and looking again', async (_name, answer) => {
    await run();
    api.findDealsByReference.mockResolvedValue(answer);
    for (let i = 0; i < 5; i += 1) {
      clock += RECONCILE_INTERVAL_SECONDS;
      await run();
      expect(events[0].status).toBe('ambiguous');
      expect(events[0].lastError).toMatch(/^reconciling:/);
    }
    expect(api.createDeal).toHaveBeenCalledTimes(1);
    expect(api.findDealsByReference.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  test('after the waiting period without a match, the event goes to manual review and no new Deal is created', async () => {
    await run();
    api.findDealsByReference.mockResolvedValue({ status: 'none', dealIds: [] });
    clock += RECONCILIATION_WINDOW_SECONDS + 1;
    await run();
    expect(events[0].lastError).toBe('manual_review_required:no_match_after_waiting_period');
    expect(linkRow.syncStatus).toBe('error');
    clock += 10 * RECONCILE_INTERVAL_SECONDS;
    await run();
    expect(api.createDeal).toHaveBeenCalledTimes(1);
    expect(api.findDealsByReference).toHaveBeenCalledTimes(1);
  });

  test('a Deal ID that is already linked to another Case goes to manual review, not into a retry loop', async () => {
    await run();
    clock += RECONCILE_FIRST_DELAY_SECONDS;
    api.findDealsByReference.mockResolvedValue({ status: 'single', dealIds: ['9001'], stageId: null });
    prisma.tx.bitrixDealLink.update.mockImplementationOnce(async () => { throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }); });
    await run();
    expect(events[0].lastError).toBe('manual_review_required:deal_id_already_linked');
    expect(linkRow.bitrixDealId).toBeNull();
  });
});

// ---- lease and fencing --------------------------------------------------------------------------------------------
describe('lease and fencing', () => {
  test('the lease is taken with the claim and released when the result is written', async () => {
    api.createDeal.mockImplementation(async () => {
      expect(events[0]).toMatchObject({ status: 'processing', lockedBy: 'worker-A', lockedUntil: 1000 + LEASE_SECONDS, attempts: 1 });
      return { dealId: '5' };
    });
    await run();
    expect(events[0]).toMatchObject({ lockedBy: null, lockedUntil: null });
  });

  test('a worker whose lease expired during the call cannot record the success; recovery then adopts the Deal by reference', async () => {
    api.createDeal.mockImplementation(async () => { clock += LEASE_SECONDS + 1; return { dealId: '5' }; });
    await run();
    expect(events[0]).toMatchObject({ status: 'processing', lockedBy: 'worker-A' }); // nothing was written
    expect(linkRow.bitrixDealId).toBeNull();
    expect(auditRows).toHaveLength(0);

    api.findDealsByReference.mockResolvedValue({ status: 'single', dealIds: ['5'], stageId: 'C38:NEW' });
    await run({ workerId: 'worker-B' }); // recovery: lease expired + call started -> ambiguous (due now)
    expect(api.createDeal).toHaveBeenCalledTimes(1);
    expect(events[0].status).toBe('completed');
    expect(linkRow.bitrixDealId).toBe('5');
  });

  test('an expired worker also cannot record a definitive failure or an ambiguous outcome', async () => {
    api.createDeal.mockImplementation(async () => { clock += LEASE_SECONDS + 1; throw new BitrixDealCallError('definitive', 'bitrix_error', 'x'); });
    await run();
    expect(events[0].status).toBe('processing');
    expect(linkRow.syncStatus).toBe('pending');
  });

  test('a stale worker can never overwrite a newer worker\'s claim', async () => {
    const a = await store.claim(null, { id: 1, fromStatus: 'pending', workerId: 'worker-A', leaseSeconds: 10 });
    clock += 11;
    await store.recoverExpiredLeases(null, { maxClaims: 10 });
    const b = await store.claim(null, { id: 1, fromStatus: 'pending', workerId: 'worker-B', leaseSeconds: 10 });
    expect(b.attempts).toBe(2);
    expect(await store.writeResult(null, a, { status: 'completed' })).toBe(0);
    expect(events[0]).toMatchObject({ status: 'processing', lockedBy: 'worker-B' });
    expect(await store.writeResult(null, b, { status: 'completed' })).toBe(1);
  });

  test('if the remaining lease cannot cover the request timeout, no call is made', async () => {
    store.markExternalCallStarted.mockResolvedValue(false);
    await run();
    expect(api.createDeal).not.toHaveBeenCalled();
  });

  test('an expired lease with no call started returns the event to pending, and it is sent once', async () => {
    store.markExternalCallStarted.mockImplementationOnce(async () => false); // first pass: worker "dies" before the call
    await run();
    expect(events[0].status).toBe('processing');
    clock += LEASE_SECONDS + 1;
    await run();
    expect(api.createDeal).toHaveBeenCalledTimes(1);
    expect(events[0].status).toBe('completed');
  });

  test('a lease that expired after the call started never goes back to pending', async () => {
    api.createDeal.mockImplementation(async () => { clock += LEASE_SECONDS + 1; throw new Error('worker died'); });
    await run();
    await store.recoverExpiredLeases(null, { maxClaims: 10 });
    expect(events[0].status).toBe('ambiguous');
  });
});

// ---- ordering and exclusions --------------------------------------------------------------------------------------
describe('per-Case ordering', () => {
  test.each(['pending', 'processing', 'ambiguous', 'failed'])('a later event waits while an earlier event of the Case is %s', async (status) => {
    events = [newEvent({ id: 1, status, nextAt: status === 'pending' ? 9999 : 0, lockedUntil: status === 'processing' ? 9999 : null }), newEvent({ id: 2 })];
    await run();
    expect(events[1].status).toBe('pending');
    expect(api.createDeal).not.toHaveBeenCalled();
  });

  test('a later event is processed once the earlier one is completed', async () => {
    events = [newEvent({ id: 1, status: 'completed' }), newEvent({ id: 2 })];
    await run();
    expect(events[1].status).toBe('completed');
  });
});

describe('what the worker never sends', () => {
  const ineligible = {
    'a Corporate Case (no service request)': (c) => { c.serviceRequestId = null; c.serviceRequest = null; },
    'another service': (c) => { c.serviceRequest.serviceKey = 'ground'; },
    'a request with NULL review status': (c) => { c.serviceRequest.reviewStatus = null; },
    'a request that already has a Lead': (c) => { c.serviceRequest.bitrixLeadId = 4321; },
  };
  test.each(Object.keys(ineligible))('%s: no marker, no call, a definitive failure', async (name) => {
    ineligible[name](caseRow);
    await run();
    expect(api.createDeal).not.toHaveBeenCalled();
    expect(api.findDealsByReference).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ status: 'failed', callStartedAt: null });
    expect(events[0].lastError).toMatch(/^not_eligible/);
  });

  test('a missing link is a failure, not a call', async () => {
    linkRow = null;
    prisma.case.findUnique.mockImplementation(async () => ({ ...caseRow, bitrixDealLink: null }));
    prisma.tx.bitrixDealLink.update.mockImplementation(async () => {});
    await run();
    expect(api.createDeal).not.toHaveBeenCalled();
    expect(events[0].lastError).toBe('deal_link_missing');
  });

  test('a pending event that already has call evidence is reconciled, never sent', async () => {
    events[0].callStartedAt = 500;
    await run();
    expect(api.createDeal).not.toHaveBeenCalled();
    expect(api.findDealsByReference).toHaveBeenCalled();
  });
});

// ---- the real store's SQL -----------------------------------------------------------------------------------------
describe('the SQL of the real store', () => {
  const text = (strings) => strings.join('?').replace(/\s+/g, ' ');
  function fakeDb(queryResults = []) {
    const executed = [];
    const queried = [];
    const db = {
      $executeRaw: jest.fn(async (strings, ...values) => { executed.push({ sql: text(strings), values }); return 1; }),
      $queryRaw: jest.fn(async (strings, ...values) => { queried.push({ sql: text(strings), values }); return queryResults.shift() ?? []; }),
      $transaction: jest.fn(async (cb) => cb(db)),
    };
    return { db, executed, queried };
  }
  const claim = { id: 4, attempts: 2, workerId: 'worker-A', caseId: 7 };

  test('candidates: only Private Charter, reviewed, Lead-free Cases with a service request; never manual-review events', async () => {
    const { db, queried } = fakeDb([[{ id: 4n }]]);
    expect(await realStore.findCandidateIds(db, 'pending', 5)).toEqual([4]);
    const sql = queried[0].sql;
    expect(sql).toContain('JOIN cases c ON c.id = o.case_id');
    expect(sql).toContain('JOIN service_requests sr ON sr.id = c.service_request_id');
    expect(sql).toContain('sr.service_key = ?');
    expect(sql).toContain('sr.review_status IS NOT NULL');
    expect(sql).toContain('sr.bitrix_lead_id IS NULL');
    expect(sql).toContain('o.next_attempt_at <= UTC_TIMESTAMP(3)');
    expect(sql).toContain('NOT LIKE');
    expect(queried[0].values).toEqual(expect.arrayContaining(['bitrix.deal.create', 'privatecharter', 'pending']));
  });

  test('claim: locks the event and the Case\'s earlier events, then one compare-and-swap UPDATE on the database clock', async () => {
    const row = { id: 4, status: 'pending', attempts: 0, case_id: 7, entity_type: 'case', entity_id: '7', external_call_started_at: null, seconds_since_call: null };
    const { db, executed, queried } = fakeDb([[row], []]);
    const taken = await realStore.claim(db, { id: 4, fromStatus: 'pending', workerId: 'worker-A', leaseSeconds: 120 });
    expect(queried[0].sql).toContain('FOR UPDATE');
    expect(queried[1].sql).toContain('id < ?');
    expect(queried[1].sql).toContain('FOR UPDATE');
    const update = executed[0].sql;
    expect(update).toContain("status = 'processing'");
    expect(update).toContain('attempts = attempts + 1');
    expect(update).toContain('locked_until = UTC_TIMESTAMP(3) + INTERVAL ? SECOND');
    expect(update).toContain('WHERE id = ? AND status = ? AND attempts = ?');
    expect(update).not.toMatch(/NOW\(/i);
    expect(taken).toMatchObject({ id: 4, attempts: 1, caseId: 7, workerId: 'worker-A' });
  });

  test('claim: an earlier non-completed event, or 0 rows changed, means no claim', async () => {
    const row = { id: 4, status: 'pending', attempts: 0, case_id: 7, entity_type: 'case', entity_id: '7' };
    const blocked = fakeDb([[row], [{ id: 3, status: 'failed' }]]);
    expect(await realStore.claim(blocked.db, { id: 4, fromStatus: 'pending', workerId: 'w', leaseSeconds: 120 })).toBeNull();
    expect(blocked.executed).toHaveLength(0);
    const lost = fakeDb([[row], [{ id: 3, status: 'completed' }]]);
    lost.db.$executeRaw.mockResolvedValue(0);
    expect(await realStore.claim(lost.db, { id: 4, fromStatus: 'pending', workerId: 'w', leaseSeconds: 120 })).toBeNull();
  });

  describe('claim ordering after a recovery decision', () => {
    const row = (key) => ({ id: 30, status: 'pending', attempts: 0, case_id: 7, entity_type: 'case', entity_id: '7', idempotency_key: key });
    const take = (results) => { const f = fakeDb(results); return realStore.claim(f.db, { id: 30, fromStatus: 'pending', workerId: 'w', leaseSeconds: 120 }); };
    const replacementKey = 'bitrix.deal.create:case:7:recovery:10';

    test('a failed event does not block its OWN replacement', async () => {
      expect(await take([[row(replacementKey)], [{ id: 10, status: 'failed', last_error: 'mapping:care_level_not_single' }]])).toMatchObject({ id: 30 });
    });
    test('a failed event keeps blocking a later event until its replacement has COMPLETED', async () => {
      expect(await take([[row('stage-update')], [{ id: 10, status: 'failed' }], [{ status: 'completed' }]])).toMatchObject({ id: 30 });
      expect(await take([[row('stage-update')], [{ id: 10, status: 'failed' }], [{ status: 'pending' }]])).toBeNull();
      expect(await take([[row('stage-update')], [{ id: 10, status: 'failed' }], [{ status: 'failed' }]])).toBeNull();
      expect(await take([[row('stage-update')], [{ id: 10, status: 'failed' }], []])).toBeNull();
    });
    test('an ambiguous event in manual review is released the same way; one still reconciling never is', async () => {
      expect(await take([[row(replacementKey)], [{ id: 10, status: 'ambiguous', last_error: 'manual_review_required:no_match_after_waiting_period' }]])).toMatchObject({ id: 30 });
      expect(await take([[row(replacementKey)], [{ id: 10, status: 'ambiguous', last_error: 'reconciling:no_match' }]])).toBeNull();
    });
    test('pending and processing events block, with or without a replacement key', async () => {
      expect(await take([[row(replacementKey)], [{ id: 10, status: 'pending' }]])).toBeNull();
      expect(await take([[row(replacementKey)], [{ id: 10, status: 'processing' }]])).toBeNull();
    });
  });

  test('the result UPDATE is fenced on id, status, attempts, owner and an unexpired lease, all on the database clock', async () => {
    const { db, executed } = fakeDb();
    expect(await realStore.writeResult(db, claim, { status: 'completed' })).toBe(1);
    const sql = executed[0].sql;
    expect(sql).toContain("WHERE id = ? AND status = 'processing' AND attempts = ? AND locked_by = ?");
    expect(sql).toContain('locked_until > UTC_TIMESTAMP(3)');
    expect(sql).not.toMatch(/NOW\(/i);
    expect(executed[0].values).toEqual(expect.arrayContaining([4, 2, 'worker-A']));
  });

  test('external_call_started_at is written once, fenced, and only if the lease outlives the call', async () => {
    const { db, executed } = fakeDb();
    expect(await realStore.markExternalCallStarted(db, claim, 45)).toBe(true);
    const sql = executed[0].sql;
    expect(sql).toContain('external_call_started_at = UTC_TIMESTAMP(3)');
    expect(sql).toContain('external_call_started_at IS NULL');
    expect(sql).toContain('locked_until > UTC_TIMESTAMP(3) + INTERVAL ? SECOND');
    expect(sql).toContain("status = 'processing' AND attempts = ? AND locked_by = ?");
  });

  test('recovery: no call started -> pending (or failed past the cap); call started -> ambiguous; failed events untouched', async () => {
    const { db, executed } = fakeDb();
    await realStore.recoverExpiredLeases(db, { maxClaims: 10 });
    const [toFailed, toPending, toAmbiguous] = executed.map((e) => e.sql);
    expect(toFailed).toContain("SET status = 'failed'");
    expect(toFailed).toContain('external_call_started_at IS NULL AND attempts >= ?');
    expect(toPending).toContain("SET status = 'pending'");
    expect(toPending).toContain('external_call_started_at IS NULL AND attempts < ?');
    expect(toAmbiguous).toContain("SET status = 'ambiguous'");
    expect(toAmbiguous).toContain('external_call_started_at IS NOT NULL');
    for (const sql of [toFailed, toPending, toAmbiguous]) {
      expect(sql).toContain("status = 'processing' AND locked_until <= UTC_TIMESTAMP(3)");
      expect(sql).not.toContain("status = 'failed' AND");
    }
  });

  test('last_error is stripped of URLs and capped', () => {
    expect(realStore.cleanError('boom https://x.example/rest/1/TOKEN/ end')).toBe('boom [url] end');
    expect(realStore.cleanError('a'.repeat(900))).toHaveLength(500);
    expect(realStore.cleanError(null)).toBeNull();
  });
});
