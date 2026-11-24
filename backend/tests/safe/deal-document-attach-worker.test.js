/* global describe, test, expect, jest, beforeEach */
// The one-time document attachment runner (src/deal-document-attach-worker.js): the sweep of the automatic sharing, narrowed to one Case's request, and ONE scoped pass of the
// existing document worker. Both services are mocks: the tests prove WHICH functions run, how often and with which scope, and that every refusal happens before anything runs.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/modules/bitrix/deal-document-worker.service', () => ({ runDealDocumentWorker: jest.fn(async () => ({ active: true, claimed: 2 })) }));
jest.mock('../../src/modules/bitrix/deal-document-auto-share', () => {
  const actual = jest.requireActual('../../src/modules/bitrix/deal-document-auto-share');
  return { ...actual, sweep: jest.fn(async () => ({ outcome: 'done', results: [{ documentId: 209, outcome: 'shared' }] })), adminProblem: jest.fn(async () => null) };
});

const fs = require('fs');
const path = require('path');
const shared = require('../../src/common/safety/single-stage-runner');
const worker = require('../../src/modules/bitrix/deal-document-worker.service');
const autoShare = require('../../src/modules/bitrix/deal-document-auto-share');

const ENV = {
  NODE_ENV: 'development', DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev', BITRIX_DEAL_PROFILE: 'actual',
  BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true',
  BITRIX24_WEBHOOK_URL: 'https://portal.example.bitrix24.in/rest/1/fakefake/', BITRIX_ALLOWED_PORTAL_HOST: 'portal.example.bitrix24.in',
  DOCUMENT_AUTO_SHARE: 'true', DOCUMENT_AUTO_SHARE_ADMIN_ID: '2',
};
let log; let prisma; let databaseName;
const stage = () => require('../../src/deal-document-attach-worker').loadStage();
const run = (argv, env = ENV) => shared.runStage(stage(), { argv, env, prisma, log });
const printed = () => [...log.log.mock.calls, ...log.error.mock.calls].map((c) => c.join(' ')).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  databaseName = 'humancare_dev';
  log = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  prisma = {
    $queryRaw: jest.fn(async () => [{ db: databaseName }]),
    case: { findMany: jest.fn(async () => [{ serviceRequestId: 210 }]) },
    requestDocument: { count: jest.fn(async () => 1) },
    bitrixDealDocument: { count: jest.fn(async () => 0) },
    integrationOutbox: { count: jest.fn(async () => 0) },
  };
  autoShare.adminProblem.mockResolvedValue(null);
});

describe('readiness (the default) runs nothing', () => {
  test('it validates, reports counts only, and neither shares nor attaches', async () => {
    expect(await run([])).toBe(0);
    expect(await run(['--readiness-only', '--case-id', '208'])).toBe(0);
    expect(autoShare.sweep).not.toHaveBeenCalled();
    expect(worker.runDealDocumentWorker).not.toHaveBeenCalled();
    expect(printed()).toMatch(/READY \(readiness only: nothing was run\)/);
    expect(printed()).toContain('"eligibleWithoutShare":1');
  });
});

describe('--once', () => {
  test('shares for the Case\'s request only, then runs ONE scoped worker pass for that Case only', async () => {
    expect(await run(['--once', '--case-id', '208'])).toBe(0);
    expect(autoShare.sweep).toHaveBeenCalledTimes(1);
    expect(autoShare.sweep).toHaveBeenCalledWith({ prisma, requestIds: [210] });
    expect(worker.runDealDocumentWorker).toHaveBeenCalledTimes(1);
    expect(worker.runDealDocumentWorker).toHaveBeenCalledWith({ scope: { caseIds: [208] } });
    expect(printed()).toContain('"shared":1');
    expect(printed()).toContain('"claimed":2');
  });
  test('without a Case id it is refused before anything is read', async () => {
    expect(await run(['--once'])).toBe(1);
    expect(printed()).toContain('scope_required');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(autoShare.sweep).not.toHaveBeenCalled();
    expect(worker.runDealDocumentWorker).not.toHaveBeenCalled();
  });
  test.each([
    [{ NODE_ENV: 'production' }, 'refused_in_production'], [{ NODE_ENV: 'test' }, 'node_env_test'],
    [{ DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }, 'database_not_humancare_dev'], [{ DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }, 'database_host_not_local'],
    [{ BITRIX_DEAL_PROFILE: undefined }, 'profile_not_actual'], [{ BITRIX_DEAL_PROFILE: 'test' }, 'profile_not_actual'],
    [{ BITRIX_SYNC_ENABLED: 'false' }, 'bitrix_configuration_invalid'], [{ PRIVATE_CHARTER_REVIEW_WORKFLOW: 'false' }, 'bitrix_configuration_invalid'], // the existing configuration check refuses these first
    [{ DOCUMENT_AUTO_SHARE: undefined }, 'switch_off'], [{ DOCUMENT_AUTO_SHARE_ADMIN_ID: undefined }, 'admin_id_missing_or_invalid'],
  ])('%j is refused (%s) and nothing runs', async (patch, code) => {
    expect(await run(['--once', '--case-id', '208'], { ...ENV, ...patch })).toBe(1);
    expect(printed()).toContain(code);
    expect(autoShare.sweep).not.toHaveBeenCalled();
    expect(worker.runDealDocumentWorker).not.toHaveBeenCalled();
  });
  test('the database SERVER must answer humancare_dev, and Admin 2 must be usable', async () => {
    databaseName = 'humancare_test';
    expect(await run(['--once', '--case-id', '208'])).toBe(1);
    expect(printed()).toContain('database_not_humancare_dev');
    databaseName = 'humancare_dev';
    autoShare.adminProblem.mockResolvedValue('admin_not_active');
    expect(await run(['--once', '--case-id', '208'])).toBe(1);
    expect(printed()).toContain('admin_not_active');
    expect(autoShare.sweep).not.toHaveBeenCalled();
    expect(worker.runDealDocumentWorker).not.toHaveBeenCalled();
  });
  test('a failure is a short code only (exit 2)', async () => {
    worker.runDealDocumentWorker.mockRejectedValueOnce(Object.assign(new Error('Access denied mysql://u:hunter2@localhost'), { code: 'P1001' }));
    expect(await run(['--once', '--case-id', '208'])).toBe(2);
    expect(printed()).toContain('failed: P1001');
    expect(printed()).not.toMatch(/hunter2|Access denied|mysql:/);
  });
});

describe('isolation', () => {
  const code = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  test('it requires no job list, no general worker, no timer, no Bitrix client of its own and no dotenv outside main', () => {
    const text = code('src/deal-document-attach-worker.js');
    for (const forbidden of [/jobs[\\/]index/, /require\('\.\/worker'\)/, /job-runner/, /setInterval|setTimeout/, /bitrix-deal\.api|updateDealFiles|getDeal/, /dotenv/]) expect({ hit: forbidden.test(text) }).toEqual({ hit: false });
    require('../../src/deal-document-attach-worker');
    const loaded = Object.keys(require.cache).map((k) => k.replace(/\\/g, '/'));
    expect(loaded.filter((k) => /\/src\/jobs\//.test(k))).toEqual([]);
    expect(loaded.filter((k) => /\/src\/worker\.js$/.test(k))).toEqual([]);
  });
});
