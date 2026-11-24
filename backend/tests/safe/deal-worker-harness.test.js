/* global describe, test, expect, jest, beforeEach */
// The guarded Deal worker (scripts/e2e-worker.js and src/modules/bitrix/deal-worker-harness.js): scope isolation, a fake Bitrix24
// API by default, and rejection of live or unexpected portal hosts before any request leaves. No database, no network, nothing
// is executed against a real service.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const harness = require('../../src/modules/bitrix/deal-worker-harness');
const store = require('../../src/modules/bitrix/deal-outbox.store');
const { runDealWorker } = require('../../src/modules/bitrix/deal-worker.service');
const api = require('../../src/modules/bitrix/bitrix-deal.api');
const { bitrixHostProblem, bitrixConfigurationProblems } = require('../../src/modules/bitrix/bitrix-config');

const ENV_ON = { BITRIX_DEAL_PROFILE: 'test', BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' };
const SANDBOX = 'sandbox-portal.bitrix24.in';
const LIVE = 'live-portal.bitrix24.in';
const hook = (host) => `https://${host}/rest/1/secrettoken123/`;

// ---- command line --------------------------------------------------------------------------------------------------------
describe('parseArgs', () => {
  test('a scope is required, and by default nothing is executed and nothing is live', () => {
    expect(harness.parseArgs(['--case-ids', '2210,2211'])).toEqual({ caseIds: [2210, 2211], live: false, execute: false });
    expect(harness.parseArgs(['--case-ids', '7', '--execute'])).toEqual({ caseIds: [7], live: false, execute: true });
    expect(harness.parseArgs(['--execute', '--live', '--case-ids', '7'])).toMatchObject({ live: true, execute: true });
  });

  test.each([
    [[], /--case-ids is required/],
    [['--execute'], /--case-ids is required/],
    [['--case-ids'], /needs a comma-separated list/],
    [['--case-ids', '--execute'], /needs a comma-separated list/],
    [['--case-ids', '0'], /positive whole/],
    [['--case-ids', '1,abc'], /positive whole/],
    [['--case-ids', '1,,2'], /positive whole/],
    [['--case-ids', '-5'], /positive whole/],
    [['--case-ids', '1.5'], /positive whole/],
    [['--case-ids', '*'], /positive whole/],
    [['--case-ids', '1', '--all'], /unknown argument/],
    [['--case-ids', Array.from({ length: 11 }, (_, i) => i + 1).join(',')], /at most 10/],
  ])('refuses %j', (argv, message) => {
    expect(() => harness.parseArgs(argv)).toThrow(message);
  });

  test('repeated ids collapse to one', () => {
    expect(harness.parseArgs(['--case-ids', '5,5,6']).caseIds).toEqual([5, 6]);
  });
});

// ---- fake API and network ------------------------------------------------------------------------------------------------
describe('the fake Bitrix24 API', () => {
  test('returns fake Deal ids from a fixed fake range, in order, and records the calls', async () => {
    const fake = harness.makeFakeBitrixApi();
    expect(fake.isFake).toBe(true);
    expect(await fake.createDeal({ TITLE: 'CASE-1' })).toEqual({ dealId: '9000000001' });
    expect(await fake.createDeal({ TITLE: 'CASE-2' })).toEqual({ dealId: '9000000002' });
    expect(await fake.findDealsByReference('CASE-1')).toEqual({ status: 'none', dealIds: [] });
    expect(await fake.getDeal('9000000001')).toMatchObject({ status: 'uncertain' });
    expect(fake.calls.map((c) => c.method)).toEqual(['crm.deal.add', 'crm.deal.add', 'crm.deal.list', 'crm.deal.get']);
  });

  test('its Deal ids are valid Deal ids for the worker (positive whole numbers as text)', async () => {
    const { dealId } = await harness.makeFakeBitrixApi().createDeal({});
    expect(api.exactDealId(dealId)).toBe(dealId);
  });

  test('has the same functions as the real client the worker uses', () => {
    const fake = harness.makeFakeBitrixApi();
    for (const name of ['createDeal', 'findDealsByReference', 'getDeal']) expect(typeof fake[name]).toBe(typeof api[name]);
  });

  test('while a fake pass runs, any network call fails at once, and fetch is restored afterwards', async () => {
    const target = { fetch: jest.fn() };
    const original = target.fetch;
    const restore = harness.blockNetwork(target);
    await expect(target.fetch('https://anything.example/')).rejects.toThrow(/Network access is disabled/);
    expect(original).not.toHaveBeenCalled();
    restore();
    expect(target.fetch).toBe(original);
  });
});

describe('workerEnv', () => {
  const base = { NODE_ENV: 'test', BITRIX24_WEBHOOK_URL: hook(LIVE), BITRIX_INBOUND_APPLICATION_TOKEN: 'x'.repeat(32), BITRIX_SYNC_ENABLED: 'false' };

  test('fake mode turns the worker switches on in memory only, and hides the webhook and inbound token', () => {
    const env = harness.workerEnv(base, { live: false });
    expect(env).toMatchObject({ ...ENV_ON, BITRIX24_WEBHOOK_URL: '', BITRIX_INBOUND_APPLICATION_TOKEN: '' });
    expect(base.BITRIX_SYNC_ENABLED).toBe('false'); // the caller's environment is untouched
    expect(base.BITRIX24_WEBHOOK_URL).toBe(hook(LIVE));
  });

  test('live mode keeps the webhook (the real client then checks its host before every request)', () => {
    expect(harness.workerEnv(base, { live: true }).BITRIX24_WEBHOOK_URL).toBe(hook(LIVE));
  });
});

// ---- live host rejection (the harness) -----------------------------------------------------------------------------------
describe('--live is allowed only for the named sandbox portal, never the live one', () => {
  const env = (over = {}) => ({ NODE_ENV: 'test', BITRIX24_WEBHOOK_URL: hook(SANDBOX), BITRIX_ALLOWED_PORTAL_HOST: SANDBOX, ...over });

  test('allowed: the allowlist equals the webhook host and it is not the live host', () => {
    expect(harness.assertLiveAllowed(env(), LIVE)).toBe(true);
  });

  test.each([
    ['no allowlist', env({ BITRIX_ALLOWED_PORTAL_HOST: '' }), /needs BITRIX_ALLOWED_PORTAL_HOST/],
    ['an allowlist for another host', env({ BITRIX_ALLOWED_PORTAL_HOST: 'other.bitrix24.in' }), /host is not allowed \(host_not_allowed\)/],
    ['the live portal', env({ BITRIX24_WEBHOOK_URL: hook(LIVE), BITRIX_ALLOWED_PORTAL_HOST: LIVE }), /that is the live portal/],
    ['a host that only looks like the allowed one', env({ BITRIX24_WEBHOOK_URL: hook(`${SANDBOX}.evil.example`) }), /host_not_allowed/],
    ['a credentials trick (allowed host in the user info)', env({ BITRIX24_WEBHOOK_URL: `https://${SANDBOX}@${LIVE}/rest/1/x/` }), /host_not_allowed/],
    ['an invalid allowlist value', env({ BITRIX_ALLOWED_PORTAL_HOST: `https://${SANDBOX}/` }), /allowlist_invalid/],
    ['no webhook', env({ BITRIX24_WEBHOOK_URL: '' }), /webhook_host_invalid/],
  ])('refuses %s', (_name, environment, message) => {
    expect(() => harness.assertLiveAllowed(environment, LIVE)).toThrow(message);
  });

  test('a refusal never contains the host, the token or the webhook', () => {
    for (const environment of [env({ BITRIX24_WEBHOOK_URL: hook(LIVE), BITRIX_ALLOWED_PORTAL_HOST: LIVE }), env({ BITRIX_ALLOWED_PORTAL_HOST: 'other.bitrix24.in' })]) {
      try { harness.assertLiveAllowed(environment, LIVE); } catch (err) { expect(err.message).not.toMatch(/secrettoken|live-portal|sandbox-portal|bitrix24\.in/); }
    }
  });

  test('the live host is read from the development .env text only (nothing is returned for a missing or empty file)', () => {
    expect(harness.developmentWebhookHost('.env', () => `A=1\nBITRIX24_WEBHOOK_URL="${hook(LIVE)}"\n`)).toBe(LIVE);
    expect(harness.developmentWebhookHost('.env', () => 'A=1\n')).toBeNull();
    expect(harness.developmentWebhookHost('.env', () => { throw new Error('ENOENT'); })).toBeNull();
  });
});

// ---- live host rejection (config and the real client) -------------------------------------------------------------------
describe('bitrixHostProblem', () => {
  test('without an allowlist: refused in a test environment, unrestricted elsewhere (as before)', () => {
    expect(bitrixHostProblem({ NODE_ENV: 'test' }, hook(LIVE))).toBe('allowlist_required_in_test');
    expect(bitrixHostProblem({}, hook(LIVE))).toBeNull();
    expect(bitrixHostProblem({ NODE_ENV: 'production' }, hook(LIVE))).toBeNull();
  });

  test('with an allowlist: only an exact, case-insensitive host match passes, anywhere', () => {
    expect(bitrixHostProblem({ BITRIX_ALLOWED_PORTAL_HOST: SANDBOX }, hook(SANDBOX))).toBeNull();
    expect(bitrixHostProblem({ BITRIX_ALLOWED_PORTAL_HOST: SANDBOX.toUpperCase() }, hook(SANDBOX))).toBeNull();
    expect(bitrixHostProblem({ BITRIX_ALLOWED_PORTAL_HOST: SANDBOX }, hook(LIVE))).toBe('host_not_allowed');
    expect(bitrixHostProblem({ BITRIX_ALLOWED_PORTAL_HOST: SANDBOX }, `https://x.${SANDBOX}/rest/`)).toBe('host_not_allowed'); // a subdomain is not the host
    expect(bitrixHostProblem({ BITRIX_ALLOWED_PORTAL_HOST: SANDBOX }, `https://${SANDBOX}@${LIVE}/rest/`)).toBe('host_not_allowed');
  });

  test.each(['https://sandbox.bitrix24.in', 'sandbox.bitrix24.in/rest', '*.bitrix24.in', 'sandbox bitrix24.in', 'sandbox.bitrix24.in:443'])('an allowlist value like %p is invalid', (value) => {
    expect(bitrixHostProblem({ BITRIX_ALLOWED_PORTAL_HOST: value }, hook(SANDBOX))).toBe('allowlist_invalid');
  });

  test.each(['', 'not a url', 'ftp://x.example/', undefined])('a webhook of %p has no usable host', (url) => {
    expect(bitrixHostProblem({ BITRIX_ALLOWED_PORTAL_HOST: SANDBOX }, url)).toBe('webhook_host_invalid');
  });
});

describe('start-up configuration', () => {
  test('a Bitrix switch on with a webhook that is not allowed refuses to start; with the right allowlist it is valid', () => {
    expect(bitrixConfigurationProblems({ ...ENV_ON, NODE_ENV: 'test', BITRIX24_WEBHOOK_URL: hook(LIVE) }).join(' ')).toMatch(/webhook host is not allowed \(allowlist_required_in_test\)/);
    expect(bitrixConfigurationProblems({ ...ENV_ON, BITRIX24_WEBHOOK_URL: hook(LIVE), BITRIX_ALLOWED_PORTAL_HOST: SANDBOX }).join(' ')).toMatch(/host_not_allowed/);
    expect(bitrixConfigurationProblems({ ...ENV_ON, BITRIX24_WEBHOOK_URL: hook(SANDBOX), BITRIX_ALLOWED_PORTAL_HOST: SANDBOX })).toEqual([]);
  });

  test('existing settings are unaffected: switches without a webhook, or no allowlist outside tests, stay valid', () => {
    expect(bitrixConfigurationProblems(ENV_ON)).toEqual([]);
    expect(bitrixConfigurationProblems({ ...ENV_ON, BITRIX24_WEBHOOK_URL: hook(LIVE) })).toEqual([]);
    expect(bitrixConfigurationProblems({ BITRIX24_WEBHOOK_URL: hook(LIVE), NODE_ENV: 'test' })).toEqual([]); // switches off: nothing can be sent
  });
});

describe('the real Deal client refuses a wrong host BEFORE any request leaves', () => {
  const okFetch = () => jest.fn(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ result: 4242 }) }));
  const options = (env, fetchImpl) => ({ env: { ...ENV_ON, ...env }, fetchImpl });

  test.each([
    ['no allowlist in a test environment', { NODE_ENV: 'test', BITRIX24_WEBHOOK_URL: hook(LIVE) }, 'allowlist_required_in_test'],
    ['an allowlist for another portal', { BITRIX24_WEBHOOK_URL: hook(LIVE), BITRIX_ALLOWED_PORTAL_HOST: SANDBOX }, 'host_not_allowed'],
    ['an unreadable webhook', { BITRIX24_WEBHOOK_URL: 'not a url', BITRIX_ALLOWED_PORTAL_HOST: SANDBOX }, 'webhook_host_invalid'],
  ])('%s', async (_name, env, code) => {
    for (const call of [
      (fetchImpl) => api.createDeal({ TITLE: 'x' }, options(env, fetchImpl)),
      (fetchImpl) => api.getDeal('55', options(env, fetchImpl)),
      (fetchImpl) => api.findDealsByReference('CASE-1', options(env, fetchImpl)),
    ]) {
      const fetchImpl = okFetch();
      const outcome = await call(fetchImpl).catch((err) => err);
      // createDeal rejects with the error; getDeal and findDealsByReference turn it into "uncertain".
      const text = outcome instanceof Error ? `${outcome.code}` : JSON.stringify(outcome);
      expect(text).toMatch(new RegExp(`host_not_allowed|${code}`));
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  test('a rejected host is a definitive failure (nothing was sent), and the message holds no host or token', async () => {
    const fetchImpl = okFetch();
    const error = await api.createDeal({}, options({ BITRIX24_WEBHOOK_URL: hook(LIVE), BITRIX_ALLOWED_PORTAL_HOST: SANDBOX }, fetchImpl)).catch((err) => err);
    expect(error).toBeInstanceOf(api.BitrixDealCallError);
    expect(error.outcome).toBe('definitive');
    expect(error.code).toBe('host_not_allowed');
    expect(error.message).not.toMatch(/secrettoken|live-portal|sandbox-portal/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('the allowed portal still works, and outside tests without an allowlist nothing changes', async () => {
    const fetchImpl = okFetch();
    expect(await api.createDeal({ TITLE: 'x' }, options({ BITRIX24_WEBHOOK_URL: hook(SANDBOX), BITRIX_ALLOWED_PORTAL_HOST: SANDBOX }, fetchImpl))).toEqual({ dealId: '4242' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const second = okFetch();
    expect(await api.createDeal({ TITLE: 'x' }, options({ BITRIX24_WEBHOOK_URL: hook(LIVE) }, second))).toEqual({ dealId: '4242' });
    expect(second).toHaveBeenCalledTimes(1);
  });
});

// ---- which Cases may be processed ----------------------------------------------------------------------------------------
describe('assertScopeEligible', () => {
  const good = (caseId, over = {}) => ({
    case_id: caseId, request_id: caseId + 100, service_key: 'privatecharter', review_status: 'approved', lead_id: null,
    link_id: caseId + 200, deal_id: null, event_id: caseId + 300, event_status: 'pending', ...over,
  });
  const dbWith = (rows) => ({ $queryRawUnsafe: jest.fn(async () => rows) });

  test('accepts approved Private Charter Cases with a pending (or ambiguous) event and no Deal yet, and reads only', async () => {
    const db = dbWith([good(7), good(8, { event_status: 'ambiguous' })]);
    expect(await harness.assertScopeEligible(db, [7, 8])).toEqual([
      { caseId: 7, requestId: 107, eventId: 307, eventStatus: 'pending' },
      { caseId: 8, requestId: 108, eventId: 308, eventStatus: 'ambiguous' },
    ]);
    const [sql, ...params] = db.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/^\s*SELECT/);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE|DROP|ALTER)\b/i);
    expect(sql).toContain('WHERE c.id IN (?, ?)');
    expect(params).toEqual([7, 8]);
  });

  test.each([
    ['a Case that does not exist', [], /case 7: not found/],
    ['a request that is not approved', [good(7, { review_status: 'in_review' })], /case 7: its request is not approved/],
    ['a draft', [good(7, { review_status: 'awaiting_documents' })], /not approved/],
    ['another service', [good(7, { service_key: 'ground' })], /not a Private Charter request Case/],
    ['a Case with no request (Corporate)', [good(7, { request_id: null, service_key: null })], /not a Private Charter request Case/],
    ['a request with a Lead', [good(7, { lead_id: 55 })], /has a Bitrix Lead/],
    ['no Deal link', [good(7, { link_id: null })], /no Deal link/],
    ['a Deal that already exists', [good(7, { deal_id: '4344' })], /its Deal already exists/],
    ['a completed event only', [good(7, { event_status: 'completed' })], /no pending or ambiguous Deal event/],
    ['a failed event only', [good(7, { event_status: 'failed' })], /no pending or ambiguous Deal event/],
    ['no event', [good(7, { event_id: null, event_status: null })], /no pending or ambiguous Deal event/],
  ])('refuses %s', async (_name, rows, message) => {
    await expect(harness.assertScopeEligible(dbWith(rows), [7])).rejects.toThrow(message);
  });

  test('refuses a Case that holds the protected event 411, even if the event is pending', async () => {
    const rows = [good(2203, { event_id: 411, event_status: 'pending' })];
    await expect(harness.assertScopeEligible(dbWith(rows), [2203])).rejects.toThrow(/case 2203: holds a protected event/);
    await expect(harness.assertScopeEligible(dbWith([good(9, { event_id: 411 })]), [9], { protectedEventIds: [411] })).rejects.toThrow(/protected/);
  });

  test('one bad Case in the list refuses the whole run, naming every problem and nothing else', async () => {
    const rows = [good(7), good(8, { review_status: 'in_review' })];
    const error = await harness.assertScopeEligible(dbWith(rows), [7, 8, 9]).catch((err) => err);
    expect(error.message).toMatch(/case 8: its request is not approved/);
    expect(error.message).toMatch(/case 9: not found/);
    expect(error.message).not.toMatch(/case 7:/);
    expect(error.message).toMatch(/Nothing was run/);
  });
});

// ---- scope isolation in the store (SQL) ----------------------------------------------------------------------------------
describe('the store only offers and recovers events of the scoped Cases', () => {
  const text = (strings) => strings.join('?').replace(/\s+/g, ' ').trim();

  test('a scope is validated: 1 to 50 positive whole ids; an empty or malformed list is refused, never read as "everything"', () => {
    expect(store.normalizeCaseIds(undefined)).toBeNull();
    expect(store.normalizeCaseIds([3, 3, 4])).toEqual([3, 4]);
    for (const bad of [[], [0], [-1], [1.5], ['7'], [null], 'x', { 0: 1 }, Array.from({ length: 51 }, (_, i) => i + 1)]) expect(() => store.normalizeCaseIds(bad)).toThrow(/scope needs/);
  });

  test('scoped candidates: a parameterised query with "o.case_id IN (...)" and exactly those ids; the unscoped query is not used', async () => {
    const db = { $queryRawUnsafe: jest.fn(async () => [{ id: 41n }]), $queryRaw: jest.fn() };
    expect(await store.findCandidateIds(db, 'pending', 5, { caseIds: [7, 9] }, 'test')).toEqual([41]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    const [sql, ...params] = db.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('o.case_id IN (?, ?)');
    expect(sql).toContain("(o.status <> 'pending' OR sr.review_status = 'approved')");
    expect(sql).toContain("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.profile')), 'test') = ?"); // only the active profile's events
    expect(sql).toContain('sr.patient_name NOT LIKE ?'); // the synthetic identity is never offered (see deal-dispatch-synthetic-guard.test.js)
    expect(params).toEqual(['bitrix.deal.create', 'case', 'pending', 'privatecharter', 'manual_review_required%', 'test', 'ZZ-SYNTHETIC%', 7, 9, 5]);
  });

  test('an empty scope is refused before any query', async () => {
    const db = { $queryRawUnsafe: jest.fn(), $queryRaw: jest.fn() };
    await expect(store.findCandidateIds(db, 'pending', 5, { caseIds: [] })).rejects.toThrow(/scope needs/);
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  test('without a scope the original query is used, unchanged', async () => {
    const db = { $queryRawUnsafe: jest.fn(), $queryRaw: jest.fn(async () => []) };
    await store.findCandidateIds(db, 'pending', 5);
    await store.findCandidateIds(db, 'pending', 5, undefined);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('the scoped statement is the unscoped one plus the Case filter (they cannot drift apart)', async () => {
    const queried = [];
    const db = { $queryRaw: jest.fn(async (strings) => { queried.push(text(strings)); return []; }) };
    await store.findCandidateIds(db, 'pending', 5);
    const normalise = (sql) => sql.replace(/\?/g, '?').replace(/\s+/g, ' ').replace(/\s*AND o\.case_id IN \(%CASES%\)/, '').trim();
    expect(normalise(store.SCOPED_CANDIDATES_SQL)).toBe(queried[0].replace(/\s+/g, ' ').trim());
  });

  test('scoped lease recovery: all three statements are limited to the scoped Cases; the unscoped statements are not used', async () => {
    const db = { $executeRawUnsafe: jest.fn(async () => 0), $executeRaw: jest.fn() };
    await store.recoverExpiredLeases(db, { maxClaims: 10, caseIds: [7] });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(3);
    for (const [sql, ...params] of db.$executeRawUnsafe.mock.calls) {
      expect(sql).toContain('case_id IN (?)');
      expect(sql).toContain("status = 'processing'");
      expect(params).toContain(7);
    }
  });

  test('without a scope lease recovery is exactly as before', async () => {
    const db = { $executeRawUnsafe: jest.fn(), $executeRaw: jest.fn(async () => 0) };
    await store.recoverExpiredLeases(db, { maxClaims: 10 });
    expect(db.$executeRaw).toHaveBeenCalledTimes(3);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

// ---- scope isolation in the worker ----------------------------------------------------------------------------------------
describe('a scoped worker pass handles only the scoped Case', () => {
  let events;
  let created;
  let log;
  let prisma;
  let fakeStore;
  let fakeApi;

  const caseRow = (id) => ({
    id, referenceNumber: `CASE-${id}`, serviceRequestId: id + 100, patientName: 'Asha Rao',
    serviceRequest: { id: id + 100, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null, patientName: 'Asha Rao', patientContact: '+971501234567', preferredDate: new Date('2030-03-05T00:00:00Z'), careLevel: 'care_icu', mobility: 'walking', urgency: 'planned' },
    bitrixDealLink: { id: id + 200, caseId: id, bitrixDealId: null, syncStatus: 'pending' },
  });

  beforeEach(() => {
    events = [{ id: 301, caseId: 7, status: 'pending' }, { id: 411, caseId: 2203, status: 'pending' }, { id: 305, caseId: 8, status: 'pending' }];
    created = [];
    log = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    const tx = { bitrixDealLink: { update: jest.fn(async () => ({})) }, auditLog: { create: jest.fn(async () => ({})) } };
    prisma = { $transaction: jest.fn(async (callback) => callback(tx)), case: { findUnique: jest.fn(async ({ where }) => caseRow(where.id)) } };
    fakeStore = {
      MANUAL_REVIEW_PREFIX: store.MANUAL_REVIEW_PREFIX,
      recoverExpiredLeases: jest.fn(async () => ({})),
      // Applies the scope like the real SQL does.
      findCandidateIds: jest.fn(async (_db, status, limit, scope) => events
        .filter((e) => e.status === status && (!scope || scope.caseIds.includes(e.caseId))).slice(0, limit).map((e) => e.id)),
      claim: jest.fn(async (_db, { id, fromStatus }) => ({ id, fromStatus, workerId: 'w', attempts: 1, caseId: events.find((e) => e.id === id).caseId, externalCallStartedAt: null, secondsSinceCall: null })),
      markExternalCallStarted: jest.fn(async () => true),
      writeResult: jest.fn(async (_db, claim) => { events.find((e) => e.id === claim.id).status = 'completed'; return 1; }),
    };
    fakeApi = harness.makeFakeBitrixApi();
  });

  const run = (extra = {}) => runDealWorker({ prisma, store: fakeStore, api: fakeApi, env: harness.workerEnv({}, { live: false }), log, workerId: 'w', scope: { caseIds: [7] }, ...extra });

  test('claims and creates the Deal for the scoped Case only; the other pending events, including 411, are never offered, claimed or touched', async () => {
    expect(await run()).toEqual({ active: true, claimed: 1 });
    expect(fakeStore.claim).toHaveBeenCalledTimes(1);
    expect(fakeStore.claim.mock.calls[0][1].id).toBe(301);
    expect(fakeApi.calls.map((c) => c.reference)).toEqual(['CASE-7']);
    expect(events.find((e) => e.id === 301).status).toBe('completed');
    expect(events.find((e) => e.id === 411)).toEqual({ id: 411, caseId: 2203, status: 'pending' });
    expect(events.find((e) => e.id === 305)).toEqual({ id: 305, caseId: 8, status: 'pending' });
    expect(prisma.case.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.case.findUnique.mock.calls[0][0].where.id).toBe(7);
  });

  test('the scope reaches both the candidate query (both statuses) and the lease recovery', async () => {
    await run();
    expect(fakeStore.recoverExpiredLeases).toHaveBeenCalledWith(prisma, expect.objectContaining({ caseIds: [7] }));
    for (const call of fakeStore.findCandidateIds.mock.calls) expect(call[3]).toEqual({ caseIds: [7] });
    expect(fakeStore.findCandidateIds.mock.calls.map((c) => c[1])).toEqual(['pending', 'ambiguous']);
  });

  test('a scope that names a Case with no event processes nothing', async () => {
    expect(await run({ scope: { caseIds: [12345] } })).toEqual({ active: true, claimed: 0 });
    expect(fakeApi.calls).toEqual([]);
    expect(events.every((e) => e.status === 'pending')).toBe(true);
  });

  test('a scoped pass writes no failure alerts about events outside its scope, unless the caller supplies the writer', async () => {
    const defaultWriter = jest.fn();
    // The default alert writer is the one that looks at EVERY failed event; a scoped pass never calls it.
    const alerts = require('../../src/modules/bitrix/deal-failure-alerts');
    const spy = jest.spyOn(alerts, 'reportDealFailures');
    await run();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await run({ reportFailures: defaultWriter });
    expect(defaultWriter).toHaveBeenCalledTimes(1);
  });

  test('the worker still refuses to do anything unless its three switches are on', async () => {
    expect(await run({ env: {} })).toEqual({ active: false, claimed: 0 });
    expect(fakeStore.findCandidateIds).not.toHaveBeenCalled();
    expect(fakeApi.calls).toEqual([]);
  });

  test('a pass without a scope is exactly as before (every event is offered)', async () => {
    const result = await runDealWorker({ prisma, store: fakeStore, api: fakeApi, env: harness.workerEnv({}, { live: false }), log, workerId: 'w', reportFailures: async () => 0 });
    expect(result.claimed).toBe(3);
    for (const call of fakeStore.findCandidateIds.mock.calls) expect(call[3]).toBeUndefined();
  });
});

// ---- the script ----------------------------------------------------------------------------------------------------------
describe('scripts/e2e-worker.js', () => {
  test('requiring it runs nothing (it exports main and starts only when executed directly)', () => {
    const script = require('../../scripts/e2e-worker');
    expect(typeof script.main).toBe('function');
  });

  test('is a dry run unless --execute is given, uses the guarded test environment, and never starts the other jobs', () => {
    const fs = require('fs');
    const path = require('path');
    const full = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'e2e-worker.js'), 'utf8');
    const source = full.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n'); // code only: the header comment names what it is NOT
    expect(source).toMatch(/applyIsolatedEnv\(\)/);
    expect(source).toMatch(/verifyLiveDatabase/);
    expect(source).toMatch(/if \(!options\.execute\)/);
    expect(source).toMatch(/scope: \{ caseIds: options\.caseIds \}/);
    expect(source).not.toMatch(/runInboxWorker|reconcileDeals|retryFailedBitrixSyncs|sweepPendingScans|require\('dotenv'\)\.config|src\/worker/);
    expect(source).not.toMatch(/process\.env\.\w+\s*=/); // it never changes process.env itself
  });
});
