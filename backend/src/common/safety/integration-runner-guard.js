// Safety rules for the INTEGRATION runner: real-service end-to-end checks that use the existing `humancare_test`
// database but must NEVER go through the ordinary Jest global setup (tests/global-setup.js), which empties every
// table. This file adds to test-database-guard.js and changes nothing in it; it reuses its URL, live-identity and
// environment checks, so the rules for "which database" stay in one place.
//
// What it adds:
//   explicit opt-in      nothing connects unless HUMANCARE_INTEGRATION_RUN is exactly "true"
//   exact identity       URL (humancare_test, test user, this machine), then the SERVER confirms database, account and
//                        port, and (SHOW GRANTS) that the account's privileges are confined to humancare_test
//   no concurrency       a session lock file shared with the ordinary Jest global setup, which already refuses to run
//                        while it exists, plus a check that no other session is connected to humancare_test
//   Bitrix off           a Bitrix switch may be "true" only together with HUMANCARE_INTEGRATION_ALLOW_BITRIX="true"
//   no leakage           every environment key the code reads is blanked unless backend/.env.test sets it, so nothing is
//                        filled in from the development .env
// Nothing here deletes, truncates, seeds or migrates anything. Messages name the rule, never a value.
const fs = require('fs');
const path = require('path');
const testGuard = require('./test-database-guard');

const { TEST_DATABASE, BACKEND_ROOT } = testGuard;
const RUN_FLAG = 'HUMANCARE_INTEGRATION_RUN';
const ALLOW_BITRIX_FLAG = 'HUMANCARE_INTEGRATION_ALLOW_BITRIX';
// The SAME file tests/global-setup.js checks: while it exists, no ordinary Jest run may start.
const SESSION_LOCK = path.join(BACKEND_ROOT, '.integration-session.lock');
const ENV_FILE = path.join(BACKEND_ROOT, '.env.test');
const LOOPBACK_ACCOUNT_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

class IntegrationRunnerGuardError extends Error {
  constructor(rule) {
    super(`Integration runner safety guard: ${rule}`);
    this.name = 'IntegrationRunnerGuardError';
  }
}
const refuse = (rule) => new IntegrationRunnerGuardError(rule);

// ---- opt-in and environment ----------------------------------------------------------------------------------------
function assertOptIn(env = process.env) {
  if (env[RUN_FLAG] !== 'true') throw refuse(`${RUN_FLAG} must be "true"; the integration runner never connects without it.`);
}

/** Opt-in + the ordinary test rules (URL, mail, uploads, NODE_ENV) + Bitrix switches off unless explicitly allowed. */
function assertIntegrationEnvironment(env = process.env) {
  assertOptIn(env);
  const target = testGuard.assertTestDatabaseUrl(env.DATABASE_URL);
  testGuard.assertSafeTestEnvironment(env);
  const bitrixOn = env.BITRIX_SYNC_ENABLED === 'true' || env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED === 'true';
  if (bitrixOn && env[ALLOW_BITRIX_FLAG] !== 'true') throw refuse(`a Bitrix switch is on but ${ALLOW_BITRIX_FLAG} is not "true".`);
  return target;
}

// Names of every environment variable the application code reads (from the source text, never from an env file).
function collectEnvKeyNames(srcDir = path.join(BACKEND_ROOT, 'src')) {
  const names = new Set();
  const pattern = /\benv\.([A-Z][A-Z0-9_]+)\b/g;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) for (const m of fs.readFileSync(full, 'utf8').matchAll(pattern)) names.add(m[1]);
    }
  };
  walk(srcDir);
  return names;
}

const SYSTEM_KEYS = ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WINDIR'];

/**
 * The complete, validated environment for an integration process, from `parsedFile` (backend/.env.test) ONLY.
 * Every other key the code reads is set to '' (an empty value counts as "already set", so the Prisma client will not
 * fill it in from a development .env). Does not touch process.env. The caller supplies the opt-in flag.
 */
function buildIntegrationEnv(parsedFile, { systemEnv = process.env, knownKeys = collectEnvKeyNames() } = {}) {
  const env = {};
  for (const key of SYSTEM_KEYS) if (systemEnv[key] !== undefined) env[key] = systemEnv[key];
  for (const key of knownKeys) if (!(key in parsedFile) && !(key in env)) env[key] = '';
  Object.assign(env, parsedFile, { NODE_ENV: 'test', [RUN_FLAG]: systemEnv[RUN_FLAG] === 'true' ? 'true' : '' });
  assertIntegrationEnvironment(env);
  return env;
}

