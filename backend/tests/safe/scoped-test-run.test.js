/* global describe, test, expect, jest */
// The safety layer of a scoped test run (src/common/safety/scoped-test-run.js): pure logic and an in-memory fake database.
// No database, no network, no files written.
const fs = require('fs');
const path = require('path');
const scoped = require('../../src/common/safety/scoped-test-run');
const { resolveTestUploadsDir, TEST_UPLOADS_DIR, BACKEND_ROOT } = require('../../src/common/safety/test-database-guard');

const RUN = 'sr0a1b2c3d';
const GOOD_URL = 'mysql://humancare_test_app:SECRETPW@localhost:3306/humancare_test?connection_limit=20';
const parsed = { DATABASE_URL: GOOD_URL, EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', UPLOAD_DIR: '.e2e-uploads', BITRIX_SYNC_ENABLED: 'true', BITRIX24_WEBHOOK_URL: 'https://example.invalid/rest/1/x/' };
const build = (over = {}, run = RUN) => scoped.buildScopedEnv({ ...parsed, ...over }, run, { systemEnv: {}, knownKeys: [] });

describe('the run id and the fixtures it marks', () => {
  test('a new id has the fixed shape, and only that shape is accepted', () => {
    expect(scoped.newRunId()).toMatch(/^sr[0-9a-f]{8}$/);
    expect(scoped.assertRunId(RUN)).toBe(RUN);
    for (const bad of [undefined, '', 'sr123', 'SR0a1b2c3d', 'sr0a1b2c3dd', 'sr0a1b2c3%', '../x', 'sr0a1b2c3_']) expect(() => scoped.assertRunId(bad)).toThrow(/run id/);
  });

  test('the e-mail pattern carries the run id, so another run\'s or an older user\'s address never matches', () => {
    const like = scoped.emailPattern('patient', RUN);
    expect(like).toBe(`patient-${RUN}-%@example.com`);
    const regex = new RegExp(`^${like.replace(/[.]/g, '\\.').replace('%', '.*')}$`);
    expect(regex.test(`patient-${RUN}-1700000000000-123456@example.com`)).toBe(true);
    expect(regex.test('patient-1700000000000-123456@example.com')).toBe(false); // an address made before this change, or outside a scoped run
    expect(regex.test('patient-sr99999999-1700000000000-1@example.com')).toBe(false); // another run
    expect(regex.test(`admin-${RUN}-1@example.com`)).toBe(false);
  });

  test('the shared test helper adds the run id to every address, and only when a scoped run set it', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'helpers.js'), 'utf8');
    expect(source).toMatch(/process\.env\.HC_SCOPED_RUN_ID/);
    expect(source).toMatch(/\$\{tag\}-\$\{run\}\$\{Date\.now\(\)\}/);
  });
});

