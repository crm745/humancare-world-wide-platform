// Runs the Prisma CLI for the integration runner without letting it see anything it was not explicitly given.
//
// THE PROBLEM: the Prisma CLI loads a `.env` it finds in its working directory and next to the schema, and fills in
// every variable the process does not already have. Started from backend/, it therefore pulled in the development
// .env ("Environment variables loaded from .env"), whatever the runner had passed.
//
// THE FIX, in three parts:
//   1. The CLI runs from a TEMPORARY COPY of prisma/schema.prisma and prisma/migrations (env files are never
//      copied), with that folder as its working directory and --schema pointing into it. There is no .env there
//      for it to load, and the real backend/ is not its working directory or schema location.
//   2. Its environment is an ALLOW-LIST built here, not a copy of process.env: the OS basics it needs to start, the
//      validated DATABASE_URL, and a few fixed switches. Nothing else is inherited.
//   3. It is started directly (node + the CLI entry file, shell off) with FIXED arguments: only
//      `migrate status`, which reads the migration history and applies nothing. There is no generic "run prisma"
//      function here, so deploy, reset, dev, push and db execute cannot be reached through it.
//
// The target stays fixed: the environment is validated by the integration guard (which uses the test guard)
// BEFORE anything is copied or started, so only humancare_test, as a test account on this machine, is accepted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const guard = require('./integration-runner-guard');

const SYSTEM_KEYS = ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WINDIR'];
// Fixed values the CLI is given on top: no telemetry/update call, no update notice, test mode, the opt-in marker.
const FIXED_ENV = { CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', NODE_ENV: 'test', [guard.RUN_FLAG]: 'true' };
// Fixed arguments. The schema path is appended at run time.
const STATUS_ARGS = ['migrate', 'status'];

const isEnvFile = (name) => name === '.env' || name.startsWith('.env.');

/** Copies the schema and migrations (never an env file) into a fresh temporary folder. */
function stageSchemaCopy({ backendRoot = guard.BACKEND_ROOT, tmpBase = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'hc-prisma-cli-'));
  const target = path.join(dir, 'prisma');
  try {
    fs.mkdirSync(target);
    fs.copyFileSync(path.join(backendRoot, 'prisma', 'schema.prisma'), path.join(target, 'schema.prisma'));
    fs.cpSync(path.join(backendRoot, 'prisma', 'migrations'), path.join(target, 'migrations'), {
      recursive: true,
      filter: (source) => !isEnvFile(path.basename(source)),
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, schemaPath: path.join(target, 'schema.prisma'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The only environment the CLI receives: the OS basics, the DATABASE_URL, and the fixed values. `env` must already
 * pass the integration guard (checked again here). Nothing is copied from process.env except the OS basics.
 */
function buildPrismaCliEnv(env, systemEnv = process.env) {
  guard.assertIntegrationEnvironment(env); // humancare_test only; opt-in; ordinary test rules; Bitrix off
  const child = {};
  for (const key of SYSTEM_KEYS) if (systemEnv[key] !== undefined) child[key] = systemEnv[key];
  child.DATABASE_URL = env.DATABASE_URL;
  return Object.assign(child, FIXED_ENV);
}

/** `prisma migrate status` against humancare_test, isolated as described above. Returns the child's exit status. */
function runPrismaMigrateStatus(env, { spawn = spawnSync, backendRoot = guard.BACKEND_ROOT, cliRoot = backendRoot, tmpBase, systemEnv = process.env } = {}) {
  const childEnv = buildPrismaCliEnv(env, systemEnv); // validates the target BEFORE anything is staged or started
  const entry = require.resolve('prisma/build/index.js', { paths: [cliRoot] });
  const stage = stageSchemaCopy({ backendRoot, tmpBase });
  try {
    const result = spawn(process.execPath, [entry, ...STATUS_ARGS, '--schema', stage.schemaPath], {
      cwd: stage.dir, env: childEnv, stdio: 'inherit', shell: false,
    });
    if (result.error) throw result.error;
    return result.status;
  } finally {
    stage.cleanup();
  }
}

module.exports = { runPrismaMigrateStatus, buildPrismaCliEnv, stageSchemaCopy, STATUS_ARGS, FIXED_ENV, SYSTEM_KEYS };
