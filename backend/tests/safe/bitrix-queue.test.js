/* global describe, test, expect, jest, beforeEach */
// The shared Bitrix24 queue infrastructure: backoff, ONE rate limiter, ONE circuit breaker, the gateway every worker's calls pass, the eight-queue
// registry (checked against the canonical service list), and every Bitrix worker running through the gateway. No database, no network, no real clock.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() }));

const { backoffSeconds } = require('../../src/modules/bitrix/queue/backoff');
const { createRateLimiter } = require('../../src/modules/bitrix/queue/rate-limiter');
const { createCircuitBreaker } = require('../../src/modules/bitrix/queue/circuit-breaker');
const { createDispatcher, classifyCallError, GateRefusedError } = require('../../src/modules/bitrix/queue/dispatcher');
const { SERVICE_QUEUES, serviceQueue, queueForRequestKey, PRIVATE_CHARTER_QUEUE, QUEUE_POLL_INTERVAL_MS } = require('../../src/modules/bitrix/queue/service-registry');
const SERVICES = require('../../src/modules/services/services.data');
const { ACTUAL_PROFILE } = require('../../src/modules/bitrix/bitrix-profiles');
const api = require('../../src/modules/bitrix/bitrix-deal.api');
const { BitrixDealCallError } = api;
const { runDealWorker, MAX_DELIVERY_ATTEMPTS } = require('../../src/modules/bitrix/deal-worker.service');
const { runDealDocumentWorker } = require('../../src/modules/bitrix/deal-document-worker.service');
const { runQuotationSync } = require('../../src/modules/bitrix/quotation-sync.service');
const { runInboxWorker } = require('../../src/modules/bitrix/deal-inbox.service');
const { reconcileDeals } = require('../../src/modules/bitrix/deal-reconcile.service');
const outboxStore = require('../../src/modules/bitrix/deal-outbox.store');
const { classifyFailure } = require('../../src/modules/bitrix/deal-failure-alerts');

const sleeper = (clock) => async (ms) => { clock.t += ms; };
const err = (outcome, code, extra = {}) => Object.assign(new BitrixDealCallError(outcome, code), extra);

describe('backoff', () => {
  test('doubles per attempt from the base, capped, with bounded jitter', () => {
    const mid = () => 0.5; // zero jitter
    expect([1, 2, 3, 4].map((n) => backoffSeconds(n, { rng: mid }))).toEqual([60, 120, 240, 480]);
    expect(backoffSeconds(20, { rng: mid })).toBe(3600);
    expect(backoffSeconds(3, { rng: () => 0 })).toBe(192); // -20%
    expect(backoffSeconds(3, { rng: () => 0.999999 })).toBe(288); // +20%
    expect(backoffSeconds(30, { rng: () => 0.999999 })).toBe(3600); // never above the cap, jitter included
    expect(backoffSeconds(0)).toBeGreaterThanOrEqual(1);
  });
});

describe('the shared rate limiter', () => {
  test('lets a burst through, then paces calls at the configured rate', async () => {
    const clock = { t: 0 };
    const limiter = createRateLimiter({ ratePerSecond: 2, burst: 2, maxConcurrent: 5, now: () => clock.t, sleep: sleeper(clock) });
    for (let i = 0; i < 2; i += 1) (await limiter.acquire())();
    expect(clock.t).toBe(0);
    const start = clock.t;
    for (let i = 0; i < 4; i += 1) (await limiter.acquire({ timeoutMs: 60000 }))();
    expect(clock.t - start).toBeGreaterThanOrEqual(1900); // 4 calls at 2 per second
  });

  test('never exceeds the concurrency cap, and gives up after the timeout instead of waiting forever', async () => {
    const clock = { t: 0 };
    const limiter = createRateLimiter({ ratePerSecond: 100, burst: 100, maxConcurrent: 1, now: () => clock.t, sleep: sleeper(clock) });
    const release = await limiter.acquire();
    expect(limiter.snapshot().inFlight).toBe(1);
    expect(await limiter.acquire({ timeoutMs: 500 })).toBeNull();
    release();
    release(); // releasing twice frees only one slot
    expect(limiter.snapshot().inFlight).toBe(0);
    expect(await limiter.acquire()).toEqual(expect.any(Function));
  });
});