// ---- live identity -------------------------------------------------------------------------------------------------
// `lines` are the rows of SHOW GRANTS FOR CURRENT_USER(). Refused: any database other than humancare_test (or a
// wildcard / table / column scope), any global privilege beyond USAGE, GRANT OPTION, and role grants. Privileges on
// humancare_test itself are not restricted here (the existing test account is created elsewhere), only confined.
function assertGrantsConfined(lines, database = TEST_DATABASE) {
  if (!Array.isArray(lines) || lines.length === 0) throw refuse('could not read the account\'s privileges.');
  let own = false;
  for (const raw of lines) {
    const line = String(raw).trim();
    if (/WITH\s+GRANT\s+OPTION\s*$/i.test(line)) throw refuse('the account holds GRANT OPTION.');
    const match = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(line);
    if (!match) throw refuse('the account has a grant that is not a plain privilege grant (a role?).');
    const scope = match[2].replace(/`/g, '');
    if (scope === '*.*') {
      if (match[1].trim().toUpperCase() !== 'USAGE') throw refuse('the account holds a global privilege.');
      continue;
    }
    if (scope.replace(/\\/g, '') !== `${database}.*`) throw refuse('the account holds a privilege outside humancare_test.');
    if (/GRANT\s+OPTION/i.test(match[1])) throw refuse('the account holds GRANT OPTION.');
    own = true;
  }
  if (!own) throw refuse('the account has no privilege on humancare_test.');
}

/**
 * Asks the connected server who and where it is, BEFORE any integration operation. `db` is a PrismaClient (or
 * anything with $queryRawUnsafe). `expectedPort` is the port in the URL; the server must report the same one.
 */
async function verifyLiveIdentity(db, { expectedPort } = {}) {
  const live = await testGuard.verifyLiveDatabase(db); // DATABASE() = humancare_test, a humancare_test* account
  let facts;
  let grants;
  try {
    [facts] = await db.$queryRawUnsafe('SELECT @@port AS port, CURRENT_ROLE() AS role');
    grants = (await db.$queryRawUnsafe('SHOW GRANTS FOR CURRENT_USER()')).map((row) => String(Object.values(row)[0]));
  } catch {
    throw refuse('could not verify the connected server.');
  }
  const host = live.account.split('@').slice(1).join('@').toLowerCase();
  if (!LOOPBACK_ACCOUNT_HOSTS.has(host)) throw refuse('the account is allowed from a host other than this machine.');
  if (expectedPort !== undefined && String(Number(facts.port)) !== String(expectedPort)) throw refuse('the server\'s port is not the one in DATABASE_URL.');
  const role = String((facts && facts.role) || 'NONE').toUpperCase();
  if (role !== 'NONE') throw refuse('the account has an active role.');
  assertGrantsConfined(grants);
  return live;
}

/**
 * Refuses if any OTHER session is connected to humancare_test (an ordinary Jest run, the end-to-end server, a
 * developer tool). Limit: a restricted account sees only its own account's sessions, so this catches runs and tools
 * using the same test account (the normal case) and is a second line behind the session lock.
 */
async function assertNoOtherSessions(db) {
  let rows;
  let me;
  try {
    [me] = await db.$queryRawUnsafe('SELECT CONNECTION_ID() AS id');
    rows = await db.$queryRawUnsafe('SHOW PROCESSLIST');
  } catch {
    throw refuse('could not check for other sessions on humancare_test.');
  }
  const mine = Number(me.id);
  const others = rows.filter((row) => (row.Db ?? row.db) === TEST_DATABASE && Number(row.Id ?? row.id) !== mine);
  if (others.length) throw refuse(`${others.length} other session(s) are connected to humancare_test. Stop them (an ordinary Jest run, the end-to-end server) first.`);
}

// ---- session lock --------------------------------------------------------------------------------------------------
/**
 * Takes the exclusive session lock (the file tests/global-setup.js already honours) or throws. While it exists an
 * ordinary Jest run refuses to start (it would empty the tables); a second integration run refuses here. It is created
 * atomically (flag "wx"), records who holds it, and is never removed by anything except release(). A stale lock left by
 * a crash is NOT removed automatically: the message says who held it.
 */
function acquireSessionLock({ lockFile = SESSION_LOCK, pid = process.pid, now = () => new Date() } = {}) {
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      let holder = 'unknown holder';
      try {
        const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        holder = `held by ${info.holder || 'a session'} (pid ${info.pid}, since ${info.since})`;
      } catch { /* a hand-made lock file has no details */ }
      throw refuse(`a session lock already exists (${holder}). Another integration run or a manual session is using humancare_test. If you are sure none is active, delete backend/.integration-session.lock yourself.`);
    }
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ holder: 'integration-runner', pid, since: now().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try {
      const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (info.pid === pid && info.holder === 'integration-runner') fs.unlinkSync(lockFile); // only our own lock
    } catch { /* already gone or not ours: leave it */ }
  };
}

module.exports = {
  assertOptIn,
  assertIntegrationEnvironment,
  buildIntegrationEnv,
  collectEnvKeyNames,
  assertGrantsConfined,
  verifyLiveIdentity,
  assertNoOtherSessions,
  acquireSessionLock,
  IntegrationRunnerGuardError,
  RUN_FLAG,
  ALLOW_BITRIX_FLAG,
  SESSION_LOCK,
  ENV_FILE,
  BACKEND_ROOT,
};