describe('the environment of a scoped run', () => {
  test('is built from the test file only, with Bitrix forced off and this run\'s own uploads folder', () => {
    const env = build();
    expect(env).toMatchObject({ NODE_ENV: 'test', HUMANCARE_SCOPED_RUN: 'true', HC_SCOPED_RUN_ID: RUN, BITRIX_SYNC_ENABLED: 'false', BITRIX24_WEBHOOK_URL: '' });
    expect(path.resolve(BACKEND_ROOT, env.UPLOAD_DIR)).toBe(scoped.scopedUploadsDir(RUN));
    expect(path.dirname(scoped.scopedUploadsDir(RUN))).toBe(TEST_UPLOADS_DIR);
  });

  test.each([
    ['no opt-in flag', { HUMANCARE_SCOPED_RUN: '' }],
    ['no run id', { HC_SCOPED_RUN_ID: '' }],
    ['another database', { DATABASE_URL: GOOD_URL.replace('/humancare_test', '/humancare_dev') }],
    ['a non-test user', { DATABASE_URL: GOOD_URL.replace('humancare_test_app', 'root') }],
    ['the shared uploads root', { UPLOAD_DIR: '.e2e-uploads' }],
    ['another run\'s uploads folder', { UPLOAD_DIR: '.e2e-uploads/scoped-sr99999999' }],
    ['a Bitrix switch on', { BITRIX_SYNC_ENABLED: 'true' }],
    ['a Bitrix webhook', { BITRIX24_WEBHOOK_URL: 'https://x.invalid/' }],
  ])('is refused with %s', (_name, over) => {
    const env = { ...build(), ...over };
    expect(() => scoped.assertScopedEnvironment(env)).toThrow(/Scoped test run safety|Test environment safety guard/);
  });

  test('refusal messages never contain the password', () => {
    try { scoped.assertScopedEnvironment({ ...build(), DATABASE_URL: GOOD_URL.replace('/humancare_test', '/humancare_dev') }); } catch (err) { expect(err.message).not.toMatch(/SECRETPW/); }
  });

  test('the guard accepts exactly this run\'s own scoped uploads folder inside .e2e-uploads, and still refuses everything else', () => {
    expect(resolveTestUploadsDir(`.e2e-uploads/scoped-${RUN}`)).toBe(scoped.scopedUploadsDir(RUN));
    expect(resolveTestUploadsDir('.e2e-uploads')).toBe(TEST_UPLOADS_DIR);
    for (const bad of ['.e2e-uploads/sub', '.e2e-uploads/scoped-', '.e2e-uploads/scoped-sr123', '.e2e-uploads/scoped-sr0a1b2c3d/deeper', 'uploads/scoped-sr0a1b2c3d',
      '../.e2e-uploads/scoped-sr0a1b2c3d/..', 'scoped-sr0a1b2c3d']) {
      expect(() => resolveTestUploadsDir(bad)).toThrow(/UPLOAD_DIR/);
    }
  });
});

describe('the cleanup plan', () => {
  const ids = { userIds: [11, 12], adminIds: [21], identifiers: ['a@example.com', '+911234567890'], requestIds: [31], caseIds: [41], fixtureGeonameIds: [900000001] };
  const order = (steps) => steps.map((s) => s.table);

  test('with nothing created by the run there is nothing to delete (no unconditional statement exists)', () => {
    expect(scoped.planCleanup({ userIds: [], adminIds: [], identifiers: [], requestIds: [], caseIds: [], fixtureGeonameIds: [] })).toEqual([]);
  });

  test('every step is bound to this run\'s ids: a WHERE clause, as many parameters as placeholders, never empty', () => {
    for (const step of scoped.planCleanup(ids)) {
      expect(step.where.length).toBeGreaterThan(0);
      expect(step.params.length).toBeGreaterThan(0);
      expect((step.where.match(/\?/g) || []).length).toBe(step.params.length);
      expect(step.where).not.toMatch(/^\s*1\s*=\s*1|\bTRUE\b/i);
    }
  });

  test('children are deleted before their parents (foreign keys), and only the tables the suite writes are touched', () => {
    const tables = order(scoped.planCleanup(ids));
    const before = (a, b) => expect(tables.indexOf(a)).toBeLessThan(tables.indexOf(b));
    before('notification_delivery_attempts', 'notification_deliveries');
    before('notification_deliveries', 'notifications');
    before('payments', 'invoices');
    for (const child of ['integration_outbox', 'bitrix_deal_links', 'audit_logs', 'case_stage_events', 'documents', 'document_requests', 'request_documents', 'request_events']) before(child, 'cases');
    before('request_documents', 'document_requests');
    before('cases', 'service_requests');
    before('service_requests', 'users');
    for (const child of ['user_consents', 'security_events', 'otp_codes']) before(child, 'users');
    before('admin_webauthn_challenges', 'admin_refresh_tokens');
    before('admin_refresh_tokens', 'admin_sessions');
    before('admin_sessions', 'admin_users');
    before('admin_recovery_approvals', 'admin_recovery_requests');
    before('admin_recovery_requests', 'admin_users');
    const allowed = new Set([
      'notification_delivery_attempts', 'notification_deliveries', 'notifications', 'payments', 'invoices', 'integration_outbox', 'bitrix_deal_links', 'audit_logs',
      'case_stage_events', 'case_communications', 'request_documents', 'document_requests', 'request_events', 'documents', 'cases', 'service_requests', 'otp_codes',
      'security_events', 'user_consents', 'users', 'admin_webauthn_challenges', 'admin_refresh_tokens', 'admin_sessions', 'admin_passkeys', 'admin_invitations',
      'admin_recovery_approvals', 'admin_recovery_requests', 'admin_users', 'geonames_cities',
    ]);
    for (const table of tables) expect(allowed.has(table)).toBe(true);
    expect(tables).not.toContain('integration_inbox'); // the protected inbox is never in a cleanup plan
  });

  test('the GeoNames step names only the fixture ids the suite itself inserted', () => {
    const step = scoped.planCleanup(ids).find((s) => s.table === 'geonames_cities');
    expect(step.params).toEqual([900000001]);
    expect(scoped.planCleanup({ ...ids, fixtureGeonameIds: [] }).some((s) => s.table === 'geonames_cities')).toBe(false);
  });
});

