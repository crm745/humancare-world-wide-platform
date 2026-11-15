/* global describe, test, expect, jest, beforeEach, afterEach */
// The Prisma CLI isolation for the integration runner. No database, no Prisma command and no network: the child
// process is a fake `spawn` that records what it was given. Real folders are used only under the OS temp directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const isolation = require('../../src/common/safety/prisma-cli-isolation');
const guard = require('../../src/common/safety/integration-runner-guard');
const testGuard = require('../../src/common/safety/test-database-guard');

const GOOD_URL = 'mysql://humancare_test_app:secret@localhost:3306/humancare_test?connection_limit=20';
const goodEnv = (over = {}) => ({
  NODE_ENV: 'test', HUMANCARE_INTEGRATION_RUN: 'true', DATABASE_URL: GOOD_URL, EMAIL_PROVIDER: 'console', UPLOAD_DIR: '.e2e-uploads', ...over,
});
const SYSTEM = { PATH: '/bin', SystemRoot: 'C:\\Windows' };
const root = path.join(__dirname, '..', '..');

let sandbox; let fakeBackend; let spawn; let calls;
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-iso-test-'));
  // A stand-in backend folder, with env files in the places the real CLI would look. Nothing real is read.
  fakeBackend = path.join(sandbox, 'backend');
  fs.mkdirSync(path.join(fakeBackend, 'prisma', 'migrations', '20260101000000_first'), { recursive: true });
  fs.writeFileSync(path.join(fakeBackend, 'prisma', 'schema.prisma'), 'datasource db { provider = "mysql" url = env("DATABASE_URL") }');
  fs.writeFileSync(path.join(fakeBackend, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "mysql"');
  fs.writeFileSync(path.join(fakeBackend, 'prisma', 'migrations', '20260101000000_first', 'migration.sql'), 'SELECT 1;');
  fs.writeFileSync(path.join(fakeBackend, '.env'), 'FAKE_DEV_SECRET=dev');
  fs.writeFileSync(path.join(fakeBackend, 'prisma', '.env'), 'FAKE_DEV_SECRET=dev');
  fs.writeFileSync(path.join(fakeBackend, 'prisma', 'migrations', '.env.local'), 'FAKE_DEV_SECRET=dev');
  // The child runs from a stand-in too: the real CLI entry file is only resolved, never started.
  calls = [];
  spawn = jest.fn((command, args, options) => {
    calls.push({ command, args, options, stagedFiles: listFiles(options.cwd) });
    return { status: 0 };
  });
});
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]));
}
const run = (env = goodEnv(), extra = {}) => isolation.runPrismaMigrateStatus(env, { spawn, backendRoot: fakeBackend, cliRoot: root, tmpBase: sandbox, systemEnv: SYSTEM, ...extra });
const stagedDirs = () => fs.readdirSync(sandbox).filter((n) => n.startsWith('hc-prisma-cli-'));

describe('the child receives the explicitly constructed environment', () => {
  test('exactly the allow-list: OS basics, the validated DATABASE_URL and fixed switches', () => {
    run();
    expect(calls[0].options.env).toEqual({
      PATH: '/bin', SystemRoot: 'C:\\Windows', DATABASE_URL: GOOD_URL,
      CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', NODE_ENV: 'test', HUMANCARE_INTEGRATION_RUN: 'true',
    });
  });
  test('the environment is passed as given, not merged with process.env', () => {
    process.env.HC_ISO_TEST_LEAK = 'leak';
    try {
      run(goodEnv(), { systemEnv: { ...SYSTEM, HC_ISO_TEST_LEAK: 'leak' } });
      expect(calls[0].options.env).not.toHaveProperty('HC_ISO_TEST_LEAK');
      expect(Object.keys(calls[0].options.env).sort()).toEqual(['CHECKPOINT_DISABLE', 'DATABASE_URL', 'HUMANCARE_INTEGRATION_RUN', 'NODE_ENV', 'PATH', 'PRISMA_HIDE_UPDATE_MESSAGE', 'SystemRoot']);
    } finally { delete process.env.HC_ISO_TEST_LEAK; }
  });
});

