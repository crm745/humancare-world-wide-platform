// Loaded before every SAFE test (see jest.safe.config.js). A safe test must never reach a real database, bucket, CRM, mail server, payment gateway or any other outside service, whatever
// backend/.env says and whatever a test forgets to mock. Four layers:
//
//  1. The database URL points at a closed local port.
//  2. NOTHING from backend/.env can enter process.env. This file reads no .env, but @prisma/client loads backend/.env into process.env the first time a test requires it, and dotenv only
//     fills variables that are NOT set (an empty string counts as set). So every key that file defines is set to "" here, first. (Deleting a variable, as an earlier version of this file did
//     for the Bitrix settings, does not help: the variable is simply filled in again.)
//  3. Storage and AWS: the local adapter only (STORAGE_PROVIDER=local), and every AWS setting the SDK's credential chain or endpoint resolution reads is blank, including web identity, container
//     credentials, the shared credentials and config files (pointed at a path that does not exist), profiles, and endpoint overrides. The instance-metadata lookup is switched off.
//  4. The network: fetch is refused, and so is every outgoing socket to anything but this machine. The AWS SDK, SMTP, ClamAV, Razorpay and Bitrix clients all end in net.Socket.connect (http,
//     https and tls included), so one guard covers them; a name is refused BEFORE it is resolved, so no DNS lookup happens either. Loopback (127.x, ::1, localhost) and unix sockets stay open
//     for the tests' own servers (supertest, the fake SMTP and ClamAV servers).
// A test that needs the real thing (an S3 adapter) injects a fake client; none can reach the outside by accident.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// 1. database
process.env.DATABASE_URL = 'mysql://blocked:blocked@127.0.0.1:1/blocked_by_safe_tests';

// 2. nothing from backend/.env
try {
  const dotenv = require('dotenv');
  const envFile = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const key of Object.keys(dotenv.parse(fs.readFileSync(envFile)))) {
      if (process.env[key] === undefined) process.env[key] = '';
    }
  }
} catch { /* no dotenv or no file: nothing to keep out */ }
for (const key of ['BITRIX24_WEBHOOK_URL', 'BITRIX_SYNC_ENABLED', 'BITRIX_PRIVATE_CHARTER_DEAL_ENABLED', 'PRIVATE_CHARTER_REVIEW_WORKFLOW']) process.env[key] = '';

// 3. storage and AWS
process.env.STORAGE_PROVIDER = 'local';
const AWS_SETTINGS = [
  // what the application reads (src/storage/config.js)
  'AWS_REGION', 'AWS_S3_BUCKET', 'AWS_S3_FORCE_PATH_STYLE', 'AWS_S3_READ_FALLBACK_BUCKET', 'AWS_S3_READ_FALLBACK_REGION',
  // static and temporary credentials, profiles
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CREDENTIAL_EXPIRATION', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_DEFAULT_REGION',
  // web identity (EKS / OIDC) and role assumption
  'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME',
  // container credentials (ECS / EKS pod identity)
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  // endpoint overrides
  'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL_STS', 'AWS_ENDPOINT_URL_SSO', 'AWS_USE_FIPS_ENDPOINT', 'AWS_USE_DUALSTACK_ENDPOINT', 'AWS_S3_USE_ARN_REGION',
  'AWS_SDK_LOAD_CONFIG', 'AWS_STS_REGIONAL_ENDPOINTS',
];
for (const key of AWS_SETTINGS) process.env[key] = '';
// ANY other AWS_* variable the machine has (a new SDK setting, a CI variable) is blanked too.
for (const key of Object.keys(process.env)) if (/^AWS_/i.test(key) && !(key in { AWS_EC2_METADATA_DISABLED: 1, AWS_SHARED_CREDENTIALS_FILE: 1, AWS_CONFIG_FILE: 1 })) process.env[key] = '';
// The shared credentials and config files: an empty value would make the SDK use ~/.aws, so they point at a path that does not exist. The instance-metadata service is switched off.
process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(os.tmpdir(), 'hc-safe-tests-no-aws', 'credentials');
process.env.AWS_CONFIG_FILE = path.join(os.tmpdir(), 'hc-safe-tests-no-aws', 'config');
process.env.AWS_EC2_METADATA_DISABLED = 'true';

// 4. the network
global.fetch = () => Promise.reject(new Error('The network is blocked in the safe tests.'));

const GUARD = Symbol.for('humancare.safeTests.networkGuard');
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|0\.0\.0\.0|::|0:0:0:0:0:0:0:1)$/i;
function destinationOf(args) {
  const first = args[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    if (first.path) return null; // a unix socket / named pipe: this machine
    return first.host || 'localhost';
  }
  if (typeof first === 'string') return null; // connect(path)
  return typeof args[1] === 'string' ? args[1] : 'localhost'; // connect(port[, host])
}
if (!net.Socket.prototype[GUARD]) {
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    // connect(...args) may be given [options, cb] in an array by net.connect's normalised form
    const normalised = Array.isArray(args[0]) ? args[0] : args;
    const host = destinationOf(normalised);
    if (host !== null && !LOOPBACK.test(String(host))) {
      const err = Object.assign(new Error(`The network is blocked in the safe tests (connection to ${String(host).slice(0, 60)} refused).`), { code: 'SAFE_TESTS_NETWORK_BLOCKED' });
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return realConnect.apply(this, args);
  };
  Object.defineProperty(net.Socket.prototype, GUARD, { value: true });
}
