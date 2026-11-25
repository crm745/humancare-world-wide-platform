/* global describe, test, expect, jest, beforeEach, afterEach */
// Monitoring and startup reporting of the push delivery worker (push-delivery.monitor.js, store.deliveryMetrics) and the environment documentation.
// Fake store with a fake clock + fake Expo client + a recording Prisma stub: no database, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const fs = require('fs');
const path = require('path');
const { runPushDelivery } = require('../../src/modules/notifications/push-delivery.service');
const monitorModule = require('../../src/modules/notifications/push-delivery.monitor');
const store = require('../../src/modules/notifications/push-delivery.store');
const { MONITOR } = require('../../src/modules/notifications/push-delivery.config');
const { makeWorld, SEC, HOUR } = require('./push-delivery-fake');

const ACCESS = 'a-very-secret-expo-access-token-0123456789';
const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const ENV = Object.freeze({ PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: ACCESS, NODE_ENV: 'production' });
const SUMMARY_MS = MONITOR.SUMMARY_INTERVAL_SECONDS * 1000;
const COOLDOWN_MS = MONITOR.ALERT_COOLDOWN_SECONDS * 1000;
const prisma = new Proxy({}, { get() { throw new Error('the worker touched Prisma directly'); } });

let world;
let client;
let log;
let credentials;
let monitor;
let clock;

const pass = (over = {}) => runPushDelivery({ store: world.store, prisma, env: ENV, log, client, workerId: 'w1', credentials, monitor, nowMs: () => clock.t, ...over });
const later = (ms) => { clock.t += ms; world.advance(ms); };
const lines = (fn) => fn.mock.calls.map((c) => c[0]);
const summaries = () => [...lines(log.info), ...lines(log.warn)].filter((l) => l.includes('] summary:'));
const alerts = () => lines(log.error).filter((l) => l.startsWith('[ALERT]'));

// Closed deliveries (recent): `n` of them with the given status and code.
function closed(n, status, code = null) {
  for (let i = 0; i < n; i += 1) world.addDelivery({ status, closedAt: world.now - 60 * SEC, lastErrorCode: code, deviceId: null, destinationKey: `device:closed-${status}-${code}-${i}` });
}

beforeEach(() => {
  world = makeWorld();
  credentials = { fingerprint: null, status: 'unverified', checkedAtMs: 0 };
  monitor = monitorModule.createMonitorState();
  clock = { t: world.now };
  client = {
    verifyCredentials: jest.fn(async () => ({ outcome: 'valid' })),
    sendMessage: jest.fn(async () => ({ outcome: 'accepted', ticketId: 'ticket-1' })),
    getReceipts: jest.fn(async () => ({ outcome: 'ok', receipts: new Map() })),
  };
  log = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
});

describe('the aggregate query (real store, recording stub)', () => {
  const rec = (rows) => {
    const calls = [];
    return { calls, $queryRaw: jest.fn(async (strings, ...values) => { calls.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), values }); return rows; }) };
  };

  test('is ONE read-only SELECT of counts: no write, no identifying column, push only, closed rows limited to the window', async () => {
    const db = rec([{ pending: 2n, sending: 1n, accepted: '3', failed: 4n, uncertain: 0n, expired: 5n, oldest_pending_seconds: 90n }]);
    const m = await store.deliveryMetrics(db, { windowHours: 24 });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = db.calls[0];
    expect(sql).toMatch(/^SELECT /);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    expect(sql).toMatch(/FROM notification_deliveries WHERE channel = 'push'/);
    expect(sql).toMatch(/UTC_TIMESTAMP\(3\) - INTERVAL \? HOUR/);
    expect(sql).not.toMatch(/\bid\b|recipient|device_id|notification_id|provider_message_id|locked_by|last_error\b|destination_key/);
    expect(values.every((v) => v === 24)).toBe(true);
    expect(m).toEqual({ pending: 2, sending: 1, accepted: 3, failed: 4, uncertain: 0, expired: 5, oldestPendingSeconds: 90 });
  });

  test('an empty table gives zeros and no oldest pending delivery; a bad window falls back to 24 h', async () => {
    const db = rec([{ pending: 0n, sending: 0n, accepted: 0n, failed: 0n, uncertain: 0n, expired: 0n, oldest_pending_seconds: null }]);
    expect(await store.deliveryMetrics(db, { windowHours: -3 })).toEqual({ pending: 0, sending: 0, accepted: 0, failed: 0, uncertain: 0, expired: 0, oldestPendingSeconds: null });
    expect(db.calls[0].values.every((v) => v === 24)).toBe(true);
  });
});

