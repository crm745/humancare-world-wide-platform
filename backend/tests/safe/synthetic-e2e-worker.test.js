/* global describe, test, expect, jest */
// src/synthetic-e2e-worker.js: the dedicated, isolated worker for the synthetic E2E approval workflow.
// No database, no network, no process started: requiring the module only registers its exports (main() runs
// only when the file is executed directly - see its `require.main === module` guard), and the entrypoint script
// itself is also checked statically, the same way scripts/e2e-payments-runner.js is checked in
// tests/safe/payments-e2e-tooling.test.js.
//
// Prisma, ClamAV and the upload directory are mocked purely so that requiring the scan-request-documents job (a
// transitive require of the worker module) never touches a real database, network or the shared uploads folder;
// the job's own behaviour is already covered by its existing tests and is not re-tested here.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const fs = require('fs');
const path = require('path');
const scanRequestDocumentsJob = require('../../src/jobs/scan-request-documents.job');
const worker = require('../../src/synthetic-e2e-worker');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\/.*$/gm, '');

const GOOD_ENV = {
  SYNTHETIC_E2E_AUTO_APPROVE: 'true',
  SYNTHETIC_E2E_SECRET: 'x'.repeat(32),
  NODE_ENV: 'development',
  DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev',
};

describe('the job list', () => {
  test('schedules only the existing scan-request-documents job, unchanged', () => {
    expect(worker.JOBS).toHaveLength(1);
    expect(worker.JOBS[0]).toBe(scanRequestDocumentsJob);
    expect(worker.JOBS[0].name).toBe('scan-request-documents');
  });
  test('that job still runs on startup and every 60 seconds (unchanged schedule)', () => {
    expect(worker.JOBS[0].runOnStart).toBe(true);
    expect(worker.JOBS[0].intervalMs).toBe(60 * 1000);
  });
});

