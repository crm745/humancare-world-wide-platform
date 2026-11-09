// The test-environment safety guard. Pure unit tests: no database, no network, no files written. The
// only "client" is a stub, and the one test that builds a Prisma client does so lazily (Prisma never
// connects until the first query).
const path = require('path');
const {
  assertTestDatabaseUrl,
  verifyLiveDatabase,
  assertSafeTestEnvironment,
  resolveTestUploadsDir,
  TestDatabaseGuardError,
  TEST_UPLOADS_DIR,
  BACKEND_ROOT,
} = require('../src/common/safety/test-database-guard');

const GOOD = 'mysql://humancare_test_app:SECRETPW@localhost:3306/humancare_test?connection_limit=20';
const withUrl = (patch) => GOOD.replace(patch[0], patch[1]);

const rejects = (fn) => {
  let error;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(TestDatabaseGuardError);
  // No message may carry the password, the host, the account or the URL.
  expect(error.message).not.toMatch(/SECRETPW|humancare_test_app|@localhost|:3306|user:|password/i);
  return error;
};

describe('assertTestDatabaseUrl', () => {
  it('accepts the canonical local test URL and reports it without the password', () => {
    expect(assertTestDatabaseUrl(GOOD)).toEqual({ host: 'localhost', port: '3306', database: 'humancare_test', user: 'humancare_test_app' });
    expect(JSON.stringify(assertTestDatabaseUrl(GOOD))).not.toContain('SECRETPW');
  });

  it.each([
    ['127.0.0.1', 'mysql://humancare_test_app:p@127.0.0.1:3306/humancare_test'],
    ['IPv6 loopback', 'mysql://humancare_test_app:p@[::1]:3306/humancare_test'],
    ['no port', 'mysql://humancare_test_app:p@localhost/humancare_test'],
    ['another test user', 'mysql://humancare_test_ci:p@localhost:3306/humancare_test'],
    ['an allowed option', 'mysql://humancare_test_app:p@localhost/humancare_test?connection_limit=5&pool_timeout=10&connect_timeout=5'],
  ])('accepts %s', (_label, url) => {
    expect(() => assertTestDatabaseUrl(url)).not.toThrow();
  });

  it.each([
    ['the development database', 'mysql://humancare_test_app:p@localhost:3306/humancare_dev'],
    ['another database', 'mysql://humancare_test_app:p@localhost:3306/mysql'],
    ['a look-alike database (suffix)', 'mysql://humancare_test_app:p@localhost:3306/humancare_test2'],
    ['a look-alike database (prefix)', 'mysql://humancare_test_app:p@localhost:3306/xhumancare_test'],
    ['a different-case database', 'mysql://humancare_test_app:p@localhost:3306/HUMANCARE_TEST'],
    ['no database', 'mysql://humancare_test_app:p@localhost:3306/'],
    ['an extra path segment', 'mysql://humancare_test_app:p@localhost:3306/humancare_test/other'],
    ['a trailing path segment trick', 'mysql://humancare_test_app:p@localhost:3306/humancare_dev/humancare_test'],
    ['the development user', 'mysql://humancare_app:p@localhost:3306/humancare_test'],
    ['no user', 'mysql://localhost:3306/humancare_test'],
    ['root', 'mysql://root:p@localhost:3306/humancare_test'],
    ['a remote host', 'mysql://humancare_test_app:p@db.example.com:3306/humancare_test'],
    ['a remote IP', 'mysql://humancare_test_app:p@10.0.0.5:3306/humancare_test'],
    ['a host that merely starts with localhost', 'mysql://humancare_test_app:p@localhost.evil.com:3306/humancare_test'],
    ['a host that merely contains 127.0.0.1', 'mysql://humancare_test_app:p@127.0.0.1.evil.com:3306/humancare_test'],
    ['another protocol', 'postgresql://humancare_test_app:p@localhost:5432/humancare_test'],
    ['a socket redirect', 'mysql://humancare_test_app:p@localhost:3306/humancare_test?socket=/tmp/other.sock'],
    ['a host option', 'mysql://humancare_test_app:p@localhost:3306/humancare_test?host=db.example.com'],
    ['an unknown option', 'mysql://humancare_test_app:p@localhost:3306/humancare_test?schema=humancare_dev'],
    ['not a URL', 'humancare_test'],
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('refuses %s', (_label, url) => {
    rejects(() => assertTestDatabaseUrl(url));
  });

  it.each([[undefined], [null], [42], [{}]])('refuses a non-string (%p)', (value) => {
    rejects(() => assertTestDatabaseUrl(value));
  });

  it('names the rule, not the value, and never prints the password', () => {
    const error = rejects(() => assertTestDatabaseUrl(withUrl(['humancare_test?', 'humancare_dev?'])));
    expect(error.message).toMatch(/must name the database "humancare_test"/);
    expect(rejects(() => assertTestDatabaseUrl('mysql://humancare_app:SECRETPW@localhost/humancare_test')).message).toMatch(/dedicated test user/);
  });

  it('checks the database itself, not just the user', () => {
    // a dev-looking URL with a test-looking user is still refused
    rejects(() => assertTestDatabaseUrl('mysql://humancare_test_app:SECRETPW@localhost:3306/humancare_dev'));
  });
});

describe('verifyLiveDatabase', () => {
  const client = (rows) => ({ $queryRawUnsafe: jest.fn().mockResolvedValue(rows) });

  it('accepts a server that confirms the test database and a test account', async () => {
    const stub = client([{ db: 'humancare_test', account: 'humancare_test_app@localhost' }]);
    await expect(verifyLiveDatabase(stub)).resolves.toEqual({ database: 'humancare_test', account: 'humancare_test_app@localhost' });
    expect(stub.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(stub.$queryRawUnsafe.mock.calls[0][0]).toMatch(/^SELECT DATABASE\(\)/); // read-only
  });

  it.each([
    ['the development database', [{ db: 'humancare_dev', account: 'humancare_test_app@localhost' }]],
    ['no database selected', [{ db: null, account: 'humancare_test_app@localhost' }]],
    ['a look-alike database', [{ db: 'humancare_test_old', account: 'humancare_test_app@localhost' }]],
    ['the development account', [{ db: 'humancare_test', account: 'humancare_app@localhost' }]],
    ['root', [{ db: 'humancare_test', account: 'root@localhost' }]],
    ['an empty answer', []],
    ['an account that only contains the prefix', [{ db: 'humancare_test', account: 'x_humancare_test@localhost' }]],
  ])('refuses %s', async (_label, rows) => {
    await expect(verifyLiveDatabase(client(rows))).rejects.toBeInstanceOf(TestDatabaseGuardError);
  });

  it('refuses when the server cannot be asked, without leaking the driver error', async () => {
    const stub = { $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED mysql://u:SECRETPW@db:3306')) };
    const error = await verifyLiveDatabase(stub).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(TestDatabaseGuardError);
    expect(error.message).not.toMatch(/SECRETPW|ECONNREFUSED/);
  });
});

describe('assertSafeTestEnvironment', () => {
  const ok = { NODE_ENV: 'test', EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', UPLOAD_DIR: '.e2e-uploads' };

  it('accepts the sandbox settings', () => {
    expect(() => assertSafeTestEnvironment(ok)).not.toThrow();
    expect(() => assertSafeTestEnvironment({ ...ok, EMAIL_PROVIDER: 'console', SMTP_HOST: undefined })).not.toThrow();
    expect(() => assertSafeTestEnvironment({ ...ok, SMTP_HOST: 'localhost' })).not.toThrow();
    expect(() => assertSafeTestEnvironment({ ...ok, EMAIL_PROVIDER: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, SMTP_HOST: undefined })).not.toThrow(); // console by default
  });

  it.each([
    ['NODE_ENV unset', { NODE_ENV: undefined }],
    ['NODE_ENV=development', { NODE_ENV: 'development' }],
    ['NODE_ENV=production', { NODE_ENV: 'production' }],
  ])('refuses %s', (_label, patch) => {
    rejects(() => assertSafeTestEnvironment({ ...ok, ...patch }));
  });

  it.each([
    ['real SMTP host', { SMTP_HOST: 'smtp.gmail.com' }],
    ['a look-alike host', { SMTP_HOST: '127.0.0.1.evil.com' }],
    ['no SMTP host (the mailer would default to Gmail)', { SMTP_HOST: undefined }],
    ['an empty SMTP host', { SMTP_HOST: '' }],
    ['an unknown provider', { EMAIL_PROVIDER: 'sendgrid' }],
    ['credentials without a provider or host (implicit real SMTP)', { EMAIL_PROVIDER: undefined, SMTP_USER: 'a', SMTP_PASS: 'b', SMTP_HOST: undefined }],
  ])('refuses mail settings with %s', (_label, patch) => {
    rejects(() => assertSafeTestEnvironment({ ...ok, ...patch }));
  });

  it.each([
    ['no UPLOAD_DIR', { UPLOAD_DIR: undefined }],
    ['an empty UPLOAD_DIR', { UPLOAD_DIR: '' }],
    ['the shared uploads folder', { UPLOAD_DIR: 'uploads' }],
    ['the shared folder by absolute path', { UPLOAD_DIR: path.join(BACKEND_ROOT, 'uploads') }],
    ['a parent traversal', { UPLOAD_DIR: '../uploads' }],
    ['a nested folder', { UPLOAD_DIR: '.e2e-uploads/sub' }],
    ['a sibling look-alike', { UPLOAD_DIR: '.e2e-uploads2' }],
    ['a folder outside the backend', { UPLOAD_DIR: path.join(path.dirname(BACKEND_ROOT), '.e2e-uploads') }],
  ])('refuses %s', (_label, patch) => {
    rejects(() => assertSafeTestEnvironment({ ...ok, ...patch }));
  });
});

describe('resolveTestUploadsDir', () => {
  it('accepts only backend/.e2e-uploads, relative or absolute', () => {
    expect(resolveTestUploadsDir('.e2e-uploads')).toBe(TEST_UPLOADS_DIR);
    expect(resolveTestUploadsDir('./.e2e-uploads')).toBe(TEST_UPLOADS_DIR);
    expect(resolveTestUploadsDir(TEST_UPLOADS_DIR)).toBe(TEST_UPLOADS_DIR);
    expect(path.basename(TEST_UPLOADS_DIR)).toBe('.e2e-uploads');
    expect(path.dirname(TEST_UPLOADS_DIR)).toBe(BACKEND_ROOT);
  });

  it('refuses everything else', () => {
    for (const value of [undefined, null, '', '   ', 'uploads', '../uploads', '/tmp/.e2e-uploads', '.e2e-uploads/..']) {
      rejects(() => resolveTestUploadsDir(value));
    }
  });
});

describe('the Prisma client hook (src/db/prisma.js)', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL };
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.DATABASE_URL === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.DATABASE_URL;
    jest.resetModules();
  });

  const load = () => {
    let loaded;
    jest.isolateModules(() => { loaded = require('../src/db/prisma'); });
    return loaded;
  };

  it('builds no client for the development database, a missing URL or a blank URL in test mode', () => {
    process.env.NODE_ENV = 'test';
    for (const url of ['mysql://humancare_app:SECRETPW@localhost:3306/humancare_dev', 'mysql://humancare_test_app:SECRETPW@localhost:3306/humancare_dev', '', undefined]) {
      if (url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = url;
      expect(load).toThrow(/Test environment safety guard/); // (a fresh module registry, so not the same class object)
    }
  });

  it('builds the client (lazily - nothing connects) for the test URL', () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = GOOD;
    const { prisma } = load();
    expect(prisma).toBeDefined();
    expect(typeof prisma.$queryRawUnsafe).toBe('function');
  });

  it('does not interfere outside test mode', () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'mysql://humancare_app:SECRETPW@localhost:3306/humancare_dev';
    expect(load).not.toThrow(); // still just constructs the client; no connection is made
  });
});
