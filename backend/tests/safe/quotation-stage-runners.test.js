/* global describe, test, expect, jest, beforeEach */
// The three ONE-TIME quotation stage runners (sync, scan, auto-publish). Each service is a mock: the tests prove WHICH single function a runner calls, how
// many times, with which scope, and that every refusal happens before anything runs. No database, no network, no Bitrix, no ClamAV, no timers.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() }));
jest.mock('../../src/modules/bitrix/quotation-sync.service', () => ({ runQuotationSync: jest.fn(async () => ({ active: true, claimed: 1, results: [{ eventId: 5, outcome: 'created', quotationId: 9, versionNumber: 2, secret: 'https://leak.example/x' }] })) }));
jest.mock('../../src/modules/bitrix/quotation-scan.service', () => ({ sweepPendingQuotationScans: jest.fn(async () => ({ active: true, checked: 1, due: 1, results: [{ id: 9, outcome: 'clean' }] })) }));
jest.mock('../../src/modules/quotations/quotation-auto-publish.service', () => ({
  sweepQuotationAutoPublish: jest.fn(async () => ({ active: true, checked: 1, results: [{ id: 9, outcome: 'published' }] })),
  adminProblem: jest.fn(async () => null),
}));
jest.mock('../../src/integrations/clamav/clamav', () => ({ isReady: jest.fn(async () => true) }));

const fs = require('fs');
const path = require('path');
const sync = require('../../src/modules/bitrix/quotation-sync.service');
const scan = require('../../src/modules/bitrix/quotation-scan.service');
const publish = require('../../src/modules/quotations/quotation-auto-publish.service');
const clamav = require('../../src/integrations/clamav/clamav');
const shared = require('../../src/common/safety/single-stage-runner');

const RUNNERS = {
  sync: { file: 'src/quotation-sync-worker.js', service: sync, fn: 'runQuotationSync' },
  scan: { file: 'src/quotation-scan-worker.js', service: scan, fn: 'sweepPendingQuotationScans' },
  publish: { file: 'src/quotation-auto-publish-worker.js', service: publish, fn: 'sweepQuotationAutoPublish' },
};
const ENV = {
  NODE_ENV: 'development', DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev',
  BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true', BITRIX_DEAL_PROFILE: 'actual',
  BITRIX24_WEBHOOK_URL: 'https://portal.example.bitrix24.in/rest/1/fakefake/', BITRIX_ALLOWED_PORTAL_HOST: 'portal.example.bitrix24.in',
  QUOTATION_AUTO_PUBLISH: 'true', QUOTATION_AUTO_PUBLISH_FROM: '2029-12-01T00:00:00Z', QUOTATION_AUTO_PUBLISH_ADMIN_ID: '2',
};
let log; let prisma; let databaseName;
const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const code = (rel) => read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const stageOf = (name) => require(`../../${RUNNERS[name].file.replace(/\.js$/, '')}`).loadStage();
const run = (name, argv, env = ENV) => shared.runStage(stageOf(name), { argv, env, prisma, log });
const calls = () => Object.values(RUNNERS).map((r) => r.service[r.fn].mock.calls.length);
const printed = () => [...log.log.mock.calls, ...log.error.mock.calls].map((c) => c.join(' ')).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  databaseName = 'humancare_dev';
  log = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  prisma = {
    $queryRaw: jest.fn(async () => [{ db: databaseName }]),
    integrationOutbox: { count: jest.fn(async () => 1) },
    caseQuotation: { count: jest.fn(async () => 1) },
  };
  clamav.isReady.mockResolvedValue(true);
  publish.adminProblem.mockResolvedValue(null);
});

