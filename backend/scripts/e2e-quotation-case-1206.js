// A guarded, ONE-CASE run of the Bitrix24 quotation synchronization and scan for the development database (humancare_dev, localhost):
// Deal 21846 (Category 0, profile "actual") | CASE-1206 | REQ-1208 | the development S3 bucket. NOT src/worker.js: no job runner, no inbox, no reconcile.
//
//   node scripts/e2e-quotation-case-1206.js                              DRY RUN (default): database reads only. No Bitrix call, no event, no S3 call, no download, no scan.
//   node scripts/e2e-quotation-case-1206.js --execute --confirm CASE-1206   ONE guarded pass: read the Deal, queue ONE event, run ONE scoped sync pass, ONE scoped scan pass.
//
// backend/.env is READ (dotenv) and never written; the switches and BITRIX_DEAL_PROFILE=actual exist in memory for this process only. Output never contains a
// credential, webhook, token or signed URL. See scripts/lib/quotation-case-1206.js for every rule. Exit code: 0 = dry run ready / execute succeeded, 1 = refused
// or failed, 2 = executed but the end state is not the expected one (stop and investigate; do not re-run).
require('dotenv').config({ quiet: true }); // before Prisma and the storage layer, which read their settings from the environment
const lib = require('./lib/quotation-case-1206');

async function main(argv) {
  let options;
  try { options = lib.parseArgs(argv); } catch (err) { console.error(`Quotation E2E: ${err.message}. Use no arguments (dry run) or: --execute --confirm CASE-1206`); return 1; }

  const { prisma } = require('../src/db/prisma');
  const realApi = require('../src/modules/bitrix/bitrix-deal.api');
  const clamav = require('../src/integrations/clamav/clamav');
  const { sharedDispatcher } = require('../src/modules/bitrix/queue/dispatcher');
  const { makeGuard } = require('./e2e-quotation-sync');
  const { detectAndEnqueueQuotationSync } = require('../src/modules/bitrix/quotation-outbox');
  const { runQuotationSync } = require('../src/modules/bitrix/quotation-sync.service');
  const { sweepPendingQuotationScans } = require('../src/modules/bitrix/quotation-scan.service');
  const { createQuotationStorage } = require('../src/modules/bitrix/quotation-storage');

  try {
    const report = await lib.run(options, {
      prisma, env: process.env, log: console, realApi, makeGuard, gateway: sharedDispatcher(), clamReady: () => clamav.isReady(),
      createStorage: () => createQuotationStorage(),
      s3Probe: (key) => require('../src/storage').storageForProvider('s3').exists(key), // execute only: a read-only HEAD of a key that does not exist
      services: { detect: detectAndEnqueueQuotationSync, runSync: runQuotationSync, sweep: sweepPendingQuotationScans },
    });
    print(report);
    if (!report.ready && report.mode === 'dry-run') return 1;
    if (report.mode === 'execute' && !report.succeeded) { console.error('WARNING: the end state is not the expected one. Stop and investigate; do not re-run.'); return 2; }
    return 0;
  } catch (err) {
    console.error(err && err.name === 'Refused' ? `Quotation E2E ${err.message}. Nothing was changed by this check.` : `Quotation E2E failed: ${(err && (err.code || err.name)) || 'error'}. Check the state before any re-run.`);
    return 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

// The snapshots are summarised, never dumped: counts and statuses only.
function print(r) {
  const brief = (s) => (s ? { case: s.caseRow, link: s.link, quotations: s.quotations.map((q) => ({ id: q.id, v: q.version_number, status: q.status, scan: q.scan_status, provider: q.storage_provider })), caseEvents: s.events, invoices: s.money.invoices, payments: s.money.payments, stageEvents: s.money.stage_events, patientNotifications: s.money.patient_notifications, others: { outbox: s.otherOutbox.length, quotations: s.otherQuotations.length, inbox: s.inbox.length, links: s.otherLinks.length } } : undefined);
  const { before, after, ...rest } = r;
  console.log(JSON.stringify({ ...rest, before: brief(before), after: brief(after) }, (k, v) => (v instanceof Date ? v.toISOString() : v), 2));
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