describe('the circuit breaker', () => {
  test('opens after repeated transient failures, probes once after the open period, closes on success', () => {
    const clock = { t: 0 };
    const breaker = createCircuitBreaker({ transientThreshold: 3, openMs: 1000, now: () => clock.t });
    for (let i = 0; i < 2; i += 1) breaker.recordFailure('transient');
    expect(breaker.canPass()).toBe(true);
    breaker.recordFailure('transient');
    expect(breaker.snapshot()).toMatchObject({ state: 'open', retryInSeconds: 1 });
    expect(breaker.canPass()).toBe(false);
    expect(breaker.isClosedOrProbeDue()).toBe(false);
    clock.t = 1000;
    expect(breaker.isClosedOrProbeDue()).toBe(true); // asking does not take the probe
    expect(breaker.canPass()).toBe(true); // the one probe
    expect(breaker.canPass()).toBe(false); // nothing else until the probe reports
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe('closed');
  });

  test('a failed probe re-opens it; blocking failures open it faster; a refusal about one request never counts; an unused probe is given back', () => {
    const clock = { t: 0 };
    const breaker = createCircuitBreaker({ transientThreshold: 5, blockingThreshold: 2, openMs: 1000, now: () => clock.t });
    for (let i = 0; i < 10; i += 1) breaker.recordFailure('refused');
    expect(breaker.snapshot().state).toBe('closed');
    breaker.recordFailure('blocking');
    breaker.recordFailure('blocking');
    expect(breaker.snapshot().state).toBe('open');
    clock.t = 1500;
    expect(breaker.canPass()).toBe(true);
    breaker.releaseProbe(); // the call was never made
    expect(breaker.canPass()).toBe(true);
    breaker.recordFailure('transient');
    expect(breaker.snapshot().state).toBe('open');
  });
});

describe('error classification', () => {
  test.each([
    ['timeout', err('ambiguous', 'timeout'), 'transient'],
    ['5xx', err('ambiguous', 'server_error'), 'transient'],
    ['lost connection', err('ambiguous', 'network_error'), 'transient'],
    ['an unknown error', new Error('boom'), 'transient'],
    ['rate limit (code)', err('definitive', 'bitrix_error', { bitrixCode: 'QUERY_LIMIT_EXCEEDED', httpStatus: 503 }), 'blocking'],
    ['rate limit (429)', err('definitive', 'http_error', { httpStatus: 429 }), 'blocking'],
    ['expired credential', err('definitive', 'bitrix_error', { bitrixCode: 'expired_token', httpStatus: 401 }), 'blocking'],
    ['a legacy Lead call refused with 429', Object.assign(new Error('x'), { httpStatus: 429 }), 'blocking'],
    ['never connected', err('definitive', 'not_sent'), 'unsent'],
    ['switch off', err('definitive', 'switch_off'), 'config'],
    ['a bad field', err('definitive', 'bitrix_error', { bitrixCode: 'ERROR_CORE', httpStatus: 400 }), 'refused'],
    ['our own gate (API error)', err('ambiguous', 'gate_closed'), 'deferred'],
    ['our own gate (legacy)', new GateRefusedError('circuit_open'), 'deferred'],
  ])('%s -> %s', (_n, error, kind) => {
    expect(classifyCallError(error)).toBe(kind);
  });
});

