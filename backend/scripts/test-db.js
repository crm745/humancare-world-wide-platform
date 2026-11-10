// Guarded database commands for the dedicated TEST database. This replaces running the Prisma CLI by
// hand against whatever DATABASE_URL happens to be in the environment.
//
//   node scripts/test-db.js verify    who am I connected as, and what may I do (read-only)
//   node scripts/test-db.js status    prisma migrate status (which migrations are applied)
//   node scripts/test-db.js diff      read-only drift check: live database vs prisma/schema.prisma
//   node scripts/test-db.js migrate   prisma migrate deploy (applies pending migrations only)
//
// Every command: loads ONLY backend/.env.test (never the development .env), validates the URL before
// connecting, asks the server to confirm it is humancare_test as a test user, then runs, and
// `migrate` confirms again afterwards. There is no reset, drop or `migrate dev`. Nothing prints the
// connection string or password.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');
const {
  assertTestDatabaseUrl,
  assertSafeTestEnvironment,
  verifyLiveDatabase,
  BACKEND_ROOT,
} = require('../src/common/safety/test-database-guard');

const COMMANDS = ['verify', 'status', 'diff', 'migrate'];

function loadTestEnv() {
  const file = path.join(BACKEND_ROOT, '.env.test');
  if (!fs.existsSync(file)) {
    throw new Error('backend/.env.test does not exist. Copy .env.test.example to .env.test and fill it in (never commit it).');
  }
  // Only the test file, merged over the bare minimum the child process needs to run.
  const system = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) system[key] = process.env[key];
  }
  return { ...system, ...dotenv.parse(fs.readFileSync(file)), NODE_ENV: 'test' };
}

async function liveCheck(env) {
  // Point this process at the validated test URL only for this check.
  process.env.DATABASE_URL = env.DATABASE_URL;
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const live = await verifyLiveDatabase(prisma);
    return { live, prisma };
  } catch (err) {
    await prisma.$disconnect();
    throw err;
  }
}

function prismaCli(env, args) {
  // Fixed arguments only; `shell` is needed to launch npx on Windows.
  const result = spawnSync('npx', ['prisma', ...args], { cwd: BACKEND_ROOT, env, stdio: 'inherit', shell: true });
  if (result.status !== 0) throw new Error(`prisma ${args[0]} ${args[1] || ''} failed (exit ${result.status}).`);
}

async function main(command) {
  if (!COMMANDS.includes(command)) {
    throw new Error(`Usage: node scripts/test-db.js <${COMMANDS.join('|')}>`);
  }
  const env = loadTestEnv();
  const target = assertTestDatabaseUrl(env.DATABASE_URL); // before any connection
  assertSafeTestEnvironment(env);
  console.log(`Target: ${target.database} on ${target.host}:${target.port} as ${target.user}`);

  const { live, prisma } = await liveCheck(env);
  console.log(`Server confirms: database ${live.database}, account ${live.account}`);

  try {
    if (command === 'verify') {
      const grants = await prisma.$queryRawUnsafe('SHOW GRANTS FOR CURRENT_USER()');
      console.log('Grants:');
      grants.forEach((row) => console.log(`  ${Object.values(row)[0]}`));
      return;
    }
  } finally {
    await prisma.$disconnect();
  }

  if (command === 'status') prismaCli(env, ['migrate', 'status']);
  if (command === 'diff') {
    prismaCli(env, ['migrate', 'diff', '--from-schema-datasource', 'prisma/schema.prisma', '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
  }
  if (command === 'migrate') {
    prismaCli(env, ['migrate', 'deploy']);
    const after = await liveCheck(env); // the same database, confirmed again after the change
    await after.prisma.$disconnect();
    console.log('Migrations applied to humancare_test; target re-confirmed.');
  }
}

main(process.argv[2]).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
