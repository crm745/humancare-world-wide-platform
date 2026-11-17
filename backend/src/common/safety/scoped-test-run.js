// Safety layer for a SCOPED test run: running a DB-backed suite against the EXISTING `humancare_test` database WITHOUT
// emptying it. It is used only by jest.scoped.config.js (tests/scoped/*) and scripts/scoped-test-cleanup.js.
//
// How isolation is guaranteed (nothing here truncates, resets or globally cleans anything):
//   1. Opt-in + environment    HUMANCARE_SCOPED_RUN=true, the ordinary test guard (database, user, loopback mail), Bitrix
//                              switches off and no webhook, and an uploads folder that belongs to THIS run only.
//   2. Identity                the server confirms database, account and port, and that the account's privileges are
//                              confined to humancare_test (integration-runner-guard.verifyLiveIdentity).
//   3. Session lock            the same lock file the ordinary Jest global setup honours: while a scoped run holds it, an
//                              ordinary `npm test` (which WOULD empty the tables) refuses to start.
//   4. Backup + snapshot       before anything runs: a logical backup of the database (mysqldump, read-only) and, for every
//                              table, the row count and CHECKSUM TABLE. The protected rows (outbox 411, inbox 55/57-61) are
//                              fingerprinted row by row.
//   5. Unique fixtures         every user and admin the suite creates carries this run's id in its e-mail
//                              (patient-<runId>-..., admin-<runId>-...), so rows made by the run are told apart from every
//                              other row by an exact, run-specific pattern (and by creation time).
//   6. Targeted cleanup        only rows reachable from those users/admins (their requests, Cases, documents, events, Deal
//                              records, notifications, OTPs, sessions...) and the run's own GeoNames fixture rows are
//                              deleted, child tables first, in one transaction. No DELETE without a run-specific WHERE.
//   7. Verification            after the cleanup every table's count and checksum must equal the snapshot and the protected
//                              rows must be unchanged. Anything else FAILS the run loudly and names the backup.
// Messages name the rule, never a value (no URL, password or token).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const testGuard = require('./test-database-guard');
const integration = require('./integration-runner-guard');

const { BACKEND_ROOT, TEST_UPLOADS_DIR, SCOPED_UPLOADS_PATTERN } = testGuard;

const RUN_FLAG = 'HUMANCARE_SCOPED_RUN';
const RUN_ID_ENV = 'HC_SCOPED_RUN_ID';
const RUN_ID_PATTERN = /^sr[0-9a-f]{8}$/;
const RUNS_DIR = path.join(BACKEND_ROOT, '.scoped-runs');
// The rows the owner asked to be preserved untouched (they are part of the whole-table checksums too).
const PROTECTED_ROWS = Object.freeze({ integration_outbox: [411], integration_inbox: [55, 57, 58, 59, 60, 61] });
const TABLE_NAME = /^[A-Za-z0-9_]{1,64}$/;

class ScopedRunError extends Error {
  constructor(rule) {
    super(`Scoped test run safety: ${rule}`);
    this.name = 'ScopedRunError';
  }
}
const refuse = (rule) => new ScopedRunError(rule);

// ---- identity of a run ---------------------------------------------------------------------------------------------
const newRunId = () => `sr${crypto.randomBytes(4).toString('hex')}`;
const assertRunId = (id) => {
  if (typeof id !== 'string' || !RUN_ID_PATTERN.test(id)) throw refuse('the run id is not valid.');
  return id;
};
const scopedUploadsDir = (runId) => path.join(TEST_UPLOADS_DIR, `scoped-${assertRunId(runId)}`);
const runDir = (runId) => path.join(RUNS_DIR, assertRunId(runId));
// The exact e-mail patterns of the users this run creates (tests/helpers.js adds the run id to every address).
const emailPattern = (tag, runId) => `${tag}-${assertRunId(runId)}-%@example.com`;

// ---- environment ----------------------------------------------------------------------------------------------------
/**
 * The complete environment of a scoped run, from `parsedFile` (backend/.env.test) ONLY, with everything the run must not
 * use forced: Bitrix off and no webhook, this run's own uploads folder, NODE_ENV=test. Does not touch process.env.
 */
