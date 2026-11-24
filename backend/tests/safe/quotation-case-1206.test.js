/* global describe, test, expect, jest, beforeEach */
// The guarded CASE-1206 quotation launcher (scripts/lib/quotation-case-1206.js): arguments, environment, storage, target checks, the dry run, the
// execution sequence and its scope, and what it can never do. No database, no network, no S3: prisma is a fake that answers by SQL text, the
// services and the Bitrix client are stand-ins, and every call is recorded.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const fs = require('fs');
const path = require('path');
const lib = require('../../scripts/lib/quotation-case-1206');
const { ACTUAL_FIELD } = require('../../src/modules/bitrix/bitrix-profiles');

const ENV = {
  DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev', BITRIX24_WEBHOOK_URL: 'https://b24-4orefh.bitrix24.in/rest/1/secrettoken/', BITRIX_ALLOWED_PORTAL_HOST: 'b24-4orefh.bitrix24.in',
  STORAGE_PROVIDER: 's3', AWS_REGION: 'ap-southeast-2', AWS_S3_BUCKET: 'humancare-dev-private-documents-123-ap-southeast-2-an', NODE_ENV: 'test',
};
const REF_FIELD = ACTUAL_FIELD.CASE_REFERENCE;
const GOOD_DEAL = { ID: '21846', CATEGORY_ID: '0', STAGE_ID: 'NEW', [REF_FIELD]: 'CASE-1206', UF_CRM_1795177914: { id: '9001' }, OPPORTUNITY: '25000.00', CURRENCY_ID: 'INR' };
const TARGET_ROW = {
  case_id: 206n, reference_number: 'CASE-1206', status: 'in_progress', request_id: 208n, request_reference: 'REQ-1208', user_id: 55n, service_key: 'privatecharter', review_status: 'approved',
  bitrix_lead_id: null, link_id: 9n, bitrix_deal_id: '21846', category_id: '0', profile: 'actual', sync_status: 'synced',
};

// A fake database answering by the text of the statement. `state` is mutable so the stand-in services can "write".
function world(over = {}) {
  const state = {
    database: 'humancare_dev', target: [{ ...TARGET_ROW }], openEvents: [], quotations: [], events: [], otherOutbox: [{ id: 3n, event_type: 'bitrix.deal.create', status: 'completed', attempts: 1 }],
    otherQuotations: [], inbox: [{ id: 1n, status: 'processed', attempts: 1 }], otherLinks: [{ id: 2n, stage_id: 'NEW', external_modified_at: null, last_attempt_at: null, sync_status: 'synced' }],
    caseRow: { status: 'in_progress', charter_stage: 'NEW', stage_version: 3 }, link: { stage_id: 'NEW', external_modified_at: null, sync_status: 'synced', last_attempt_at: null, last_synced_at: null },
    money: { invoices: 0n, payments: 0n, stage_events: 4n, patient_notifications: 2n }, candidates: [], ...over,
  };
  const db = { state, queries: [] };
  db.$queryRawUnsafe = jest.fn(async (sql) => {
    const s = sql.replace(/\s+/g, ' ');
    db.queries.push(s);
    if (s.includes('SELECT DATABASE()')) return [{ db: state.database }];
    if (s.includes('FROM cases c JOIN service_requests sr')) return state.target;
    if (s.includes("event_type = 'bitrix.quotation.sync' AND status IN")) return state.openEvents;
    if (s.startsWith('SELECT id, status FROM case_quotations')) return state.quotations.map((q) => ({ id: q.id, status: q.status }));
    if (s.startsWith('SELECT status, charter_stage')) return [state.caseRow];
    if (s.includes('FROM bitrix_deal_links WHERE case_id = ?')) return [state.link];
    if (s.includes('FROM bitrix_deal_links WHERE case_id <>')) return state.otherLinks;
    if (s.includes('FROM case_quotations WHERE case_id = ? ORDER')) return state.quotations;
    if (s.includes('FROM case_quotations WHERE case_id <>')) return state.otherQuotations;
    if (s.includes('FROM integration_outbox WHERE case_id = ? ORDER')) return state.events;
    if (s.includes('FROM integration_outbox WHERE case_id IS NULL')) return state.otherOutbox;
    if (s.includes('FROM integration_inbox')) return state.inbox;
    if (s.startsWith('SELECT (SELECT COUNT(*) FROM invoices')) return [state.money];
    if (s.includes('SELECT o.id AS id')) return state.candidates;
    throw new Error(`unexpected statement: ${s.slice(0, 90)}`);
  });
  return db;
}
const writesIn = (db) => db.queries.filter((q) => /\b(INSERT|UPDATE|DELETE)\b/i.test(q));

