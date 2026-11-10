// Hard safety guard for everything that runs against the dedicated TEST database.
//
// Tests wipe tables and write uploads and mail, so the process must be unable to do that to the
// development database, a remote server, a real mailbox or the shared uploads folder - however it
// was started (npm test, an ad-hoc Jest config, a script, the E2E server).
//
//   assertTestDatabaseUrl(url)   BEFORE any connection: the URL must be a local mysql: URL for the
//                                database "humancare_test", with a "humancare_test*" user and only
//                                harmless query options. Throws; never prints the URL or password.
//   verifyLiveDatabase(client)   AFTER connecting, before anything destructive: the server itself
//                                must report DATABASE() = humancare_test and a humancare_test* user.
//   assertSafeTestEnvironment()  NODE_ENV is "test", mail can only go to a loopback server (or the
//                                console), and uploads go to backend/.e2e-uploads.
//   resolveTestUploadsDir(value) the one accepted spelling of the test uploads folder.
//
// Rules are by NAME (database and user), so the development credentials never need to be read or
// compared. Error messages name the rule and the variable, never a value.
const path = require('path');

const TEST_DATABASE = 'humancare_test';
const TEST_USER_PREFIX = 'humancare_test';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
// Connection options that cannot redirect the connection to another server.
const ALLOWED_URL_PARAMS = new Set(['connection_limit', 'pool_timeout', 'connect_timeout']);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_UPLOADS_DIR = path.join(BACKEND_ROOT, '.e2e-uploads');

class TestDatabaseGuardError extends Error {
  constructor(rule) {
    super(`Test environment safety guard: ${rule}`);
    this.name = 'TestDatabaseGuardError';
  }
}

const refuse = (rule) => new TestDatabaseGuardError(rule);
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Validates DATABASE_URL without touching the network. Returns { host, port, database, user }. */
function assertTestDatabaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw refuse('DATABASE_URL is not set. Create backend/.env.test (see .env.test.example).');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw refuse('DATABASE_URL is not a valid URL.');
  }
  if (url.protocol !== 'mysql:') throw refuse('DATABASE_URL must be a mysql:// URL.');
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw refuse('DATABASE_URL must point at this machine (localhost, 127.0.0.1 or ::1).');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database !== TEST_DATABASE) throw refuse(`DATABASE_URL must name the database "${TEST_DATABASE}" and nothing else.`);
  const user = decodeURIComponent(url.username);
  if (!user.startsWith(TEST_USER_PREFIX)) {
    throw refuse(`DATABASE_URL must use a dedicated test user whose name starts with "${TEST_USER_PREFIX}".`);
  }
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_URL_PARAMS.has(key)) throw refuse(`DATABASE_URL option "${key}" is not allowed in the test environment.`);
  }
  return { host: url.hostname, port: url.port || '3306', database, user };
}

/** Asks the connected server who and where it is. `client` is a PrismaClient (or anything with $queryRawUnsafe). */
async function verifyLiveDatabase(client) {
  let row;
  try {
    [row] = await client.$queryRawUnsafe('SELECT DATABASE() AS db, CURRENT_USER() AS account');
  } catch {
    throw refuse('could not verify the connected database.');
  }
  const database = row && row.db;
  const account = String((row && row.account) || '');
  if (database !== TEST_DATABASE) throw refuse(`connected database is not "${TEST_DATABASE}".`);
  if (!account.split('@')[0].startsWith(TEST_USER_PREFIX)) {
    throw refuse(`connected account is not a "${TEST_USER_PREFIX}*" test user.`);
  }
  return { database, account };
}

/** The only accepted value of UPLOAD_DIR in test mode: backend/.e2e-uploads (relative or absolute). */
function resolveTestUploadsDir(value) {
  if (typeof value !== 'string' || value.trim() === '') throw refuse('UPLOAD_DIR must be set to .e2e-uploads in the test environment.');
  const resolved = path.resolve(BACKEND_ROOT, value);
  if (!samePath(resolved, TEST_UPLOADS_DIR)) throw refuse('UPLOAD_DIR must be backend/.e2e-uploads in the test environment.');
  return TEST_UPLOADS_DIR;
}

/** Everything about the process environment that could reach outside the test sandbox. */
function assertSafeTestEnvironment(env = process.env) {
  if (env.NODE_ENV !== 'test') throw refuse('NODE_ENV must be "test".');

  // Mail: the console, or SMTP to this machine (the capture sink). An unset provider with SMTP
  // credentials would silently mean real SMTP, so it is judged as SMTP and needs a loopback host.
  const provider = env.EMAIL_PROVIDER || (env.SMTP_USER && env.SMTP_PASS ? 'smtp' : 'console');
  if (provider === 'smtp') {
    if (!LOOPBACK_HOSTS.has(String(env.SMTP_HOST || '').toLowerCase())) {
      throw refuse('SMTP_HOST must be 127.0.0.1 (the local capture sink) in the test environment.');
    }
  } else if (provider !== 'console') {
    throw refuse('EMAIL_PROVIDER must be "smtp" (to the local sink) or "console" in the test environment.');
  }

  resolveTestUploadsDir(env.UPLOAD_DIR);
}

module.exports = {
  assertTestDatabaseUrl,
  verifyLiveDatabase,
  assertSafeTestEnvironment,
  resolveTestUploadsDir,
  TestDatabaseGuardError,
  TEST_DATABASE,
  TEST_USER_PREFIX,
  TEST_UPLOADS_DIR,
  BACKEND_ROOT,
};
