/* global describe, test, expect, jest, beforeEach, afterEach */
// The integration runner's guard. No database and no network: Prisma is a fake, the lock file lives in a temp
// folder, and nothing here reads backend/.env or backend/.env.test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('../../src/common/safety/integration-runner-guard');
const testGuard = require('../../src/common/safety/test-database-guard');

const GOOD_URL = 'mysql://humancare_test_app:secret@localhost:3306/humancare_test?connection_limit=20';
const goodEnv = (over = {}) => ({
  NODE_ENV: 'test', HUMANCARE_INTEGRATION_RUN: 'true', DATABASE_URL: GOOD_URL, EMAIL_PROVIDER: 'console', UPLOAD_DIR: '.e2e-uploads', ...over,
});
const refused = (fn) => { try { fn(); } catch (err) { return err; } return null; };

describe('explicit opt-in', () => {
  test.each([[undefined], [''], ['TRUE'], ['1'], ['yes'], [' true']])('HUMANCARE_INTEGRATION_RUN=%p is refused', (value) => {
    expect(refused(() => guard.assertOptIn({ HUMANCARE_INTEGRATION_RUN: value }))).toBeInstanceOf(guard.IntegrationRunnerGuardError);
    expect(refused(() => guard.assertIntegrationEnvironment(goodEnv({ HUMANCARE_INTEGRATION_RUN: value })))).not.toBeNull();
  });
  test('"true" passes', () => {
    expect(guard.assertIntegrationEnvironment(goodEnv())).toMatchObject({ database: 'humancare_test', user: 'humancare_test_app', host: 'localhost' });
  });
});

describe('the exact database', () => {
  test.each([
    ['humancare_dev', 'mysql://humancare_test_app:p@localhost:3306/humancare_dev'],
    ['humancare', 'mysql://humancare_test_app:p@localhost/humancare'],
    ['a production-like name', 'mysql://humancare_test_app:p@localhost/humancare_prod'],
    ['a look-alike', 'mysql://humancare_test_app:p@localhost/humancare_test2'],
    ['the (abandoned) integration name', 'mysql://humancare_test_app:p@localhost/humancare_integration_test'],
    ['no database', 'mysql://humancare_test_app:p@localhost'],
    ['a remote host', 'mysql://humancare_test_app:p@db.example.com:3306/humancare_test'],
    ['a LAN address', 'mysql://humancare_test_app:p@10.0.0.5/humancare_test'],
    ['the root user', 'mysql://root:p@localhost/humancare_test'],
    ['the development user', 'mysql://humancare_app:p@localhost/humancare_test'],
    ['an unexpected option', 'mysql://humancare_test_app:p@localhost/humancare_test?socket=/tmp/x'],
    ['another protocol', 'postgresql://humancare_test_app:p@localhost/humancare_test'],
    ['no URL', ''],
    ['garbage', 'not a url'],
  ])('%s is refused before any connection', (_name, url) => {
    expect(refused(() => guard.assertIntegrationEnvironment(goodEnv({ DATABASE_URL: url })))).not.toBeNull();
  });
  test('messages never contain the URL, a user or a password', () => {
    const err = refused(() => guard.assertIntegrationEnvironment(goodEnv({ DATABASE_URL: 'mysql://root:hunter2@db.example.com/humancare_dev' })));
    expect(err.message).not.toMatch(/hunter2|root|db\.example\.com/);
  });
});

