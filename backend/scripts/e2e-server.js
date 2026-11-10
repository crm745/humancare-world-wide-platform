// The backend for real-browser tests. NOT src/server.js: that loads the development .env.
//
//   node scripts/e2e-server.js
//
// Loads only backend/.env.test (see e2e-env.js), refuses unless the safety guard passes, asks the
// database server to confirm it is humancare_test before listening, and listens on the loopback
// interface on the test port (never 4000, the development backend's). It serves HTTP only: the
// scheduled-jobs worker is not started. Mail goes to the local capture sink.
const { applyIsolatedEnv } = require('./e2e-env');

const env = applyIsolatedEnv(); // validates, and must run before Prisma is loaded

const port = Number(env.PORT);
if (!Number.isInteger(port) || port <= 0 || port === 4000) {
  console.error('E2E backend: PORT must be set in .env.test and must not be 4000 (the development backend).');
  process.exit(1);
}

const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { verifyLiveDatabase } = require('../src/common/safety/test-database-guard');

async function main() {
  const live = await verifyLiveDatabase(prisma); // the server itself says: humancare_test, as a test user
  const server = app.listen(port, 'localhost', () => {
    console.log(`E2E backend listening on http://localhost:${port} (database ${live.database}, account ${live.account})`);
  });
  server.on('error', (err) => {
    console.error(`E2E backend could not listen on port ${port}: ${err.code || err.name}`);
    process.exit(1);
  });
  const stop = () => server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(`E2E backend refused to start: ${err.message}`);
  process.exit(1);
});
