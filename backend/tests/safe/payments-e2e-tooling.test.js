/* global describe, test, expect, jest */
// The test-only tooling for a Test Mode payment: the guarded seed (scripts/lib/payable-invoice-seed.js, scripts/e2e-seed-payable-invoice.js) and the isolated
// Razorpay runner (scripts/lib/e2e-payments-runner.js, scripts/e2e-payments-runner.js). No database, no network, no process started.
const fs = require('fs');
const path = require('path');
const seed = require('../../scripts/lib/payable-invoice-seed');
const runner = require('../../scripts/lib/e2e-payments-runner');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\/.*$/gm, '');

// ---- the seed ---------------------------------------------------------------------------------------------------------------------------------------
const args = (...a) => seed.parseArgs(a);
const refusalOf = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

describe('seed arguments', () => {
  test('both ids are required (the user id proves the request is that patient\'s); the default is a DRY RUN of 1500.00 INR', () => {
    expect(args('--request-id', '12', '--user-id', '5')).toMatchObject({ requestId: 12, userId: 5, amount: '1500.00', currency: 'INR', execute: false, allowPartial: false, amountText: '1500.00' });
    expect(refusalOf(() => args('--user-id', '5'))).toBe('request_id_required');
    expect(refusalOf(() => args('--request-id', '12'))).toBe('user_id_required');
  });
  test.each([
    [['--request-id', 'x', '--user-id', '5'], 'request_id_invalid'],
    [['--request-id', '0', '--user-id', '5'], 'request_id_invalid'],
    [['--request-id', '1', '--user-id', '-5'], 'user_id_invalid'],
    [['--request-id', '1', '--user-id', '5', '--amount', '1500.001'], 'amount_invalid'], // would need rounding in INR
    [['--request-id', '1', '--user-id', '5', '--amount', '0'], 'amount_invalid'],
    [['--request-id', '1', '--user-id', '5', '--amount', '1e3'], 'amount_invalid'],
    [['--request-id', '1', '--user-id', '5', '--currency', 'KWD'], 'currency_unsupported'],
    [['--request-id', '1', '--user-id', '5', '--due-days', '0'], 'due_days_invalid'],
    [['--request-id', '1', '--user-id', '5', '--database', 'humancare'], 'unknown_argument'],
    [['--request-id', '1', '--user-id', '5', '--amount'], 'missing_value_for_--amount'],
  ])('refuses %j with %s', (a, expected) => { expect(refusalOf(() => args(...a))).toBe(expected); });
  test('--execute, --allow-partial, --due-days and a custom amount are parsed', () => {
    expect(args('--request-id', '1', '--user-id', '5', '--execute', '--allow-partial', '--due-days', '30', '--amount', '250.50')).toMatchObject({ execute: true, allowPartial: true, dueDays: 30, amountText: '250.50' });
  });
});

const request = (over = {}) => ({ id: 12, userId: 5, serviceKey: 'privatecharter', case: { id: 40, status: 'in_progress', closedAt: null }, ...over });
function fakeDb({ req = request(), live = null, link = null, head = null, liveUnderLock = null } = {}) {
  const log = { calls: [], created: {}, locked: [] };
  let inTx = false;
  const build = () => ({
    serviceRequest: { findFirst: jest.fn(async ({ where }) => (req && where.id === req.id && where.userId === req.userId ? req : null)) },
    caseQuotation: {
      findFirst: jest.fn(async ({ where, orderBy }) => {
        if (where.liveSlot) return inTx && liveUnderLock ? liveUnderLock : live;
        return orderBy ? head : null;
      }),
      create: jest.fn(async ({ data }) => { log.calls.push('quotation'); log.created.quotation = data; return { id: 300 }; }),
    },
    bitrixDealLink: {
      findUnique: jest.fn(async () => link),
      create: jest.fn(async ({ data }) => { log.calls.push('link'); log.created.link = data; return { id: 200 }; }),
      update: jest.fn(), updateMany: jest.fn(),
    },
    adminUser: { create: jest.fn(async ({ data }) => { log.calls.push('admin'); log.created.admin = data; return { id: 100 }; }) },
    invoice: { create: jest.fn(async ({ data }) => { log.calls.push('invoice'); log.created.invoice = data; return { id: 400 }; }) },
    $queryRaw: jest.fn(async (strings, ...values) => { log.locked.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), values, afterCalls: [...log.calls] }); return []; }),
  });
  const db = build();
  db.$transaction = jest.fn(async (fn) => { inTx = true; try { return await fn(db); } finally { inTx = false; } });
  db.log = log;
  return db;
}
const opts = (over = {}) => ({ ...args('--request-id', '12', '--user-id', '5', '--execute'), ...over });