function harness({ db = world(), deal = GOOD_DEAL, env = ENV, clam = true, s3Fails = false, sync, scanStatus = 'clean' } = {}) {
  const calls = [];
  const guardState = { dealGet: 0, itemGet: 0, download: 0, refused: [] };
  const deps = {
    prisma: db, env, log: { warn: jest.fn(), error: jest.fn(), log: jest.fn() }, gateway: { stand: 'in' },
    realApi: { BitrixDealCallError: Error, getDeal: jest.fn(async () => { calls.push('getDeal'); return { status: 'ok', deal }; }) },
    makeGuard: jest.fn(() => ({ state: guardState, fetchImpl: jest.fn() })),
    clamReady: jest.fn(async () => clam),
    createStorage: jest.fn(() => ({ provider: 's3' })),
    s3Probe: jest.fn(async () => { calls.push('s3Probe'); if (s3Fails) throw Object.assign(new Error('x'), { code: 'access_denied' }); return false; }),
    services: {
      detect: jest.fn(async (_db, caseRecord) => { calls.push('detect'); db.state.events.push({ id: 11n, event_type: 'bitrix.quotation.sync', status: 'pending', attempts: 0 }); return { queued: true, reason: 'queued', caseRecord }; }),
      runSync: jest.fn(async () => {
        calls.push('runSync');
        db.state.events[0].status = 'completed';
        db.state.quotations.push({ id: 77n, version_number: 1, status: 'draft', scan_status: 'pending', scan_attempts: 0, revision: 0, storage_provider: 's3', storage_key: 'quotations/case-206/ev11-abc.pdf', sha256: 'abc', confirmed_at: null, published_at: null });
        return sync || { active: true, claimed: 1, results: [{ eventId: 11, outcome: 'created', quotationId: 77, versionNumber: 1 }] };
      }),
      sweep: jest.fn(async () => { calls.push('sweep'); db.state.quotations[0].scan_status = scanStatus; return { active: true, checked: 1, results: [{ id: 77, outcome: scanStatus }] }; }),
    },
  };
  return { deps, calls, db, guardState };
}
const dry = { execute: false };
const exec = { execute: true };

describe('arguments', () => {
  test('the default is a dry run; execute needs the exact confirmation, and nothing else is accepted', () => {
    expect(lib.parseArgs([])).toEqual({ execute: false });
    expect(lib.parseArgs(['--execute', '--confirm', 'CASE-1206'])).toEqual({ execute: true });
    for (const bad of [['--execute'], ['--confirm', 'CASE-1206'], ['--execute', '--confirm', 'CASE-4037'], ['--execute', '--confirm'], ['--deal-id', '1'], ['--case-id', '206'], ['--force']]) {
      expect(() => lib.parseArgs(bad)).toThrow(lib.Refused);
    }
  });
});