// ---- the registry against the canonical services ---------------------------------------------------------------------------------------
describe('the eight service queues', () => {
  test('exactly the canonical services: same slugs, same count, no ninth', () => {
    expect(Object.keys(SERVICE_QUEUES).sort()).toEqual(SERVICES.map((s) => s.slug).sort());
    expect(Object.keys(SERVICE_QUEUES)).toHaveLength(8);
    expect(SERVICES).toHaveLength(8);
    for (const s of SERVICES) expect(SERVICE_QUEUES[s.slug].slug).toBe(s.slug);
    expect(Object.isFrozen(SERVICE_QUEUES)).toBe(true);
  });

  test('Private Charter lives under Air Ambulance (it is a request kind, not a service); that is the only active queue, on the actual profile', () => {
    expect(PRIVATE_CHARTER_QUEUE).toBe('air_ambulance');
    expect(Object.values(SERVICE_QUEUES).filter((q) => q.active).map((q) => q.slug)).toEqual(['air_ambulance']);
    expect(SERVICE_QUEUES.air_ambulance).toMatchObject({ requestKeys: ['privatecharter'], profile: 'actual', outboxEventTypes: ['bitrix.deal.create'], approval: 'review' });
    expect(queueForRequestKey('privatecharter').slug).toBe('air_ambulance');
    expect(queueForRequestKey('commercialair')).toBeNull(); // Commercial Charter is deliberately not mapped
    expect(serviceQueue('privatecharter')).toBeNull(); // it is not a queue of its own
    expect(serviceQueue('__proto__')).toBeNull();
  });

  test('no configuration is duplicated: every other queue is empty, and the registry holds no Bitrix ids at all (they stay in bitrix-profiles.js)', () => {
    for (const q of Object.values(SERVICE_QUEUES).filter((x) => !x.active)) {
      expect(q).toMatchObject({ profile: null, requestKeys: [], outboxEventTypes: [], approval: null });
    }
    const text = JSON.stringify(SERVICE_QUEUES);
    expect(text).not.toMatch(/UF_CRM|CATEGORY|STAGE|UC_|C38|"NEW"/);
    expect(ACTUAL_PROFILE.categoryId).toBe(0); // the category lives only in the profile
    expect(QUEUE_POLL_INTERVAL_MS).toBe(60000);
  });

  test('the gateway refuses to start a queue that is inactive or unknown', () => {
    const gateway = createDispatcher();
    expect(gateway.canStart('ground_ambulance')).toEqual({ ok: false, reason: 'service_not_active' });
    expect(gateway.canStart('privatecharter')).toEqual({ ok: false, reason: 'unknown_service' });
    expect(gateway.canStart('air_ambulance')).toEqual({ ok: true });
  });
});

