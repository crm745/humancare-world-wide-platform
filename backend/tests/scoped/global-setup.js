// Runs once, in the Jest parent process, before a scoped run. It never changes data: it checks, backs up, records.
// Order: opt-in -> session lock -> environment -> live identity -> preflight -> backup -> snapshot -> manifest.
// If anything fails after the lock is taken, the lock is released here (Jest does not call the teardown after a failed setup).
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const integration = require('../../src/common/safety/integration-runner-guard');
const scoped = require('../../src/common/safety/scoped-test-run');
const { BACKEND_ROOT } = require('../../src/common/safety/test-database-guard');

module.exports = async function scopedGlobalSetup() {
  if (process.env[scoped.RUN_FLAG] !== 'true') throw new Error(`Scoped run: ${scoped.RUN_FLAG} must be "true". Nothing was run.`);
  const envFile = path.join(BACKEND_ROOT, '.env.test');
  if (!fs.existsSync(envFile)) throw new Error('Scoped run: backend/.env.test does not exist. Nothing was run.');

  const release = integration.acquireSessionLock(); // an ordinary `npm test` refuses to start while this exists
  let prisma;
  try {
    const runId = scoped.newRunId();
    const env = scoped.buildScopedEnv(dotenv.parse(fs.readFileSync(envFile)), runId);
    const target = scoped.assertScopedEnvironment(env);

    process.env.DATABASE_URL = env.DATABASE_URL;
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
    await integration.verifyLiveIdentity(prisma, { expectedPort: target.port });
    await scoped.assertPreflight(prisma);

    const dir = scoped.runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const backup = scoped.createBackup(env.DATABASE_URL, path.join(dir, 'pre-run-backup.sql'));
    const startedAt = new Date().toISOString();
    const snapshot = await scoped.takeSnapshot(prisma);
    const protectedRows = await scoped.fingerprintProtected(prisma);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId, startedAt, snapshot, protectedRows, backup }, null, 2));

    // The workers inherit this environment; tests/scoped/setup.js applies it again inside each worker.
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    global.__SCOPED_RELEASE_LOCK__ = release;
    // eslint-disable-next-line no-console
    console.log(`\n[scoped] run ${runId}: backup ${backup.bytes} bytes at .scoped-runs/${runId}/, ${Object.keys(snapshot.tables).length} tables snapshotted, `
      + `protected rows: ${Object.entries(protectedRows).map(([t, rows]) => `${t} ${Object.keys(rows).join(',')}`).join('; ')}.\n`);
  } catch (err) {
    release();
    throw err;
  } finally {
    if (prisma) await prisma.$disconnect();
  }
};