describe('environment: set in memory only', () => {
  test('the worker environment is a copy with the switches and the actual profile forced on', () => {
    const base = { ...ENV, BITRIX_SYNC_ENABLED: 'false', BITRIX_QUOTATION_SYNC_ENABLED: 'false', BITRIX_DEAL_PROFILE: 'test' };
    const before = { ...process.env };
    const env = lib.buildWorkerEnv(base);
    expect(env).toMatchObject({ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true', BITRIX_DEAL_PROFILE: 'actual' });
    expect(base.BITRIX_SYNC_ENABLED).toBe('false');
    expect(process.env).toEqual(before);
    expect(lib.environmentProblems(env)).toEqual([]);
  });

  test.each([
    ['switches off (not forced)', { ...ENV }, 'quotation_sync_not_active'],
    ['wrong profile', { ...lib.buildWorkerEnv(ENV), BITRIX_DEAL_PROFILE: 'test' }, 'bitrix_profile_not_actual'],
    ['no profile', { ...lib.buildWorkerEnv(ENV), BITRIX_DEAL_PROFILE: '' }, 'bitrix_profile_not_actual'],
    ['wrong database', { ...lib.buildWorkerEnv(ENV), DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }, 'database_url_not_humancare_dev'],
    ['remote database', { ...lib.buildWorkerEnv(ENV), DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }, 'database_not_loopback'],
    ['production', { ...lib.buildWorkerEnv(ENV), NODE_ENV: 'production' }, 'production_refused'],
    ['no webhook', { ...lib.buildWorkerEnv(ENV), BITRIX24_WEBHOOK_URL: '' }, 'webhook_not_configured'],
    ['another portal', { ...lib.buildWorkerEnv(ENV), BITRIX_ALLOWED_PORTAL_HOST: 'other.bitrix24.in' }, 'portal_host_not_allowed'],
  ])('%s is refused', (_name, env, code) => {
    expect(lib.environmentProblems(env)).toContain(code);
  });
});

describe('S3 configuration (configuration only, no S3 call)', () => {
  test('the development bucket is accepted; no secret is ever returned', () => {
    const r = lib.storageProblems({ ...ENV, AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'sekret' });
    expect(r.problems).toEqual([]);
    expect(r.info).toMatchObject({ provider: 's3', bucket: ENV.AWS_S3_BUCKET, credentials: 'environment keys' });
    expect(JSON.stringify(r)).not.toMatch(/AKIAEXAMPLE|sekret/);
  });
  test('local storage, a non-development bucket and a missing bucket are refused', () => {
    expect(lib.storageProblems({ ...ENV, STORAGE_PROVIDER: 'local' }).problems).toContain('storage_provider_not_s3');
    expect(lib.storageProblems({ ...ENV, AWS_S3_BUCKET: 'humancare-prod-documents' }).problems).toContain('bucket_not_a_development_bucket');
    expect(lib.storageProblems({ ...ENV, AWS_S3_BUCKET: '' }).problems).toEqual(['storage_config_missing']);
  });
  test('non-standard AWS variable names are reported as a warning, without their values', () => {
    const r = lib.storageProblems({ ...ENV, AWS_ACCESS_KEY: 'AKIAXX', AWS_SECRET: 'zzz' });
    expect(r.warnings.join(' ')).toMatch(/default credential chain/);
    expect(JSON.stringify(r)).not.toMatch(/AKIAXX|zzz/);
  });
});

describe('target verification', () => {
  test('the right records pass and the ids come from the database', async () => {
    const r = await lib.inspectTarget(world());
    expect(r).toMatchObject({ ok: true, problems: [], target: { caseId: 206, requestId: 208, userId: 55 } });
  });
  test.each([
    ['case not found', { target: [] }, 'case_not_found'],
    ['wrong request', { target: [{ ...TARGET_ROW, request_reference: 'REQ-1209' }] }, 'request_reference_mismatch'],
    ['wrong deal', { target: [{ ...TARGET_ROW, bitrix_deal_id: '21802' }] }, 'deal_id_mismatch'],
    ['wrong category', { target: [{ ...TARGET_ROW, category_id: '38' }] }, 'link_category_not_0'],
    ['wrong profile', { target: [{ ...TARGET_ROW, profile: 'test' }] }, 'link_profile_not_actual'],
    ['no link', { target: [{ ...TARGET_ROW, link_id: null }] }, 'deal_link_missing'],
    ['closed case', { target: [{ ...TARGET_ROW, status: 'completed' }] }, 'case_closed'],
    ['has a Lead', { target: [{ ...TARGET_ROW, bitrix_lead_id: '5' }] }, 'not_an_approved_private_charter_request_without_lead'],
    ['an open quotation event', { openEvents: [{ id: 9n }] }, 'open_quotation_event_exists'],
    ['a published quotation', { quotations: [{ id: 5n, status: 'published' }] }, 'case_has_a_non_draft_quotation'],
  ])('%s is refused', async (_n, over, code) => {
    expect((await lib.inspectTarget(world(over))).problems).toContain(code);
  });
  test('a database that is not humancare_dev is refused before anything else', async () => {
    await expect(lib.verifyDatabase(world({ database: 'humancare_test' }))).rejects.toThrow(/database_not_humancare_dev/);
    const h = harness({ db: world({ database: 'humancare_prod' }) });
    await expect(lib.run(dry, h.deps)).rejects.toThrow(lib.Refused);
    expect(h.db.queries).toHaveLength(1); // only SELECT DATABASE()
  });
});

describe('dry run', () => {
  test('is ready, read-only and touches nothing outside the database', async () => {
    const h = harness();
    const r = await lib.run(dry, h.deps);
    expect(r).toMatchObject({ mode: 'dry-run', ready: true, problems: [], ids: { caseId: 206, requestId: 208 }, clamav: 'ready', inScope: { quotationEventCandidates: 0 } });
    expect(r.storage).toMatchObject({ provider: 's3' });
    expect(writesIn(h.db)).toEqual([]);
    expect(h.deps.realApi.getDeal).not.toHaveBeenCalled();
    expect(h.deps.makeGuard).not.toHaveBeenCalled();
    expect(h.deps.s3Probe).not.toHaveBeenCalled();
    expect(h.deps.createStorage).not.toHaveBeenCalled();
    for (const fn of Object.values(h.deps.services)) expect(fn).not.toHaveBeenCalled();
  });
  test('snapshots the quotation, invoice, payment and Case state', async () => {
    const r = await lib.run(dry, harness().deps);
    expect(r.before.money).toMatchObject({ invoices: 0, payments: 0 });
    expect(r.before.caseRow).toMatchObject({ status: 'in_progress' });
    expect(r.before.quotations).toEqual([]);
  });
  test.each([
    ['ClamAV down', { clam: false }, 'clamav_not_ready'],
    ['a non-development bucket', { env: { ...ENV, AWS_S3_BUCKET: 'prod-bucket-1' } }, 'bucket_not_a_development_bucket'],
    ['a wrong Deal link', { db: world({ target: [{ ...TARGET_ROW, bitrix_deal_id: '1' }] }) }, 'deal_id_mismatch'],
  ])('%s makes the dry run not ready (and still writes nothing)', async (_n, opts, code) => {
    const h = harness(opts);
    const r = await lib.run(dry, h.deps);
    expect(r.ready).toBe(false);
    expect(r.problems).toContain(code);
    expect(writesIn(h.db)).toEqual([]);
  });
  test('a case that does not exist returns not ready without reading further', async () => {
    const r = await lib.run(dry, harness({ db: world({ target: [] }) }).deps);
    expect(r).toMatchObject({ ready: false, problems: expect.arrayContaining(['case_not_found']) });
  });
});

describe('execution', () => {
  test('runs the exact sequence, scoped to the Case and the one quotation it created', async () => {
    const h = harness();
    const r = await lib.run(exec, h.deps);
    expect(h.calls).toEqual(['s3Probe', 'getDeal', 'detect', 'runSync', 'sweep']); // S3 is checked first and uploaded to only by the sync, after the Deal is verified
    expect(h.deps.services.detect.mock.calls[0][1]).toEqual({ id: 206, referenceNumber: 'CASE-1206' });
    expect(h.deps.services.detect.mock.calls[0][3]).toMatchObject({ name: 'actual', categoryId: 0 });
    expect(h.deps.services.runSync.mock.calls[0][0].scope).toEqual({ caseIds: [206] });
    expect(h.deps.services.runSync.mock.calls[0][0].gateway).toBe(h.deps.gateway);
    expect(h.deps.services.sweep.mock.calls[0][0]).toMatchObject({ caseIds: [206], quotationIds: [77] });
    const workerEnv = h.deps.services.runSync.mock.calls[0][0].env;
    expect(workerEnv).toMatchObject({ BITRIX_QUOTATION_SYNC_ENABLED: 'true', BITRIX_DEAL_PROFILE: 'actual' });
    expect(r).toMatchObject({ succeeded: true, quotationId: 77, unexpected: [], final: { scan_status: 'clean', status: 'draft' } });
  });

  test('the Bitrix surface it gives the services refuses every write method', async () => {
    const h = harness();
    await lib.run(exec, h.deps);
    const api = h.deps.services.runSync.mock.calls[0][0].api;
    for (const name of ['createDeal', 'updateDealFiles', 'findDealsByReference', 'getDealFiles']) await expect(api[name]()).rejects.toThrow(/disabled/);
    expect(h.guardState.refused).toEqual(['createDeal', 'updateDealFiles', 'findDealsByReference', 'getDealFiles']);
  });

  test('every read goes through the guard and the shared dispatcher', async () => {
    const h = harness();
    await lib.run(exec, h.deps);
    const options = h.deps.realApi.getDeal.mock.calls[0][1];
    expect(options.gateway).toBe(h.deps.gateway);
    expect(typeof options.fetchImpl).toBe('function');
    expect(h.deps.makeGuard).toHaveBeenCalledWith('b24-4orefh.bitrix24.in', lib.LIMITS);
  });

  test.each([
    ['no quotation PDF', { UF_CRM_1795177914: null }, 'quotation_pdf_missing'],
    ['an unreadable PDF field', { UF_CRM_1795177914: [{ id: '1' }, { id: '2' }] }, 'quotation_pdf_field_unreadable'],
    ['a missing amount', { OPPORTUNITY: '' }, 'quotation_amount_missing'],
    ['an invalid amount', { OPPORTUNITY: 'abc' }, 'quotation_amount_invalid'],
    ['a missing currency', { CURRENCY_ID: '' }, 'quotation_currency_missing'],
    ['an invalid currency', { CURRENCY_ID: 'rupees' }, 'quotation_currency_invalid'],
    ['a Deal of another category', { CATEGORY_ID: '38' }, 'deal_category_mismatch'],
    ['a Deal with another reference', { [REF_FIELD]: 'CASE-9999' }, 'deal_reference_mismatch'],
    ['another Deal id', { ID: '21802' }, 'deal_deal_id_mismatch'],
    ['a closed Deal', { STAGE_ID: 'WON' }, 'deal_closed'],
  ])('%s is refused before anything is queued, stored or scanned', async (_n, patch, code) => {
    const h = harness({ deal: { ...GOOD_DEAL, ...patch } });
    await expect(lib.run(exec, h.deps)).rejects.toThrow(code);
    for (const fn of Object.values(h.deps.services)) expect(fn).not.toHaveBeenCalled();
    expect(writesIn(h.db)).toEqual([]);
  });

  test('a Deal that cannot be read is refused before anything is written', async () => {
    const h = harness();
    h.deps.realApi.getDeal.mockResolvedValueOnce({ status: 'uncertain', reason: 'timeout' });
    await expect(lib.run(exec, h.deps)).rejects.toThrow('deal_read_uncertain');
    expect(h.deps.services.detect).not.toHaveBeenCalled();
  });

  test('S3 is probed before the Deal is read, and an unreachable bucket stops everything', async () => {
    const h = harness({ s3Fails: true });
    await expect(lib.run(exec, h.deps)).rejects.toThrow('storage_unreachable_access_denied');
    expect(h.calls).toEqual(['s3Probe']);
    expect(h.deps.realApi.getDeal).not.toHaveBeenCalled();
  });

  test('a refused dry-run condition (ClamAV down) also blocks execution', async () => {
    const h = harness({ clam: false });
    await expect(lib.run(exec, h.deps)).rejects.toThrow('clamav_not_ready');
    expect(h.deps.s3Probe).not.toHaveBeenCalled();
    expect(h.deps.services.detect).not.toHaveBeenCalled();
  });

  test('S3 is only ever used during execution: the dry run never builds the storage', async () => {
    const dryRun = harness(); await lib.run(dry, dryRun.deps);
    expect(dryRun.deps.createStorage).not.toHaveBeenCalled();
    const live = harness(); await lib.run(exec, live.deps);
    expect(live.deps.createStorage).toHaveBeenCalledTimes(1);
  });

  test('detection that queues nothing stops the run', async () => {
    const h = harness();
    h.deps.services.detect.mockResolvedValueOnce({ queued: false, reason: 'already_queued' });
    await expect(lib.run(exec, h.deps)).rejects.toThrow('detection_already_queued');
    expect(h.deps.services.runSync).not.toHaveBeenCalled();
  });

  describe('failure and retry handling: one pass, reported, never looped', () => {
    test.each([
      ['a retry', { active: true, claimed: 1, results: [{ eventId: 11, outcome: 'retry', code: 'bitrix_read_failed' }] }],
      ['a failure', { active: true, claimed: 1, results: [{ eventId: 11, outcome: 'failed', code: 'download_not_pdf' }] }],
      ['an unchanged result', { active: true, claimed: 1, results: [{ eventId: 11, outcome: 'unchanged' }] }],
      ['nothing claimed', { active: true, claimed: 0, results: [] }],
      ['two versions', { active: true, claimed: 2, results: [{ outcome: 'created', quotationId: 1 }, { outcome: 'created', quotationId: 2 }] }],
    ])('%s: no scan is run and the end state is not a success', async (_n, sync) => {
      const h = harness({ sync });
      const r = await lib.run(exec, h.deps);
      expect(h.deps.services.sweep).not.toHaveBeenCalled();
      expect(h.deps.services.runSync).toHaveBeenCalledTimes(1);
      expect(r.succeeded).toBe(false);
    });
    test.each(['infected', 'error', 'pending'])('a scan that ends %s is reported as not successful', async (scanStatus) => {
      const r = await lib.run(exec, harness({ scanStatus }).deps);
      expect(r.succeeded).toBe(false);
      expect(r.final.scan_status).toBe(scanStatus);
    });
  });

  describe('nothing else may change', () => {
    test('another event, another quotation, the inbox, a link, an invoice, a payment, a notification, a stage change or a Deal-stage change is detected', () => {
      const base = (async () => lib.snapshot(world(), { caseId: 206, userId: 55 }));
      return base().then(async (before) => {
        const mutate = (fn) => { const after = JSON.parse(JSON.stringify(before)); fn(after); return lib.unexpectedChanges(before, after); };
        expect(lib.unexpectedChanges(before, JSON.parse(JSON.stringify(before)))).toEqual([]);
        expect(mutate((a) => { a.otherOutbox[0].status = 'failed'; })).toContain('other_outbox_events_changed');
        expect(mutate((a) => { a.otherQuotations.push({ id: 9 }); })).toContain('other_quotations_changed');
        expect(mutate((a) => { a.inbox[0].attempts = 5; })).toContain('inbox_changed');
        expect(mutate((a) => { a.otherLinks[0].stage_id = 'WON'; })).toContain('other_deal_links_changed');
        expect(mutate((a) => { a.link.stage_id = 'PREPARATION'; })).toContain('deal_link_or_stage_changed');
        expect(mutate((a) => { a.caseRow.status = 'completed'; })).toContain('case_state_changed');
        for (const key of ['invoices', 'payments', 'stage_events', 'patient_notifications']) expect(mutate((a) => { a.money[key] += 1; })).toContain('invoice_payment_notification_or_stage_event_changed');
        expect(mutate((a) => { a.events.push({ id: 1, event_type: 'bitrix.quotation.sync' }, { id: 2, event_type: 'bitrix.quotation.sync' }); })).toContain('unexpected_new_events');
        expect(mutate((a) => { a.events.push({ id: 1, event_type: 'bitrix.deal.create' }); })).toContain('unexpected_new_events');
        expect(mutate((a) => { a.quotations.push({ id: 1, status: 'published', published_at: new Date() }); })).toContain('quotation_confirmed_or_published');
        expect(mutate((a) => { a.events.push({ id: 1, event_type: 'bitrix.quotation.sync' }); a.quotations.push({ id: 1, status: 'draft', confirmed_at: null, published_at: null }); })).toEqual([]);
      });
    });
    test('a change made by a service to unrelated rows turns the run into a reported failure', async () => {
      const h = harness();
      h.deps.services.runSync.mockImplementationOnce(async () => {
        h.db.state.otherOutbox[0].attempts = 9; // another event touched
        h.db.state.events.push({ id: 11n, event_type: 'bitrix.quotation.sync', status: 'completed', attempts: 1 });
        h.db.state.quotations.push({ id: 77n, version_number: 1, status: 'draft', scan_status: 'pending', scan_attempts: 0, revision: 0, storage_provider: 's3', storage_key: 'k', sha256: 'a', confirmed_at: null, published_at: null });
        return { active: true, claimed: 1, results: [{ eventId: 11, outcome: 'created', quotationId: 77 }] };
      });
      const r = await lib.run(exec, h.deps);
      expect(r.unexpected).toContain('other_outbox_events_changed');
      expect(r.succeeded).toBe(false);
    });
  });
});

describe('what the launcher can never do (source check)', () => {
  const files = [path.join(__dirname, '../../scripts/lib/quotation-case-1206.js'), path.join(__dirname, '../../scripts/e2e-quotation-case-1206.js')];
  const code = files.map((f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')).join('\n');
  test.each([
    ['the inbox processor', /runInboxWorker|deal-inbox/],
    ['reconciliation', /reconcileDeals|deal-reconcile/],
    ['the job runner or the job list', /job-runner|createJobRunner|src\/jobs|\/jobs\//],
    ['an invoice or a payment', /sweepAcceptedWithoutInvoice|quotation-invoice|razorpay|payments\/|createInvoice|createPayment/i],
    ['a notification or a push', /sendNotification|createNotification|notifyPatient|sendPush|expo-server|expo.host|notification.create/i],
    ['a write to process.env', /process\.env(\.[A-Z_]+|\[[^\]]+\])\s*=[^=]/],
    ['Object.assign onto process.env', /Object\.assign\(\s*process\.env/],
    ['a file write', /writeFile|appendFile|createWriteStream/],
    ['a Bitrix write method', /crm\.deal\.(add|update)|crm\.item\.(add|update)|createDeal\(|updateDealFiles\(/],
    ['a stage or quotation state change', /stage_id\s*=|\.update\(|updateMany|\$executeRaw/],
  ])('has no reference to %s', (_n, pattern) => {
    expect(code).not.toMatch(pattern);
  });
});
