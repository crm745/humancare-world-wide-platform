// Scans the LEGACY documents (the `documents` table, uploaded before scanning existed) with ClamAV and records the outcome. Procedure and rules: src/modules/documents/legacy-backfill.js.
// Nothing schedules this: it is run by hand.
//
//   Dry run (the default; READ ONLY: no claim, no scan, no row or file is changed):
//     node scripts/backfill-legacy-document-scans.js --env-file .env [--limit 200] [--report report.json]
//
//   Real run (scans, records, writes one audit entry per document, quarantines infected files):
//     node scripts/backfill-legacy-document-scans.js --execute --env-file .env --confirm-database <the exact database name> [--limit 200] [--report report.json]
//
// A real run needs: the migration 20261120100000_document_client_upload_id applied (the scan columns), the audit_logs table (migration M3), the regenerated Prisma client, and ClamAV answering.
// It stops by itself, giving the attempt back, if ClamAV stops answering. Run it again until the report says nothing is left to process: it is idempotent and never rescans a document that
// already has a verdict. The report is JSON on stdout (and in --report): counts by outcome, one line per document with the ids Operations need, and the infected documents that were
// probably forwarded to Bitrix24. It contains no file names. Nothing is ever sent to Bitrix24 by this script.
const fs = require('fs');
const path = require('path');

function argsOf(argv) {
  const out = { execute: false, limit: undefined, envFile: null, report: null, confirmDatabase: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--execute') out.execute = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--env-file') out.envFile = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--confirm-database') out.confirmDatabase = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (!args.envFile) throw new Error('--env-file is required (so the target database is explicit).');
  require('dotenv').config({ path: path.resolve(args.envFile) });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set by that env file.');
  const url = new URL(process.env.DATABASE_URL);
  const database = url.pathname.replace(/^\//, '');
  console.error(`Target: ${url.hostname}:${url.port || '3306'}/${database}   mode: ${args.execute ? 'EXECUTE' : 'dry run (read only)'}`);
  if (args.execute && args.confirmDatabase !== database) throw new Error(`A real run needs --confirm-database ${database} (the exact name of the target database).`);
  if (args.limit !== undefined && !(args.limit >= 1 && args.limit <= 5000)) throw new Error('--limit must be between 1 and 5000.');

  const { prisma } = require('../src/db/prisma');
  const clamav = require('../src/integrations/clamav/clamav');
  const { UPLOAD_DIR } = require('../src/middleware/upload.middleware');
  const { QUARANTINE_DIR } = require('../src/modules/documents/legacy-scan');
  const { backfillLegacyDocuments } = require('../src/modules/documents/legacy-backfill');

  try {
    const report = await backfillLegacyDocuments({
      db: prisma, execute: args.execute, limit: args.limit, scanner: clamav.scanFile, ping: clamav.ping, uploadDir: UPLOAD_DIR, quarantineDir: QUARANTINE_DIR,
      log: (line) => console.error(line),
    });
    const text = JSON.stringify(report, null, 2);
    if (args.report) fs.writeFileSync(path.resolve(args.report), text, { flag: 'wx' }); // never overwrites an earlier report
    console.log(text);
    if (report.aborted) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => { console.error(`backfill: ${err.message}`); process.exitCode = 1; });