describe('environment', () => {
  test.each([
    ['NODE_ENV not test', { NODE_ENV: 'development' }],
    ['mail to a real server', { EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com' }],
    ['an unknown mail provider', { EMAIL_PROVIDER: 'sendgrid' }],
    ['the shared uploads folder', { UPLOAD_DIR: 'uploads' }],
    ['no uploads setting', { UPLOAD_DIR: '' }],
  ])('%s is refused (the ordinary test rules still apply)', (_name, over) => {
    expect(refused(() => guard.assertIntegrationEnvironment(goodEnv(over)))).not.toBeNull();
  });
  test('Bitrix switches stay off unless explicitly allowed', () => {
    for (const key of ['BITRIX_SYNC_ENABLED', 'BITRIX_PRIVATE_CHARTER_DEAL_ENABLED']) {
      expect(refused(() => guard.assertIntegrationEnvironment(goodEnv({ [key]: 'true' })))).not.toBeNull();
      expect(refused(() => guard.assertIntegrationEnvironment(goodEnv({ [key]: 'true', HUMANCARE_INTEGRATION_ALLOW_BITRIX: 'true' })))).toBeNull();
    }
    expect(refused(() => guard.assertIntegrationEnvironment(goodEnv({ BITRIX_SYNC_ENABLED: 'false' })))).toBeNull();
  });
});

describe('building the isolated environment', () => {
  const file = { DATABASE_URL: GOOD_URL, UPLOAD_DIR: '.e2e-uploads', EMAIL_PROVIDER: 'console', JWT_ACCESS_SECRET: 'fake' };
  const system = { PATH: '/bin', DATABASE_URL: 'mysql://dev:dev@localhost/humancare_dev', BITRIX24_WEBHOOK_URL: 'https://real.example/rest/', HUMANCARE_INTEGRATION_RUN: 'true' };

  test('uses the test file only: nothing from the surrounding environment leaks in, other known keys are blanked', () => {
    const env = guard.buildIntegrationEnv(file, { systemEnv: system, knownKeys: new Set(['BITRIX24_WEBHOOK_URL', 'SMTP_PASS', 'JWT_ACCESS_SECRET', 'DATABASE_URL']) });
    expect(env.DATABASE_URL).toBe(GOOD_URL);
    expect(env.BITRIX24_WEBHOOK_URL).toBe('');
    expect(env.SMTP_PASS).toBe('');
    expect(env.JWT_ACCESS_SECRET).toBe('fake');
    expect(env).toMatchObject({ NODE_ENV: 'test', HUMANCARE_INTEGRATION_RUN: 'true', PATH: '/bin' });
  });
  test('without the opt-in in the surrounding environment, it refuses', () => {
    expect(refused(() => guard.buildIntegrationEnv(file, { systemEnv: { PATH: '/bin' }, knownKeys: new Set() }))).not.toBeNull();
  });
  test('a file that names another database is refused', () => {
    expect(refused(() => guard.buildIntegrationEnv({ ...file, DATABASE_URL: 'mysql://humancare_test_app:p@localhost/humancare_dev' }, { systemEnv: system, knownKeys: new Set() }))).not.toBeNull();
  });
  test('the known keys come from the source code, not from any env file', () => {
    const names = guard.collectEnvKeyNames();
    for (const key of ['DATABASE_URL', 'BITRIX24_WEBHOOK_URL', 'BITRIX_SYNC_ENABLED', 'BITRIX_INBOUND_APPLICATION_TOKEN', 'JWT_ACCESS_SECRET']) expect(names.has(key)).toBe(true);
  });
});

describe('privileges confined to humancare_test', () => {
  const user = "TO `humancare_test_app`@`localhost`";
  const ok = [`GRANT USAGE ON *.* ${user}`, `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES ON \`humancare_test\`.* ${user}`];
  test('the expected shapes pass', () => {
    expect(refused(() => guard.assertGrantsConfined(ok))).toBeNull();
    expect(refused(() => guard.assertGrantsConfined([ok[0], `GRANT ALL PRIVILEGES ON \`humancare\\_test\`.* ${user}`]))).toBeNull(); // \_ escaped
  });
  test.each([
    ['a global privilege', [`GRANT SELECT ON *.* ${"TO `u`@`localhost`"}`]],
    ['ALL on everything', [`GRANT ALL PRIVILEGES ON *.* ${user}`]],
    ['another database', [ok[0], ok[1], `GRANT SELECT ON \`humancare_dev\`.* ${user}`]],
    ['a wildcard database', [ok[0], `GRANT SELECT ON \`humancare%\`.* ${user}`]],
    ['a table of the dev database', [ok[0], `GRANT SELECT ON \`humancare_dev\`.\`users\` ${user}`]],
    ['GRANT OPTION', [ok[0], `${ok[1]} WITH GRANT OPTION`]],
    ['a role', [ok[0], ok[1], 'GRANT `admin_role`@`%` TO `humancare_test_app`@`localhost`']],
    ['no privilege on the test database', [ok[0]]],
    ['nothing at all', []],
  ])('%s is refused', (_name, lines) => {
    expect(refused(() => guard.assertGrantsConfined(lines))).toBeInstanceOf(guard.IntegrationRunnerGuardError);
  });
});

describe('live identity (a fake server)', () => {
  const grants = ["GRANT USAGE ON *.* TO `humancare_test_app`@`localhost`", "GRANT SELECT, INSERT, UPDATE, DELETE ON `humancare_test`.* TO `humancare_test_app`@`localhost`"];
  const server = (over = {}) => {
    const facts = { db: 'humancare_test', account: 'humancare_test_app@localhost', port: 3306, role: 'NONE', grants, ...over };
    return {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (/DATABASE\(\)/.test(sql)) return [{ db: facts.db, account: facts.account }];
        if (/@@port/.test(sql)) return [{ port: facts.port, role: facts.role }];
        if (/SHOW GRANTS/.test(sql)) return facts.grants.map((g) => ({ g }));
        throw new Error(`unexpected ${sql}`);
      }),
    };
  };
  test('the right server state passes', async () => {
    expect(await guard.verifyLiveIdentity(server(), { expectedPort: '3306' })).toEqual({ database: 'humancare_test', account: 'humancare_test_app@localhost' });
  });
  test.each([
    ['another database', { db: 'humancare_dev' }],
    ['the integration name', { db: 'humancare_integration_test' }],
    ['no database selected', { db: null }],
    ['a non-test account', { account: 'root@localhost' }],
    ['an account allowed from anywhere', { account: 'humancare_test_app@%' }],
    ['another port', { port: 3307 }],
    ['an active role', { role: '`reader`@`%`' }],
    ['privileges beyond the test database', { grants: [...grants, 'GRANT SELECT ON `humancare_dev`.* TO `humancare_test_app`@`localhost`'] }],
  ])('%s is refused', async (_name, over) => {
    await expect(guard.verifyLiveIdentity(server(over), { expectedPort: '3306' })).rejects.toThrow(/safety guard/);
  });
  test('a failing server is a refusal, never a pass', async () => {
    await expect(guard.verifyLiveIdentity({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('down')) })).rejects.toThrow(/safety guard/);
  });
  test('other sessions on humancare_test are refused; our own and other databases are not counted', async () => {
    const db = (rows) => ({ $queryRawUnsafe: jest.fn(async (sql) => (/CONNECTION_ID/.test(sql) ? [{ id: 10 }] : rows)) });
    await expect(guard.assertNoOtherSessions(db([{ Id: 10, Db: 'humancare_test' }, { Id: 11, Db: 'humancare_dev' }, { Id: 12, Db: null }]))).resolves.toBeUndefined();
    await expect(guard.assertNoOtherSessions(db([{ Id: 10, Db: 'humancare_test' }, { Id: 11, Db: 'humancare_test' }]))).rejects.toThrow(/other session/);
    await expect(guard.assertNoOtherSessions({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('x')) })).rejects.toThrow(/safety guard/);
  });
});

