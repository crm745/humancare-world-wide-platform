// The legacy-data backfill against the real test database (humancare_test): what it finds, what it
// rewrites, what it must never touch, and that a rewrite can be verified and undone.
//
// The test database is shared with every other suite, which leave their own requests and cases in
// it. So this suite never deletes or counts what it did not create: it removes only its own rows,
// and judges the scan's output through the ids of its own rows (or as a before/after difference).
// A "foreign" Private Charter request in an old format is planted on purpose, standing for another
// suite's leftover: every run of the command line in here must rewrite and restore it exactly as it
// does any other row, and expected counts are computed from a scan, never assumed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { prisma } = require('../src/db/prisma');
const backfill = require('../src/common/utils/legacy-backfill');
const { PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE } = require('../src/common/constants/request.constants');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'normalize-legacy-data.js');
const BACKEND = path.join(__dirname, '..');
const PREFIX = 'BF-';

let user;
let foreignUser;
let foreign;
let folder;
let counter = 0;
const mine = { service_requests: new Set(), cases: new Set() };
const isMine = (entry) => mine[entry.table].has(entry.id);

beforeAll(async () => {
  // Never anything but the dedicated test database.
  expect(await backfill.databaseName(prisma)).toBe('humancare_test');
  user = await prisma.user.create({ data: { name: 'Backfill Tester', email: `backfill-${Date.now()}@example.test`, mobile: `+9715${String(Date.now()).slice(-8)}` } });
  foreignUser = await prisma.user.create({ data: { name: 'Foreign Tester', email: `foreign-${Date.now()}@example.test`, mobile: `+9716${String(Date.now()).slice(-8)}` } });
  foreign = await prisma.serviceRequest.create({
    data: {
      userId: foreignUser.id, serviceType: PRIVATE_CHARTER_SERVICE_TYPE, serviceKey: PRIVATE_CHARTER_KEY, patientName: 'Foreign Patient',
      origin: 'o', destination: 'd', referenceNumber: `${PREFIX}foreign-${Date.now()}`,
      patientGender: 'Male', careLevel: 'care_icu, care_na-not-a-key', country: 'Egypt', patientContact: '+20 100 123 4567',
    },
  });
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-test-'));
});
afterAll(async () => {
  fs.rmSync(folder, { recursive: true, force: true });
  // Leave nothing behind for the suites that run after this one.
  await prisma.case.deleteMany({ where: { referenceNumber: { startsWith: PREFIX } } });
  await prisma.serviceRequest.deleteMany({ where: { userId: { in: [user.id, foreignUser.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [user.id, foreignUser.id] } } });
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.case.deleteMany({ where: { referenceNumber: { startsWith: PREFIX } } });
  await prisma.serviceRequest.deleteMany({ where: { userId: user.id } });
  mine.service_requests.clear();
  mine.cases.clear();
});

const ref = () => { counter += 1; return `${PREFIX}${Date.now()}-${counter}`; };
async function makeRequest(over = {}) {
  const row = await prisma.serviceRequest.create({
    data: {
      userId: user.id, serviceType: PRIVATE_CHARTER_SERVICE_TYPE, serviceKey: PRIVATE_CHARTER_KEY,
      patientName: 'Asha Rao', patientAge: 61, origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates',
      description: 'BP <90/60; keep exactly', referenceNumber: ref(), ...over,
    },
  });
  mine.service_requests.add(row.id);
  return row;
}
async function makeCase(over = {}) {
  const row = await prisma.case.create({
    data: { referenceNumber: ref(), patientName: 'Case Patient', serviceType: 'Ground Ambulance', origin: 'a', destination: 'b', ...over },
  });
  mine.cases.add(row.id);
  return row;
}
const oldFormats = { patientGender: 'Female', careLevel: 'ICU / Critical, स्थिर / निगरानी में', country: 'India', patientContact: '+971 501234567' };
const reload = (id) => prisma.serviceRequest.findUnique({ where: { id } });
const backupPath = () => path.join(folder, `backup-${++counter}.json`);

// A scan limited to this suite's own rows: what apply() and writeBackup() are given.
async function scanMine(scope = 'privatecharter') {
  const scanned = await backfill.scan(prisma, { scope });
  return { ...scanned, changes: scanned.changes.filter(isMine), review: scanned.review.filter(isMine) };
}
const tallies = (scanned) => scanned.tables.service_requests.fields;
const difference = (before, after) => Object.fromEntries(Object.keys(after).map((field) => [
  field, Object.fromEntries(Object.keys(after[field]).map((status) => [status, after[field][status] - before[field][status]])),
]));

describe('scan: report only', () => {
  it('counts what would change and what needs review, per field', async () => {
    const before = await backfill.scan(prisma, { scope: 'privatecharter' });
    await makeRequest(oldFormats);
    await makeRequest({ patientGender: 'female', careLevel: 'care_icu', country: 'IN', patientContact: '+919876543210' });
    await makeRequest({ patientGender: 'M', careLevel: 'oxygen please', country: 'Atlantis', patientContact: '9876543210' });
    await makeRequest({});

    const after = await backfill.scan(prisma, { scope: 'privatecharter' });
    expect(after.tables.service_requests.rows - before.tables.service_requests.rows).toBe(4);
    const each = { empty: 1, unchanged: 1, normalize: 1, review: 1 };
    expect(difference(tallies(before), tallies(after))).toEqual({
      patientGender: each, careLevel: each, country: each, patientContact: each,
    });
    expect(after.changes.filter(isMine)).toHaveLength(4);
    expect(after.review.filter(isMine).map((r) => r.reason).sort()).toEqual([
      'care_level_unrecognised_value', 'country_unrecognised', 'gender_unrecognised', 'phone_without_country_code',
    ]);
  });

  it('writes nothing', async () => {
    const row = await makeRequest(oldFormats);
    const before = await reload(row.id);
    await backfill.scan(prisma, { scope: 'all' });
    expect(await reload(row.id)).toEqual(before);
  });

  it('puts only ids and reason codes in the review list, never a patient value', async () => {
    await makeRequest({ patientGender: 'Zephyrina', careLevel: 'Zephyrina', country: 'Zephyrina', patientContact: 'Zephyrina' });
    const { review } = await scanMine();
    expect(review).toHaveLength(4);
    expect(JSON.stringify((await backfill.scan(prisma, { scope: 'all' })).review)).not.toContain('Zephyrina');
    for (const r of review) expect(Object.keys(r).sort()).toEqual(['field', 'id', 'reason', 'table']);
  });

  it('scope "privatecharter" ignores other services and corporate cases; "all" includes them', async () => {
    const pc = await makeRequest(oldFormats);
    const other = await makeRequest({ serviceType: 'Ground Ambulance', serviceKey: 'ground', ...oldFormats });
    const corporateCase = await makeCase(oldFormats);

    const narrow = await scanMine('privatecharter');
    expect(narrow.tables.cases.rows).toBe(0);
    expect(narrow.changes.every((c) => c.table === 'service_requests' && c.id === pc.id)).toBe(true);
    expect(narrow.changes).toHaveLength(4);

    const wide = await scanMine('all');
    const ids = (table) => new Set(wide.changes.filter((c) => c.table === table).map((c) => c.id));
    expect(ids('service_requests')).toEqual(new Set([pc.id, other.id]));
    expect(ids('cases')).toEqual(new Set([corporateCase.id]));
  });

  it('finds a Private Charter request by service name when its key is missing', async () => {
    const row = await makeRequest({ serviceKey: null, ...oldFormats });
    expect((await scanMine('privatecharter')).changes.every((c) => c.id === row.id)).toBe(true);
    expect((await scanMine('privatecharter')).changes).toHaveLength(4);
  });

  it('rejects an unknown scope', async () => {
    await expect(backfill.scan(prisma, { scope: 'everything' })).rejects.toThrow(/scope/);
  });
});

describe('scan: fields', () => {
  it('looks at the fields asked for and nothing else', async () => {
    const row = await makeRequest(oldFormats);
    const stageB = await backfill.scan(prisma, { scope: 'privatecharter', fields: ['careLevel'] });
    expect(Object.keys(stageB.tables.service_requests.fields)).toEqual(['careLevel']);
    expect(stageB.changes.filter((c) => c.id === row.id).map((c) => c.field)).toEqual(['careLevel']);
    const stageA = await backfill.scan(prisma, { scope: 'privatecharter', fields: backfill.STAGE_A_FIELDS });
    expect(stageA.changes.filter((c) => c.id === row.id).map((c) => c.field).sort()).toEqual(['country', 'patientContact', 'patientGender']);
  });

  it('keeps the stages apart: Stage A and Stage B share no field, and together they are every field', () => {
    expect(backfill.STAGE_A_FIELDS.filter((f) => backfill.STAGE_B_FIELDS.includes(f))).toEqual([]);
    expect([...backfill.STAGE_A_FIELDS, ...backfill.STAGE_B_FIELDS].sort()).toEqual(Object.keys(backfill.COLUMNS).sort());
  });

  it('rejects an empty or unknown field list', async () => {
    await expect(backfill.scan(prisma, { fields: [] })).rejects.toThrow(/fields/);
    await expect(backfill.scan(prisma, { fields: ['patientName'] })).rejects.toThrow(/fields/);
    await expect(backfill.scan(prisma, { fields: ['__proto__'] })).rejects.toThrow(/fields/);
  });
});

describe('apply', () => {
  it('rewrites the four columns and changes nothing else on the row', async () => {
    const row = await makeRequest(oldFormats);
    const before = await reload(row.id);
    const scanned = await scanMine();
    backfill.writeBackup(backupPath(), { database: 'humancare_test', scope: 'privatecharter', scan: scanned });
    expect(await backfill.apply(prisma, scanned.changes)).toEqual({ done: 4, skipped: 0 });

    const after = await reload(row.id);
    expect(after).toMatchObject({
      patientGender: 'female', careLevel: 'care_icu,care_stable', country: 'IN', patientContact: '+971501234567',
    });
    // Every other column, updatedAt included, is exactly as it was.
    const untouched = (r) => { const { patientGender, careLevel, country, patientContact, ...rest } = r; return rest; };
    expect(untouched(after)).toEqual(untouched(before));
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('leaves rows that need review exactly as they are, while rewriting the readable ones next to them', async () => {
    const odd = await makeRequest({ patientGender: 'M', careLevel: 'care_icu, mystery', country: 'Atlantis', patientContact: '9876543210' });
    const fine = await makeRequest(oldFormats);
    const before = await reload(odd.id);
    await backfill.apply(prisma, (await scanMine()).changes);
    expect(await reload(odd.id)).toEqual(before);
    expect((await reload(fine.id)).careLevel).toBe('care_icu,care_stable');
  });

  it('is idempotent: a second scan finds nothing to rewrite', async () => {
    await makeRequest(oldFormats);
    await backfill.apply(prisma, (await scanMine()).changes);
    const again = await scanMine();
    expect(again.changes).toHaveLength(0);
    expect(await backfill.apply(prisma, again.changes)).toEqual({ done: 0, skipped: 0 });
  });

  it('skips a value that changed between the scan and the rewrite', async () => {
    const row = await makeRequest(oldFormats);
    const scanned = await scanMine();
    // Staff correct the phone number after the scan has read it.
    await prisma.serviceRequest.update({ where: { id: row.id }, data: { patientContact: '+971559990000' } });
    expect(await backfill.apply(prisma, scanned.changes)).toEqual({ done: 3, skipped: 1 });
    expect((await reload(row.id)).patientContact).toBe('+971559990000');
  });

  it('never rewrites a value that merely differs in case from the one read (binary guard)', async () => {
    const row = await makeRequest({ patientGender: 'Male' });
    const scanned = await scanMine();
    await prisma.serviceRequest.update({ where: { id: row.id }, data: { patientGender: 'MALE' } });
    expect(await backfill.apply(prisma, scanned.changes)).toEqual({ done: 0, skipped: 1 });
    expect((await reload(row.id)).patientGender).toBe('MALE');
  });

  it('does not touch another service in the default scope', async () => {
    const other = await makeRequest({ serviceType: 'Ground Ambulance', serviceKey: 'ground', ...oldFormats });
    const before = await reload(other.id);
    const scanned = await backfill.scan(prisma, { scope: 'privatecharter' });
    expect(scanned.changes.some(isMine)).toBe(false);
    await backfill.apply(prisma, scanned.changes.filter(isMine));
    expect(await reload(other.id)).toEqual(before);
  });

  it('keeps the number of rows and the patient data of every row', async () => {
    const a = await makeRequest(oldFormats);
    const b = await makeRequest({ patientName: 'Ben Okafor', patientAge: 34, ...oldFormats });
    await backfill.apply(prisma, (await scanMine()).changes);
    expect(await prisma.serviceRequest.count({ where: { userId: user.id } })).toBe(2);
    expect(await reload(a.id)).toMatchObject({ patientName: 'Asha Rao', patientAge: 61, description: 'BP <90/60; keep exactly' });
    expect(await reload(b.id)).toMatchObject({ patientName: 'Ben Okafor', patientAge: 34 });
  });

  it('also rewrites corporate cases when the scope is "all"', async () => {
    const created = await makeCase({ careLevel: 'care_icu, care_stable', patientGender: 'Male' });
    await backfill.apply(prisma, (await scanMine('all')).changes);
    expect(await prisma.case.findUnique({ where: { id: created.id } })).toMatchObject({ careLevel: 'care_icu,care_stable', patientGender: 'male' });
  });
});

describe('backup, verify and rollback', () => {
  it('writes every old and new value to a new file, and never replaces an existing one', async () => {
    const row = await makeRequest(oldFormats);
    const scanned = await scanMine();
    const file = backupPath();
    const backup = backfill.writeBackup(file, { database: 'humancare_test', scope: 'privatecharter', scan: scanned });
    expect(backup.entries).toHaveLength(4);
    expect(backup.entries.find((e) => e.field === 'country')).toEqual({ table: 'service_requests', id: row.id, field: 'country', old: 'India', new: 'IN' });
    expect(typeof backup.rowCounts.service_requests).toBe('number');
    expect(() => backfill.writeBackup(file, { database: 'humancare_test', scope: 'privatecharter', scan: scanned })).toThrow(/EEXIST/);
  });

  it('verify reports applied values, and the row counts before and now', async () => {
    await makeRequest(oldFormats);
    const scanned = await scanMine();
    const backup = backfill.writeBackup(backupPath(), { database: 'humancare_test', scope: 'privatecharter', scan: scanned });
    await backfill.apply(prisma, scanned.changes);
    const result = await backfill.verify(prisma, backup);
    expect(result).toMatchObject({ applied: 4, restored: 0, changedSince: 0, missing: 0 });
    for (const counts of Object.values(result.rowCounts)) expect(counts.now).toBe(counts.before);
  });

  it('rollback restores the exact old values', async () => {
    const row = await makeRequest(oldFormats);
    const before = await reload(row.id);
    const scanned = await scanMine();
    const backup = backfill.writeBackup(backupPath(), { database: 'humancare_test', scope: 'privatecharter', scan: scanned });
    await backfill.apply(prisma, scanned.changes);
    expect(await backfill.rollback(prisma, backup)).toEqual({ done: 4, skipped: 0 });
    expect(await reload(row.id)).toEqual(before);
    expect(await backfill.verify(prisma, backup)).toMatchObject({ applied: 0, restored: 4 });
  });

  it('rollback leaves a value that was changed after the rewrite', async () => {
    const row = await makeRequest(oldFormats);
    const scanned = await scanMine();
    const backup = backfill.writeBackup(backupPath(), { database: 'humancare_test', scope: 'privatecharter', scan: scanned });
    await backfill.apply(prisma, scanned.changes);
    await prisma.serviceRequest.update({ where: { id: row.id }, data: { country: 'AE' } });
    expect(await backfill.rollback(prisma, backup)).toEqual({ done: 3, skipped: 1 });
    expect((await reload(row.id)).country).toBe('AE');
  });

  it('refuses a backup that names a table or field outside the whitelist', async () => {
    await expect(backfill.verify(prisma, { scope: 'all', rowCounts: {}, entries: [{ table: 'users', id: 1, field: 'country', old: 'a', new: 'b' }] })).rejects.toThrow(/Unknown/);
    await expect(backfill.rollback(prisma, { entries: [{ table: 'service_requests', id: 1, field: 'x`; DROP TABLE users; --', old: 'a', new: 'b' }] })).rejects.toThrow(/Unknown/);
  });

  it('flags a backup path inside the repository', () => {
    const repo = path.join(BACKEND, '..');
    expect(backfill.isInside(path.join(repo, 'backend', 'b.json'), repo)).toBe(true);
    expect(backfill.isInside(path.join(os.tmpdir(), 'b.json'), repo)).toBe(false);
  });
});

describe('command line safeguards (run against humancare_test)', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--env-file', '.env.test', ...args], { cwd: BACKEND, encoding: 'utf8' });
  const number = (text, pattern) => Number((text.match(pattern) || [])[1]);

  it('report mode prints counts and changes nothing', async () => {
    const row = await makeRequest(oldFormats);
    const before = await reload(row.id);
    const out = run();
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Database: humancare_test');
    expect(out.stdout).toContain('Report only: nothing was changed.');
    expect(out.stdout).toMatch(/patientGender\s+empty \d+, already current \d+, to rewrite \d+, needs review \d+/);
    // The printed total is the scan's own total, whoever owns the rows.
    const all = await backfill.scan(prisma, { scope: 'privatecharter' });
    expect(number(out.stdout, /Values to rewrite: (\d+)\./)).toBe(all.changes.length);
    expect(number(out.stdout, /Rows left for manual review: (\d+)\./)).toBe(all.review.length);
    expect(await reload(row.id)).toEqual(before);
    // No patient value anywhere in the output.
    for (const secret of ['Asha', 'Female', '+971 501234567', 'ICU / Critical']) expect(out.stdout + out.stderr).not.toContain(secret);
  });

  it('writes a review list of ids and reasons only', async () => {
    const row = await makeRequest({ country: 'Atlantis' });
    const file = path.join(folder, `review-${++counter}.csv`);
    expect(run('--review-file', file).status).toBe(0);
    const csv = fs.readFileSync(file, 'utf8');
    expect(csv.startsWith('table,id,field,reason\n')).toBe(true);
    expect(csv).toContain(`service_requests,${row.id},country,country_unrecognised\n`);
    expect(csv).not.toContain('Atlantis');
  });

  it('--apply refuses a wrong database confirmation, and changes nothing', async () => {
    const row = await makeRequest(oldFormats);
    const before = await reload(row.id);
    const out = run('--apply', '--confirm-database', 'humancare_dev');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('--confirm-database must be exactly "humancare_test"');
    expect(await reload(row.id)).toEqual(before);
  });

  it('--apply refuses without a recent mysqldump, an existing backup path, or a path inside the repo', async () => {
    const row = await makeRequest(oldFormats);
    const before = await reload(row.id);
    const dump = path.join(folder, 'dump.sql');
    const base = ['--apply', '--confirm-database', 'humancare_test', '--fields', 'patientGender'];

    expect(run(...base).stderr).toContain('--confirm-backup');
    fs.writeFileSync(dump, '');
    expect(run(...base, '--confirm-backup', dump).stderr).toContain('non-empty mysqldump');

    fs.writeFileSync(dump, '-- dump');
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(dump, old, old);
    expect(run(...base, '--confirm-backup', dump).stderr).toContain('older than 24 hours');

    const now = new Date();
    fs.utimesSync(dump, now, now);
    expect(run(...base, '--confirm-backup', dump).stderr).toContain('--backup-file is required');
    const existing = path.join(folder, 'existing.json');
    fs.writeFileSync(existing, '{}');
    expect(run(...base, '--confirm-backup', dump, '--backup-file', existing).stderr).toContain('already exists');
    expect(run(...base, '--confirm-backup', dump, '--backup-file', path.join(BACKEND, 'tmp-backup.json')).stderr).toContain('outside this repository');

    expect(fs.existsSync(path.join(BACKEND, 'tmp-backup.json'))).toBe(false);
    expect(await reload(row.id)).toEqual(before);
  });

  const dumpFile = () => {
    const dump = path.join(folder, `dump-${++counter}.sql`);
    fs.writeFileSync(dump, '-- dump');
    return dump;
  };

  it('applies Stage A end to end, then verifies and rolls back; care level stays untouched', async () => {
    const row = await makeRequest(oldFormats);
    const before = await reload(row.id);
    const foreignBefore = await reload(foreign.id);
    const file = backupPath();
    // What the run must do, from a scan: this row's three values plus whatever else is in scope.
    const expected = (await backfill.scan(prisma, { scope: 'privatecharter', fields: backfill.STAGE_A_FIELDS })).changes.length;
    expect(expected).toBeGreaterThanOrEqual(3 + 3); // this row, and the planted foreign row (gender, country, phone)

    const applied = run('--apply', '--fields', 'patientGender,country,patientContact', '--confirm-database', 'humancare_test', '--confirm-backup', dumpFile(), '--backup-file', file);
    expect(applied.status).toBe(0);
    expect(number(applied.stdout, /Rewrote (\d+) value\(s\)/)).toBe(expected);
    expect(applied.stdout).toContain('skipped 0');
    expect(await reload(foreign.id)).toMatchObject({ patientGender: 'male', country: 'EG', patientContact: '+201001234567', careLevel: foreignBefore.careLevel });
    const after = await reload(row.id);
    expect(after).toMatchObject({ patientGender: 'female', country: 'IN', patientContact: '+971501234567' });
    expect(after.careLevel).toBe(before.careLevel); // Stage B has not run
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).fields).toEqual(['patientGender', 'country', 'patientContact']);

    expect(number(run('--verify', '--backup-file', file).stdout, /"applied":(\d+)/)).toBe(expected);

    const refused = run('--rollback', '--backup-file', file, '--confirm-database', 'humancare_dev');
    expect(refused.status).toBe(1);
    expect((await reload(row.id)).country).toBe('IN');

    const rolled = run('--rollback', '--backup-file', file, '--confirm-database', 'humancare_test');
    expect(number(rolled.stdout, /Rolled back (\d+) value\(s\)/)).toBe(expected);
    expect(await reload(row.id)).toEqual(before);
    expect(await reload(foreign.id)).toEqual(foreignBefore);
  });

  it('applies Stage B (care level alone) only with --confirm-display-fix, and touches nothing else', async () => {
    const row = await makeRequest(oldFormats);
    const before = await reload(row.id);
    const foreignBefore = await reload(foreign.id);
    const common = ['--apply', '--fields', 'careLevel', '--confirm-database', 'humancare_test', '--confirm-backup', dumpFile()];

    const without = run(...common, '--backup-file', backupPath());
    expect(without.status).toBe(1);
    expect(without.stderr).toContain('--confirm-display-fix');
    expect(await reload(row.id)).toEqual(before);

    const file = backupPath();
    const applied = run(...common, '--confirm-display-fix', '--backup-file', file);
    expect(applied.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).fields).toEqual(['careLevel']);
    const after = await reload(row.id);
    expect(after.careLevel).toBe('care_icu,care_stable');
    expect({ ...after, careLevel: null }).toEqual({ ...before, careLevel: null });

    // The planted row's care level is not readable with certainty, so Stage B leaves it alone.
    expect(await reload(foreign.id)).toEqual(foreignBefore);

    run('--rollback', '--backup-file', file, '--confirm-database', 'humancare_test');
    expect(await reload(row.id)).toEqual(before);
    expect(await reload(foreign.id)).toEqual(foreignBefore);
  });

  it('never combines the stages, never applies without --fields, and rejects unknown fields', async () => {
    const row = await makeRequest(oldFormats);
    const before = await reload(row.id);
    const common = ['--apply', '--confirm-database', 'humancare_test', '--confirm-backup', dumpFile(), '--confirm-display-fix'];

    const none = run(...common, '--backup-file', backupPath());
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('--apply needs --fields');
    const mixed = run(...common, '--fields', 'country,careLevel', '--backup-file', backupPath());
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toContain('--apply needs --fields');
    const unknown = run(...common, '--fields', 'patientName', '--backup-file', backupPath());
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('--fields must be some of');
    expect(await reload(row.id)).toEqual(before);
  });

  it('rejects any scope other than privatecharter for --apply and --rollback, but still reports on "all"', async () => {
    const row = await makeRequest(oldFormats);
    const before = await reload(row.id);
    const apply = run('--apply', '--scope', 'all', '--fields', 'country', '--confirm-database', 'humancare_test', '--confirm-backup', dumpFile(), '--backup-file', backupPath());
    expect(apply.status).toBe(1);
    expect(apply.stderr).toContain('only work with --scope privatecharter');
    const rollback = run('--rollback', '--scope', 'all', '--backup-file', backupPath(), '--confirm-database', 'humancare_test');
    expect(rollback.status).toBe(1);
    expect(rollback.stderr).toContain('only work with --scope privatecharter');
    expect(await reload(row.id)).toEqual(before);
    expect(run('--scope', 'all').status).toBe(0);
  });

  it('refuses to roll back or verify a backup made with another scope', async () => {
    const file = path.join(folder, `allscope-${++counter}.json`);
    fs.writeFileSync(file, JSON.stringify({ database: 'humancare_test', scope: 'all', rowCounts: {}, entries: [] }));
    for (const mode of ['--verify', '--rollback']) {
      const out = run(mode, '--backup-file', file, '--confirm-database', 'humancare_test');
      expect(out.status).toBe(1);
      expect(out.stderr).toContain('not a Private Charter backup');
    }
  });

  it('reports only the fields asked for', async () => {
    await makeRequest(oldFormats);
    const out = run('--fields', 'careLevel');
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/careLevel\s+empty/);
    expect(out.stdout).not.toMatch(/patientGender\s+empty/);
  });

  it('refuses a backup taken from another database', async () => {
    const file = path.join(folder, `foreign-${++counter}.json`);
    fs.writeFileSync(file, JSON.stringify({ database: 'humancare_dev', scope: 'privatecharter', rowCounts: {}, entries: [] }));
    const out = run('--verify', '--backup-file', file);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('taken from "humancare_dev"');
  });
});