// ---- the egress: every Bitrix API call passes the one gateway ---------------------------------------------------------------------------------
const WEBHOOK = 'https://b24-4orefh.bitrix24.in/rest/1/testtoken/';
const API_ENV = { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', BITRIX24_WEBHOOK_URL: WEBHOOK, BITRIX_ALLOWED_PORTAL_HOST: 'b24-4orefh.bitrix24.in', BITRIX_DEAL_PROFILE: 'actual' };
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), headers: { get: () => null } });
const limitReply = () => reply(503, { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' });

describe('the gateway at the API layer', () => {
  test('a normal call goes out once, is counted, and takes and releases its slot', async () => {
    const gateway = createDispatcher();
    const fetchImpl = jest.fn(async () => reply(200, { result: 48213 }));
    expect(await api.createDeal({ TITLE: 'x' }, { env: API_ENV, fetchImpl, gateway })).toEqual({ dealId: '48213' });
    expect(gateway.snapshot()).toMatchObject({ calls: { success: 1 }, breaker: { state: 'closed' }, limiter: { inFlight: 0 } });
  });

  test('Bitrix24 answering a rate limit with HTTP 503 is a refusal to run (retry later), not an unknown 5xx; a bare 503 stays ambiguous', async () => {
    const gateway = createDispatcher();
    await expect(api.createDeal({}, { env: API_ENV, fetchImpl: async () => limitReply(), gateway })).rejects.toMatchObject({ outcome: 'definitive', code: 'bitrix_error', httpStatus: 503, bitrixCode: 'QUERY_LIMIT_EXCEEDED' });
    await expect(api.createDeal({}, { env: API_ENV, fetchImpl: async () => reply(503, {}), gateway })).rejects.toMatchObject({ outcome: 'ambiguous', code: 'server_error' });
    expect(gateway.snapshot().calls).toMatchObject({ blocking: 1, transient: 1 });
  });

  test('every kind of Bitrix call shares the one breaker: Deal creation, the reference lookup and the file download', async () => {
    const gateway = createDispatcher();
    const fetchImpl = jest.fn(async () => limitReply());
    await expect(api.createDeal({}, { env: API_ENV, fetchImpl, gateway })).rejects.toBeDefined();
    const found = await api.findDealsByReference('HC-PC-000123', { env: API_ENV, fetchImpl, gateway, profile: ACTUAL_PROFILE });
    expect(found.status).toBe('uncertain'); // the lookup's own handling of a failed call: never "none"
    expect(gateway.snapshot().breaker.state).toBe('open'); // two blocking failures, from two DIFFERENT call types
    const calls = fetchImpl.mock.calls.length;
    // the download (a different egress) is refused by the SAME open breaker, before anything is sent
    await expect(api.downloadBitrixFile({ id: 5, urlMachine: 'https://b24-4orefh.bitrix24.in/x' }, { env: API_ENV, fetchImpl, gateway })).rejects.toMatchObject({ code: 'gate_closed', outcome: 'ambiguous' });
    await expect(api.getDeal('55', { env: API_ENV, fetchImpl, gateway })).resolves.toMatchObject({ status: expect.any(String) });
    expect(fetchImpl.mock.calls).toHaveLength(calls); // not one more request left this server
  });

  test('a call refused by the gateway is never sent, and says so', async () => {
    const gateway = createDispatcher();
    gateway.report('blocking');
    gateway.report('blocking');
    const fetchImpl = jest.fn();
    await expect(api.createDeal({}, { env: API_ENV, fetchImpl, gateway })).rejects.toMatchObject({ name: 'BitrixDealCallError', code: 'gate_closed' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(gateway.snapshot().calls.deferred).toBe(1);
  });

  test('the rate limit is shared by all callers: an exhausted limiter refuses the next call of ANY kind without sending it', async () => {
    const clock = { t: 0 };
    const limiter = createRateLimiter({ ratePerSecond: 1, burst: 1, maxConcurrent: 1, now: () => clock.t, sleep: sleeper(clock) });
    const gateway = createDispatcher({ limiter, admitTimeoutMs: 50 });
    const hold = await limiter.acquire(); // some other worker's call is in flight
    const fetchImpl = jest.fn();
    await expect(api.createDeal({}, { env: API_ENV, fetchImpl, gateway })).rejects.toMatchObject({ code: 'gate_closed' });
    await expect(api.downloadBitrixFile({ id: 5, urlMachine: 'x' }, { env: API_ENV, fetchImpl, gateway })).rejects.toMatchObject({ code: 'gate_closed' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(gateway.snapshot().breaker.state).toBe('closed'); // our own refusal says nothing about the portal
    hold();
  });

  test('a caller that injects its own fetch and no gateway makes no shared-gate call (existing behaviour of every stand-in)', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { result: 9 }));
    expect(await api.createDeal({}, { env: API_ENV, fetchImpl })).toEqual({ dealId: '9' });
  });
});

describe('the legacy Lead calls share the same portal limits', () => {
  const run = async (fn) => {
    let result;
    await jest.isolateModulesAsync(async () => {
      process.env.BITRIX24_WEBHOOK_URL = WEBHOOK;
      process.env.BITRIX_SYNC_ENABLED = 'true';
      const gateway = require('../../src/modules/bitrix/queue/dispatcher').sharedDispatcher();
      const { createLead } = require('../../src/modules/bitrix/bitrix.service');
      result = await fn({ gateway, createLead });
    });
    return result;
  };
  const lead = { contactName: 'Rakesh Sharma', mobile: '9876543210', email: 'a@b.com', origin: 'Mumbai', destination: 'Dubai', referenceNumber: 'REQ-1' };
  const realFetch = global.fetch;
  beforeEach(() => { global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'QUERY_LIMIT_EXCEEDED' }) })); });
  afterEach(() => { global.fetch = realFetch; delete process.env.BITRIX24_WEBHOOK_URL; delete process.env.BITRIX_SYNC_ENABLED; });

  test('Lead failures feed the same breaker, and once it is open a Lead call is deferred (never sent) with deferred: true', async () => {
    await run(async ({ gateway, createLead }) => {
      await expect(createLead(lead)).rejects.toMatchObject({ httpStatus: 503, bitrixCode: 'QUERY_LIMIT_EXCEEDED' });
      await expect(createLead(lead)).rejects.toMatchObject({ httpStatus: 503 });
      expect(gateway.snapshot().breaker.state).toBe('open');
      const sent = global.fetch.mock.calls.length;
      await expect(createLead(lead)).rejects.toMatchObject({ deferred: true, code: 'gate_closed' });
      expect(global.fetch.mock.calls).toHaveLength(sent);
    });
  });
});

