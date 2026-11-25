/* global describe, test, expect, jest, beforeEach */
// The global pause when Expo rejects the ACCESS TOKEN (HTTP 401/403): nothing is sent, pending deliveries are kept untouched, no delivery loses an
// attempt, the error is reported once without the secret, and sending resumes only when Expo no longer rejects the credential.
// Fake store with a fake database clock + a fake Expo client; no database, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const { runPushDelivery } = require('../../src/modules/notifications/push-delivery.service');
const { POLICY } = require('../../src/modules/notifications/push-delivery.config');
const { makeWorld, SEC, HOUR } = require('./push-delivery-fake');

const SECRET = 'a-very-secret-expo-access-token-0123456789';
const ENV = Object.freeze({ PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: SECRET, NODE_ENV: 'production' });
const RECHECK_MS = POLICY.CREDENTIAL_RECHECK_SECONDS * 1000;
const prisma = new Proxy({}, { get() { throw new Error('the worker touched Prisma directly'); } });

let world;
let client;
let log;
let credentials;
let clock;

const pass = (over = {}) => runPushDelivery({ store: world.store, prisma, env: ENV, log, client, workerId: 'w1', credentials, nowMs: () => clock.t, ...over });
const row = (id) => world.deliveries.get(id);
const everyLog = () => JSON.stringify([log.warn.mock.calls, log.error.mock.calls, log.info.mock.calls]);

beforeEach(() => {
  world = makeWorld();
  credentials = { fingerprint: null, status: 'unverified', checkedAtMs: 0 };
  clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  client = {
    verifyCredentials: jest.fn(async () => ({ outcome: 'valid' })),
    sendMessage: jest.fn(async () => ({ outcome: 'accepted', ticketId: 'ticket-1' })),
    getReceipts: jest.fn(async (ids) => ({ outcome: 'ok', receipts: new Map(ids.map((id) => [id, { status: 'ok' }])) })),
  };
  log = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
});

// Two pending deliveries for two devices of the same patient.
function twoDeliveries() {
  const first = world.setup();
  world.addDevice({ id: 11 });
  const second = world.addDelivery({ deviceId: 11, destinationKey: 'device:11' });
  return { first: first.delivery, second };
}
const untouched = (d) => expect(row(d.id)).toMatchObject({ status: 'pending', attemptCount: 0, lockedBy: null, lockedUntil: null, closedAt: null, providerMessageId: null });