function buildScopedEnv(parsedFile, runId, { systemEnv = process.env, knownKeys = integration.collectEnvKeyNames() } = {}) {
  assertRunId(runId);
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WINDIR']) {
    if (systemEnv[key] !== undefined) env[key] = systemEnv[key];
  }
  for (const key of knownKeys) if (!(key in parsedFile) && !(key in env)) env[key] = '';
  Object.assign(env, parsedFile, {
    NODE_ENV: 'test',
    [RUN_FLAG]: 'true',
    [RUN_ID_ENV]: runId,
    UPLOAD_DIR: path.relative(BACKEND_ROOT, scopedUploadsDir(runId)),
    BITRIX_SYNC_ENABLED: 'false',
    BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: '',
    BITRIX24_WEBHOOK_URL: '',
    BITRIX_INBOUND_APPLICATION_TOKEN: '',
  });
  assertScopedEnvironment(env);
  return env;
}

function assertScopedEnvironment(env) {
  if (env[RUN_FLAG] !== 'true') throw refuse(`${RUN_FLAG} must be "true"; a scoped run never starts without it.`);
  const runId = assertRunId(env[RUN_ID_ENV]);
  const target = testGuard.assertTestDatabaseUrl(env.DATABASE_URL);
  testGuard.assertSafeTestEnvironment(env);
  if (path.resolve(BACKEND_ROOT, String(env.UPLOAD_DIR)).toLowerCase() !== scopedUploadsDir(runId).toLowerCase()) {
    throw refuse('UPLOAD_DIR must be this run\'s own scoped uploads folder.');
  }
  if (env.BITRIX_SYNC_ENABLED === 'true' || env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED === 'true') throw refuse('a Bitrix switch is on.');
  if (env.BITRIX24_WEBHOOK_URL) throw refuse('a Bitrix webhook is configured.');
  return target;
}

// ---- snapshot --------------------------------------------------------------------------------------------------------
const num = (value) => (value == null ? null : Number(value));
const jsonSafe = (value) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() : v));

async function listTables(db) {
  const rows = await db.$queryRawUnsafe(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
  );
  return rows.map((row) => String(row.t)).filter((name) => TABLE_NAME.test(name));
}

/** Per table: row count and CHECKSUM TABLE. Read-only. */
async function takeSnapshot(db) {
  const tables = {};
  for (const name of await listTables(db)) {
    const [count] = await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${name}\``);
    const [sum] = await db.$queryRawUnsafe(`CHECKSUM TABLE \`${name}\``);
    const checksum = sum && (sum.Checksum ?? sum.checksum);
    tables[name] = { count: num(count.n), checksum: checksum == null ? null : String(checksum) };
  }
  return { takenAt: new Date().toISOString(), tables };
}

/** The tables whose count or checksum differ: [{ table, before, after }]. Empty means identical. */
function compareSnapshots(before, after) {
  const names = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
  const different = [];
  for (const table of [...names].sort()) {
    const a = before.tables[table];
    const b = after.tables[table];
    if (!a || !b || a.count !== b.count || a.checksum !== b.checksum) different.push({ table, before: a || null, after: b || null });
  }
  return different;
}

/** The protected rows, as they are now (id -> the whole row as text), so any change to one is visible. */
async function fingerprintProtected(db, protectedRows = PROTECTED_ROWS) {
  const out = {};
  for (const [table, ids] of Object.entries(protectedRows)) {
    if (!TABLE_NAME.test(table)) throw refuse('an unusual protected table name.');
    out[table] = {};
    for (const id of ids) {
      const rows = await db.$queryRawUnsafe(`SELECT * FROM \`${table}\` WHERE id = ?`, id);
      out[table][id] = rows.length ? jsonSafe(rows[0]) : null;
    }
  }
  return out;
}

function compareProtected(before, after) {
  const changed = [];
  for (const [table, rows] of Object.entries(before)) {
    for (const [id, text] of Object.entries(rows)) if (text !== (after[table] || {})[id]) changed.push(`${table}#${id}`);
  }
  return changed;
}