describe('seed refusals (every one before anything is written)', () => {
  test.each([
    ['the request is not this patient\'s', { req: request({ userId: 6 }) }, 'request_not_found_for_this_patient'],
    ['there is no such request', { req: null }, 'request_not_found_for_this_patient'],
    ['not a Private Charter request', { req: request({ serviceKey: 'air' }) }, 'not_a_private_charter_request'],
    ['the request has no Case', { req: request({ case: null }) }, 'request_has_no_case'],
    ['the Case is closed', { req: request({ case: { id: 40, status: 'closed', closedAt: new Date() } }) }, 'case_closed'],
    ['the Case is cancelled', { req: request({ case: { id: 40, status: 'cancelled', closedAt: null } }) }, 'case_closed'],
    ['the Case already has a live quotation', { live: { id: 1 } }, 'case_already_has_a_live_quotation'],
  ])('%s -> %s', async (_l, dbOver, codeExpected) => {
    const db = fakeDb(dbOver);
    await expect(seed.runSeed(db, opts())).rejects.toMatchObject({ name: 'SeedRefused', code: codeExpected });
    expect(db.log.calls).toEqual([]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  test('a live quotation that appears while waiting for the Case lock is refused under the lock, and nothing is written', async () => {
    const db = fakeDb({ liveUnderLock: { id: 9 } });
    await expect(seed.runSeed(db, opts())).rejects.toMatchObject({ code: 'case_already_has_a_live_quotation' });
    expect(db.log.calls).toEqual([]);
  });
});

describe('seed behaviour', () => {
  test('a dry run reads only: no transaction, no write, and the plan names the Case and the next quotation version', async () => {
    const db = fakeDb({ head: { versionNumber: 2 } });
    const result = await seed.runSeed(db, opts({ execute: false }));
    expect(result).toEqual({ executed: false, plan: { requestId: 12, caseId: 40, linkId: null, versionNumber: 3 } });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.log.calls).toEqual([]);
  });
  test('execute: locks the Case FIRST, then creates admin, link (none existed), accepted live quotation, issued invoice that matches it; all marked SEED_', async () => {
    const db = fakeDb({ head: { versionNumber: 1 } });
    const now = new Date('2026-11-20T10:00:00.000Z');
    const result = await seed.runSeed(db, opts({ dueDays: 30 }), { now: () => now });
    expect(result.created).toMatchObject({ adminId: 100, linkId: 200, quotationId: 300, invoiceId: 400 });
    expect(db.log.locked[0]).toMatchObject({ sql: 'SELECT id FROM cases WHERE id = ? FOR UPDATE', values: [40], afterCalls: [] });
    expect(db.log.calls).toEqual(['admin', 'link', 'quotation', 'invoice']);
    const { quotation, invoice, link, admin } = db.log.created;
    expect(quotation).toMatchObject({ caseId: 40, versionNumber: 2, status: 'accepted', liveSlot: 1, amount: '1500.00', currency: 'INR', decidedByUserId: 5, scanStatus: 'clean' });
    expect(invoice).toMatchObject({ caseId: 40, source: 'quotation', quotationId: 300, amount: '1500.00', currency: 'INR', status: 'issued', allowPartialPayment: false });
    expect(invoice.dueDate.getTime()).toBe(now.getTime() + 30 * 86400000);
    expect(link).toMatchObject({ caseId: 40, syncStatus: 'synced' });
    for (const text of [admin.name, admin.email, quotation.storageKey, invoice.idempotencyKey, link.bitrixDealId]) expect(text.toUpperCase()).toContain('SEED_');
    expect(admin.email).toMatch(/@example\.invalid$/);
  });
  test('an EXISTING Deal link is reused and never changed or created again', async () => {
    const db = fakeDb({ link: { id: 77, bitrixDealId: '4711' } });
    const result = await seed.runSeed(db, opts());
    expect(result.created.linkId).toBe(77);
    expect(db.bitrixDealLink.create).not.toHaveBeenCalled();
    expect(db.bitrixDealLink.update).not.toHaveBeenCalled();
    expect(db.log.created.quotation.dealLinkId).toBe(77);
  });
  test('--allow-partial authorises partial payment with the synthetic admin and the time', async () => {
    const db = fakeDb();
    await seed.runSeed(db, opts({ allowPartial: true }));
    expect(db.log.created.invoice).toMatchObject({ allowPartialPayment: true, partialPaymentAuthorizedByAdminId: 100 });
    expect(db.log.created.invoice.partialPaymentAuthorizedAt).toBeInstanceOf(Date);
  });
  test('it writes only the four kinds of row: no request, Case, patient or existing link is created or changed', async () => {
    const db = fakeDb();
    await seed.runSeed(db, opts());
    expect(Object.keys(db.log.created).sort()).toEqual(['admin', 'invoice', 'link', 'quotation']);
  });
});

describe('seed script safety (static)', () => {
  const script = code('scripts/e2e-seed-payable-invoice.js');
  test('loads only .env.test through e2e-env, forces both Bitrix switches off, and never writes an env file', () => {
    expect(script).toContain("require('./e2e-env')");
    expect(script).toMatch(/BITRIX_SYNC_ENABLED = 'false'/);
    expect(script).toMatch(/BITRIX_PRIVATE_CHARTER_DEAL_ENABLED = 'false'/);
    expect(script).not.toMatch(/writeFile|appendFile|\.env['"`]|dotenv|unlink|rmSync/);
  });
  test('every guard runs BEFORE the seed: URL guard, live server identity (database, account, loopback, port, grants), then the session lock; the lock is released', () => {
    const order = ['buildIsolatedEnv()', 'assertTestDatabaseUrl', 'verifyLiveIdentity', 'acquireSessionLock', 'runSeed('].map((s) => script.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(script).toMatch(/finally[\s\S]*release\(\)/);
  });
  test('dry run is the default and only --execute writes; no network, no Razorpay, no Bitrix; output is ids and codes only', () => {
    expect(seed.parseArgs(['--request-id', '1', '--user-id', '1']).execute).toBe(false);
    expect(script + code('scripts/lib/payable-invoice-seed.js')).not.toMatch(/fetch\(|https?:\/\/|razorpay\.api|bitrix-|require\('https?'\)/i);
    expect(script).not.toMatch(/err\.message|\.stack/);
  });
  test('the library only writes inside one transaction with the Case locked first', () => {
    const lib = code('scripts/lib/payable-invoice-seed.js');
    expect(lib.indexOf('$transaction')).toBeLessThan(lib.indexOf('FOR UPDATE'));
    expect(lib.indexOf('FOR UPDATE')).toBeLessThan(lib.indexOf('adminUser.create'));
    expect(lib).not.toMatch(/\b(tx|db)\.\w+\.(update|updateMany|delete|deleteMany|upsert)\(/); // (the hash's own .update() is not a database write)
  });
});

// ---- the runner -------------------------------------------------------------------------------------------------------------------------------------
const GOOD = {
  NODE_ENV: 'test', PORT: '4199', PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_KEY_ID: 'rzp_test_FAKEKEY123456',
  RAZORPAY_KEY_SECRET: 'FAKE_API_SECRET_VALUE_1', RAZORPAY_WEBHOOK_SECRET: 'FAKE_WEBHOOK_SECRET_VALUE_2',
};

describe('runner environment', () => {
  test('both Bitrix switches are forced OFF and the Bitrix webhook URL is blanked, whatever the file says and whatever an override says', () => {
    const env = runner.buildPaymentsRunnerEnv({ base: () => ({ ...GOOD, BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', BITRIX24_WEBHOOK_URL: 'https://example.invalid/hook' }), overrides: { BITRIX_SYNC_ENABLED: 'true' } });
    expect(env).toMatchObject({ BITRIX_SYNC_ENABLED: 'false', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'false', BITRIX24_WEBHOOK_URL: '' });
  });
  test('it starts from the isolated .env.test environment (e2e-env), never the development one', () => {
    expect(code('scripts/lib/e2e-payments-runner.js')).toContain("require('../e2e-env')");
    expect(code('scripts/lib/e2e-payments-runner.js')).not.toMatch(/dotenv|readFileSync|\.env['"`]/);
  });
});

describe('runner readiness', () => {
  test('a complete Test Mode configuration is ready', () => { expect(runner.runnerProblems(GOOD)).toEqual([]); });
  test.each([
    ['payments disabled', { PAYMENTS_ENABLED: 'false' }, ['payments_disabled']],
    ['PAYMENTS_ENABLED not exactly true', { PAYMENTS_ENABLED: 'TRUE' }, ['payments_disabled']],
    ['no webhook secret', { RAZORPAY_WEBHOOK_SECRET: '' }, ['webhook_secret_missing']],
    ['webhook secret equals the API secret', { RAZORPAY_WEBHOOK_SECRET: 'FAKE_API_SECRET_VALUE_1' }, ['webhook_secret_reused']],
    ['no environment id', { PAYMENTS_ENVIRONMENT_ID: '' }, ['environment_id_missing']],
    ['a LIVE key', { RAZORPAY_KEY_ID: 'rzp_live_FAKEKEY123456' }, ['key_mode_mismatch']],
    ['a key that is neither', { RAZORPAY_KEY_ID: 'abc' }, ['key_id_invalid']],
    ['the development port', { PORT: '4000' }, ['port_invalid']],
    ['no port', { PORT: '' }, ['port_invalid']],
  ])('%s -> %j', (_l, over, expected) => { expect(runner.runnerProblems({ ...GOOD, ...over })).toEqual(expected); });
  test('everything missing is named in ONE run', () => {
    expect(runner.runnerProblems({ NODE_ENV: 'test', PORT: '4199', RAZORPAY_KEY_ID: 'rzp_test_FAKEKEY123456', RAZORPAY_KEY_SECRET: 'FAKE_API_SECRET_VALUE_1' }))
      .toEqual(['payments_disabled', 'webhook_secret_missing', 'environment_id_missing']);
  });
  test('problems are fixed codes: no value of the environment ever appears in them', () => {
    const text = JSON.stringify(runner.runnerProblems({ ...GOOD, PAYMENTS_ENABLED: 'no', RAZORPAY_WEBHOOK_SECRET: 'FAKE_API_SECRET_VALUE_1' }));
    expect(text).not.toMatch(/FAKE|rzp_/);
  });
});

describe('runner script (static)', () => {
  const script = code('scripts/e2e-payments-runner.js');
  test('is NOT src/server.js or src/worker.js and starts no job but the Razorpay webhook inbox job', () => {
    expect(script).not.toMatch(/src\/worker|\.\.\/src\/server|require\('\.\.\/src\/jobs'\)|jobs\/index/);
    expect(script).toContain("require('../src/jobs/razorpay-webhook-inbox.job')");
    expect(script).toMatch(/createJobRunner\(\[razorpayJob\]\)/);
    expect(script).not.toMatch(/require\([^)]*(bitrix|payment-order-recovery|scan-request|purge)/i); // (log text may say "Bitrix forced off")
  });
  test('checks first and starts only with --run; refuses on any problem before it connects', () => {
    expect(script).toContain("argv.includes('--run')");
    const order = ['runnerProblems(env)', 'verifyLiveIdentity', 'acquireSessionLock', 'app.listen'].map((s) => script.indexOf(s));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order.every((i) => i > -1)).toBe(true);
  });
  test('listens on loopback only, never on the development port, and releases the session lock on every exit path', () => {
    expect(script).toContain("app.listen(port, 'localhost'");
    expect(script).not.toMatch(/0\.0\.0\.0|app\.listen\(port\)/);
    expect((script.match(/release\(\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });
  test('prints status codes only: never a message, a stack, a key or a secret; never writes an env file', () => {
    expect(script).not.toMatch(/err\.message|\.stack|RAZORPAY_KEY|WEBHOOK_SECRET|process\.env\.[A-Z_]*SECRET/);
    expect(script).not.toMatch(/writeFile|appendFile|unlink|rmSync/);
  });
  test('the existing e2e server, worker and the guards are untouched by this tooling', () => {
    expect(read('scripts/e2e-server.js')).toContain('backend/.env.test');
    expect(read('scripts/e2e-env.js')).toContain('buildIsolatedEnv');
  });
});