// ---- every Bitrix worker pauses, claiming nothing, while the portal circuit is open -------------------------------------------------------------
const untouched = () => new Proxy({}, { get() { throw new Error('the database must not be touched while the portal circuit is open'); } });
const openGateway = () => { const g = createDispatcher(); g.report('blocking'); g.report('blocking'); return g; };
const ALL_ON = { ...API_ENV, PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true' };

describe('every worker asks the one shared gateway before claiming anything', () => {
  test.each([
    ['Deal creation', (o) => runDealWorker(o), { store: { recoverExpiredLeases: async () => undefined, findCandidateIds: jest.fn(async () => [1]), claim: jest.fn() }, reportFailures: async () => 0 }],
    ['Deal documents', (o) => runDealDocumentWorker(o), {}],
    ['quotation sync', (o) => runQuotationSync(o), {}],
    ['inbound stage inbox', (o) => runInboxWorker(o), {}],
    ['reconciliation', (o) => reconcileDeals(o), {}],
  ])('%s: an open circuit pauses the pass', async (_name, runner, extra) => {
    const result = await runner({ prisma: untouched(), env: ALL_ON, gateway: openGateway(), log: { warn: jest.fn(), error: jest.fn(), log: jest.fn() }, ...extra });
    expect(result).toMatchObject({ active: true, paused: 'circuit_open' });
    if (extra.store) expect(extra.store.claim).not.toHaveBeenCalled();
  });

  test('a worker whose own switches are off still does nothing, as before (and never reaches the gateway)', async () => {
    const gateway = { canStart: jest.fn() };
    expect(await runDealDocumentWorker({ prisma: untouched(), env: {}, gateway })).toEqual({ active: false, claimed: 0 });
    expect(gateway.canStart).not.toHaveBeenCalled();
  });
});

// ---- the Deal worker through the real API and the gateway (actual profile, Category 0, NEW) --------------------------------------------------
const REF = 'HC-PC-000123';
const WORKER_ENV = { ...API_ENV, PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' };
const requestRow = () => ({
  id: 3, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null, patientName: 'Asha Rao', patientAge: 54, patientGender: 'female', patientContact: '+919812345678',
  travelType: 'patient_transfer', origin: 'Mumbai, Maharashtra, India', destination: 'Smallville', description: 'x', criticalLevel: 'icu', oxygenRequired: false, country: 'IN', preferredDate: new Date('2030-03-05T00:00:00Z'),
});

function world({ attempts = 1, gateway, fetchImpl }) {
  const state = { linkUpdates: [], results: [], retries: [], claims: 0 };
  const tx = { bitrixDealLink: { update: jest.fn(async ({ data }) => { state.linkUpdates.push(data); }) }, auditLog: { create: jest.fn(async () => undefined) } };
  const prisma = {
    $transaction: jest.fn(async (cb) => cb(tx)),
    case: { findUnique: jest.fn(async () => ({ id: 7, referenceNumber: REF, serviceRequestId: 3, patientName: 'Asha Rao', serviceRequest: requestRow(), bitrixDealLink: { id: 1, caseId: 7, bitrixDealId: null, profile: 'actual' } })) },
  };
  const store = {
    MANUAL_REVIEW_PREFIX: outboxStore.MANUAL_REVIEW_PREFIX,
    recoverExpiredLeases: jest.fn(async () => undefined),
    findCandidateIds: jest.fn(async (_db, status) => (status === 'pending' ? [1] : [])),
    claim: jest.fn(async () => { state.claims += 1; return { id: 1, fromStatus: 'pending', workerId: 'w', attempts, caseId: 7, externalCallStartedAt: null, secondsSinceCall: null, payload: { caseId: 7, profile: 'actual' } }; }),
    markExternalCallStarted: jest.fn(async () => true),
    writeResult: jest.fn(async (_db, _c, result) => { state.results.push(result); return 1; }),
    writeRetry: jest.fn(async (_db, _c, result) => { state.retries.push(result); return 1; }),
  };
  // the REAL API client, with a stand-in network and the gateway under test
  const realApi = {
    createDeal: (fields, o) => api.createDeal(fields, { ...o, fetchImpl, gateway }),
    findDealsByReference: (ref, o) => api.findDealsByReference(ref, { ...o, fetchImpl, gateway }),
  };
  return { prisma, store, api: realApi, state, gateway };
}
const pass = (w) => runDealWorker({ prisma: w.prisma, store: w.store, api: w.api, env: WORKER_ENV, log: { warn: jest.fn(), error: jest.fn(), log: jest.fn() }, workerId: 'w', reportFailures: async () => 0, gateway: w.gateway });

describe('Deal worker: Category 0 / Enquiry through the gateway', () => {
  test('creates the Deal in Category 0, stage NEW; links the exact Deal ID as actual / Category 0 / NEW; releases its slot', async () => {
    const gateway = createDispatcher();
    const fetchImpl = jest.fn(async () => reply(200, { result: 48213 }));
    const w = world({ gateway, fetchImpl });
    expect(await pass(w)).toEqual({ active: true, claimed: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${WEBHOOK}crm.deal.add.json`);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).fields).toMatchObject({ CATEGORY_ID: 0, STAGE_ID: 'NEW' });
    expect(w.state.results[0]).toMatchObject({ status: 'completed' });
    expect(w.state.linkUpdates[0]).toMatchObject({ bitrixDealId: '48213', categoryId: '0', profile: 'actual', stageId: 'NEW', syncStatus: 'synced' });
    expect(gateway.snapshot()).toMatchObject({ calls: { success: 1 }, limiter: { inFlight: 0 } });
  });

  test('a rate-limit refusal is NOT a failure: back to pending with backoff, evidence cleared, nothing failed; counted once by the breaker', async () => {
    const gateway = createDispatcher();
    const w = world({ gateway, fetchImpl: async () => limitReply() });
    await pass(w);
    expect(w.state.retries).toHaveLength(1);
    expect(w.state.retries[0].lastError).toBe('retry:blocking:query_limit_exceeded');
    expect(w.state.results).toHaveLength(0);
    expect(w.state.linkUpdates[0]).toMatchObject({ syncStatus: 'pending' });
    expect(gateway.snapshot().calls.blocking).toBe(1); // once: reported at the egress only, never twice
  });

  test('a portal that cannot be reached before sending is retried later, not failed', async () => {
    const w = world({ gateway: createDispatcher(), fetchImpl: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } });
    await pass(w);
    expect(w.state.retries).toHaveLength(1);
    expect(w.state.results).toHaveLength(0);
  });

  test('every retry waits longer: the delay grows with the delivery attempt', async () => {
    const delays = [];
    for (const attempts of [1, 3, 5]) {
      const w = world({ attempts, gateway: createDispatcher(), fetchImpl: async () => limitReply() });
      await pass(w);
      delays.push(w.state.retries[0].delaySeconds);
    }
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
  });

  test('after the maximum deliveries a blocked event is dead-lettered (failed, dead_letter reason), which the failure alert classifies', async () => {
    const w = world({ attempts: MAX_DELIVERY_ATTEMPTS, gateway: createDispatcher(), fetchImpl: async () => limitReply() });
    await pass(w);
    expect(w.state.retries).toHaveLength(0);
    expect(w.state.results[0]).toMatchObject({ status: 'failed', lastError: 'dead_letter:retry:blocking:query_limit_exceeded' });
    expect(classifyFailure(w.state.results[0].lastError)).toMatchObject({ category: 'dead_letter' });
  });

  test('a call our own gateway refused never counts toward the dead letter, even at the maximum: it goes back to pending', async () => {
    const clock = { t: 0 };
    const limiter = createRateLimiter({ ratePerSecond: 1, burst: 1, maxConcurrent: 1, now: () => clock.t, sleep: sleeper(clock) });
    await limiter.acquire(); // another worker holds the only slot
    const fetchImpl = jest.fn();
    const w = world({ attempts: MAX_DELIVERY_ATTEMPTS, gateway: createDispatcher({ limiter, admitTimeoutMs: 50 }), fetchImpl });
    await pass(w);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(w.state.results).toHaveLength(0); // not dead-lettered
    expect(w.state.retries).toHaveLength(1);
    expect(w.state.retries[0].lastError).toMatch(/^retry:deferred:/);
  });

  test('a timeout stays ambiguous exactly as before (the Deal may exist): never retried by create, only reconciled', async () => {
    const gateway = createDispatcher();
    const w = world({ gateway, fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
    await pass(w);
    expect(w.state.results[0]).toMatchObject({ status: 'ambiguous' });
    expect(w.state.retries).toHaveLength(0);
    expect(gateway.snapshot().calls.transient).toBe(1);
  });

  test('a refusal about the request itself still fails definitively, and does not trip the breaker', async () => {
    const gateway = createDispatcher();
    const w = world({ gateway, fetchImpl: async () => reply(400, { error: 'ERROR_CORE', error_description: 'bad field' }) });
    await pass(w);
    expect(w.state.results[0]).toMatchObject({ status: 'failed' });
    expect(gateway.snapshot().breaker.state).toBe('closed');
  });

  test('two blocking refusals open the shared breaker: the next pass claims NOTHING and uses no attempt; no more requests leave', async () => {
    const gateway = createDispatcher();
    const fetchImpl = jest.fn(async () => limitReply());
    const w = world({ gateway, fetchImpl });
    await pass(w);
    await pass(w);
    expect(gateway.snapshot().breaker.state).toBe('open');
    const claims = w.state.claims;
    expect(await pass(w)).toEqual({ active: true, claimed: 0, paused: 'circuit_open' });
    expect(w.state.claims).toBe(claims);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('the real store: retry write', () => {
  test('is fenced like the result write, clears the call evidence only for a claimed event that had it set, and runs on the database clock', async () => {
    const executed = [];
    const db = { $executeRaw: jest.fn(async (strings, ...values) => { executed.push({ sql: strings.join('?'), values }); return 1; }) };
    expect(await outboxStore.writeRetry(db, { id: 5, attempts: 2, workerId: 'w' }, { lastError: 'retry:blocking:x https://x.example/rest/1/TOKEN/', delaySeconds: 120 })).toBe(1);
    const { sql, values } = executed[0];
    expect(sql).toContain("SET status = 'pending'");
    expect(sql).toContain('external_call_started_at = NULL');
    expect(sql).toContain("status = 'processing' AND attempts = ? AND locked_by = ?");
    expect(sql).toContain('locked_until > UTC_TIMESTAMP(3)');
    expect(sql).toContain('external_call_started_at IS NOT NULL');
    expect(sql).toContain('UTC_TIMESTAMP(3) + INTERVAL ? SECOND');
    expect(values.join('|')).not.toContain('TOKEN'); // URLs are stripped from last_error
  });
});