/** Conditions that would make a scoped run unsafe for data it must not touch. Throws; changes nothing. */
async function assertPreflight(db) {
  // The scan sweep (sweepPendingScans) works on EVERY pending/error document in the database, not only this run's.
  const [pending] = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM request_documents WHERE scan_status IN ('pending', 'error')");
  if (num(pending.n) > 0) throw refuse('existing request documents are waiting for a scan; the suite\'s scan sweep could modify them.');
  // Processing events could be mid-flight in a worker started elsewhere.
  const [processing] = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM integration_outbox WHERE status = 'processing'");
  if (num(processing.n) > 0) throw refuse('an outbox event is being processed; stop the worker first.');
}

// ---- backup ----------------------------------------------------------------------------------------------------------
function findMysqldump(env = process.env) {
  const candidates = [env.MYSQLDUMP_PATH, 'C:\\Program Files\\MySQL\\MySQL Server 26.7\\bin\\mysqldump.exe', 'mysqldump'].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const STDERR_LIMIT = 600;
const DUMP_COMPLETED_MARKER = '-- Dump completed';

// mysqldump's own message for the error text: the password is removed (it is only ever in MYSQL_PWD, but a message could
// echo it), whitespace is collapsed and the length is capped.
function safeStderr(text, password) {
  let out = String(text == null ? '' : text);
  if (password) out = out.split(password).join('[hidden]');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > STDERR_LIMIT ? `${out.slice(0, STDERR_LIMIT)}...` : out;
}

function readTail(file, bytes = 4096) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A logical backup of the whole database to `file` (read-only for the database). The dump is written to `<file>.part` and
 * renamed to `file` ONLY after mysqldump exited with status 0 (not killed by a signal), the file is not tiny and it ends with
 * mysqldump's "Dump completed" line. Any other outcome throws with the exit code and mysqldump's stderr (password removed),
 * and leaves only the `.part` file, which nothing treats as a backup. An existing `file` is never overwritten.
 * `spawn` is injectable for tests.
 */
function createBackup(databaseUrl, file, { dump = findMysqldump(), spawn = spawnSync } = {}) {
  if (!dump) throw refuse('mysqldump was not found, so no backup can be made (set MYSQLDUMP_PATH).');
  const target = testGuard.assertTestDatabaseUrl(databaseUrl);
  const password = decodeURIComponent(new URL(databaseUrl).password);
  if (fs.existsSync(file)) throw refuse('a backup file already exists; it is never overwritten.');
  const part = `${file}.part`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const fd = fs.openSync(part, 'w');
  let result;
  try {
    result = spawn(
      dump,
      [
        '--single-transaction', '--no-tablespaces',
        // The account has no global privileges: reading the GTID position would need RELOAD/FLUSH_TABLES, and a data backup
        // does not need it.
        '--set-gtid-purged=OFF',
        '-h', target.host, '-P', String(target.port), '-u', target.user, target.database,
      ],
      { env: { PATH: process.env.PATH || '', Path: process.env.Path || '', SystemRoot: process.env.SystemRoot || '', MYSQL_PWD: password }, stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' },
    );
  } finally {
    fs.closeSync(fd);
  }

  const detail = safeStderr(result && result.stderr, password);
  if (!result || result.error) {
    const code = result && result.error && (result.error.code || result.error.name);
    throw refuse(`the backup could not be made (mysqldump could not run${code ? `: ${code}` : ''}${detail ? `; stderr: ${detail}` : ''}).`);
  }
  if (result.signal) throw refuse(`the backup could not be made (mysqldump was terminated by signal ${result.signal}${detail ? `; stderr: ${detail}` : ''}).`);
  if (result.status !== 0) throw refuse(`the backup could not be made (mysqldump exit code ${result.status}${detail ? `; stderr: ${detail}` : '; no stderr'}).`);

  const bytes = fs.statSync(part).size;
  if (bytes < 1024) throw refuse(`the backup is not valid: the dump is only ${bytes} bytes.`);
  if (!readTail(part).includes(DUMP_COMPLETED_MARKER)) throw refuse('the backup is not valid: the dump does not end with "Dump completed".');
  fs.renameSync(part, file);
  return { file, bytes };
}

// ---- targeted cleanup ------------------------------------------------------------------------------------------------
const placeholders = (list) => list.map(() => '?').join(',');
const chunk = (list, size = 400) => {
  const parts = [];
  for (let i = 0; i < list.length; i += size) parts.push(list.slice(i, i + size));
  return parts;
};

/** The ids of everything this run created, found ONLY through its run-specific e-mail patterns (and creation time). */
async function collectRunRows(db, runId, startedAt) {
  const since = new Date(startedAt);
  const users = await db.$queryRawUnsafe('SELECT id, email, mobile FROM users WHERE email LIKE ? AND created_at >= ?', emailPattern('patient', runId), since);
  const admins = await db.$queryRawUnsafe('SELECT id FROM admin_users WHERE email LIKE ? AND created_at >= ?', emailPattern('admin', runId), since);
  const userIds = users.map((u) => Number(u.id));
  const adminIds = admins.map((a) => Number(a.id));
  const identifiers = users.flatMap((u) => [u.email, u.mobile]).filter(Boolean).map(String);
  const requestIds = [];
  const caseIds = [];
  for (const part of chunk(userIds)) {
    requestIds.push(...(await db.$queryRawUnsafe(`SELECT id FROM service_requests WHERE user_id IN (${placeholders(part)})`, ...part)).map((r) => Number(r.id)));
  }
  for (const part of chunk(requestIds)) {
    caseIds.push(...(await db.$queryRawUnsafe(`SELECT id FROM cases WHERE service_request_id IN (${placeholders(part)})`, ...part)).map((r) => Number(r.id)));
  }
  return { userIds, adminIds, identifiers, requestIds, caseIds };
}

/**
 * The ordered deletions (children first). Pure: from the collected ids, returns [{ table, where, params }]. Every WHERE is
 * bound to this run's ids; there is no unconditional DELETE. A step with no ids is left out.
 */
function planCleanup({ userIds, adminIds, identifiers, requestIds, caseIds, fixtureGeonameIds = [] }) {
  const steps = [];
  const add = (table, where, params) => { if (params.length) steps.push({ table, where, params }); };
  const U = (list) => placeholders(list);

  const notif = `SELECT id FROM notifications WHERE recipient_type = 'patient' AND recipient_id IN (${U(userIds)})`;
  if (userIds.length) {
    steps.push({ table: 'notification_delivery_attempts', where: `delivery_id IN (SELECT id FROM notification_deliveries WHERE notification_id IN (${notif}))`, params: [...userIds] });
    steps.push({ table: 'notification_deliveries', where: `notification_id IN (${notif})`, params: [...userIds] });
    steps.push({ table: 'notifications', where: `recipient_type = 'patient' AND recipient_id IN (${U(userIds)})`, params: [...userIds] });
  }
  add('payments', `case_id IN (${U(caseIds)})`, caseIds);
  add('invoices', `case_id IN (${U(caseIds)})`, caseIds);
  add('integration_outbox', `case_id IN (${U(caseIds)})`, caseIds);
  add('bitrix_deal_links', `case_id IN (${U(caseIds)})`, caseIds);
  add('audit_logs', `case_id IN (${U(caseIds)})`, caseIds);
  add('case_stage_events', `case_id IN (${U(caseIds)})`, caseIds);
  add('case_communications', `case_id IN (${U(caseIds)})`, caseIds);
  add('request_documents', `service_request_id IN (${U(requestIds)})`, requestIds); // before document_requests (foreign key)
  add('document_requests', `case_id IN (${U(caseIds)})`, caseIds);
  add('request_events', `service_request_id IN (${U(requestIds)})`, requestIds);
  add('documents', `case_id IN (${U(caseIds)})`, caseIds);
  add('cases', `id IN (${U(caseIds)})`, caseIds);
  add('service_requests', `id IN (${U(requestIds)})`, requestIds);
  add('otp_codes', `identifier IN (${U(identifiers)})`, identifiers);
  if (userIds.length || adminIds.length) {
    const where = [];
    const params = [];
    if (userIds.length) { where.push(`user_id IN (${U(userIds)})`, `(actor_type = 'patient' AND actor_id IN (${U(userIds)}))`); params.push(...userIds, ...userIds); }
    if (adminIds.length) { where.push(`(actor_type = 'admin' AND actor_id IN (${U(adminIds)}))`); params.push(...adminIds); }
    steps.push({ table: 'security_events', where: where.join(' OR '), params });
  }
  add('user_consents', `user_id IN (${U(userIds)})`, userIds);
  add('users', `id IN (${U(userIds)})`, userIds);
  if (adminIds.length) {
    const sessions = `SELECT id FROM admin_sessions WHERE admin_id IN (${U(adminIds)})`;
    steps.push({ table: 'admin_webauthn_challenges', where: `admin_id IN (${U(adminIds)})`, params: [...adminIds] });
    steps.push({ table: 'admin_refresh_tokens', where: `session_id IN (${sessions})`, params: [...adminIds] });
    steps.push({ table: 'admin_sessions', where: `admin_id IN (${U(adminIds)})`, params: [...adminIds] });
    steps.push({ table: 'admin_passkeys', where: `admin_id IN (${U(adminIds)})`, params: [...adminIds] });
    steps.push({ table: 'admin_invitations', where: `admin_id IN (${U(adminIds)})`, params: [...adminIds] });
    steps.push({ table: 'admin_recovery_approvals', where: `approver_id IN (${U(adminIds)})`, params: [...adminIds] });
    steps.push({ table: 'admin_recovery_requests', where: `admin_id IN (${U(adminIds)})`, params: [...adminIds] });
    steps.push({ table: 'admin_users', where: `id IN (${U(adminIds)})`, params: [...adminIds] });
  }
  add('geonames_cities', `geoname_id IN (${U(fixtureGeonameIds)})`, fixtureGeonameIds);
  return steps;
}

/** Runs (or, with dryRun, only counts) the cleanup. Returns { counts } per table. One transaction; any failure rolls back. */
async function runCleanup(db, runId, { startedAt, fixtureGeonameIds = [], dryRun = false } = {}) {
  assertRunId(runId);
  if (!startedAt) throw refuse('the run\'s start time is needed for the cleanup.');
  const rows = await collectRunRows(db, runId, startedAt);
  const steps = planCleanup({ ...rows, fixtureGeonameIds });
  const counts = {};
  if (dryRun) {
    for (const step of steps) {
      const [row] = await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${step.table}\` WHERE ${step.where}`, ...step.params);
      counts[step.table] = num(row.n);
    }
    return { counts, ids: { users: rows.userIds.length, admins: rows.adminIds.length, requests: rows.requestIds.length, cases: rows.caseIds.length } };
  }
  await db.$transaction(async (tx) => {
    for (const step of steps) {
      if (!TABLE_NAME.test(step.table) || !step.where || !step.params.length) throw refuse('an unscoped cleanup step was refused.');
      counts[step.table] = num(await tx.$executeRawUnsafe(`DELETE FROM \`${step.table}\` WHERE ${step.where}`, ...step.params));
    }
  }, { timeout: 120000 });
  return { counts, ids: { users: rows.userIds.length, admins: rows.adminIds.length, requests: rows.requestIds.length, cases: rows.caseIds.length } };
}

/** Removes THIS run's uploads folder (only a direct, correctly named child of backend/.e2e-uploads). */
function removeScopedUploads(runId) {
  const dir = scopedUploadsDir(runId);
  if (path.dirname(dir).toLowerCase() !== TEST_UPLOADS_DIR.toLowerCase() || !SCOPED_UPLOADS_PATTERN.test(path.basename(dir))) {
    throw refuse('refusing to remove a folder that is not a scoped uploads folder.');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  RUN_FLAG, RUN_ID_ENV, RUN_ID_PATTERN, RUNS_DIR, PROTECTED_ROWS, ScopedRunError,
  newRunId, assertRunId, scopedUploadsDir, runDir, emailPattern,
  buildScopedEnv, assertScopedEnvironment,
  takeSnapshot, compareSnapshots, fingerprintProtected, compareProtected, assertPreflight,
  findMysqldump, createBackup,
  collectRunRows, planCleanup, runCleanup, removeScopedUploads,
};
