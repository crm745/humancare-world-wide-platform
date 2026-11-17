// Runs once after a scoped run (whether the tests passed or failed). It deletes ONLY what this run created and then
// verifies that the database is exactly as it was. The lock is always released. A failed verification fails the run and
// names the backup; it never "fixes" anything beyond the run's own rows.
const fs = require('fs');
const path = require('path');
const scoped = require('../../src/common/safety/scoped-test-run');

// The GeoNames rows the suite inserted itself (the fixtures that did not exist yet), recorded by the suite.
function readFixtureIds(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'fixture-geonames.json'), 'utf8')).map(Number);
  } catch {
    return [];
  }
}

module.exports = async function scopedGlobalTeardown() {
  const runId = process.env[scoped.RUN_ID_ENV];
  const release = global.__SCOPED_RELEASE_LOCK__;
  let prisma;
  try {
    scoped.assertRunId(runId);
    const dir = scoped.runDir(runId);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const result = await scoped.runCleanup(prisma, runId, { startedAt: manifest.startedAt, fixtureGeonameIds: readFixtureIds(dir) });
    scoped.removeScopedUploads(runId);

    const after = await scoped.takeSnapshot(prisma);
    const differing = scoped.compareSnapshots(manifest.snapshot, after);
    const changedProtected = scoped.compareProtected(manifest.protectedRows, await scoped.fingerprintProtected(prisma));
    const report = { runId, finishedAt: new Date().toISOString(), deleted: result.counts, createdByRun: result.ids, tablesDifferent: differing, protectedRowsChanged: changedProtected };
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));

    // eslint-disable-next-line no-console
    console.log(`\n[scoped] run ${runId} cleanup: ${Object.entries(result.counts).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ') || 'nothing to delete'}.`);
    if (differing.length || changedProtected.length) {
      throw new Error(
        `Scoped run ${runId}: the database is NOT back to its snapshot. Tables different: ${differing.map((d) => d.table).join(', ') || 'none'}. `
        + `Protected rows changed: ${changedProtected.join(', ') || 'none'}. A backup taken before the run is at .scoped-runs/${runId}/pre-run-backup.sql; `
        + 'see report.json in the same folder. Nothing else was deleted.',
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[scoped] run ${runId}: every table matches the snapshot and the protected rows are unchanged.\n`);
  } finally {
    if (prisma) await prisma.$disconnect();
    if (release) release();
  }
};
