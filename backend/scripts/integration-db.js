// READ-ONLY inspection of the existing test database (humancare_test) for the integration runner.
//
//   HUMANCARE_INTEGRATION_RUN=true node scripts/integration-db.js verify     identity + privileges + other sessions
//   HUMANCARE_INTEGRATION_RUN=true node scripts/integration-db.js status     prisma migrate status (reads the history)
//   HUMANCARE_INTEGRATION_RUN=true node scripts/integration-db.js inventory  row COUNTS per table (is there data?)
//
// (`npm run integration:db -- <command>` sets the flag.) An explicit command is required. Every command loads ONLY
// backend/.env.test, blanks every other environment key the code knows, validates the URL before connecting, asks
// the SERVER to confirm the database, account, port and privileges, and then only reads. There is deliberately NO
// migrate, cleanup, reset, truncate, delete, seed, drop or push command here: applying migrations stays with
// scripts/test-db.js, and nothing in the integration runner changes the data. Nothing prints the connection string
// or a password, and inventory prints counts only, never rows.
const fs = require('fs');
const dotenv = require('dotenv');
const guard = require('../src/common/safety/integration-runner-guard');
const { assertTestDatabaseUrl } = require('../src/common/safety/test-database-guard');
const { runPrismaMigrateStatus } = require('../src/common/safety/prisma-cli-isolation');

const COMMANDS = ['verify', 'status', 'inventory'];

function usage() {
  return `Usage: HUMANCARE_INTEGRATION_RUN=true node scripts/integration-db.js <${COMMANDS.join('|')}>`;
}

function loadEnv() {
  if (!fs.existsSync(guard.ENV_FILE)) throw new Error('backend/.env.test does not exist (see .env.test.example).');
  return guard.buildIntegrationEnv(dotenv.parse(fs.readFileSync(guard.ENV_FILE)));
}

async function connect(env, target) {
  process.env.DATABASE_URL = env.DATABASE_URL; // this process only, and only after the URL passed the guard
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const live = await guard.verifyLiveIdentity(prisma, { expectedPort: target.port });
    return { live, prisma };
  } catch (err) {
    await prisma.$disconnect();
    throw err;
  }
}

function quote(name) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error('unusual table name; refusing to query it.');
  return `\`${name}\``;
}

async function inventory(prisma) {
  const tables = (await prisma.$queryRawUnsafe(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
  )).map((row) => String(row.name || row.NAME || row.TABLE_NAME));
  let total = 0;
  console.log(`Tables: ${tables.length}`);
  for (const name of tables) {
    const [row] = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM ${quote(name)}`);
    const n = Number(row.n);
    total += n;
    console.log(`  ${name}: ${n}`);
  }
  console.log(`Total rows: ${total}${total > 0 ? ' (the database holds data; the integration runner will not delete it)' : ' (empty)'}`);
}

async function main(command) {
  if (!COMMANDS.includes(command)) throw new Error(usage());
  guard.assertOptIn(process.env); // explicit opt-in before anything else
  const env = loadEnv();
  const target = assertTestDatabaseUrl(env.DATABASE_URL); // before any connection
  console.log(`Target: ${target.database} on ${target.host}:${target.port} as ${target.user}`);

  const { live, prisma } = await connect(env, target);
  console.log(`Server confirms: database ${live.database}, account ${live.account}; privileges confined to this database.`);
  try {
    const [version] = await prisma.$queryRawUnsafe('SELECT VERSION() AS v');
    console.log(`MySQL server version: ${version.v}`);
    await guard.assertNoOtherSessions(prisma);
    console.log('No other session is connected to humancare_test.');
    if (command === 'inventory') await inventory(prisma);
  } finally {
    await prisma.$disconnect();
  }
  if (command === 'status') {
    // Read-only: compares the migration folder with the _prisma_migrations table. Applies nothing. Runs in an
    // isolated child (temporary schema copy with no .env, allow-listed environment, fixed arguments): see
    // src/common/safety/prisma-cli-isolation.js.
    const exit = runPrismaMigrateStatus(env);
    if (exit !== 0 && exit !== 1) throw new Error(`prisma migrate status failed (exit ${exit}).`);
  }
}

if (require.main === module) {
  main(process.argv[2]).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { main, COMMANDS };