describe.each(Object.keys(RUNNERS))('the %s runner', (name) => {
  const { service, fn } = RUNNERS[name];

  test('with no flag it is readiness only: it validates, reports counts and runs nothing', async () => {
    expect(await run(name, [])).toBe(0);
    expect(await run(name, ['--readiness-only', '--case-id', '206'])).toBe(0);
    expect(calls()).toEqual([0, 0, 0]);
    expect(printed()).toMatch(/READY \(readiness only: nothing was run\)/);
  });

  test('--once --case-id runs exactly ONE pass of exactly ITS function, scoped to the given Cases, and no other stage', async () => {
    expect(await run(name, ['--once', '--case-id', '206', '--case-id', '207', '--case-id', '206'])).toBe(0);
    expect(service[fn]).toHaveBeenCalledTimes(1);
    const arg = service[fn].mock.calls[0][0];
    expect(JSON.stringify(arg)).toContain('[206,207]');
    expect(calls().reduce((a, b) => a + b, 0)).toBe(1); // none of the other two stages was called
  });

  test('--once without a scope is refused before anything runs', async () => {
    expect(await run(name, ['--once'])).toBe(1);
    expect(printed()).toMatch(/scope_required/);
    expect(calls()).toEqual([0, 0, 0]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  test.each([
    [['--once', '--case-id'], 'case_id_invalid'], [['--once', '--case-id', '0'], 'case_id_invalid'], [['--once', '--case-id', 'abc'], 'case_id_invalid'],
    [['--once', '--readiness-only', '--case-id', '1'], 'mode_repeated_or_conflicting'], [['--loop'], 'unknown_argument'], [['--once', '--case-id', '1', '--all'], 'unknown_argument'],
  ])('arguments %j are refused (%s)', async (argv, expected) => {
    expect(await run(name, argv)).toBe(1);
    expect(printed()).toContain(expected);
    expect(calls()).toEqual([0, 0, 0]);
  });

  test.each([
    [{ NODE_ENV: 'production' }, 'refused_in_production'],
    [{ NODE_ENV: 'test' }, 'node_env_test'],
    [{ DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }, 'database_not_humancare_dev'],
    [{ DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }, 'database_host_not_local'],
    [{ DATABASE_URL: undefined }, 'database_url_invalid'],
    [{ BITRIX_QUOTATION_SYNC_ENABLED: 'false' }, name === 'publish' ? 'quotation_sync_inactive' : 'quotation_sync_inactive'],
    [{ BITRIX_DEAL_PROFILE: undefined }, name === 'publish' ? 'profile_not_actual' : 'profile_not_configured'],
  ])('%j is refused (%s) and nothing runs', async (patch, expected) => {
    expect(await run(name, ['--once', '--case-id', '206'], { ...ENV, ...patch })).toBe(1);
    expect(printed()).toContain(expected);
    expect(calls()).toEqual([0, 0, 0]);
  });

  test('the database SERVER must confirm humancare_dev, not only the URL', async () => {
    databaseName = 'humancare_test';
    expect(await run(name, ['--once', '--case-id', '206'])).toBe(1);
    expect(printed()).toContain('database_not_humancare_dev');
    expect(calls()).toEqual([0, 0, 0]);
  });

  test('a failure of the stage is reported as a short code only, with exit code 2', async () => {
    service[fn].mockRejectedValueOnce(Object.assign(new Error('Access denied for user u@localhost using password YES, mysql://u:secret@localhost'), { name: 'PrismaClientKnownRequestError', code: 'P2002' }));
    expect(await run(name, ['--once', '--case-id', '206'])).toBe(2);
    expect(printed()).toContain('failed: P2002');
    expect(printed()).not.toMatch(/secret|Access denied|mysql:/);
  });
});

describe('what only some stages require', () => {
  test('the sync runner needs the Bitrix portal host to be allowed', async () => {
    expect(await run('sync', ['--once', '--case-id', '206'], { ...ENV, BITRIX_ALLOWED_PORTAL_HOST: 'other.example.bitrix24.in' })).toBe(1);
    expect(printed()).toContain('bitrix_configuration_invalid');
    expect(sync.runQuotationSync).not.toHaveBeenCalled();
  });
  test('the scan runner needs ClamAV to answer', async () => {
    clamav.isReady.mockResolvedValue(false);
    expect(await run('scan', ['--once', '--case-id', '206'])).toBe(1);
    expect(printed()).toContain('clamav_unavailable');
    expect(scan.sweepPendingQuotationScans).not.toHaveBeenCalled();
  });
  test('the auto-publish runner needs its own switch, cutoff, Admin and a usable Admin account', async () => {
    for (const [patch, expected] of [
      [{ QUOTATION_AUTO_PUBLISH: undefined }, 'switch_off'], [{ QUOTATION_AUTO_PUBLISH_FROM: undefined }, 'cutoff_missing_or_invalid'],
      [{ QUOTATION_AUTO_PUBLISH_ADMIN_ID: undefined }, 'admin_id_missing_or_invalid'], [{ BITRIX_DEAL_PROFILE: 'test' }, 'profile_not_actual'],
    ]) {
      expect(await run('publish', ['--once', '--case-id', '206'], { ...ENV, ...patch })).toBe(1);
      expect(printed()).toContain(expected);
    }
    publish.adminProblem.mockResolvedValue('admin_not_active');
    expect(await run('publish', ['--once', '--case-id', '206'])).toBe(1);
    expect(printed()).toContain('admin_not_active');
    expect(publish.sweepQuotationAutoPublish).not.toHaveBeenCalled();
  });
  test('the auto-publish pass is limited to the given Cases (and Admin 2 is re-verified through the service)', async () => {
    expect(await run('publish', ['--once', '--case-id', '206'])).toBe(0);
    expect(publish.adminProblem).toHaveBeenCalledWith(expect.objectContaining({ prisma }), 2);
    expect(publish.sweepQuotationAutoPublish).toHaveBeenCalledWith({ caseIds: [206] });
  });
});

describe('output safety', () => {
  test('only identifier-shaped values and an allow-list of result keys are printed', async () => {
    expect(await run('sync', ['--once', '--case-id', '206'])).toBe(0);
    const out = printed();
    expect(out).toContain('"outcome":"created"');
    expect(out).toContain('"quotationId":9');
    expect(out).not.toContain('leak.example');
    expect(shared.summarize({ a: 'has space', b: 'https://x', c: 3, d: true, e: 'ok_code', results: [{ id: 1, outcome: 'x y', other: 'z' }] })).toEqual({ c: 3, d: true, e: 'ok_code', results: [{ id: 1 }] });
  });
  test('the readiness report never prints the Admin or Bitrix configuration values', async () => {
    await run('publish', []);
    await run('sync', []);
    expect(printed()).not.toMatch(/fakefake|portal\.example|mysql:/);
  });
});

describe('isolation: nothing else can start', () => {
  const SOURCES = [...Object.values(RUNNERS).map((r) => r.file), 'src/common/safety/single-stage-runner.js'];
  test('no runner or the shared body requires the job list, the general worker, a job runner or a timer', () => {
    for (const file of SOURCES) {
      const text = code(file);
      for (const forbidden of [/jobs[\\/]index/, /require\(['"]\.\/worker['"]\)/, /job-runner/, /createJobRunner/, /setInterval/, /setTimeout/, /\.job['"]\)/, /payment|razorpay|invoice/i]) {
        expect({ file, hit: forbidden.test(text) }).toEqual({ file, hit: false });
      }
    }
  });
  test('each runner requires only its own stage service', () => {
    expect(code(RUNNERS.sync.file)).toMatch(/quotation-sync\.service/);
    expect(code(RUNNERS.sync.file)).not.toMatch(/quotation-scan\.service|quotation-auto-publish\.service/);
    expect(code(RUNNERS.scan.file)).toMatch(/quotation-scan\.service/);
    expect(code(RUNNERS.scan.file)).not.toMatch(/quotation-sync\.service|quotation-auto-publish\.service/);
    expect(code(RUNNERS.publish.file)).toMatch(/quotation-auto-publish\.service/);
    expect(code(RUNNERS.publish.file)).not.toMatch(/quotation-sync\.service|quotation-scan\.service/);
  });
  test('requiring a runner loads no job file, no job list and no worker, and starts nothing', () => {
    for (const r of Object.values(RUNNERS)) require(`../../${r.file.replace(/\.js$/, '')}`);
    const loaded = Object.keys(require.cache).map((k) => k.replace(/\\/g, '/'));
    expect(loaded.filter((k) => /\/src\/jobs\//.test(k))).toEqual([]);
    expect(loaded.filter((k) => /\/src\/worker\.js$/.test(k))).toEqual([]);
    expect(calls()).toEqual([0, 0, 0]);
  });
  test('dotenv is loaded only inside main(), never when a runner is required', () => {
    expect(code('src/common/safety/single-stage-runner.js')).toMatch(/async function main[\s\S]*dotenv/);
    expect(code('src/common/safety/single-stage-runner.js').split('async function main')[0]).not.toMatch(/dotenv/);
    for (const r of Object.values(RUNNERS)) expect(code(r.file)).not.toMatch(/dotenv/);
  });
});
