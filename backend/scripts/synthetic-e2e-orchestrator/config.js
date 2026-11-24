// Preflight checks: every gate that must pass BEFORE a synthetic patient account is created. Reads
// backend/.env as a FILE (read-only, never written to) only for facts the spawned processes inherit from it (which
// database, which secret); the Bitrix/SMTP/payment settings are NOT trusted from the file at all - the spawned API and
// worker get a sanitized environment that forces them off (childEnv.js). Everything else is a concrete,
// independently-checked fact (DB identity via our own query, ClamAV via a real TCP probe, the general worker and any
// already-running dedicated worker via processGuard). Any failure here throws PreflightError and the caller must stop
// before calling POST /auth/register.
const fs = require('fs');
const path = require('path');
const net = require('net');
const dotenv = require('dotenv');
const processGuard = require('./processGuard');
const { LIMITS: MARKER_LIMITS, databaseOfUrl, secretOf } = require('../../src/common/safety/synthetic-e2e-marker');
const { webhookHost } = require('../../src/modules/bitrix/bitrix-config');
const { isLoopbackDatabase } = require('./childEnv');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const ENV_FILE = path.join(BACKEND_ROOT, '.env');
const BITRIX_MODULE_DIR = path.join(BACKEND_ROOT, 'src', 'modules', 'bitrix');

class PreflightError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PreflightError';
    this.code = code;
  }
}

function readDotEnvFile() {
  if (!fs.existsSync(ENV_FILE)) throw new PreflightError('backend/.env does not exist', 'env_missing');
  return dotenv.parse(fs.readFileSync(ENV_FILE));
}

// ---- config-at-rest checks (the .env FILE; never the live process's actual memory) -----------------
// Only what the spawned processes INHERIT from the file. Bitrix, SMTP, payment and storage settings are forced by
// childEnv.js, so their values in the file are irrelevant (and never need editing).
function checkConfigAtRest(envFileValues) {
  const problems = [];
  if (!secretOf(envFileValues)) problems.push('SYNTHETIC_E2E_SECRET is not set (or too short) at rest');
  if (databaseOfUrl(envFileValues.DATABASE_URL) !== MARKER_LIMITS.DATABASE) problems.push(`DATABASE_URL does not name ${MARKER_LIMITS.DATABASE} at rest`);
  else if (!isLoopbackDatabase(envFileValues.DATABASE_URL)) problems.push('DATABASE_URL does not point at a loopback host');
  if (!envFileValues.FIREBASE_SERVICE_ACCOUNT_PATH) problems.push('FIREBASE_SERVICE_ACCOUNT_PATH is not set at rest');
  if (problems.length) throw new PreflightError(`config-at-rest check failed: ${problems.join('; ')}`, 'config_at_rest_failed');
}

// ---- live database identity, proven transitively (not merely asserted) ------------------------------
async function checkDatabaseIdentity(prisma) {
  let rows;
  try {
    rows = await prisma.$queryRaw`SELECT DATABASE() AS db`;
  } catch (err) {
    throw new PreflightError(`could not confirm database identity: ${err.message}`, 'database_unreachable');
  }
  const db = rows && rows[0] && rows[0].db;
  if (db !== MARKER_LIMITS.DATABASE) throw new PreflightError(`connected database is "${db}", expected "${MARKER_LIMITS.DATABASE}"`, 'database_wrong');
  return db;
}

// ---- ClamAV reachability ------------------------------------------------------------------------------
function checkClamAvReachable(host, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const fail = () => { socket.destroy(); reject(new PreflightError(`ClamAV is not reachable at ${host}:${port}`, 'clamav_unreachable')); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', fail);
    socket.once('error', fail);
    socket.connect({ host, port });
  });
}

