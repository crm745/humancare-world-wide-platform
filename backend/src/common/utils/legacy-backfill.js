// The engine behind scripts/normalize-legacy-data.js: finds the stored values that are still in
// an older format (see legacy-normalize.js), writes them to a backup file, rewrites them with a
// guard, and can verify or undo the rewrite. The database client is passed in, so the tests run
// it against humancare_test and the script against whatever env file the operator names.
//
// Safety properties, each covered by tests/legacy-backfill.test.js:
//   - scan() only reads, and reports counts, ids and reason codes (never a patient value);
//   - a value is rewritten only when legacy-normalize.js reads it with certainty ("normalize");
//     anything else ("review") is left exactly as it is;
//   - only the four columns named below are ever written, never another column (not even
//     updated_at: a data clean-up is not an edit by the patient or by staff);
//   - every UPDATE is guarded by the value that was read (`WHERE col = old`), so a row the
//     patient or staff changed in the meantime is skipped, never overwritten;
//   - rollback restores the old value only where the column still holds the value written.

const fs = require('fs');
const path = require('path');
const { FIELD_NORMALIZERS } = require('./legacy-normalize');
const { PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE } = require('../constants/request.constants');

// Table -> column names. This whitelist is the only place a column or table name comes from,
// which is what makes the dynamic SQL below safe.
const COLUMNS = {
  patientGender: 'patient_gender',
  careLevel: 'care_level',
  country: 'country',
  patientContact: 'patient_contact',
};
const TABLES = {
  service_requests: { privatecharter: { sql: 'service_key = ? OR service_type = ?', params: [PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE] }, all: { sql: '1 = 1', params: [] } },
  // Corporate cases carry no service key, so they are only touched by --scope all.
  cases: { privatecharter: null, all: { sql: '1 = 1', params: [] } },
};
const SCOPES = ['privatecharter', 'all'];
const PAGE = 2000;

const selectList = Object.entries(COLUMNS).map(([field, column]) => `\`${column}\` AS \`${field}\``).join(', ');

async function* rowsOf(prisma, table, filter) {
  let lastId = 0;
  for (;;) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, ${selectList} FROM \`${table}\` WHERE id > ? AND (${filter.sql}) ORDER BY id LIMIT ${PAGE}`,
      lastId, ...filter.params,
    );
    if (!rows.length) return;
    yield* rows;
    lastId = rows[rows.length - 1].id;
  }
}

async function databaseName(prisma) {
  const [row] = await prisma.$queryRawUnsafe('SELECT DATABASE() AS name');
  return row.name;
}

// Reads every in-scope row. Returns the counts and review list for a report, and the exact
// rewrites (`changes`, which hold the old and new value, so keep them out of any log).
async function scan(prisma, { scope = 'privatecharter', fields = Object.keys(COLUMNS) } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of: ${SCOPES.join(', ')}`);
  if (!fields.length || fields.some((field) => !Object.hasOwn(COLUMNS, field))) throw new Error(`fields must be some of: ${Object.keys(COLUMNS).join(', ')}`);
  const result = { scope, fields, tables: {}, review: [], changes: [] };
  for (const [table, scopes] of Object.entries(TABLES)) {
    const filter = scopes[scope];
    const summary = { rows: 0, fields: {} };
    for (const field of fields) summary.fields[field] = { empty: 0, unchanged: 0, normalize: 0, review: 0 };
    result.tables[table] = summary;
    if (!filter) { summary.skipped = 'not in this scope'; continue; }
    for await (const row of rowsOf(prisma, table, filter)) {
      summary.rows += 1;
      for (const field of fields) {
        const outcome = FIELD_NORMALIZERS[field](row[field]);
        summary.fields[field][outcome.status] += 1;
        if (outcome.status === 'review') result.review.push({ table, id: row.id, field, reason: outcome.reason });
        if (outcome.status === 'normalize') result.changes.push({ table, id: row.id, field, old: row[field], new: outcome.value });
      }
    }
  }
  return result;
}

// Writes the rows about to change. 'wx': never replaces an existing file. The file holds
// personal data (phone numbers): the script keeps it out of the repository.
function writeBackup(file, { database, scope, scan: scanned }) {
  const body = {
    createdAt: new Date().toISOString(),
    database,
    scope,
    fields: scanned.fields,
    rowCounts: Object.fromEntries(Object.entries(scanned.tables).map(([table, t]) => [table, t.rows])),
    entries: scanned.changes,
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 1), { flag: 'wx', mode: 0o600 });
  // Read it back: a backup that cannot be parsed is not a backup.
  const check = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(check.entries) || check.entries.length !== scanned.changes.length) {
    throw new Error('The backup file could not be verified; nothing was changed.');
  }
  return check;
}

function updateSql(table, field) {
  if (!TABLES[table] || !COLUMNS[field]) throw new Error('Unknown table or field.');
  // BINARY: the guard compares exact bytes ("Male" is not "male" here, whatever the collation).
  return `UPDATE \`${table}\` SET \`${COLUMNS[field]}\` = ? WHERE id = ? AND BINARY \`${COLUMNS[field]}\` = BINARY ?`;
}