// An in-memory database that records every statement.
function fakeDb({ users = [], admins = [], requests = [], cases = [] } = {}) {
  const log = [];
  const db = {
    log,
    $queryRawUnsafe: jest.fn(async (sql, ...params) => {
      log.push({ sql, params });
      if (/FROM users WHERE email LIKE/.test(sql)) return users;
      if (/FROM admin_users WHERE email LIKE/.test(sql)) return admins;
      if (/FROM service_requests WHERE user_id IN/.test(sql)) return requests;
      if (/FROM cases WHERE service_request_id IN/.test(sql)) return cases;
      if (/SELECT COUNT\(\*\) AS n/.test(sql)) return [{ n: 2n }];
      return [];
    }),
    $executeRawUnsafe: jest.fn(async (sql, ...params) => { log.push({ sql, params }); return 3; }),
    $transaction: jest.fn(async (callback) => callback(db)),
  };
  return db;
}
const started = '2026-11-16T10:00:00.000Z';

describe('running the cleanup', () => {
  const rows = { users: [{ id: 11, email: `patient-${RUN}-1@example.com`, mobile: '+911234567890' }], admins: [{ id: 21 }], requests: [{ id: 31 }], cases: [{ id: 41 }] };

  test('finds the run\'s rows only through the run-specific e-mail patterns and the start time', async () => {
    const db = fakeDb(rows);
    await scoped.runCleanup(db, RUN, { startedAt: started, dryRun: true });
    const finders = db.log.filter((entry) => /FROM (users|admin_users) WHERE email LIKE/.test(entry.sql));
    expect(finders).toHaveLength(2);
    expect(finders[0].params[0]).toBe(`patient-${RUN}-%@example.com`);
    expect(finders[1].params[0]).toBe(`admin-${RUN}-%@example.com`);
    for (const entry of finders) expect(entry.params[1]).toEqual(new Date(started)); // and created at or after the run began
  });

  test('a dry run only counts: no DELETE is issued and no transaction is opened', async () => {
    const db = fakeDb(rows);
    const result = await scoped.runCleanup(db, RUN, { startedAt: started, dryRun: true });
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.log.every((entry) => !/DELETE|UPDATE|INSERT|TRUNCATE|DROP|ALTER/i.test(entry.sql.replace(/FOR UPDATE/gi, '')))).toBe(true);
    expect(result.counts.users).toBe(2);
    expect(result.ids).toEqual({ users: 1, admins: 1, requests: 1, cases: 1 });
  });

  test('a real cleanup runs in ONE transaction and every statement is a DELETE with a run-bound WHERE', async () => {
    const db = fakeDb(rows);
    const result = await scoped.runCleanup(db, RUN, { startedAt: started });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const deletes = db.$executeRawUnsafe.mock.calls;
    expect(deletes.length).toBeGreaterThan(10);
    for (const [sql, ...params] of deletes) {
      expect(sql).toMatch(/^DELETE FROM `[a-z_]+` WHERE .+/);
      expect((sql.match(/\?/g) || []).length).toBe(params.length);
    }
    expect(result.counts.cases).toBe(3);
    // Nothing is ever deleted from the protected tables of other work.
    expect(deletes.some(([sql]) => /integration_inbox/.test(sql))).toBe(false);
  });

  test('with nothing created by the run it deletes nothing at all', async () => {
    const db = fakeDb();
    await scoped.runCleanup(db, RUN, { startedAt: started });
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  test('refuses without the run\'s start time or with an invalid run id', async () => {
    await expect(scoped.runCleanup(fakeDb(), RUN, {})).rejects.toThrow(/start time/);
    await expect(scoped.runCleanup(fakeDb(), 'bad', { startedAt: started })).rejects.toThrow(/run id/);
    expect(() => scoped.removeScopedUploads('bad')).toThrow(/run id/);
  });
});

describe('the snapshot and its comparison', () => {
  test('lists every base table with its count and checksum', async () => {
    const db = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (/information_schema\.TABLES/.test(sql)) return [{ t: 'cases' }, { t: 'users' }, { t: 'bad name;' }];
        if (/COUNT/.test(sql)) return [{ n: 41n }];
        if (/CHECKSUM TABLE/.test(sql)) return [{ Table: 'x', Checksum: 123456789n }];
        return [];
      }),
    };
    const snapshot = await scoped.takeSnapshot(db);
    expect(Object.keys(snapshot.tables)).toEqual(['cases', 'users']); // an unusual name is never interpolated into SQL
    expect(snapshot.tables.cases).toEqual({ count: 41, checksum: '123456789' });
  });

  test('reports exactly the tables whose count or checksum changed, and none when identical', () => {
    const before = { tables: { a: { count: 1, checksum: '1' }, b: { count: 2, checksum: '2' }, c: { count: 3, checksum: '3' } } };
    expect(scoped.compareSnapshots(before, JSON.parse(JSON.stringify(before)))).toEqual([]);
    const after = { tables: { a: { count: 1, checksum: '1' }, b: { count: 3, checksum: '2' }, c: { count: 3, checksum: '9' }, d: { count: 0, checksum: '0' } } };
    expect(scoped.compareSnapshots(before, after).map((d) => d.table)).toEqual(['b', 'c', 'd']);
  });

  test('a protected row that changed in any column is named, an unchanged one is not', async () => {
    const make = (status) => ({ $queryRawUnsafe: jest.fn(async (sql, id) => (id === 411 || id === 55 ? [{ id, status, attempts: 0 }] : [])) });
    const before = await scoped.fingerprintProtected(make('pending'), { integration_outbox: [411], integration_inbox: [55, 56] });
    expect(scoped.compareProtected(before, await scoped.fingerprintProtected(make('pending'), { integration_outbox: [411], integration_inbox: [55, 56] }))).toEqual([]);
    expect(scoped.compareProtected(before, await scoped.fingerprintProtected(make('completed'), { integration_outbox: [411], integration_inbox: [55, 56] }))).toEqual(['integration_outbox#411', 'integration_inbox#55']);
    expect(scoped.PROTECTED_ROWS).toEqual({ integration_outbox: [411], integration_inbox: [55, 57, 58, 59, 60, 61] });
  });

  test('the preflight refuses documents a scan sweep could modify and events that are being processed', async () => {
    const answer = (pending, processing) => ({ $queryRawUnsafe: jest.fn(async (sql) => [{ n: /request_documents/.test(sql) ? pending : processing }]) });
    await expect(scoped.assertPreflight(answer(0, 0))).resolves.toBeUndefined();
    await expect(scoped.assertPreflight(answer(1, 0))).rejects.toThrow(/waiting for a scan/);
    await expect(scoped.assertPreflight(answer(0, 1))).rejects.toThrow(/being processed/);
  });
});

