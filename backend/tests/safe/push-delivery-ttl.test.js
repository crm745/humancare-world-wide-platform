/* global describe, test, expect, jest, beforeEach */
// The Expo push TTL: every message carries the seconds left of the delivery's 24 h window (counted from the delivery row's own created_at), a delivery
// with too little left is not sent (the existing expiry closes it), and nothing is ever extended. Fake store + fake clocks + fake Expo client: no
// database, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const { runPushDelivery, processDelivery, buildContext, remainingLifetimeSeconds } = require('../../src/modules/notifications/push-delivery.service');
const { POLICY } = require('../../src/modules/notifications/push-delivery.config');
const { createExpoPushClient } = require('../../src/integrations/push/expo-push.client');
const { makeWorld, SEC, HOUR } = require('./push-delivery-fake');

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const ENV = Object.freeze({ PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: 'a'.repeat(40), NODE_ENV: 'production' });
const WINDOW = 24 * 3600;
const prisma = new Proxy({}, { get() { throw new Error('the worker touched Prisma directly'); } });

let world;
let client;
let log;
let credentials;
let clock;
let monitor;

const pass = (over = {}) => runPushDelivery({ store: world.store, prisma, env: ENV, log, client, workerId: 'w1', credentials, monitor, nowMs: () => clock.t, ...over });
// Both clocks (the worker's and the fake database's) move together, like one machine.
const later = (ms) => { clock.t += ms; world.advance(ms); };
const sentTtl = (call = 0) => client.sendMessage.mock.calls[call][0].ttl;

beforeEach(() => {
  world = makeWorld();
  credentials = { fingerprint: null, status: 'unverified', checkedAtMs: 0 };
  monitor = { lastSummaryAtMs: 0, lastAlertAtMs: {} };
  clock = { t: world.now };
  client = {
    verifyCredentials: jest.fn(async () => ({ outcome: 'valid' })),
    sendMessage: jest.fn(async () => ({ outcome: 'accepted', ticketId: 'ticket-1' })),
    getReceipts: jest.fn(async () => ({ outcome: 'ok', receipts: new Map() })),
  };
  log = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
});

describe('remainingLifetimeSeconds', () => {
  const T = Date.parse('2026-01-01T00:00:00Z');
  test('a new delivery has the whole window; an older one has less (Date, number and ISO string are read the same way)', () => {
    expect(remainingLifetimeSeconds(new Date(T), T)).toBe(WINDOW);
    expect(remainingLifetimeSeconds(T, T + 6 * HOUR)).toBe(WINDOW - 6 * 3600);
    expect(remainingLifetimeSeconds(new Date(T).toISOString(), T + 23 * HOUR + 30 * SEC)).toBe(3600 - 30);
  });
  test('never more than the window (a created_at in the future), and zero or negative once the window is over', () => {
    expect(remainingLifetimeSeconds(T + 2 * HOUR, T)).toBe(WINDOW);
    expect(remainingLifetimeSeconds(T, T + WINDOW * SEC)).toBe(0);
    expect(remainingLifetimeSeconds(T, T + WINDOW * SEC + 90 * SEC)).toBe(-90);
  });
  test('an unreadable created_at is null, never "now"', () => {
    for (const bad of [null, undefined, 'not a date', {}, NaN]) expect(remainingLifetimeSeconds(bad, T)).toBeNull();
  });
});

describe('the TTL on the Expo message', () => {
  test('a new delivery is sent with the whole 24 h window; the text, data and routing are exactly as before', async () => {
    world.setup({ notification: { data: { screen: 'request', patient: 'x' } } });
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith({
      to: TOKEN, title: 'Your case has been updated', body: 'Open the app', channelId: 'default', ttl: WINDOW, data: { screen: 'request', serviceRequestId: 7 },
    });
  });

  test('an older delivery gets a shorter TTL: what is left of its own window', async () => {
    const { delivery } = world.setup();
    delivery.createdAt = world.now - 6 * HOUR; // created six hours ago (persisted creation time)
    await pass();
    expect(sentTtl()).toBe(WINDOW - 6 * 3600);
  });

  test('a retry is sent with a shorter TTL than the first attempt (the window is not restarted)', async () => {
    world.setup();
    client.sendMessage.mockResolvedValueOnce({ outcome: 'retry', code: 'expo_server_error' });
    await pass();
    later(61 * SEC);
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(sentTtl(0)).toBe(WINDOW);
    expect(sentTtl(1)).toBe(WINDOW - 61);
    expect(sentTtl(1)).toBeLessThan(sentTtl(0));
  });

  test('the TTL is never longer than the window, even for a created_at that is slightly in the future', async () => {
    const { delivery } = world.setup();
    delivery.createdAt = world.now + 2 * HOUR;
    await pass();
    expect(sentTtl()).toBe(WINDOW);
  });

  test('the TTL is a whole number of seconds', async () => {
    const { delivery } = world.setup();
    delivery.createdAt = world.now - 1234; // 1.234 s old
    await pass();
    expect(Number.isInteger(sentTtl())).toBe(true);
    expect(sentTtl()).toBe(WINDOW - 2);
  });
});