describe('configurationProblems (pure, no I/O)', () => {
  test('a fully configured, non-production, humancare_dev environment has no problems', () => {
    expect(worker.configurationProblems(GOOD_ENV)).toEqual([]);
  });
  test.each([
    ['the switch is off', { SYNTHETIC_E2E_AUTO_APPROVE: 'false' }, 'auto_approve_disabled'],
    ['the switch is missing', { SYNTHETIC_E2E_AUTO_APPROVE: undefined }, 'auto_approve_disabled'],
    ['the switch is not exactly "true"', { SYNTHETIC_E2E_AUTO_APPROVE: '1' }, 'auto_approve_disabled'],
    ['production', { NODE_ENV: 'production' }, 'production_refused'],
    ['no secret', { SYNTHETIC_E2E_SECRET: undefined }, 'secret_missing'],
    ['a too-short secret', { SYNTHETIC_E2E_SECRET: 'short' }, 'secret_missing'],
    ['the URL names humancare_test', { DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }, 'database_not_identified'],
    ['the URL names another database', { DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_prod' }, 'database_not_identified'],
    ['the URL is on a remote host', { DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }, 'database_not_identified'],
    ['the URL is missing', { DATABASE_URL: undefined }, 'database_not_identified'],
  ])('%s -> %s', (_label, over, expected) => {
    expect(worker.configurationProblems({ ...GOOD_ENV, ...over })).toContain(expected);
  });
  test('every problem is reported together, in one pass', () => {
    expect(worker.configurationProblems({ NODE_ENV: 'production' })).toEqual(
      expect.arrayContaining(['auto_approve_disabled', 'production_refused', 'secret_missing', 'database_not_identified']),
    );
  });
});

describe('confirmDatabase (needs only a fake prisma)', () => {
  test('true only when the server itself reports humancare_dev', async () => {
    const prisma = { $queryRaw: jest.fn(async () => [{ db: 'humancare_dev' }]) };
    expect(await worker.confirmDatabase(prisma)).toBe(true);
  });
  test.each([
    ['another database', [{ db: 'humancare_test' }]],
    ['no rows', []],
    ['a falsy row', [null]],
  ])('false when the server reports %s', async (_label, rows) => {
    const prisma = { $queryRaw: jest.fn(async () => rows) };
    expect(await worker.confirmDatabase(prisma)).toBe(false);
  });
  test('false when the query rejects (never throws)', async () => {
    const prisma = { $queryRaw: jest.fn(async () => { throw new Error('connection refused'); }) };
    expect(await worker.confirmDatabase(prisma)).toBe(false);
  });
});

describe('assertSafeToRun (fails closed)', () => {
  test('resolves when every check passes, including the live database confirmation', async () => {
    const prisma = { $queryRaw: jest.fn(async () => [{ db: 'humancare_dev' }]) };
    await expect(worker.assertSafeToRun(prisma, GOOD_ENV)).resolves.toBeUndefined();
  });
  test('rejects (and never queries the database) when a pure configuration check already fails', async () => {
    const prisma = { $queryRaw: jest.fn(async () => [{ db: 'humancare_dev' }]) };
    await expect(worker.assertSafeToRun(prisma, { ...GOOD_ENV, SYNTHETIC_E2E_AUTO_APPROVE: 'false' }))
      .rejects.toMatchObject({ problems: ['auto_approve_disabled'] });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  test('rejects when the pure checks pass but the live database is not confirmed as humancare_dev', async () => {
    const prisma = { $queryRaw: jest.fn(async () => [{ db: 'humancare_test' }]) };
    await expect(worker.assertSafeToRun(prisma, GOOD_ENV)).rejects.toMatchObject({ problems: ['database_not_identified'] });
  });
  test('rejects when the database query itself fails', async () => {
    const prisma = { $queryRaw: jest.fn(async () => { throw new Error('down'); }) };
    await expect(worker.assertSafeToRun(prisma, GOOD_ENV)).rejects.toMatchObject({ problems: ['database_not_identified'] });
  });
});

describe('entrypoint script (static)', () => {
  const script = code('src/synthetic-e2e-worker.js');

  test('never requires src/worker.js, and never requires the full job list (src/jobs/index.js)', () => {
    expect(script).not.toMatch(/require\(['"]\.\/worker['"]\)/);
    expect(script).not.toMatch(/require\(['"]\.\/jobs['"]\)/);
    expect(script).not.toMatch(/require\(['"]\.\/jobs\/index['"]\)/);
  });
  test('requires only the scan-request-documents job: no Bitrix, payment, invoice, quotation or purge job is ever named', () => {
    expect(script).toMatch(/require\(['"]\.\/jobs\/scan-request-documents\.job['"]\)/);
    expect(script).not.toMatch(/require\(['"]\.\/jobs\/[^'"]+\.job['"]\)(?<!scan-request-documents\.job'\))/);
    const jobRequires = [...script.matchAll(/require\(['"]\.\/jobs\/([^'"]+)\.job['"]\)/g)].map((m) => m[1]);
    expect(jobRequires).toEqual(['scan-request-documents']);
    expect(script).not.toMatch(/bitrix|payment-order-recovery|razorpay|invoice-from-quotation|scan-case-quotations|security-log-purge|admin-audit-purge/i);
  });
  test('schedules jobs via the existing, unmodified job runner', () => {
    expect(script).toMatch(/require\(['"]\.\/jobs\/job-runner['"]\)/);
    expect(script).toMatch(/createJobRunner\(JOBS\)/);
  });
  test('fails closed before scheduling anything: the safety assertion runs before createJobRunner', () => {
    expect(script.indexOf('assertSafeToRun(')).toBeGreaterThan(-1);
    expect(script.indexOf('assertSafeToRun(')).toBeLessThan(script.indexOf('createJobRunner(JOBS)'));
  });
  test('a failed safety check exits the process with a non-zero code and never calls runner.start()', () => {
    const body = script.slice(script.indexOf('async function main'));
    const catchBlock = body.slice(0, body.indexOf('const runner = createJobRunner'));
    // main() takes an injectable `exit` (readiness-only mode and tests); its default is the real process.exit, and a failed check calls it with 1.
    expect(catchBlock).toMatch(/\bexit\(1\)/);
    expect(catchBlock).toMatch(/process\.exit\(code\)/);
    expect(catchBlock).not.toMatch(/runner\.start/);
  });
  test('handles SIGTERM and SIGINT for a graceful shutdown that stops the runner and disconnects prisma', () => {
    expect(script).toMatch(/process\.on\(['"]SIGTERM['"]/);
    expect(script).toMatch(/process\.on\(['"]SIGINT['"]/);
    expect(script).toMatch(/runner\.stop\(\)/);
    expect(script).toMatch(/prisma\.\$disconnect\(\)/);
  });
  test('main() only runs when the file is executed directly, so requiring it in a test starts nothing', () => {
    expect(script).toMatch(/if \(require\.main === module\)/);
  });
});