describe('unapproved environment variables are not inherited', () => {
  const unapproved = {
    BITRIX24_WEBHOOK_URL: 'https://real.example/rest/1/TOKEN/', BITRIX_SYNC_ENABLED: 'true', BITRIX_INBOUND_APPLICATION_TOKEN: 'tok', SMTP_PASS: 'pw', JWT_ACCESS_SECRET: 'jwt',
    FIREBASE_SERVICE_ACCOUNT_PATH: 'x.json', NODE_OPTIONS: '--require ./evil.js', HTTP_PROXY: 'http://proxy', HTTPS_PROXY: 'http://proxy', PRISMA_QUERY_ENGINE_LIBRARY: 'x.dll',
    PRISMA_SCHEMA_ENGINE_BINARY: 'x.exe', DEBUG: '*', FAKE_DEV_SECRET: 'dev',
  };
  test('neither the runner\'s own environment nor the surrounding system environment leaks through', () => {
    run(goodEnv({ ...unapproved, HUMANCARE_INTEGRATION_ALLOW_BITRIX: 'true' }), { systemEnv: { ...SYSTEM, ...unapproved } });
    for (const key of Object.keys(unapproved)) expect(calls[0].options.env).not.toHaveProperty(key);
    expect(JSON.stringify(calls[0].options.env)).not.toMatch(/TOKEN|real\.example|evil|proxy|jwt|dev$/);
  });
  test('buildPrismaCliEnv returns a fresh object and never process.env itself', () => {
    const a = isolation.buildPrismaCliEnv(goodEnv(), SYSTEM);
    expect(a).not.toBe(process.env);
    a.DATABASE_URL = 'changed';
    expect(isolation.buildPrismaCliEnv(goodEnv(), SYSTEM).DATABASE_URL).toBe(GOOD_URL);
  });
});

describe('no .env can be loaded by the CLI', () => {
  test('it runs in a temporary copy: the working directory and schema are outside backend/, and contain no env file', () => {
    run();
    const { options, args, stagedFiles } = calls[0];
    expect(path.resolve(options.cwd).startsWith(path.resolve(sandbox, 'hc-prisma-cli-'))).toBe(true);
    expect(path.resolve(options.cwd).startsWith(path.resolve(fakeBackend))).toBe(false);
    expect(path.dirname(path.dirname(args[args.length - 1]))).toBe(options.cwd);
    expect(stagedFiles.sort()).toEqual([
      'prisma/migrations/20260101000000_first/migration.sql', 'prisma/migrations/migration_lock.toml', 'prisma/schema.prisma',
    ]);
    expect(stagedFiles.filter((f) => /(^|\/)\.env/.test(f))).toEqual([]);
  });
  test('the copy is removed afterwards, also when the child fails or cannot start', () => {
    run();
    expect(stagedDirs()).toEqual([]);
    spawn.mockImplementationOnce(() => { throw new Error('spawn failed'); });
    expect(() => run()).toThrow('spawn failed');
    expect(stagedDirs()).toEqual([]);
    spawn.mockImplementationOnce(() => ({ error: new Error('ENOENT') }));
    expect(() => run()).toThrow('ENOENT');
    expect(stagedDirs()).toEqual([]);
  });
  test('the real migrations are copied without env files (the real folder is only read)', () => {
    const staged = isolation.stageSchemaCopy({ tmpBase: sandbox });
    try {
      const files = listFiles(staged.dir);
      expect(files).toContain('prisma/schema.prisma');
      expect(files.some((f) => f.endsWith('migration_lock.toml'))).toBe(true);
      expect(files.filter((f) => /(^|\/)\.env/.test(f))).toEqual([]);
      expect(files.filter((f) => f.endsWith('migration.sql')).length).toBe(fs.readdirSync(path.join(root, 'prisma', 'migrations')).filter((n) => n !== 'migration_lock.toml').length);
    } finally { staged.cleanup(); }
  });
});

