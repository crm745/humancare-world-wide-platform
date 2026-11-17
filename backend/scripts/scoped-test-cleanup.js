// Targeted cleanup of ONE scoped test run, for a run that crashed before its own teardown finished.
//
//   node scripts/scoped-test-cleanup.js <runId>            DRY RUN (default): counts what would be deleted, deletes nothing
//   node scripts/scoped-test-cleanup.js <runId> --apply    deletes the run's own rows (found through the run id in their
//                                                           e-mail addresses) and verifies the snapshot
//
// Loads ONLY backend/.env.test, validates the URL, asks the server to confirm humancare_test as a test user, and reads
// .scoped-runs/<runId>/manifest.json (written by the run's global setup). It never touches a row that does not carry the run id.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const testGuard = require('../src/common/safety/test-database-guard');
const integration = require('../src/common/safety/integration-runner-guard');
const scoped = require('../src/common/safety/scoped-test-run');

async function main() {
  const runId = process.argv[2];
  const apply = process.argv.includes('--apply');
  scoped.assertRunId(runId);
  const parsed = dotenv.parse(fs.readFileSync(path.join(testGuard.BACKEND_ROOT, '.env.test')));
  const target = testGuard.assertTestDatabaseUrl(parsed.DATABASE_URL);
  const manifest = JSON.parse(fs.readFileSync(path.join(scoped.runDir(runId), 'manifest.json'), 'utf8'));

  process.env.DATABASE_URL = parsed.DATABASE_URL;
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: parsed.DATABASE_URL } } });
  try {
    await integration.verifyLiveIdentity(prisma, { expectedPort: target.port });
    let fixtureGeonameIds = [];
    try { fixtureGeonameIds = JSON.parse(fs.readFileSync(path.join(scoped.runDir(runId), 'fixture-geonames.json'), 'utf8')).map(Number); } catch { /* none recorded */ }
    const result = await scoped.runCleanup(prisma, runId, { startedAt: manifest.startedAt, fixtureGeonameIds, dryRun: !apply });
    console.log(`${apply ? 'Deleted' : 'Would delete'} (run ${runId}):`, JSON.stringify(result.counts), 'created by the run:', JSON.stringify(result.ids));
    if (apply) {
      scoped.removeScopedUploads(runId);
      const differing = scoped.compareSnapshots(manifest.snapshot, await scoped.takeSnapshot(prisma));
      console.log(differing.length ? `Tables still different from the snapshot: ${differing.map((d) => d.table).join(', ')}` : 'Every table matches the snapshot.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
