// Builds the COMPLETE environment of a spawned process (the isolated API or the dedicated worker). Nothing is inherited
// from the orchestrator's own environment except a short list of Windows system variables, and backend/.env is only
// READ (parsed in memory by the caller); it is never written, and its values are never printed.
//
// The principle is deny-by-default (the same technique as scripts/e2e-env.js): every key that exists in backend/.env is
// set explicitly - either to a value from the small allowlist below, or to "" - because dotenv and Prisma fill in any
// variable that is NOT already present, so an unset key would silently come back from the file (a webhook, SMTP
// credentials, Razorpay keys...). A variable that is present but empty stays empty.
const path = require('path');
const { policyToEnv } = require('./egressPolicy');
const { ENV_EVIDENCE } = require('./egressEvidence');

const API_PORT = 4400;
const WEB_PORT = 8481;
const FORBIDDEN_PORTS = [4000, 4100]; // 4000 normal dev API; 4100 the payment E2E runner (humancare_test)

const SYSTEM_KEYS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WINDIR', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME'];

// Values taken from backend/.env (everything the API/worker need to run against humancare_dev, locally).
const PASS_THROUGH = [
  'DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'FIREBASE_SERVICE_ACCOUNT_PATH', 'PHONE_OTP_PROVIDER',
  'PRIVATE_CHARTER_REVIEW_WORKFLOW', 'CLAMAV_HOST', 'CLAMAV_PORT', 'CLAMAV_TIMEOUT_MS', 'SYNTHETIC_E2E_SECRET',
  'GOOGLE_CLIENT_ID_ANDROID', 'GOOGLE_CLIENT_ID_WEB', 'SECURITY_LOG_RETENTION_DAYS',
  'ADMIN_PASSKEY_ENFORCEMENT', 'ADMIN_PORTAL_URL', 'ADMIN_WEBAUTHN_ORIGIN', 'ADMIN_WEBAUTHN_RP_ID', 'ADMIN_WEBAUTHN_RP_NAME', 'CORPORATE_PORTAL_URL',
];

// Forced values. SMTP and every credential that could reach an external service are blank; storage is local so no
// patient document is written to S3 by a synthetic run.
const FORCED_BASE = {
  NODE_ENV: 'development',
  BITRIX_SYNC_ENABLED: 'false',
  BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'false',
  BITRIX_QUOTATION_SYNC_ENABLED: 'false',
  BITRIX24_WEBHOOK_URL: '',
  BITRIX_INBOUND_APPLICATION_TOKEN: '',
  BITRIX_ALLOWED_PORTAL_HOST: '',
  // Only a stamping setting for the new synthetic case's Deal link/outbox row (DB only; nothing is ever sent).
  BITRIX_DEAL_PROFILE: 'actual',
  SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', EMAIL_FROM: '',
  EMAIL_PROVIDER: 'console',
  PAYMENTS_ENABLED: 'false', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_WEBHOOK_SECRET: '',
  STORAGE_PROVIDER: 'local', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_S3_BUCKET: '', AWS_REGION: '', AWS_S3_FORCE_PATH_STYLE: '',
};

class ChildEnvError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ChildEnvError';
    this.code = code;
  }
}

function isLoopbackDatabase(databaseUrl) {
  try {
    const host = new URL(String(databaseUrl)).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  } catch {
    return false;
  }
}

// role: "api" | "worker". envFileValues: dotenv.parse(backend/.env). Returns a fresh object; process.env is not touched.
function buildChildEnv({ role, envFileValues, policy, evidenceFile, systemEnv = process.env, databaseOfUrl, requiredDatabase }) {
  if (role !== 'api' && role !== 'worker') throw new ChildEnvError('unknown role', 'bad_role');
  if (databaseOfUrl(envFileValues.DATABASE_URL) !== requiredDatabase) throw new ChildEnvError(`DATABASE_URL does not name ${requiredDatabase}`, 'database_not_dev');
  if (!isLoopbackDatabase(envFileValues.DATABASE_URL)) throw new ChildEnvError('DATABASE_URL does not point at a loopback host', 'database_not_loopback');

  const env = {};
  for (const key of SYSTEM_KEYS) if (systemEnv[key] !== undefined) env[key] = systemEnv[key];
  for (const key of Object.keys(envFileValues)) env[key] = ''; // deny by default
  for (const key of PASS_THROUGH) if (envFileValues[key] !== undefined) env[key] = envFileValues[key];
  Object.assign(env, FORCED_BASE);

  if (role === 'api') {
    env.PORT = String(API_PORT);
    env.SYNTHETIC_E2E_AUTO_APPROVE = '';
    env.SYNTHETIC_E2E_SECRET = ''; // the API never signs or verifies synthetic marks; only the worker's approval engine does
  } else {
    env.PORT = '';
    env.SYNTHETIC_E2E_AUTO_APPROVE = 'true';
  }
  env.HC_EGRESS_ROLE = role;
  env[ENV_EVIDENCE] = evidenceFile;
  Object.assign(env, policyToEnv(policy));
  env.SYNTHETIC_E2E_ISOLATED = 'true';
  return env;
}

// Defence in depth for the orchestrator: re-validates a built environment (also used by the unit tests). Codes only.
function childEnvProblems(env, role) {
  const problems = [];
  if (env.BITRIX_SYNC_ENABLED !== 'false') problems.push('bitrix_sync_not_false');
  for (const key of ['BITRIX24_WEBHOOK_URL', 'BITRIX_INBOUND_APPLICATION_TOKEN', 'BITRIX_ALLOWED_PORTAL_HOST', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
    if ((env[key] || '') !== '') problems.push(`${key.toLowerCase()}_not_blank`);
  }
  if (env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED !== 'false') problems.push('bitrix_deal_switch_not_off');
  if (env.BITRIX_DEAL_PROFILE !== 'actual') problems.push('bitrix_deal_profile_not_actual');
  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'test') problems.push('node_env_refused');
  if (env.NODE_OPTIONS) problems.push('node_options_present');
  if (role === 'api' && (env.PORT !== String(API_PORT) || FORBIDDEN_PORTS.includes(Number(env.PORT)))) problems.push('port_not_4400');
  if (role === 'worker' && env.SYNTHETIC_E2E_AUTO_APPROVE !== 'true') problems.push('worker_auto_approve_not_true');
  if (role === 'api' && env.SYNTHETIC_E2E_AUTO_APPROVE === 'true') problems.push('api_auto_approve_enabled');
  if (role === 'api' && (env.SYNTHETIC_E2E_SECRET || '') !== '') problems.push('synthetic_secret_present_in_api');
  if (env.STORAGE_PROVIDER !== 'local') problems.push('storage_not_local');
  return problems;
}

const API_ENTRY = path.resolve(__dirname, '..', '..', 'src', 'synthetic-e2e-api.js');
const WORKER_ENTRY = path.resolve(__dirname, '..', '..', 'src', 'synthetic-e2e-worker.js');
const PRELOAD = path.join(__dirname, 'egressGuard.preload.js');

module.exports = {
  API_PORT, WEB_PORT, FORBIDDEN_PORTS, SYSTEM_KEYS, PASS_THROUGH, FORCED_BASE,
  ChildEnvError, buildChildEnv, childEnvProblems, isLoopbackDatabase,
  API_ENTRY, WORKER_ENTRY, PRELOAD,
};