// ---- general worker absence --------------------------------------------------------------------------
function checkGeneralWorkerAbsent() {
  let status;
  try {
    status = processGuard.generalWorkerStatus();
  } catch (err) {
    throw new PreflightError(`could not confirm the general worker is absent: ${err.message}`, 'worker_check_failed');
  }
  if (status.running) throw new PreflightError(`the general-purpose worker (src/worker.js) is running (pid ${status.matches.map((m) => m.pid).join(', ')}) — stop it before running the orchestrator`, 'general_worker_running');
}

// ---- dedicated worker: the orchestrator starts its OWN isolated one --------------------------------------
// An already-running dedicated worker has no egress guard and an environment this tool cannot inspect, so the run
// refuses to start beside it. Nothing is stopped: the operator decides.
function checkNoDedicatedWorkerRunning() {
  let status;
  try {
    status = processGuard.dedicatedWorkerStatus();
  } catch (err) {
    throw new PreflightError(`could not confirm no dedicated worker is running: ${err.message}`, 'worker_check_failed');
  }
  if (status.running) throw new PreflightError(`a dedicated synthetic worker is already running (pid ${status.matches.map((m) => m.pid).join(', ')}); the orchestrator starts its own isolated worker and will not run beside one it cannot inspect. Nothing was stopped.`, 'dedicated_worker_running');
}

// ---- Bitrix source change-detection (regression guard, NOT proof of absence of every network path) --
// Confirms the Bitrix client source still matches the pattern audited (no proxy dispatcher, no custom Agent). This is
// not a network boundary - the egress guard is - it only flags that the audited assumptions may no longer hold.
const SUSPICIOUS_PATTERNS = [/ProxyAgent/, /setGlobalDispatcher/, /\bdispatcher\s*[:=]/, /new\s+https?\.Agent\s*\(/, /NODE_OPTIONS/];

function scanBitrixSourceForProxyPatterns(bitrixModuleDir) {
  const findings = [];
  let files = [];
  try {
    files = fs.readdirSync(bitrixModuleDir).filter((f) => f.endsWith('.js'));
  } catch (err) {
    throw new PreflightError(`could not scan Bitrix source for proxy/dispatcher patterns: ${err.message}`, 'source_scan_failed');
  }
  for (const file of files) {
    const text = fs.readFileSync(path.join(bitrixModuleDir, file), 'utf8');
    for (const pattern of SUSPICIOUS_PATTERNS) if (pattern.test(text)) findings.push({ file, pattern: pattern.toString() });
  }
  return { clean: findings.length === 0, findings };
}

function checkBitrixSourceUnchanged() {
  const result = scanBitrixSourceForProxyPatterns(BITRIX_MODULE_DIR);
  if (!result.clean) {
    throw new PreflightError(`Bitrix client source now contains proxy/dispatcher patterns not present at audit time: ${JSON.stringify(result.findings)}`, 'source_changed');
  }
}

// Runs every preflight check in order; throws PreflightError on the first failure (fail closed).
// Returns the facts gathered, for the report. The API is NOT checked here: the orchestrator starts its own.
async function runPreflight({ prisma }) {
  const envFileValues = readDotEnvFile();
  checkConfigAtRest(envFileValues);
  checkBitrixSourceUnchanged();
  checkGeneralWorkerAbsent();
  checkNoDedicatedWorkerRunning();
  const db = await checkDatabaseIdentity(prisma);
  await checkClamAvReachable(envFileValues.CLAMAV_HOST || '127.0.0.1', Number(envFileValues.CLAMAV_PORT || 3310));
  // The portal host is only needed to build the egress policy. If none is configured the pattern-based block still applies.
  const bitrixHost = webhookHost(envFileValues.BITRIX24_WEBHOOK_URL) || null;
  return { database: db, bitrixHost, envFileValues };
}

module.exports = {
  PreflightError, BACKEND_ROOT, ENV_FILE, BITRIX_MODULE_DIR,
  readDotEnvFile, checkConfigAtRest, checkDatabaseIdentity, checkClamAvReachable,
  checkGeneralWorkerAbsent, checkNoDedicatedWorkerRunning, scanBitrixSourceForProxyPatterns, checkBitrixSourceUnchanged, runPreflight,
};