describe('session lock (shared with the ordinary Jest global setup)', () => {
  let dir; let lockFile;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-lock-')); lockFile = path.join(dir, '.integration-session.lock'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('the lock is exactly the file tests/global-setup.js refuses to run beside', () => {
    const defaultSetup = require('../global-setup');
    expect(guard.SESSION_LOCK).toBe(defaultSetup.INTEGRATION_LOCK);
    expect(refused(() => defaultSetup.assertNoIntegrationSession(lockFile))).toBeNull();
    const release = guard.acquireSessionLock({ lockFile });
    expect(refused(() => defaultSetup.assertNoIntegrationSession(lockFile))).toBeInstanceOf(Error); // the wiping setup would stop
    release();
    expect(refused(() => defaultSetup.assertNoIntegrationSession(lockFile))).toBeNull();
  });
  test('a second run is refused while the first holds it, and the message names the holder', () => {
    const release = guard.acquireSessionLock({ lockFile, pid: 4242 });
    const err = refused(() => guard.acquireSessionLock({ lockFile, pid: 99 }));
    expect(err.message).toMatch(/pid 4242/);
    expect(fs.existsSync(lockFile)).toBe(true);
    release();
    expect(fs.existsSync(lockFile)).toBe(false);
    guard.acquireSessionLock({ lockFile, pid: 99 })();
  });
  test('a hand-made (manual session) lock is respected and never removed', () => {
    fs.writeFileSync(lockFile, '');
    expect(refused(() => guard.acquireSessionLock({ lockFile }))).toBeInstanceOf(guard.IntegrationRunnerGuardError);
    expect(fs.existsSync(lockFile)).toBe(true);
  });
  test('release removes only its own lock, and only once', () => {
    const release = guard.acquireSessionLock({ lockFile, pid: 1 });
    fs.writeFileSync(lockFile, JSON.stringify({ holder: 'someone-else', pid: 2, since: 'x' }));
    release();
    expect(fs.existsSync(lockFile)).toBe(true);
  });
  test('concurrent acquisition: exactly one wins', () => {
    const results = Array.from({ length: 5 }, (_, i) => refused(() => guard.acquireSessionLock({ lockFile, pid: 100 + i })));
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });
});