describe('the suite file itself', () => {
  test('keeps its unscoped (empty-WHERE) deleteMany calls inside the branch that scoped runs never take', () => {
    const lines = fs.readFileSync(path.join(__dirname, '..', 'request-review.test.js'), 'utf8').split('\n');
    const unscoped = lines.map((text, i) => ({ text, i })).filter((l) => /\.deleteMany\(\s*\)/.test(l.text));
    expect(unscoped.length).toBeGreaterThan(0);
    for (const { i } of unscoped) {
      // The nearest preceding line that opens a branch must be an "else" (the non-SCOPED side).
      let j = i - 1;
      while (j >= 0 && !/(\bif\b.*\{|\} else \{)\s*$/.test(lines[j])) j -= 1;
      expect(lines[j]).toMatch(/\} else \{\s*$/);
    }
  });

  test('has no other empty-WHERE destructive call on any model', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'request-review.test.js'), 'utf8');
    expect(source).not.toMatch(/\$executeRaw|TRUNCATE|DELETE FROM/);
    expect(source).not.toMatch(/\.updateMany\(\s*\)|\.updateMany\(\{\s*data/);
    const models = [...source.matchAll(/prisma\.(\w+)\.deleteMany\(\s*\)/g)].map((m) => m[1]);
    expect(new Set(models)).toEqual(new Set(['geonamesCity']));
  });
});