describe('the child is fixed to a read-only status call', () => {
  test('node + the CLI entry file, shell off, fixed arguments "migrate status --schema <copy>"', () => {
    run();
    const { command, args, options } = calls[0];
    expect(command).toBe(process.execPath);
    expect(args.slice(1, 3)).toEqual(['migrate', 'status']);
    expect(args[3]).toBe('--schema');
    expect(args).toHaveLength(5);
    expect(path.basename(path.dirname(args[0]))).toBe('build');
    expect(options).toMatchObject({ shell: false, stdio: 'inherit' });
    expect(args.join(' ')).not.toMatch(/deploy|reset|dev|push|execute|resolve|diff/);
    expect(isolation.STATUS_ARGS).toEqual(['migrate', 'status']);
  });
  test('the CLI entry is resolved from the project\'s own node_modules', () => {
    expect(require.resolve('prisma/build/index.js', { paths: [root] })).toContain(path.join('node_modules', 'prisma'));
  });
  test('the exit status is returned to the caller', () => {
    spawn.mockReturnValueOnce({ status: 1 });
    expect(run()).toBe(1);
  });
  test('the module offers no way to run another Prisma command', () => {
    expect(Object.keys(isolation).sort()).toEqual(['FIXED_ENV', 'STATUS_ARGS', 'SYSTEM_KEYS', 'buildPrismaCliEnv', 'runPrismaMigrateStatus', 'stageSchemaCopy']);
  });
});

describe('the target cannot change', () => {
  test.each([
    ['humancare_dev', 'mysql://humancare_test_app:p@localhost/humancare_dev'],
    ['a production-like name', 'mysql://humancare_test_app:p@localhost/humancare_prod'],
    ['production on a remote host', 'mysql://humancare_test_app:p@db.prod.example.com:3306/humancare'],
    ['the development user', 'mysql://humancare_app:p@localhost/humancare_test'],
    ['the root user', 'mysql://root:p@localhost/humancare_test'],
    ['an option that redirects the connection', 'mysql://humancare_test_app:p@localhost/humancare_test?socket=/tmp/other.sock'],
    ['a look-alike database', 'mysql://humancare_test_app:p@localhost/humancare_test_old'],
    ['no URL at all', ''],
  ])('%s: refused before anything is copied or started', (_name, url) => {
    expect(() => run(goodEnv({ DATABASE_URL: url }))).toThrow(/safety guard/);
    expect(spawn).not.toHaveBeenCalled();
    expect(stagedDirs()).toEqual([]);
  });
  test('without the explicit opt-in, or with a Bitrix switch on, it is refused too', () => {
    expect(() => run(goodEnv({ HUMANCARE_INTEGRATION_RUN: '' }))).toThrow(/safety guard/);
    expect(() => run(goodEnv({ BITRIX_SYNC_ENABLED: 'true' }))).toThrow(/safety guard/);
    expect(spawn).not.toHaveBeenCalled();
  });
  test('the only URL that reaches the child is the validated one', () => {
    run();
    expect(calls[0].options.env.DATABASE_URL).toBe(GOOD_URL);
  });
});

describe('the runner script and the ordinary Jest setup', () => {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  test('the runner script no longer starts the CLI through npx or a shell', () => {
    const source = read('scripts/integration-db.js');
    expect(source).not.toMatch(/npx|shell:\s*true|spawnSync|child_process/);
    expect(source).toContain("require('../src/common/safety/prisma-cli-isolation')");
  });
  test('the ordinary configuration, global setup and guards are unchanged', () => {
    const config = require('../../jest.config');
    expect(config).toMatchObject({ testEnvironment: 'node', globalSetup: './tests/global-setup.js', setupFiles: ['./tests/setup.js'], testTimeout: 15000 });
    expect(config.testMatch).toBeUndefined();
    expect(testGuard.TEST_DATABASE).toBe('humancare_test');
    expect(read('src/db/prisma.js')).toContain("if (process.env.NODE_ENV === 'test') assertTestDatabaseUrl(process.env.DATABASE_URL);");
    expect(read('tests/global-setup.js')).toContain('assertNoIntegrationSession();');
    expect(guard.SESSION_LOCK).toBe(require('../global-setup').INTEGRATION_LOCK);
  });
  test('the new module contains no statement that changes data or runs a Prisma command other than status', () => {
    const forbidden = /deleteMany|DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+(TABLE|DATABASE)|INSERT\s+INTO|\$executeRaw|migrate['",\s]+(deploy|reset|dev)|db['",\s]+push/i;
    expect(read('src/common/safety/prisma-cli-isolation.js')).not.toMatch(forbidden);
  });
});
