// Brings stored requests in line with today's formats: lowercase gender, care-level keys,
// ISO country code, E.164 contact number. Read-only unless --apply or --rollback is given.
// Procedure, backup, verification and rollback: backend/LEGACY-DATA-NORMALIZATION.md.
//
//   node scripts/normalize-legacy-data.js --env-file .env [--scope privatecharter|all] [--fields a,b] [--review-file review.csv]
//        Report only. Counts per field, what would change, and the rows needing a person's review.
//
//   node scripts/normalize-legacy-data.js --apply --env-file .env --scope privatecharter --fields <stage> \
//        --confirm-database <exact database name> --confirm-backup <mysqldump file> --backup-file <new json file>
//        <stage> is one of two, never both in one run:
//          Stage A: patientGender,country,patientContact (or some of them)
//          Stage B: careLevel alone, which also needs --confirm-display-fix (the PDF, Bitrix and
//                   app display fixes must be deployed first: it changes how requests read there)
//        Only --scope privatecharter can be applied or rolled back; "all" is for reports only.
//        Writes the change list to --backup-file (refuses an existing file or a path inside this
//        repository), then rewrites. Rows that cannot be read with certainty are never changed.
//
//   node scripts/normalize-legacy-data.js --verify   --env-file .env --backup-file <file>
//   node scripts/normalize-legacy-data.js --rollback --env-file .env --backup-file <file> --confirm-database <name>
//
// The report never prints a patient value: counts, row ids and reason codes only.
const fs = require('fs');
const path = require('path');

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (['--apply', '--verify', '--rollback', '--confirm-display-fix'].includes(argv[i])) args[argv[i].slice(2)] = true;
    else if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return args;
}

const fail = (message) => { console.error(`Stopped: ${message}`); process.exitCode = 1; };
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function printReport(result) {
  console.log(`Scope: ${result.scope}`);
  for (const [table, t] of Object.entries(result.tables)) {
    if (t.skipped) { console.log(`\n${table}: ${t.skipped}`); continue; }
    console.log(`\n${table}: ${t.rows} row(s)`);
    for (const [field, c] of Object.entries(t.fields)) {
      console.log(`  ${field.padEnd(15)} empty ${c.empty}, already current ${c.unchanged}, to rewrite ${c.normalize}, needs review ${c.review}`);
    }
  }
  const reasons = {};
  for (const r of result.review) reasons[`${r.table}.${r.field}: ${r.reason}`] = (reasons[`${r.table}.${r.field}: ${r.reason}`] || 0) + 1;
  console.log(`\nValues to rewrite: ${result.changes.length}. Rows left for manual review: ${result.review.length}.`);
  for (const [key, n] of Object.entries(reasons)) console.log(`  review ${key} x${n}`);
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  // dotenv first: the Prisma client reads DATABASE_URL when it is first loaded.
  require('dotenv').config({ path: path.resolve(args['env-file'] || '.env'), override: true, quiet: true });
  const { prisma } = require('../src/db/prisma');
  const backfill = require('../src/common/utils/legacy-backfill');
  try {
    const database = await backfill.databaseName(prisma);
    console.log(`Database: ${database}`);
    const scope = args.scope || 'privatecharter';
    const writing = args.apply || args.rollback;
    if (writing && args['confirm-database'] !== database) {
      return fail(`--confirm-database must be exactly "${database}" (the database this env file points to).`);
    }
    // Writing is for Private Charter requests only, whatever the report was run with.
    if (writing && scope !== 'privatecharter') return fail('--apply and --rollback only work with --scope privatecharter.');
    const allFields = [...backfill.STAGE_A_FIELDS, ...backfill.STAGE_B_FIELDS];
    const fields = args.fields ? args.fields.split(',').map((f) => f.trim()) : undefined;
    if (fields && fields.some((f) => !allFields.includes(f))) return fail(`--fields must be some of: ${allFields.join(', ')}.`);

    if (args.verify || args.rollback) {
      if (!args['backup-file'] || !fs.existsSync(args['backup-file'])) return fail('--backup-file must name an existing backup file.');
      const backup = JSON.parse(fs.readFileSync(args['backup-file'], 'utf8'));
      if (backup.database !== database) return fail(`This backup was taken from "${backup.database}", not "${database}".`);
      if (backup.scope !== 'privatecharter') return fail('This backup is not a Private Charter backup; refusing.');
      if (args.rollback) {
        const done = await backfill.rollback(prisma, backup);
        console.log(`Rolled back ${done.done} value(s); ${done.skipped} left as they are (changed since, or already restored).`);
      }
      console.log('Verification:', JSON.stringify(await backfill.verify(prisma, backup)));
      return undefined;
    }

    const result = await backfill.scan(prisma, { scope, fields });
    printReport(result);
    if (args['review-file']) {
      const lines = ['table,id,field,reason', ...result.review.map((r) => `${r.table},${r.id},${r.field},${r.reason}`)];
      fs.writeFileSync(args['review-file'], `${lines.join('\n')}\n`, { flag: 'wx' });
      console.log(`Review list written to ${args['review-file']} (ids and reasons only).`);
    }
    if (!args.apply) { console.log('\nReport only: nothing was changed.'); return undefined; }

    // --- apply: every condition below must hold before the first row is touched ---------------
    // One stage per run: A (gender, country, phone) or B (care level), never both.
    const isStageA = fields && fields.every((f) => backfill.STAGE_A_FIELDS.includes(f));
    const isStageB = fields && fields.length === 1 && backfill.STAGE_B_FIELDS.includes(fields[0]);
    if (!isStageA && !isStageB) return fail('--apply needs --fields for exactly one stage: Stage A (any of patientGender,country,patientContact) or Stage B (careLevel alone).');
    if (isStageB && !args['confirm-display-fix']) return fail('Stage B (careLevel) changes how requests read in the PDF, Bitrix and the app: pass --confirm-display-fix once those fixes are deployed and tested.');
    const dump = args['confirm-backup'];
    if (!dump || !fs.existsSync(dump) || fs.statSync(dump).size === 0) return fail('--confirm-backup must name a non-empty mysqldump file taken just before this run.');
    if (Date.now() - fs.statSync(dump).mtimeMs > BACKUP_MAX_AGE_MS) return fail('The mysqldump file is older than 24 hours: take a fresh one.');
    const file = args['backup-file'];
    if (!file) return fail('--backup-file is required: where to write the list of old values.');
    if (fs.existsSync(file)) return fail('--backup-file already exists; it is never overwritten.');
    if (backfill.isInside(file, REPO_ROOT)) return fail('--backup-file must be outside this repository: it holds patient data.');
    if (!result.changes.length) { console.log('Nothing to rewrite.'); return undefined; }

    const backup = backfill.writeBackup(file, { database, scope, scan: result });
    console.log(`\nBackup of ${backup.entries.length} value(s) written to ${file}`);
    const done = await backfill.apply(prisma, result.changes);
    console.log(`Rewrote ${done.done} value(s); skipped ${done.skipped} that changed since they were read.`);
    console.log('Verification:', JSON.stringify(await backfill.verify(prisma, backup)));
    return undefined;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // The error class only: a database error message can quote a value.
  console.error(`Failed: ${err && err.code ? err.code : err && err.name ? err.name : 'error'}`);
  process.exitCode = 1;
});