async function runGuarded(prisma, items, { from, to }) {
  let done = 0;
  let skipped = 0;
  for (const item of items) {
    const changed = await prisma.$executeRawUnsafe(updateSql(item.table, item.field), item[to], item.id, item[from]);
    if (changed === 1) done += 1; else skipped += 1;
  }
  return { done, skipped };
}

// Rewrites old -> new, one guarded UPDATE per value. `skipped` counts rows that no longer held
// the value that was read (edited meanwhile): they are left as they are.
const apply = (prisma, changes) => runGuarded(prisma, changes, { from: 'old', to: 'new' });
// Restores new -> old from a backup, only where the column still holds the value written.
const rollback = (prisma, backup) => runGuarded(prisma, backup.entries, { from: 'new', to: 'old' });

// Compares the backup with the database now: written, restored, or changed since by someone else.
async function verify(prisma, backup) {
  const tally = { applied: 0, restored: 0, changedSince: 0, missing: 0 };
  for (const entry of backup.entries) {
    if (!TABLES[entry.table] || !COLUMNS[entry.field]) throw new Error('Unknown table or field in the backup file.');
    const rows = await prisma.$queryRawUnsafe(`SELECT \`${COLUMNS[entry.field]}\` AS value FROM \`${entry.table}\` WHERE id = ?`, entry.id);
    if (!rows.length) tally.missing += 1;
    else if (rows[0].value === entry.new) tally.applied += 1;
    else if (rows[0].value === entry.old) tally.restored += 1;
    else tally.changedSince += 1;
  }
  const rowCounts = {};
  for (const table of Object.keys(backup.rowCounts)) {
    const [row] = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${(TABLES[table][backup.scope] || { sql: '1 = 0' }).sql}`, ...((TABLES[table][backup.scope] || { params: [] }).params));
    rowCounts[table] = { before: backup.rowCounts[table], now: Number(row.n) };
  }
  return { ...tally, rowCounts };
}

// A repository path would put patient data one `git add` from a commit.
function isInside(file, folder) {
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The two stages of the backfill (LEGACY-DATA-NORMALIZATION.md). Stage A is invisible to Bitrix, the PDF
// and the app; Stage B (care level) changes how a request reads on those screens, so it only runs
// once the display fixes are deployed. They are never combined in one run.
const STAGE_A_FIELDS = ['patientGender', 'country', 'patientContact'];
const STAGE_B_FIELDS = ['careLevel'];

module.exports = { STAGE_A_FIELDS, STAGE_B_FIELDS, scan, writeBackup, apply, rollback, verify, databaseName, isInside, SCOPES, COLUMNS };
