// Runs once, in the Jest parent process, before any integration test. READ-ONLY and non-destructive: it never
// changes data. Order matters: opt-in -> environment -> SESSION LOCK -> live identity -> other sessions. If anything
// fails after the lock is taken, the lock is released here (Jest does not call the teardown after a failed setup).
const fs = require('fs');
const dotenv = require('dotenv');
const guard = require('../../src/common/safety/integration-runner-guard');

module.exports = async function integrationGlobalSetup() {
  guard.assertOptIn(process.env);
  if (!fs.existsSync(guard.ENV_FILE)) throw new Error('backend/.env.test does not exist (see .env.test.example). No integration test was run.');
  const env = guard.buildIntegrationEnv(dotenv.parse(fs.readFileSync(guard.ENV_FILE)));
  const target = guard.assertIntegrationEnvironment(env);

  const release = guard.acquireSessionLock();
  let prisma;
  try {
    process.env.DATABASE_URL = env.DATABASE_URL;
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
    await guard.verifyLiveIdentity(prisma, { expectedPort: target.port });
    await guard.assertNoOtherSessions(prisma);
  } catch (err) {
    release();
    throw err;
  } finally {
    if (prisma) await prisma.$disconnect();
  }
  // The workers inherit this environment; tests/integration/setup.js applies it again inside each worker.
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  global.__INTEGRATION_RELEASE_LOCK__ = release;
};