describe('the kill-switch still comes first', () => {
  test('disabled (the default): not even the credential check is made', async () => {
    world.setup();
    expect(await runPushDelivery({ store: world.store, prisma, env: {}, log, client, credentials })).toEqual({ active: false, problem: 'switch_off' });
    expect(client.verifyCredentials).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

describe('the credential is checked BEFORE any delivery is touched', () => {
  test('a fresh worker tests the token first; a rejected token means no delivery is claimed, started or changed', async () => {
    const { first, second } = twoDeliveries();
    client.verifyCredentials.mockResolvedValue({ outcome: 'rejected', status: 401 });
    const res = await pass();
    expect(res).toMatchObject({ active: true, paused: 'credentials_rejected' });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.getReceipts).not.toHaveBeenCalled();
    untouched(first);
    untouched(second);
    expect(world.attempts).toHaveLength(0);
  });

  test('a restart with the same bad token pauses again without touching anything (the state is per process)', async () => {
    const { first } = twoDeliveries();
    client.verifyCredentials.mockResolvedValue({ outcome: 'rejected', status: 403 });
    await pass();
    credentials = { fingerprint: null, status: 'unverified', checkedAtMs: 0 }; // a new process
    clock.t += 5 * 60 * SEC;
    await pass();
    expect(client.verifyCredentials).toHaveBeenCalledTimes(2);
    untouched(first);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test('an inconclusive check (network, 5xx, 429) sends nothing this pass, concludes nothing, and asks again next pass', async () => {
    const { first } = twoDeliveries();
    client.verifyCredentials.mockResolvedValueOnce({ outcome: 'unknown', code: 'http_503' });
    expect(await pass()).toMatchObject({ paused: 'credentials_unverified' });
    untouched(first);
    expect(credentials.status).toBe('unverified');
    expect(log.error).not.toHaveBeenCalled();
    await pass(); // the next check is clear
    expect(client.verifyCredentials).toHaveBeenCalledTimes(2);
    expect(row(first.id).status).toBe('accepted');
  });

  test('a check that throws sends nothing', async () => {
    const { first } = twoDeliveries();
    client.verifyCredentials.mockRejectedValueOnce(Object.assign(new Error('suppressed'), { code: 'push_network_suppressed' }));
    expect(await pass()).toMatchObject({ paused: 'credentials_unverified' });
    untouched(first);
  });

  test('an accepted token is checked once, not on every pass', async () => {
    world.setup();
    await pass();
    await pass();
    await pass();
    expect(client.verifyCredentials).toHaveBeenCalledTimes(1);
  });
});

describe('Expo rejects the token in the middle of a send (HTTP 401 / 403)', () => {
  for (const status of [401, 403]) {
    test(`HTTP ${status}: the delivery goes back to pending with its attempt given back, nothing else is sent, nothing is failed`, async () => {
      const { first, second } = twoDeliveries();
      client.sendMessage.mockResolvedValue({ outcome: 'unauthorized', status });
      const res = await pass();
      expect(res).toMatchObject({ active: true, paused: 'credentials_rejected' });
      expect(client.sendMessage).toHaveBeenCalledTimes(1); // the second delivery is never even claimed
      untouched(second);
      // the first one: pending again, no attempt used up, the history keeps the voided attempt
      expect(row(first.id)).toMatchObject({ status: 'pending', attemptCount: 0, lockedBy: null, lockedUntil: null, closedAt: null, lastErrorCode: 'expo_unauthorized' });
      expect(world.attempts).toEqual([expect.objectContaining({ deliveryId: first.id, attemptNumber: 1, status: 'failed', errorCode: 'expo_unauthorized' })]);
      for (const d of world.deliveries.values()) expect(['failed', 'cancelled', 'uncertain']).not.toContain(d.status);
    });
  }

  test('the pause holds: later passes send nothing and look at no delivery; the error was reported once', async () => {
    const { first, second } = twoDeliveries();
    client.sendMessage.mockResolvedValue({ outcome: 'unauthorized', status: 401 });
    await pass();
    for (let i = 0; i < 5; i += 1) { clock.t += 60 * SEC; await pass(); }
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.verifyCredentials).toHaveBeenCalledTimes(1); // the first, valid, check: no re-check inside the 15 minutes
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(row(first.id)).toMatchObject({ status: 'pending', attemptCount: 0 });
    untouched(second);
  });

  test('the report names the problem and the setting, and never contains the token', async () => {
    world.setup();
    client.sendMessage.mockResolvedValue({ outcome: 'unauthorized', status: 401 });
    await pass();
    const text = log.error.mock.calls[0][0];
    expect(text).toMatch(/Expo rejected the access token/);
    expect(text).toMatch(/EXPO_PUSH_ACCESS_TOKEN/);
    expect(everyLog()).not.toContain(SECRET);
    expect(everyLog()).not.toMatch(/[0-9a-f]{64}/); // not even its fingerprint
  });

  test('receipt lookups are paused too: a 401 while looking up receipts concludes nothing and releases the leases', async () => {
    world.setup();
    await pass(); // accepted
    clock.t += 15 * 60 * SEC;
    world.advance(15 * 60 * SEC);
    client.getReceipts.mockResolvedValue({ outcome: 'unauthorized', status: 401 });
    const res = await pass();
    expect(res.paused).toBe('credentials_rejected');
    const d = [...world.deliveries.values()][0];
    expect(d).toMatchObject({ status: 'accepted', lockedBy: null, lockedUntil: null, deliveredAt: null });
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe('resuming after the credential is corrected', () => {
  async function pausedWithVoidedAttempt() {
    const { first, second } = twoDeliveries();
    client.sendMessage.mockResolvedValue({ outcome: 'unauthorized', status: 401 });
    await pass();
    client.sendMessage.mockClear();
    client.verifyCredentials.mockClear();
    return { first, second };
  }

  test('the SAME token is tested again only after 15 minutes; while Expo still rejects it the pause stays and nothing is touched', async () => {
    const { first, second } = await pausedWithVoidedAttempt();
    clock.t += RECHECK_MS - 1;
    await pass();
    expect(client.verifyCredentials).not.toHaveBeenCalled(); // not yet
    clock.t += 1;
    client.verifyCredentials.mockResolvedValue({ outcome: 'rejected', status: 401 });
    const res = await pass();
    expect(client.verifyCredentials).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe('credentials_rejected');
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(row(first.id)).toMatchObject({ status: 'pending', attemptCount: 0 });
    untouched(second);
    expect(log.error).toHaveBeenCalledTimes(1); // still the one report
    // and the wait starts again: not tested again a minute later
    clock.t += 60 * SEC;
    await pass();
    expect(client.verifyCredentials).toHaveBeenCalledTimes(1);
  });

  test('once Expo accepts the credential again, sending resumes and the kept deliveries are sent; the voided attempt never counted', async () => {
    const { first, second } = await pausedWithVoidedAttempt();
    clock.t += RECHECK_MS;
    client.verifyCredentials.mockResolvedValue({ outcome: 'valid' });
    client.sendMessage.mockResolvedValue({ outcome: 'accepted', ticketId: 'ticket-ok' });
    const res = await pass();
    expect(res.paused).toBeUndefined();
    expect(log.warn.mock.calls.map((c) => c[0])).toContain('[push-delivery] Expo accepts the access token again: sending resumed.');
    expect(row(first.id)).toMatchObject({ status: 'accepted', attemptCount: 1, providerMessageId: 'ticket-ok' }); // one counted attempt, not two
    expect(row(second.id)).toMatchObject({ status: 'accepted', attemptCount: 1 });
    // the history keeps both rows of the first delivery, numbered without a clash
    expect(world.attempts.filter((a) => a.deliveryId === first.id).map((a) => [a.attemptNumber, a.status])).toEqual([[1, 'failed'], [2, 'accepted']]);
  });

  test('after the voided attempt the delivery still has all three attempts: a real failure then retries on the normal 1 and 5 minute delays', async () => {
    const { first } = await pausedWithVoidedAttempt();
    clock.t += RECHECK_MS;
    world.advance(RECHECK_MS);
    client.verifyCredentials.mockResolvedValue({ outcome: 'valid' });
    client.sendMessage.mockResolvedValue({ outcome: 'retry', code: 'expo_server_error' });
    await pass();
    expect(row(first.id)).toMatchObject({ status: 'pending', attemptCount: 1 });
    expect(row(first.id).nextAttemptAt - world.now).toBe(60 * SEC); // the 1-minute delay of the FIRST counted attempt
    world.advance(60 * SEC);
    await pass();
    expect(row(first.id)).toMatchObject({ attemptCount: 2 });
    expect(row(first.id).nextAttemptAt - world.now).toBe(5 * 60 * SEC);
    world.advance(5 * 60 * SEC);
    await pass();
    expect(row(first.id)).toMatchObject({ status: 'failed', lastErrorCode: 'attempts_exhausted', attemptCount: 3 });
    expect(world.attempts.filter((a) => a.deliveryId === first.id)).toHaveLength(4); // 1 voided + 3 counted
  });

  test('a different token (corrected configuration) is checked at once, without waiting', async () => {
    const { first } = await pausedWithVoidedAttempt();
    client.verifyCredentials.mockResolvedValue({ outcome: 'valid' });
    client.sendMessage.mockResolvedValue({ outcome: 'accepted', ticketId: 'ticket-new' });
    clock.t += 60 * SEC; // well inside the waiting period
    await runPushDelivery({
      store: world.store, prisma, log, client, workerId: 'w1', credentials, nowMs: () => clock.t,
      env: { ...ENV, EXPO_PUSH_ACCESS_TOKEN: 'a-corrected-expo-access-token-9876543210' },
    });
    expect(client.verifyCredentials).toHaveBeenCalledTimes(1);
    expect(row(first.id).status).toBe('accepted');
  });
});

describe('database-only upkeep continues during a pause', () => {
  test('a delivery older than 24 hours still expires (approved policy) while sending is paused; the others are untouched', async () => {
    const { first } = twoDeliveries();
    const old = world.addDelivery({ createdAt: world.now - 25 * HOUR, nextAttemptAt: world.now - 25 * HOUR });
    client.verifyCredentials.mockResolvedValue({ outcome: 'rejected', status: 401 });
    await pass();
    expect(row(old.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'expired' });
    untouched(first);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
