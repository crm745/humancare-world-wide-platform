// Environment isolation + database identity tests (node:test). No database, no network, no process is started: the spawned
// processes' environments are BUILT and inspected, and the API's start-up identity check is exercised with a fake Prisma.
// The worker module (required below for its pure exports) constructs a Prisma client at load time. A dummy loopback URL on a
// closed port is set FIRST so nothing here can ever name, read or connect to a real database; no query is ever made.
process.env.DATABASE_URL = 'mysql://nobody:nothing@127.0.0.1:1/humancare_dev';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..');
const dir = path.join(BACKEND, 'scripts', 'synthetic-e2e-orchestrator');
const childEnv = require(path.join(dir, 'childEnv'));
const { createPolicy } = require(path.join(dir, 'egressPolicy'));
const { LIMITS, databaseOfUrl } = require(path.join(BACKEND, 'src', 'common', 'safety', 'synthetic-e2e-marker'));
const apiEntry = require(path.join(BACKEND, 'src', 'synthetic-e2e-api'));

// A pretend backend/.env full of the things the spawned processes must NOT inherit. Fake values only.
const FAKE_ENV_FILE = {
  DATABASE_URL: 'mysql://app:pw@localhost:3306/humancare_dev',
  JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40),
  FIREBASE_SERVICE_ACCOUNT_PATH: 'C:/keys/fake.json', PHONE_OTP_PROVIDER: 'firebase', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true',
  CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '3310', SYNTHETIC_E2E_SECRET: 's'.repeat(40),
  BITRIX24_WEBHOOK_URL: 'https://acme.bitrix24.in/rest/1/FAKEWEBHOOKTOKEN/', BITRIX_INBOUND_APPLICATION_TOKEN: 'FAKEINBOUNDTOKEN1234567890',
  BITRIX_ALLOWED_PORTAL_HOST: 'acme.bitrix24.in', BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true',
  SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_USER: 'mailer', SMTP_PASS: 'FAKESMTPPASSWORD', EMAIL_FROM: 'x@example.test',
  RAZORPAY_KEY_ID: 'rzp_fake', RAZORPAY_KEY_SECRET: 'FAKERZP', RAZORPAY_WEBHOOK_SECRET: 'FAKEWH', PAYMENTS_ENABLED: 'true',
  STORAGE_PROVIDER: 's3', AWS_ACCESS_KEY_ID: 'AKIAFAKE', AWS_SECRET_ACCESS_KEY: 'FAKEAWS', AWS_S3_BUCKET: 'fake-bucket', AWS_REGION: 'ap-south-1',
  SOME_FUTURE_SECRET_KEY: 'FAKEFUTURE', INITIAL_ADMIN_PASSWORD: 'FAKEADMINPW', PORT: '4000',
};
const policy = createPolicy({ blockedHosts: ['acme.bitrix24.in'], blockedIps: ['198.51.100.7'] });
const SYSTEM = { PATH: 'C:/x', SystemRoot: 'C:/Windows', SECRET_FROM_PARENT: 'must-not-leak', NODE_OPTIONS: '--require evil.js', HTTPS_PROXY: 'http://proxy.example.test' };

const build = (role, overrides = {}) => childEnv.buildChildEnv({
  role, envFileValues: { ...FAKE_ENV_FILE, ...overrides }, policy, evidenceFile: 'C:/runs/evidence.jsonl', systemEnv: SYSTEM, databaseOfUrl, requiredDatabase: LIMITS.DATABASE,
});