// ---- the backup --------------------------------------------------------------------------------------------------------
// mysqldump is replaced by a fake `spawn`; the only files written are in a throw-away folder under the system temp directory.
describe('createBackup', () => {
  const os = require('os');
  const PASSWORD = 'SECRETPW';
  const GOOD_DUMP = `${'-- some dump line\n'.repeat(100)}-- Dump completed on 2026-11-16 18:50:00\n`;
  let dir;
  let file;
  let calls;

  const setUpFolder = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-backup-test-'));
    file = path.join(dir, 'pre-run-backup.sql');
    calls = [];
  };
  const cleanUpFolder = () => fs.rmSync(dir, { recursive: true, force: true });

  // A fake spawn: writes `output` to the file descriptor it was given (like stdout redirected to the dump file) and returns `result`.
  const fakeSpawn = ({ output = GOOD_DUMP, result = { status: 0, signal: null, stderr: '' } } = {}) => jest.fn((command, args, options) => {
    calls.push({ command, args, options });
    if (output) fs.writeSync(options.stdio[1], output);
    return result;
  });
  const backup = (spawn) => scoped.createBackup(GOOD_URL, file, { dump: 'fake-mysqldump', spawn });

  test('success: the dump is written to .part and renamed to .sql only at the end; no .part is left', () => {
    setUpFolder();
    try {
      const spawn = fakeSpawn();
      const result = backup(spawn);
      expect(result).toEqual({ file, bytes: Buffer.byteLength(GOOD_DUMP) });
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.existsSync(`${file}.part`)).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(GOOD_DUMP);
    } finally { cleanUpFolder(); }
  });

  test('uses --set-gtid-purged=OFF and the other safe options, and the password only in the environment, never in the arguments', () => {
    setUpFolder();
    try {
      backup(fakeSpawn());
      const { command, args, options } = calls[0];
      expect(command).toBe('fake-mysqldump');
      expect(args).toEqual(expect.arrayContaining(['--single-transaction', '--no-tablespaces', '--set-gtid-purged=OFF', '-h', 'localhost', '-P', '3306', '-u', 'humancare_test_app', 'humancare_test']));
      expect(args.join(' ')).not.toContain(PASSWORD);
      expect(options.env.MYSQL_PWD).toBe(PASSWORD);
    } finally { cleanUpFolder(); }
  });

  test('a non-zero exit is reported with its exit code and mysqldump\'s stderr, with the password removed, and no .sql exists', () => {
    setUpFolder();
    try {
      const spawn = fakeSpawn({ output: '-- partial header\n', result: { status: 2, signal: null, stderr: `mysqldump: Error: 'Access denied; you need (at least one of) the RELOAD or FLUSH_TABLES privilege(s)'\nwhen trying with ${PASSWORD}\n` } });
      let error;
      try { backup(spawn); } catch (err) { error = err; }
      expect(error).toBeInstanceOf(scoped.ScopedRunError);
      expect(error.message).toMatch(/exit code 2/);
      expect(error.message).toMatch(/RELOAD or FLUSH_TABLES/);
      expect(error.message).not.toContain(PASSWORD);
      expect(error.message).toContain('[hidden]');
      expect(fs.existsSync(file)).toBe(false);
    } finally { cleanUpFolder(); }
  });

  test('a failed dump leaves only the .part file, which is not a valid backup name; nothing is deleted', () => {
    setUpFolder();
    try {
      expect(() => backup(fakeSpawn({ output: '-- partial header\n', result: { status: 1, signal: null, stderr: 'boom' } }))).toThrow(/exit code 1/);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readFileSync(`${file}.part`, 'utf8')).toBe('-- partial header\n');
    } finally { cleanUpFolder(); }
  });

  test('says so when there is no stderr', () => {
    setUpFolder();
    try {
      expect(() => backup(fakeSpawn({ result: { status: 3, signal: null, stderr: '' } }))).toThrow(/exit code 3; no stderr/);
    } finally { cleanUpFolder(); }
  });

  test('long stderr is capped', () => {
    setUpFolder();
    try {
      let error;
      try { backup(fakeSpawn({ result: { status: 2, signal: null, stderr: 'x'.repeat(5000) } })); } catch (err) { error = err; }
      expect(error.message.length).toBeLessThan(900);
      expect(error.message).toContain('...');
    } finally { cleanUpFolder(); }
  });

  test('mysqldump that cannot run is reported with its error code', () => {
    setUpFolder();
    try {
      const spawn = fakeSpawn({ output: '', result: { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), status: null, signal: null, stderr: '' } });
      expect(() => backup(spawn)).toThrow(/could not run: ENOENT/);
      expect(fs.existsSync(file)).toBe(false);
    } finally { cleanUpFolder(); }
  });

  test('an interrupted dump (killed by a signal) is never accepted, even if the file looks complete', () => {
    setUpFolder();
    try {
      expect(() => backup(fakeSpawn({ result: { status: null, signal: 'SIGTERM', stderr: '' } }))).toThrow(/terminated by signal SIGTERM/);
      expect(fs.existsSync(file)).toBe(false);
    } finally { cleanUpFolder(); }
  });

  test('a dump that exits 0 but was cut short (no "Dump completed" line) is not valid and stays a .part file', () => {
    setUpFolder();
    try {
      const truncated = '-- some dump line\n'.repeat(100);
      expect(() => backup(fakeSpawn({ output: truncated }))).toThrow(/not valid.*Dump completed/);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(`${file}.part`)).toBe(true);
    } finally { cleanUpFolder(); }
  });

  test('a tiny dump is not valid, whatever its exit code', () => {
    setUpFolder();
    try {
      expect(() => backup(fakeSpawn({ output: '-- Dump completed\n' }))).toThrow(/only \d+ bytes/);
      expect(fs.existsSync(file)).toBe(false);
    } finally { cleanUpFolder(); }
  });

  test('an existing backup is never overwritten, and mysqldump is not even started', () => {
    setUpFolder();
    try {
      fs.writeFileSync(file, 'an earlier valid backup');
      const spawn = fakeSpawn();
      expect(() => backup(spawn)).toThrow(/already exists/);
      expect(spawn).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, 'utf8')).toBe('an earlier valid backup');
    } finally { cleanUpFolder(); }
  });

  test('refuses without mysqldump, and for a database that is not the test database, before writing anything', () => {
    setUpFolder();
    try {
      expect(() => scoped.createBackup(GOOD_URL, file, { dump: null, spawn: fakeSpawn() })).toThrow(/mysqldump was not found/);
      expect(() => scoped.createBackup(GOOD_URL.replace('/humancare_test', '/humancare_dev'), file, { dump: 'x', spawn: fakeSpawn() })).toThrow(/humancare_test/);
      expect(fs.existsSync(`${file}.part`)).toBe(false);
    } finally { cleanUpFolder(); }
  });
});