describe('a delivery that is expired or about to expire is not sent', () => {
  test('an expired delivery is closed by the existing expiry and never sent', async () => {
    const { delivery } = world.setup();
    later(WINDOW * SEC + SEC);
    const res = await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(world.deliveries.get(delivery.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'expired', attemptCount: 0 });
    expect(res.expired.cancelled).toBe(1);
  });

  test('the guard in processDelivery itself: with the window over it hands the delivery back (pending, no attempt, no send)', async () => {
    const { delivery } = world.setup();
    const claimed = await world.store.claim(prisma, { id: delivery.id, workerId: 'w1', leaseSeconds: 120 });
    clock.t += WINDOW * SEC + 5 * SEC; // the worker's clock says the window is over (the database's has not caught up)
    const ctx = buildContext({ store: world.store, prisma, env: ENV, log, client, workerId: 'w1', credentials, nowMs: () => clock.t });
    expect(await processDelivery(ctx, client, claimed)).toBe('expiring');
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(world.attempts).toHaveLength(0);
    expect(world.deliveries.get(delivery.id)).toMatchObject({ status: 'pending', attemptCount: 0, lastErrorCode: 'expiry_window_closing', lockedBy: null });
  });

  test('the minimum TTL cannot extend the window: 59 s left is not sent, 60 s left is sent with exactly 60', async () => {
    const { delivery } = world.setup();
    delivery.createdAt = world.now - (WINDOW - 59) * SEC;
    await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(world.deliveries.get(delivery.id)).toMatchObject({ status: 'pending', attemptCount: 0 });

    const second = world.addDelivery({ createdAt: world.now - (WINDOW - POLICY.MIN_TTL_SECONDS) * SEC, deviceId: 10, destinationKey: 'device:10' });
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentTtl()).toBe(POLICY.MIN_TTL_SECONDS);
    expect(world.deliveries.get(second.id).status).toBe('accepted');
  });

  test('a nearly expired delivery is left to the expiry: it is closed on the pass after its window ends, still never sent', async () => {
    const { delivery } = world.setup();
    delivery.createdAt = world.now - (WINDOW - 30) * SEC; // 30 s left
    await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(world.deliveries.get(delivery.id).nextAttemptAt).toBe(world.now + 31 * SEC); // not retried before the window is over
    later(31 * SEC);
    await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(world.deliveries.get(delivery.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'expired' });
  });

  test('a delivery that was tried before and runs out of window is failed by the expiry, not sent again', async () => {
    world.setup();
    client.sendMessage.mockResolvedValue({ outcome: 'retry', code: 'expo_server_error' });
    await pass();
    later(61 * SEC);
    const [d] = [...world.deliveries.values()];
    d.createdAt = world.now - (WINDOW - 20) * SEC; // 20 s left now
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    later(21 * SEC);
    await pass();
    expect(d).toMatchObject({ status: 'failed', lastErrorCode: 'expired', attemptCount: 1 });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('an unreadable created_at is never replaced by the current time: the delivery is cancelled, not sent', async () => {
    const { delivery } = world.setup();
    delivery.createdAt = null;
    const claimed = await world.store.claim(prisma, { id: delivery.id, workerId: 'w1', leaseSeconds: 120 });
    const ctx = buildContext({ store: world.store, prisma, env: ENV, log, client, workerId: 'w1', credentials, nowMs: () => clock.t });
    expect(await processDelivery(ctx, client, claimed)).toBe('cancelled');
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(world.deliveries.get(delivery.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'created_at_unreadable' });
  });
});

describe('the ticket and receipt behaviour is unchanged', () => {
  test('accepted -> receipt delivered, as before', async () => {
    const { delivery } = world.setup();
    client.getReceipts.mockImplementation(async (ids) => ({ outcome: 'ok', receipts: new Map(ids.map((id) => [id, { status: 'ok' }])) }));
    await pass();
    expect(world.deliveries.get(delivery.id).status).toBe('accepted');
    later(POLICY.RECEIPT_FIRST_CHECK_SECONDS * SEC + SEC);
    await pass();
    expect(world.deliveries.get(delivery.id).status).toBe('delivered');
  });
});

describe('the Expo client passes the TTL through and nothing else changes', () => {
  test('ttl is in the request body next to the unchanged message', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data: [{ status: 'ok', id: 'T1' }] }) }));
    const real = createExpoPushClient({ accessToken: 'secret-access-token-0123456789', env: { NODE_ENV: 'production' }, fetchImpl });
    const message = { to: TOKEN, title: 'T', body: 'B', channelId: 'default', ttl: 3600, data: { screen: 'request', serviceRequestId: 7 } };
    await real.sendMessage(message);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual([{ ...message, sound: 'default' }]);
  });
});