for (const role of ['api', 'worker']) {
  test(`${role}: Bitrix sync is false and every Bitrix credential, webhook and token is blank`, () => {
    const env = build(role);
    assert.strictEqual(env.BITRIX_SYNC_ENABLED, 'false');
    assert.strictEqual(env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED, 'false');
    assert.strictEqual(env.BITRIX_QUOTATION_SYNC_ENABLED, 'false');
    for (const key of ['BITRIX24_WEBHOOK_URL', 'BITRIX_INBOUND_APPLICATION_TOKEN', 'BITRIX_ALLOWED_PORTAL_HOST']) assert.strictEqual(env[key], '', key);
  });
  test(`${role}: BITRIX_DEAL_PROFILE=actual is set (profile stamping only); nothing can be sent because the webhook is blank`, () => {
    const env = build(role);
    assert.strictEqual(env.BITRIX_DEAL_PROFILE, 'actual');
    assert.strictEqual(env.BITRIX24_WEBHOOK_URL, '');
  });
  test(`${role}: SMTP, payment and AWS credentials are blank, mail goes to the console provider, storage is local`, () => {
    const env = build(role);
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_BUCKET']) assert.strictEqual(env[key], '', key);
    assert.strictEqual(env.PAYMENTS_ENABLED, 'false');
    assert.strictEqual(env.EMAIL_PROVIDER, 'console');
    assert.strictEqual(env.STORAGE_PROVIDER, 'local');
  });
  test(`${role}: deny-by-default - a key that exists in backend/.env but is not allow-listed is explicitly blank (so dotenv/Prisma cannot refill it)`, () => {
    const env = build(role);
    assert.strictEqual(env.SOME_FUTURE_SECRET_KEY, '');
    assert.strictEqual(env.INITIAL_ADMIN_PASSWORD, '');
    assert.ok(Object.prototype.hasOwnProperty.call(env, 'SOME_FUTURE_SECRET_KEY'), 'the key must be PRESENT (empty), not absent');
  });
  test(`${role}: only listed system variables are inherited; NODE_OPTIONS and proxy variables are not`, () => {
    const env = build(role);
    assert.strictEqual(env.PATH, 'C:/x');
    for (const key of ['SECRET_FROM_PARENT', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.ok(!(key in env), key);
  });
  test(`${role}: NODE_ENV is development (never production, never test)`, () => {
    assert.strictEqual(build(role).NODE_ENV, 'development');
  });
  test(`${role}: the egress policy, role and evidence file travel in the environment and the validator finds no problem`, () => {
    const env = build(role);
    assert.strictEqual(env.HC_EGRESS_ROLE, role);
    assert.strictEqual(env.HC_EGRESS_EVIDENCE, 'C:/runs/evidence.jsonl');
    assert.ok(JSON.parse(env.HC_EGRESS_BLOCK_HOSTS).includes('acme.bitrix24.in'));
    assert.ok(JSON.parse(env.HC_EGRESS_BLOCK_IPS).includes('198.51.100.7'));
    assert.deepStrictEqual(childEnv.childEnvProblems(env, role), []);
  });
}

test('api: port 4400, and no synthetic secret or auto-approve (only the worker\'s approval engine uses them)', () => {
  const env = build('api');
  assert.strictEqual(env.PORT, '4400');
  assert.strictEqual(env.SYNTHETIC_E2E_AUTO_APPROVE, '');
  assert.strictEqual(env.SYNTHETIC_E2E_SECRET, '');
});
test('worker: auto-approve on, secret passed through, no port', () => {
  const env = build('worker');
  assert.strictEqual(env.SYNTHETIC_E2E_AUTO_APPROVE, 'true');
  assert.strictEqual(env.SYNTHETIC_E2E_SECRET, FAKE_ENV_FILE.SYNTHETIC_E2E_SECRET);
  assert.strictEqual(env.PORT, '');
});

test('ports: 4400 and 8481 are fixed; 4000 and 4100 are forbidden and appear nowhere as a configured port', () => {
  assert.strictEqual(childEnv.API_PORT, 4400);
  assert.strictEqual(childEnv.WEB_PORT, 8481);
  assert.deepStrictEqual(childEnv.FORBIDDEN_PORTS, [4000, 4100]);
  assert.notStrictEqual(build('api').PORT, '4000', 'the .env PORT=4000 must be overridden');
  for (const file of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    // (webBuild.js legitimately CHECKS a bundle for 4100 with a regex; what must never appear is 4100 used as a port to serve/use.)
    assert.ok(!/(API_PORT|WEB_PORT|PORT|port)\s*[:=]\s*['"]?4100\b|`http:\/\/localhost:\$\{4100\}/.test(text.replace(/\/\/.*$/gm, '')), `${file} configures port 4100`);
  }
});

test('the DATABASE_URL must name humancare_dev on a loopback host, or no environment is built at all', () => {
  assert.throws(() => build('api', { DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }), { code: 'database_not_dev' });
  assert.throws(() => build('api', { DATABASE_URL: 'mysql://u:p@localhost:3306/humancare' }), { code: 'database_not_dev' });
  // The existing databaseOfUrl() already treats a non-local host as "no identity"; the loopback check is a second, independent wall.
  assert.throws(() => build('worker', { DATABASE_URL: 'mysql://u:p@db.example.test:3306/humancare_dev' }), (e) => ['database_not_dev', 'database_not_loopback'].includes(e.code));
  assert.strictEqual(childEnv.isLoopbackDatabase('mysql://u:p@db.example.test:3306/humancare_dev'), false);
  assert.strictEqual(childEnv.isLoopbackDatabase('mysql://u:p@localhost:3306/humancare_dev'), true);
  assert.throws(() => build('api', { DATABASE_URL: undefined }), { code: 'database_not_dev' });
  assert.doesNotThrow(() => build('api', { DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/humancare_dev' }));
});

test('the validator catches a tampered environment', () => {
  const env = build('api');
  for (const [mutation, code] of [
    [{ BITRIX_SYNC_ENABLED: 'true' }, 'bitrix_sync_not_false'],
    [{ BITRIX24_WEBHOOK_URL: 'https://x.bitrix24.in/rest/1/t/' }, 'bitrix24_webhook_url_not_blank'],
    [{ SMTP_PASS: 'x' }, 'smtp_pass_not_blank'],
    [{ NODE_ENV: 'production' }, 'node_env_refused'],
    [{ NODE_OPTIONS: '--require x' }, 'node_options_present'],
    [{ PORT: '4100' }, 'port_not_4400'],
    [{ STORAGE_PROVIDER: 's3' }, 'storage_not_local'],
    [{ SYNTHETIC_E2E_AUTO_APPROVE: 'true' }, 'api_auto_approve_enabled'],
  ]) assert.ok(childEnv.childEnvProblems({ ...env, ...mutation }, 'api').includes(code), code);
});

// ---- the API's own start-up checks (src/synthetic-e2e-api.js) ------------------------------------------------------------------
// The "egress guard installed" check inspects the live socket hook by function name; the tests flip that name to model both cases.
function withGuardHookNamed(name, fn) {
  const original = Object.getOwnPropertyDescriptor(net.Socket.prototype.connect, 'name');
  Object.defineProperty(net.Socket.prototype.connect, 'name', { value: name, configurable: true });
  const restore = () => Object.defineProperty(net.Socket.prototype.connect, 'name', original);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (err) { restore(); throw err; }
}
const goodApiEnv = () => build('api');

test('api start-up: a correct isolated environment has no problems (with the guard installed)', () => {
  withGuardHookNamed('guardedConnect', () => assert.deepStrictEqual(apiEntry.apiConfigurationProblems(goodApiEnv()), []));
});
test('api start-up: refuses to run when the egress guard is not installed in the process', () => {
  withGuardHookNamed('connect', () => assert.ok(apiEntry.apiConfigurationProblems(goodApiEnv()).includes('egress_guard_not_installed')));
});
test('api start-up: refuses wrong ports, Bitrix on, credentials present, auto-approve, wrong role, production/test env', () => {
  withGuardHookNamed('guardedConnect', () => {
    const bad = (mutation) => apiEntry.apiConfigurationProblems({ ...goodApiEnv(), ...mutation });
    assert.ok(bad({ PORT: '4000' }).includes('port_not_isolated_4400'));
    assert.ok(bad({ PORT: '4100' }).includes('port_not_isolated_4400'));
    assert.ok(bad({ BITRIX_SYNC_ENABLED: 'true' }).includes('bitrix_sync_not_false'));
    assert.ok(bad({ BITRIX_SYNC_ENABLED: undefined }).includes('bitrix_sync_not_false'));
    assert.ok(bad({ BITRIX24_WEBHOOK_URL: 'https://x.bitrix24.in/rest/1/t/' }).includes('bitrix24_webhook_url_not_blank'));
    assert.ok(bad({ SMTP_USER: 'someone' }).includes('smtp_user_not_blank'));
    assert.ok(bad({ SYNTHETIC_E2E_AUTO_APPROVE: 'true' }).includes('auto_approve_enabled_in_api'));
    assert.ok(bad({ HC_EGRESS_ROLE: 'worker' }).includes('egress_role_not_api'));
    assert.ok(bad({ NODE_ENV: 'production' }).includes('production_refused'));
    assert.ok(bad({ NODE_ENV: 'test' }).includes('test_environment_refused'));
    assert.ok(bad({ DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }).includes('database_not_identified'));
    assert.ok(bad({ DATABASE_URL: 'mysql://u:p@db.example.test:3306/humancare_dev' }).includes('database_host_not_loopback'));
  });
});

const fakePrisma = (behaviour) => ({ $queryRaw: async () => behaviour() });

test('api database identity: SELECT DATABASE() must return exactly humancare_dev', async () => {
  await withGuardHookNamed('guardedConnect', async () => {
    await assert.doesNotReject(apiEntry.assertApiSafeToRun(fakePrisma(() => [{ db: 'humancare_dev' }]), goodApiEnv()));
    for (const answer of ['humancare_test', 'humancare', 'HUMANCARE_DEV', 'humancare_dev ', null, undefined, '']) {
      await assert.rejects(apiEntry.assertApiSafeToRun(fakePrisma(() => [{ db: answer }]), goodApiEnv()), /database_not_identified/, String(answer));
    }
  });
});
test('api database identity fails closed on ANY error or empty answer', async () => {
  await withGuardHookNamed('guardedConnect', async () => {
    await assert.rejects(apiEntry.assertApiSafeToRun(fakePrisma(() => { throw new Error('ECONNREFUSED'); }), goodApiEnv()), /database_not_identified/);
    await assert.rejects(apiEntry.assertApiSafeToRun(fakePrisma(() => []), goodApiEnv()), /database_not_identified/);
    await assert.rejects(apiEntry.assertApiSafeToRun(fakePrisma(() => undefined), goodApiEnv()), /database_not_identified/);
    assert.strictEqual(await apiEntry.confirmDatabase({ $queryRaw: async () => { throw new Error('x'); } }), false);
  });
});
test('api database identity is checked BEFORE the server module (which listens) is loaded', () => {
  const text = fs.readFileSync(path.join(BACKEND, 'src', 'synthetic-e2e-api.js'), 'utf8');
  const check = text.indexOf('await assertApiSafeToRun(prisma)');
  const listen = text.indexOf("require('./server')");
  assert.ok(check > 0 && listen > check, 'the identity check must come before require("./server")');
  assert.ok(!/app\.listen|\.listen\(/.test(text.replace(/\/\/.*$/gm, '')), 'the wrapper itself never listens');
});
test('the normal API entry point is untouched (src/server.js still has no synthetic wiring)', () => {
  const server = fs.readFileSync(path.join(BACKEND, 'src', 'server.js'), 'utf8');
  assert.ok(!/synthetic|egress/i.test(server));
});

test('the dedicated worker keeps its own, independent database identity check', () => {
  const worker = require(path.join(BACKEND, 'src', 'synthetic-e2e-worker'));
  assert.strictEqual(typeof worker.confirmDatabase, 'function');
  assert.deepStrictEqual(worker.JOBS.map((j) => j.name), ['scan-request-documents'], 'the worker must schedule exactly the one scan job');
  return Promise.all([
    worker.confirmDatabase(fakePrisma(() => [{ db: 'humancare_test' }])).then((ok) => assert.strictEqual(ok, false)),
    worker.confirmDatabase(fakePrisma(() => { throw new Error('x'); })).then((ok) => assert.strictEqual(ok, false)),
    worker.confirmDatabase(fakePrisma(() => [{ db: 'humancare_dev' }])).then((ok) => assert.strictEqual(ok, true)),
  ]);
});
test('the worker refuses to start with auto-approve off, a missing secret, production, or another database', () => {
  const worker = require(path.join(BACKEND, 'src', 'synthetic-e2e-worker'));
  const env = build('worker');
  assert.deepStrictEqual(worker.configurationProblems(env), []);
  assert.ok(worker.configurationProblems({ ...env, SYNTHETIC_E2E_AUTO_APPROVE: '' }).includes('auto_approve_disabled'));
  assert.ok(worker.configurationProblems({ ...env, SYNTHETIC_E2E_SECRET: '' }).includes('secret_missing'));
  assert.ok(worker.configurationProblems({ ...env, NODE_ENV: 'production' }).includes('production_refused'));
  assert.ok(worker.configurationProblems({ ...env, DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }).includes('database_not_identified'));
});

// ---- hard rules, checked against the sources --------------------------------------------------------------------------------------
const orchestratorSources = () => [...fs.readdirSync(dir).filter((n) => n.endsWith('.js')).map((n) => path.join(dir, n)), path.join(BACKEND, 'src', 'synthetic-e2e-api.js')];

test('no Windows Firewall rule is created, modified or removed anywhere in the orchestrator', () => {
  for (const file of orchestratorSources()) {
    const code = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/NetFirewallRule|netsh\s+advfirewall|advfirewall|New-NetFirewall|Remove-NetFirewall|-RemoteAddress/i.test(code), `${path.basename(file)} touches the firewall`);
  }
  for (const gone of ['networkGuard.js', 'fetchGuard.preload.js', 'worker-manager.js', 'network-risk-acknowledgment.local.json.example']) assert.ok(!fs.existsSync(path.join(dir, gone)), `${gone} should be gone`);
});
test('the orchestrator never writes to backend/.env, apps/mobile/.env or mobile sources', () => {
  for (const file of orchestratorSources()) {
    const code = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/(writeFile|appendFile|copyFile|rename|unlink|rm|truncate)\w*\s*\([^)]*(ENV_FILE|\.env\b|MOBILE_ROOT)/.test(code), `${path.basename(file)} writes to an .env or mobile path`);
  }
});
test('the old machine-wide acknowledgment mechanism has no remaining runtime dependency', () => {
  for (const file of orchestratorSources()) {
    const code = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/ACK_FILE|acknowledg|network-risk/i.test(code), `${path.basename(file)} still references the acknowledgment file`);
  }
});