describe('the ordinary Jest setup is untouched, and the integration setup cannot change data', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  test('the ordinary configuration still has its global setup, and still ignores *.integration.js', () => {
    const config = require('../../jest.config');
    expect(config.globalSetup).toBe('./tests/global-setup.js');
    expect(config.testMatch).toBeUndefined(); // Jest's default pattern is *.test.js / *.spec.js
    expect(/\.(test|spec)\.js$/.test('database-identity.integration.js')).toBe(false);
  });
  test('the ordinary guard still accepts only humancare_test and refuses the integration runner\'s flag as a reason to relax', () => {
    expect(testGuard.TEST_DATABASE).toBe('humancare_test');
    expect(refused(() => testGuard.assertTestDatabaseUrl('mysql://humancare_test_app:p@localhost/humancare_dev'))).not.toBeNull();
    expect(refused(() => testGuard.assertTestDatabaseUrl(GOOD_URL))).toBeNull();
  });
  test('src/db/prisma.js is as before: only the ordinary guard, no integration branch', () => {
    const source = read('src/db/prisma.js');
    expect(source).toContain("if (process.env.NODE_ENV === 'test') assertTestDatabaseUrl(process.env.DATABASE_URL);");
    expect(source).not.toMatch(/INTEGRATION/i);
  });
  test('the integration configuration has no wiping setup and matches only *.integration.js', () => {
    const config = require('../../jest.integration.config');
    expect(config.globalSetup).toBe('<rootDir>/tests/integration/global-setup.js');
    expect(config.globalSetup).not.toMatch(/tests\/global-setup/);
    expect(config.testMatch).toEqual(['<rootDir>/tests/integration/**/*.integration.js']);
    expect(config.maxWorkers).toBe(1);
  });
  test('the synthetic-data test files (Phase 2B) can never delete broadly: no deleteMany, truncate, drop or schema statement; every DELETE is one exact id', () => {
    const files = fs.readdirSync(path.join(root, 'tests', 'integration')).filter((f) => f.endsWith('.integration.js') && f !== 'database-identity.integration.js').map((f) => `tests/integration/${f}`)
      .concat(fs.readdirSync(path.join(root, 'tests', 'integration', 'helpers')).map((f) => `tests/integration/helpers/${f}`));
    const never = /deleteMany|\.delete\(|TRUNCATE|DROP\s+(TABLE|DATABASE)|ALTER\s+TABLE|CREATE\s+TABLE|migrate\s+(deploy|reset|dev)|db\s+push/i;
    for (const file of files) {
      const source = read(file);
      expect({ file, hit: (source.match(never) || [null])[0] }).toEqual({ file, hit: null });
      for (const match of source.matchAll(/DELETE\s+FROM\s+[a-z_]+\s+(\w+)\s+(\w+)\s*=/gi)) expect({ file, clause: match[1].toUpperCase(), column: match[2] }).toEqual({ file, clause: 'WHERE', column: 'id' });
      expect(source.match(/DELETE\s+FROM/gi) || []).toHaveLength((source.match(/DELETE\s+FROM\s+[a-z_]+\s+WHERE\s+id\s*=\s*\$\{id\}/gi) || []).length);
    }
  });
  test('the runner infrastructure contains no statement that deletes, truncates, drops, seeds or migrates', () => {
    const files = ['jest.integration.config.js', 'scripts/integration-db.js', 'src/common/safety/integration-runner-guard.js',
      'tests/integration/global-setup.js', 'tests/integration/global-teardown.js', 'tests/integration/setup.js', 'tests/integration/database-identity.integration.js'];
    const forbidden = /deleteMany|updateMany|createMany|\.create\(|\.update\(|\.delete\(|\.upsert\(|DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+(TABLE|DATABASE)|INSERT\s+INTO|\$executeRaw|migrate\s+(deploy|reset|dev)|db\s+push|rmSync\(path/i;
    for (const file of files) expect({ file, hit: (read(file).match(forbidden) || [null])[0] }).toEqual({ file, hit: null });
  });
  test('the integration script has no command that changes data', () => {
    expect(require('../../scripts/integration-db').COMMANDS).toEqual(['verify', 'status', 'inventory']);
  });
});