describe('the fake store computes the same counts (so the worker tests are meaningful)', () => {
  test('counts by status, separates expired from failed, and ignores closed rows outside the window', async () => {
    world.setup();
    closed(2, 'failed', 'MessageTooBig'); closed(3, 'failed', 'expired'); closed(1, 'uncertain', 'timeout');
    world.addDelivery({ status: 'failed', closedAt: world.now - 30 * HOUR, deviceId: null, destinationKey: 'device:old' });
    world.addDelivery({ status: 'accepted', providerMessageId: 't', acceptedAt: world.now, deviceId: null, destinationKey: 'device:acc' });
    world.addDelivery({ status: 'sending', lockedBy: 'x', lockedUntil: world.now + 60 * SEC, deviceId: null, destinationKey: 'device:snd' });
    expect(await world.store.deliveryMetrics(prisma)).toEqual({ pending: 1, sending: 1, accepted: 1, failed: 2, uncertain: 1, expired: 3, oldestPendingSeconds: 0 });
  });
});

describe('the summary', () => {
  test('is rate limited: the first pass only starts the interval, then one line per interval, never one per 15 s tick', async () => {
    world.setup();
    await pass();
    expect(summaries()).toHaveLength(0);
    for (let i = 0; i < 38; i += 1) { later(15 * SEC); await pass(); } // 9.5 minutes of 15 s ticks
    expect(summaries()).toHaveLength(0);
    later(30 * SEC); await pass(); // 10 minutes
    expect(summaries()).toHaveLength(1);
    for (let i = 0; i < 20; i += 1) { later(15 * SEC); await pass(); } // 5 more minutes
    expect(summaries()).toHaveLength(1);
    later(SUMMARY_MS); await pass();
    expect(summaries()).toHaveLength(2);
  });

  test('reports the aggregate counts and nothing else; the line has a fixed shape (no identifiers, text, names or tokens)', async () => {
    world.setup({ notification: { title: 'Your case has been updated', body: 'Open the app' } });
    client.sendMessage.mockResolvedValue({ outcome: 'retry', code: 'expo_server_error' }); // stays pending
    closed(2, 'failed', 'MessageTooBig'); closed(1, 'uncertain', 'timeout'); closed(1, 'failed', 'expired');
    await pass();
    later(SUMMARY_MS); await pass();
    const [line] = summaries();
    expect(line).toMatch(/^\[push-delivery\] summary: state=running, pending=\d+, sending=\d+, accepted=\d+, failed24h=\d+, uncertain24h=\d+, expired24h=\d+, oldestPendingSeconds=(\d+|none)\.$/);
    expect(line).toContain('failed24h=2');
    expect(line).toContain('uncertain24h=1');
    expect(line).toContain('expired24h=1');
    const everything = JSON.stringify([log.warn.mock.calls, log.error.mock.calls, log.info.mock.calls]);
    for (const secret of [ACCESS, TOKEN, 'ExponentPushToken', 'Asha', 'Rao', 'Your case has been updated', 'Open the app', 'device:']) expect(everything).not.toContain(secret);
  });

  test('represents the Expo authentication pause accurately: state=paused_credentials_rejected, at warning level, and no stuck-queue alert', async () => {
    const { delivery } = world.setup();
    delivery.createdAt = world.now - 3 * HOUR; // old and pending: a backlog the pause explains
    client.verifyCredentials.mockResolvedValue({ outcome: 'rejected' });
    await pass();
    later(SUMMARY_MS); await pass();
    const warned = lines(log.warn).filter((l) => l.includes('] summary:'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('state=paused_credentials_rejected');
    expect(warned[0]).toContain('pending=1');
    expect(alerts().filter((a) => a.includes('has waited'))).toHaveLength(0);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(world.deliveries.get(delivery.id).status).toBe('pending'); // the monitor touched nothing
  });
});

describe('alerts', () => {
  test.each([
    ['failed', () => closed(MONITOR.ALERT_FAILED, 'failed', 'MessageTooBig'), /failed in the last 24 h/],
    ['uncertain', () => closed(MONITOR.ALERT_UNCERTAIN, 'uncertain', 'timeout'), /are uncertain/],
    ['expired', () => closed(MONITOR.ALERT_EXPIRED, 'cancelled', 'expired'), /expired unsent/],
  ])('%s deliveries at the threshold raise ONE [ALERT]; below the threshold nothing', async (_name, make, text) => {
    await pass();
    later(SUMMARY_MS); await pass();
    expect(alerts()).toHaveLength(0);
    make();
    later(SUMMARY_MS); await pass();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatch(text);
    expect(alerts()[0]).toMatch(/^\[ALERT\] \[push-delivery\] /);
  });

  test('a delivery count just below each threshold raises nothing', async () => {
    closed(MONITOR.ALERT_FAILED - 1, 'failed', 'x'); closed(MONITOR.ALERT_UNCERTAIN - 1, 'uncertain', 'x'); closed(MONITOR.ALERT_EXPIRED - 1, 'cancelled', 'expired');
    await pass();
    later(SUMMARY_MS); await pass();
    expect(alerts()).toHaveLength(0);
  });

  test('an alert is not repeated on every summary: once per cooldown, then again while the problem persists', async () => {
    closed(MONITOR.ALERT_FAILED, 'failed', 'x');
    await pass();
    for (let i = 0; i < 5; i += 1) { later(SUMMARY_MS); await pass(); } // 50 minutes, five summaries
    expect(summaries().length).toBeGreaterThanOrEqual(5);
    expect(alerts()).toHaveLength(1);
    later(20 * 60 * 1000); await pass(); // 70 minutes: more than the cooldown after the first alert (minute 10)
    expect(alerts()).toHaveLength(2);
    expect(COOLDOWN_MS).toBe(3600 * 1000);
  });

  test('every 15 s tick between summaries is silent even while the problem is present', async () => {
    closed(MONITOR.ALERT_FAILED, 'failed', 'x');
    await pass();
    later(SUMMARY_MS); await pass();
    expect(alerts()).toHaveLength(1);
    for (let i = 0; i < 40; i += 1) { later(15 * SEC); await pass(); }
    expect(alerts()).toHaveLength(1);
  });

  test('a queue that is not being worked (old pending delivery, not paused) raises the stuck alert', async () => {
    const { delivery } = world.setup();
    delivery.createdAt = world.now - 40 * 60 * SEC;
    delivery.nextAttemptAt = world.now + 6 * HOUR; // pending but not due: nothing processes it
    await pass();
    later(SUMMARY_MS); await pass();
    expect(alerts().filter((a) => a.includes('has waited'))).toHaveLength(1);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test('no alert or summary carries a secret, an id or text', async () => {
    closed(MONITOR.ALERT_FAILED, 'failed', 'x'); closed(MONITOR.ALERT_UNCERTAIN, 'uncertain', 'x'); closed(MONITOR.ALERT_EXPIRED, 'cancelled', 'expired');
    world.setup();
    await pass();
    later(SUMMARY_MS); await pass();
    const everything = JSON.stringify([log.warn.mock.calls, log.error.mock.calls, log.info.mock.calls]);
    expect(alerts().length).toBeGreaterThanOrEqual(3);
    for (const secret of [ACCESS, TOKEN, 'ExponentPushToken', 'Asha', 'Open the app', 'Your case', 'device:']) expect(everything).not.toContain(secret);
  });
});

describe('when delivery is not running, the summary says why and reads no database', () => {
  const quiet = () => ({ ...world.store, deliveryMetrics: jest.fn(async () => { throw new Error('the database was read while push delivery is off'); }) });

  test.each([
    ['the switch is off (the default)', {}, 'state=disabled', 'reason=switch_off', 'info'],
    ['the switch is on but the Expo access token is missing', { PUSH_DELIVERY_ENABLED: 'true', NODE_ENV: 'production' }, 'state=credentials_missing', 'reason=access_token_missing', 'warn'],
    ['the switch is on but the Expo access token is invalid', { PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: 'short', NODE_ENV: 'production' }, 'state=credentials_invalid', 'reason=access_token_invalid', 'warn'],
    ['a test or synthetic run is refused whatever the switch says', { ...ENV, NODE_ENV: 'test' }, 'state=suppressed_test_or_synthetic', 'reason=suppressed_test_environment', 'info'],
  ])('%s', async (_name, env, state, reason, level) => {
    const s = quiet();
    await pass({ env, store: s });
    later(SUMMARY_MS);
    const res = await pass({ env, store: s });
    expect(res.active).toBe(false);
    const line = summaries()[0];
    expect(line).toContain(state);
    expect(line).toContain(reason);
    expect(line).toContain('nothing is sent');
    expect(lines(log[level])).toContain(line);
    expect(s.deliveryMetrics).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.verifyCredentials).not.toHaveBeenCalled();
    expect(JSON.stringify([log.warn.mock.calls, log.error.mock.calls, log.info.mock.calls])).not.toContain('short');
  });

  test('missing credentials also raise ONE [ALERT] per cooldown, without the secret', async () => {
    const env = { PUSH_DELIVERY_ENABLED: 'true', NODE_ENV: 'production' };
    await pass({ env });
    for (let i = 0; i < 4; i += 1) { later(SUMMARY_MS); await pass({ env }); }
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('credentials_missing');
  });

  test('the switch off or a test run never raises an [ALERT]', async () => {
    for (const env of [{}, { ...ENV, NODE_ENV: 'test' }]) {
      await pass({ env });
      later(SUMMARY_MS); await pass({ env });
    }
    expect(alerts()).toHaveLength(0);
  });
});

describe('monitoring cannot affect delivery', () => {
  test('a failing metrics query is reported once per interval and the pass still sends and returns its result', async () => {
    world.setup();
    const broken = { ...world.store, deliveryMetrics: jest.fn(async () => { throw Object.assign(new Error('connection lost with SECRET detail'), { code: 'ECONNRESET' }); }) };
    await pass({ store: broken });
    later(SUMMARY_MS);
    world.addDelivery({ deviceId: 10, destinationKey: 'device:10' });
    const res = await pass({ store: broken });
    expect(res.active).toBe(true);
    expect(res.sent.accepted).toBe(1); // delivery went on
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    const warned = lines(log.warn).filter((l) => l.includes('monitoring'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('ECONNRESET');
    expect(warned[0]).not.toContain('SECRET');
  });

  test('a store without the metrics function, a throwing logger and a hanging query never reject the pass', async () => {
    world.setup();
    const { deliveryMetrics: _omit, ...withoutMetrics } = world.store;
    await pass({ store: withoutMetrics });
    later(SUMMARY_MS);
    await expect(pass({ store: withoutMetrics })).resolves.toMatchObject({ active: true });

    const noisy = { warn() { throw new Error('logger down'); }, error() { throw new Error('logger down'); }, info() { throw new Error('logger down'); } };
    later(SUMMARY_MS);
    await expect(pass({ log: noisy })).resolves.toMatchObject({ active: true });
  });

  test('a query that never answers is cut off after the timeout and the pass still returns', async () => {
    jest.useFakeTimers();
    try {
      world.setup();
      const hanging = { ...world.store, deliveryMetrics: () => new Promise(() => {}) };
      await pass({ store: hanging });
      later(SUMMARY_MS);
      const running = pass({ store: hanging });
      await jest.advanceTimersByTimeAsync(MONITOR.METRICS_TIMEOUT_MS + 1000);
      await expect(running).resolves.toMatchObject({ active: true });
      expect(lines(log.warn).some((l) => l.includes('metrics_timeout'))).toBe(true);
    } finally { jest.useRealTimers(); }
  });

  test('the monitor writes nothing: a pass with nothing to do leaves every delivery row exactly as it was', async () => {
    world.setup();
    closed(6, 'failed', 'x');
    await pass(); // sends the one pending delivery
    const before = JSON.stringify([...world.deliveries.values()]) + JSON.stringify(world.attempts);
    later(SUMMARY_MS);
    await pass();
    expect(summaries()).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
    expect(JSON.stringify([...world.deliveries.values()]) + JSON.stringify(world.attempts)).toBe(before);
  });
});

describe('startup configuration line', () => {
  afterEach(() => { monitorModule.resetStartupForTests(); jest.restoreAllMocks(); });

  const log2 = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

  test('the default (switch off) says disabled and not attempting, as information', () => {
    const l = log2();
    expect(monitorModule.logStartup({ env: {}, log: l })).toBe(true);
    expect(l.info).toHaveBeenCalledWith('[push-delivery] startup: delivery=disabled, expoAccessTokenConfigured=no, environment=normal, attemptingDelivery=no, reason=switch_off.');
    expect(l.warn).not.toHaveBeenCalled();
  });

  test('only the exact value "true" is "enabled"', () => {
    for (const v of ['TRUE', 'True', '1', 'yes', 'false', ' true', '']) {
      const l = log2();
      monitorModule.resetStartupForTests();
      monitorModule.logStartup({ env: { PUSH_DELIVERY_ENABLED: v, EXPO_PUSH_ACCESS_TOKEN: ACCESS, NODE_ENV: 'production' }, log: l });
      expect(l.info.mock.calls[0][0]).toContain('delivery=disabled');
      expect(l.info.mock.calls[0][0]).toContain('attemptingDelivery=no');
    }
  });

  test('enabled without the Expo access token: a warning that says the token is not configured, with no secret', () => {
    const l = log2();
    monitorModule.logStartup({ env: { PUSH_DELIVERY_ENABLED: 'true', NODE_ENV: 'production' }, log: l });
    expect(l.warn).toHaveBeenCalledWith('[push-delivery] startup: delivery=enabled, expoAccessTokenConfigured=no, environment=normal, attemptingDelivery=no, reason=access_token_missing.');
    const bad = log2();
    monitorModule.resetStartupForTests();
    monitorModule.logStartup({ env: { PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: 'not valid', NODE_ENV: 'production' }, log: bad });
    expect(bad.warn.mock.calls[0][0]).toContain('expoAccessTokenConfigured=yes');
    expect(bad.warn.mock.calls[0][0]).toContain('reason=access_token_invalid');
    expect(JSON.stringify(bad.warn.mock.calls)).not.toContain('not valid');
  });

  test('enabled with a token: ready to attempt delivery; the token itself is never printed; no Expo client is built and no network call is made', () => {
    const clientModule = require('../../src/integrations/push/expo-push.client');
    const build = jest.spyOn(clientModule, 'createExpoPushClient');
    const fetchSpy = jest.spyOn(global, 'fetch');
    const l = log2();
    monitorModule.logStartup({ env: { PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: ACCESS, NODE_ENV: 'production' }, log: l });
    expect(l.info).toHaveBeenCalledWith('[push-delivery] startup: delivery=enabled, expoAccessTokenConfigured=yes, environment=normal, attemptingDelivery=yes.');
    expect(JSON.stringify([l.info.mock.calls, l.warn.mock.calls, l.error.mock.calls])).not.toContain(ACCESS);
    expect(build).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['test', { NODE_ENV: 'test' }, 'test_environment'],
    ['scoped', { NODE_ENV: 'production', HUMANCARE_SCOPED_RUN: 'true' }, 'scoped_test_run'],
    ['integration', { NODE_ENV: 'production', HUMANCARE_INTEGRATION_RUN: 'true' }, 'integration_test_run'],
    ['synthetic', { NODE_ENV: 'production', SYNTHETIC_E2E_AUTO_APPROVE: 'true' }, 'synthetic_run'],
  ])('a %s run stays suppressed whatever the switch says, and the line says so', (_name, extra, environment) => {
    const l = log2();
    monitorModule.logStartup({ env: { PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: ACCESS, ...extra }, log: l });
    const line = (l.warn.mock.calls[0] || l.info.mock.calls[0])[0];
    expect(line).toContain(`environment=${environment}`);
    expect(line).toContain('attemptingDelivery=no');
    expect(line).toContain(`reason=suppressed_${environment}`);
    expect(line).not.toContain(ACCESS);
  });

  test('is logged once per process', () => {
    const l = log2();
    expect(monitorModule.logStartup({ env: {}, log: l })).toBe(true);
    expect(monitorModule.logStartup({ env: {}, log: l })).toBe(false);
    expect(l.info).toHaveBeenCalledTimes(1);
  });

  test('the dedicated push worker (src/push-delivery-worker.js) calls it after the job has started, guarded so that it can never stop the worker; the main worker no longer does', () => {
    const text = fs.readFileSync(path.join(__dirname, '../../src/push-delivery-worker.js'), 'utf8');
    expect(text).toMatch(/try \{ logStartup\(\{ log \}\); \} catch/);
    expect(text.indexOf('runner.start()')).toBeLessThan(text.indexOf('logStartup({'));
    expect(fs.readFileSync(path.join(__dirname, '../../src/worker.js'), 'utf8')).not.toMatch(/logStartup|push-delivery/);
  });
});

describe('.env.example', () => {
  const text = fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8');

  test('documents both variables, with push delivery OFF by default and an EMPTY Expo access token', () => {
    expect(text).toMatch(/^PUSH_DELIVERY_ENABLED=false\s*$/m);
    expect(text).toMatch(/^EXPO_PUSH_ACCESS_TOKEN=\s*$/m);
    expect(text).toMatch(/OFF BY DEFAULT/);
    expect(text).toMatch(/exactly the word true/);
  });

  test('says the access token is backend only and must not be committed', () => {
    expect(text).toMatch(/BACKEND ONLY/);
    expect(text).toMatch(/Never put it in the mobile app/);
  });

  test('holds no real credential: no value after EXPO_PUSH_ACCESS_TOKEN, no push token, never an enabled switch', () => {
    expect(text).not.toMatch(/EXPO_PUSH_ACCESS_TOKEN=\S/);
    expect(text).not.toMatch(/Expo(nent)?PushToken\[/);
    expect(text).not.toMatch(/^PUSH_DELIVERY_ENABLED=true/m);
    expect(text).not.toMatch(/Bearer\s+\S{16,}/);
  });
});
