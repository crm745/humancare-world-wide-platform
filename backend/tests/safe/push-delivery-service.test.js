/* global describe, test, expect, jest, beforeEach */
// The push delivery worker (push-delivery.service.js) over a fake store with a fake database clock (push-delivery-fake.js) and a fake Expo client.
// No database, no network: Prisma is a stub that throws if anything touches it directly.
// The service imports the shared Prisma client only as its default; every test passes its own store, so the real client is never created.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const { runPushDelivery } = require('../../src/modules/notifications/push-delivery.service');
const { makeWorld, SEC, HOUR } = require('./push-delivery-fake');

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const ENV = Object.freeze({ PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: 'a'.repeat(40), NODE_ENV: 'production' });

let world;
let client;
let log;
let credentials; // the worker's in-memory credential state (one per test, like one per process)
let clock; // the worker's process clock
const prisma = new Proxy({}, { get() { throw new Error('the worker touched Prisma directly'); } });

function pass(over = {}) {
  return runPushDelivery({ store: world.store, prisma, env: ENV, log, client, workerId: 'w1', credentials, nowMs: () => clock.t, ...over });
}
const row = (id) => world.deliveries.get(id);

beforeEach(() => {
  world = makeWorld();
  credentials = { fingerprint: null, status: 'unverified', checkedAtMs: 0 };
  clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  client = { verifyCredentials: jest.fn(async () => ({ outcome: 'valid' })), sendMessage: jest.fn(async () => ({ outcome: 'accepted', ticketId: 'ticket-1' })), getReceipts: jest.fn(async (ids) => ({ outcome: 'ok', receipts: new Map(ids.map((id) => [id, { status: 'ok' }])) })) };
  log = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
});

describe('kill-switch and safety', () => {
  test('disabled (the default): no database access and no Expo call', async () => {
    world.setup();
    for (const env of [{}, { PUSH_DELIVERY_ENABLED: 'false' }, { PUSH_DELIVERY_ENABLED: 'TRUE' }, { PUSH_DELIVERY_ENABLED: '1' }]) {
      const res = await runPushDelivery({ store: world.store, prisma, env: { ...env, EXPO_PUSH_ACCESS_TOKEN: 'a'.repeat(40) }, log, client });
      expect(res).toEqual({ active: false, problem: 'switch_off' });
    }
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.getReceipts).not.toHaveBeenCalled();
    expect([...world.deliveries.values()][0].status).toBe('pending');
  });

  test('enabled but the Expo access token is missing or invalid: nothing runs (fails closed), the problem is logged once', async () => {
    world.setup();
    for (const env of [{ PUSH_DELIVERY_ENABLED: 'true', NODE_ENV: 'production' }, { PUSH_DELIVERY_ENABLED: 'true', NODE_ENV: 'production', EXPO_PUSH_ACCESS_TOKEN: 'short' }]) {
      const res = await runPushDelivery({ store: world.store, prisma, env, log, client });
      expect(res.active).toBe(false);
    }
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/short/);
  });

  test('a scoped, integration, synthetic or test run never sends, even with everything switched on', async () => {
    world.setup();
    for (const extra of [{ HUMANCARE_SCOPED_RUN: 'true' }, { HUMANCARE_INTEGRATION_RUN: 'true' }, { SYNTHETIC_E2E_AUTO_APPROVE: 'true' }, { ALLOW_SYNTHETIC_APPROVAL: 'true' }, { NODE_ENV: 'test' }]) {
      const res = await runPushDelivery({ store: world.store, prisma, env: { ...ENV, ...extra }, log, client });
      expect(res.active).toBe(false);
      expect(res.problem).toMatch(/^suppressed_/);
    }
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect([...world.deliveries.values()][0].status).toBe('pending');
  });

  test('a delivery of a synthetic E2E identity is never offered or sent', async () => {
    const { delivery } = world.setup({ notification: { serviceRequest: { patientName: 'ZZ-SYNTHETIC patient' } } });
    await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(row(delivery.id).status).toBe('pending');
  });

  test('if the Expo client itself refuses (suppressed network), the delivery is uncertain and nothing is retried', async () => {
    const { delivery } = world.setup();
    client.sendMessage.mockRejectedValue(Object.assign(new Error('suppressed'), { code: 'push_network_suppressed' }));
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'uncertain', lastErrorCode: 'client_error' });
  });
});

describe('claim, lease and concurrency', () => {
  test('a due delivery is claimed under a lease, sent once and recorded: attempt count 1, attempt row accepted', async () => {
    const { delivery } = world.setup();
    const res = await pass();
    expect(res.sent).toMatchObject({ claimed: 1, accepted: 1 });
    expect(row(delivery.id)).toMatchObject({ status: 'accepted', attemptCount: 1, providerMessageId: 'ticket-1', lockedBy: null, lockedUntil: null, closedAt: null });
    expect(world.attempts).toEqual([expect.objectContaining({ deliveryId: delivery.id, attemptNumber: 1, status: 'accepted', providerMessageId: 'ticket-1' })]);
    expect(row(delivery.id).nextAttemptAt).toBe(world.now + 15 * 60 * SEC); // first receipt check
  });

  test('the message carries the token from the device row, the catalogue title, the 24 h TTL, and only { screen, serviceRequestId } as data', async () => {
    world.setup({ notification: { data: { screen: 'request', patient: 'x' } } });
    await pass();
    expect(client.sendMessage).toHaveBeenCalledWith({ to: TOKEN, title: 'Your case has been updated', body: 'Open the app', channelId: 'default', ttl: 86400, data: { screen: 'request', serviceRequestId: 7 } });
  });

  test('two workers racing for the same delivery: exactly one sends', async () => {
    world.setup();
    await Promise.all([pass({ workerId: 'w1' }), pass({ workerId: 'w2' })]);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(world.attempts).toHaveLength(1);
  });

  test('a delivery leased by a live worker is not offered to another one', async () => {
    const { delivery } = world.setup();
    Object.assign(row(delivery.id), { status: 'sending', lockedBy: 'other', lockedUntil: world.now + 60 * SEC });
    await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(row(delivery.id).lockedBy).toBe('other');
  });

  test('expired lease, no attempt started: it goes back to pending and is sent in the same pass', async () => {
    const { delivery } = world.setup({ delivery: { status: 'sending', lockedBy: 'dead', lockedUntil: world.now - 1 } });
    const res = await pass();
    expect(res.recovered.pending).toBe(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(row(delivery.id).status).toBe('accepted');
  });

  test('expired lease while an attempt was started: uncertain, never re-sent', async () => {
    const { delivery } = world.setup({ delivery: { status: 'sending', lockedBy: 'dead', lockedUntil: world.now - 1, attemptCount: 1 } });
    world.attempts.push({ deliveryId: delivery.id, attemptNumber: 1, status: 'started', startedAt: new Date(world.now - 5000), finishedAt: null });
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'uncertain', lastErrorCode: 'lease_expired_during_send' });
    expect(client.sendMessage).not.toHaveBeenCalled();
    world.advance(2 * HOUR);
    await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test('a stale "started" attempt is finalised as uncertain', async () => {
    const { delivery } = world.setup({ delivery: { status: 'cancelled', closedAt: world.now } });
    world.attempts.push({ deliveryId: delivery.id, attemptNumber: 1, status: 'started', startedAt: new Date(world.now - 10 * 60 * SEC), finishedAt: null });
    const res = await pass();
    expect(res.recovered.attempts).toBe(1);
    expect(world.attempts[0].status).toBe('uncertain');
  });
});

describe('fencing', () => {
  test('a delivery cancelled (device unregistered) while Expo was being called is NOT overwritten; the attempt still records the answer', async () => {
    const { delivery } = world.setup();
    client.sendMessage.mockImplementation(async () => {
      // the device registry cancels it meanwhile (same fields as notification-devices.service.js)
      Object.assign(row(delivery.id), { status: 'cancelled', closedAt: world.now, lockedBy: null, lockedUntil: null, lastErrorCode: 'device_unregistered' });
      return { outcome: 'accepted', ticketId: 'ticket-9' };
    });
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'device_unregistered', providerMessageId: null });
    expect(world.attempts[0]).toMatchObject({ status: 'accepted', providerMessageId: 'ticket-9' });
  });

  test('a worker whose lease ran out before it could write writes nothing to the delivery; recovery adopts the accepted ticket and NEVER re-sends', async () => {
    const { delivery } = world.setup();
    client.sendMessage.mockImplementation(async () => { world.advance(121 * SEC); return { outcome: 'accepted', ticketId: 'late' }; });
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'sending', providerMessageId: null });
    expect(world.attempts[0]).toMatchObject({ status: 'accepted', providerMessageId: 'late' });
    const res = await pass(); // recovery runs first
    expect(res.recovered.adopted).toBe(1);
    expect(row(delivery.id)).toMatchObject({ status: 'accepted', providerMessageId: 'late', lockedBy: null });
    expect(client.sendMessage).toHaveBeenCalledTimes(1); // the push is not sent a second time
    world.advance(15 * 60 * SEC);
    await pass();
    expect(row(delivery.id).status).toBe('delivered'); // and its receipt is still checked
  });

  test('the same lease race with an uncertain answer ends uncertain, never a re-send', async () => {
    const { delivery } = world.setup();
    client.sendMessage.mockImplementation(async () => { world.advance(121 * SEC); return { outcome: 'uncertain', code: 'timeout' }; });
    await pass();
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'uncertain', lastErrorCode: 'lease_expired_during_send' });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('the same lease race after a retry-safe failure returns to pending and is tried again (within the 3 attempts)', async () => {
    const { delivery } = world.setup();
    client.sendMessage.mockImplementationOnce(async () => { world.advance(121 * SEC); return { outcome: 'retry', code: 'expo_server_error' }; });
    await pass();
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(row(delivery.id)).toMatchObject({ status: 'accepted', attemptCount: 2 });
  });

  test('a delivery taken by another worker between claim and send is dropped', async () => {
    const { delivery } = world.setup();
    const original = world.store.loadForSend;
    world.store.loadForSend = async (db, id) => { Object.assign(row(id), { lockedBy: 'someone-else' }); return original(db, id); };
    await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(row(delivery.id).lockedBy).toBe('someone-else');
  });

  test('a lease too short for the request means no attempt is started and nothing is sent', async () => {
    const { delivery } = world.setup();
    const original = world.store.claim;
    world.store.claim = async (db, args) => original(db, { ...args, leaseSeconds: 10 }); // less than the minimum left
    await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(world.attempts).toHaveLength(0);
    expect(row(delivery.id).attemptCount).toBe(0);
  });
});

describe('re-checks immediately before sending: the delivery is cancelled, nothing is sent', () => {
  const cases = [
    ['the device now belongs to another patient (ownership transfer)', { device: { ownerId: 2 } }, 'device_owner_changed'],
    ['the device is inactive (unregistered)', { device: { status: 'inactive' } }, 'device_inactive'],
    ['the device is not a patient device', { device: { ownerType: 'corporate_user' } }, 'device_owner_changed'],
    ['the device row is gone', { delivery: { deviceId: null, destinationKey: 'user' } }, 'device_missing'],
    ['the destination does not name this device', { delivery: { destinationKey: 'device:99' } }, 'destination_mismatch'],
    ['the device holds a released (non-Expo) token', { device: { expoPushToken: 'released:10:xyz' } }, 'device_token_invalid'],
    ['the notification is deleted by the patient', { notification: { deletedAt: new Date('2026-01-01') } }, 'notification_deleted'],
    ['the delivery names another recipient than the notification', { delivery: { recipientId: 3 } }, 'recipient_mismatch'],
    ['the notification is not a patient notification', { notification: { recipientType: 'corporate_user' } }, 'recipient_not_patient'],
    ['the notification belongs to a synthetic identity', { notification: { serviceRequest: { patientName: 'ZZ-SYNTHETIC x' } } }, 'synthetic_identity'],
  ];
  test.each(cases)('%s', async (_name, over, code) => {
    const { delivery } = world.setup(over);
    if (code === 'synthetic_identity') { // the claim query would not even offer it; call the claimed path directly
      Object.assign(row(delivery.id), { status: 'sending', lockedBy: 'w1', lockedUntil: world.now + 100 * SEC });
      const { processDelivery } = require('../../src/modules/notifications/push-delivery.service');
      await processDelivery({ store: world.store, prisma, log }, client, { id: delivery.id, workerId: 'w1' });
    } else {
      await pass();
    }
    expect(row(delivery.id)).toMatchObject({ status: 'cancelled', lastErrorCode: code });
    expect(row(delivery.id).closedAt).not.toBeNull();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(world.attempts).toHaveLength(0);
  });

  test('the notification row is missing (hard-deleted)', async () => {
    const { delivery } = world.setup();
    world.notifications.clear();
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'notification_missing' });
  });

  test('a device that was active at creation but transferred AFTER the claim is not sent to', async () => {
    const { delivery } = world.setup();
    const original = world.store.claim;
    world.store.claim = async (db, args) => { const c = await original(db, args); world.devices.get(10).ownerId = 2; return c; };
    await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(row(delivery.id).lastErrorCode).toBe('device_owner_changed');
  });
});

describe('push preference', () => {
  test('pushEnabled=false stops a non-mandatory notification', async () => {
    const { delivery } = world.setup();
    world.prefs.set(1, false);
    await pass();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(row(delivery.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'push_disabled' });
  });

  test('a mandatory notification is sent whatever the preference says', async () => {
    const { delivery } = world.setup({ notification: { isMandatory: true } });
    world.prefs.set(1, false);
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(row(delivery.id).status).toBe('accepted');
  });

  test('no preference row means the default (ON)', async () => {
    world.setup();
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Expo outcomes', () => {
  test('DeviceNotRegistered on the ticket: the delivery fails, the device is deactivated, its other open deliveries are cancelled, no retry', async () => {
    const { delivery } = world.setup();
    const other = world.addDelivery({ id: 2001, notificationId: 500 });
    client.sendMessage.mockResolvedValue({ outcome: 'device_not_registered', message: 'gone' });
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'failed', lastErrorCode: 'DeviceNotRegistered' });
    expect(world.devices.get(10)).toMatchObject({ status: 'inactive' });
    expect(row(other.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'device_not_registered' });
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('DeviceNotRegistered does not deactivate a device that has since registered a different token', async () => {
    world.setup();
    client.sendMessage.mockImplementation(async () => { world.devices.get(10).expoPushToken = 'ExponentPushToken[brandnewtokenbrandnew1]'; return { outcome: 'device_not_registered' }; });
    await pass();
    expect(world.devices.get(10).status).toBe('active');
  });

  test('a terminal Expo refusal fails the delivery without a retry', async () => {
    const { delivery } = world.setup();
    client.sendMessage.mockResolvedValue({ outcome: 'failed', code: 'MessageTooBig' });
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'failed', lastErrorCode: 'MessageTooBig' });
    world.advance(HOUR);
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('HTTP 429 is retried after 1 minute; a longer Retry-After postpones further, a shorter one never makes it earlier', async () => {
    const { delivery } = world.setup();
    client.sendMessage.mockResolvedValue({ outcome: 'retry', code: 'rate_limited', retryAfterSeconds: 120 });
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'pending', lastErrorCode: 'rate_limited', attemptCount: 1 });
    expect(row(delivery.id).nextAttemptAt - world.now).toBe(120 * SEC);

    const second = world.addDelivery({ id: 2100 });
    client.sendMessage.mockResolvedValue({ outcome: 'retry', code: 'rate_limited', retryAfterSeconds: 5 });
    await pass();
    expect(row(second.id).nextAttemptAt - world.now).toBe(60 * SEC);

    const third = world.addDelivery({ id: 2200 });
    client.sendMessage.mockResolvedValue({ outcome: 'retry', code: 'rate_limited', retryAfterSeconds: 999999 });
    await pass();
    expect(row(third.id).nextAttemptAt - world.now).toBe(3600 * SEC); // capped
  });

  test('a temporary Expo server failure is retried after 1 minute', async () => {
    const { delivery } = world.setup();
    client.sendMessage.mockResolvedValue({ outcome: 'retry', code: 'expo_server_error', retryAfterSeconds: null });
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'pending', lastErrorCode: 'expo_server_error' });
    expect(row(delivery.id).nextAttemptAt - world.now).toBe(60 * SEC);
    expect(world.attempts[0]).toMatchObject({ status: 'failed', errorCode: 'expo_server_error' });
  });

  test('three attempts at most: retries after 1 minute then 5 minutes, then it fails for good (no fourth attempt, ever)', async () => {
    const { delivery } = world.setup();
    client.sendMessage.mockResolvedValue({ outcome: 'retry', code: 'expo_server_error' });
    await pass(); // attempt 1
    expect(row(delivery.id).nextAttemptAt - world.now).toBe(60 * SEC);
    await pass(); // not due yet
    expect(client.sendMessage).toHaveBeenCalledTimes(1);

    world.advance(60 * SEC);
    await pass(); // attempt 2
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(row(delivery.id).nextAttemptAt - world.now).toBe(5 * 60 * SEC);
    world.advance(5 * 60 * SEC - 1);
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(2); // one millisecond early: still waiting
    world.advance(1);
    await pass(); // attempt 3
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
    expect(row(delivery.id)).toMatchObject({ status: 'failed', lastErrorCode: 'attempts_exhausted', attemptCount: 3 });
    expect(world.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);

    world.advance(HOUR);
    await pass();
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
  });

  test('a timeout (the request may have reached Expo) is uncertain and is NEVER retried', async () => {
    const { delivery } = world.setup();
    client.sendMessage.mockResolvedValue({ outcome: 'uncertain', code: 'timeout' });
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'uncertain', lastErrorCode: 'timeout', attemptCount: 1 });
    expect(world.attempts[0].status).toBe('uncertain');
    for (let i = 0; i < 5; i += 1) { world.advance(HOUR); await pass(); }
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('a malformed Expo answer (client says uncertain) and an unknown outcome are uncertain and never retried', async () => {
    const a = world.setup().delivery;
    client.sendMessage.mockResolvedValue({ outcome: 'uncertain', code: 'malformed_response' });
    await pass();
    expect(row(a.id)).toMatchObject({ status: 'uncertain', lastErrorCode: 'malformed_response' });
    const b = world.addDelivery({ id: 3000 });
    client.sendMessage.mockResolvedValue({ outcome: 'something_new' });
    await pass();
    expect(row(b.id)).toMatchObject({ status: 'uncertain', lastErrorCode: 'unknown_outcome' });
  });
});

describe('receipts', () => {
  async function accepted() {
    const ctx = world.setup();
    await pass();
    expect(row(ctx.delivery.id).status).toBe('accepted');
    return ctx;
  }

  test('not checked before 15 minutes; then a successful receipt marks it delivered (hand-off, not display)', async () => {
    const { delivery } = await accepted();
    world.advance(14 * 60 * SEC);
    await pass();
    expect(client.getReceipts).not.toHaveBeenCalled();
    world.advance(60 * SEC);
    const res = await pass();
    expect(client.getReceipts).toHaveBeenCalledWith(['ticket-1']);
    expect(res.receipts.delivered).toBe(1);
    expect(row(delivery.id)).toMatchObject({ status: 'delivered', lockedBy: null });
    expect(row(delivery.id).deliveredAt).not.toBeNull();
    expect(row(delivery.id).closedAt).not.toBeNull();
  });

  test('a terminal record is never processed again', async () => {
    await accepted();
    world.advance(15 * 60 * SEC);
    await pass();
    world.advance(HOUR);
    await pass();
    await pass();
    expect(client.getReceipts).toHaveBeenCalledTimes(1);
  });

  test('no receipt yet: it stays accepted and is looked at again later (10 minutes)', async () => {
    const { delivery } = await accepted();
    client.getReceipts.mockResolvedValue({ outcome: 'ok', receipts: new Map() });
    world.advance(15 * 60 * SEC);
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'accepted', lastErrorCode: 'receipt_pending' });
    expect(row(delivery.id).nextAttemptAt - world.now).toBe(10 * 60 * SEC);
    await pass();
    expect(client.getReceipts).toHaveBeenCalledTimes(1);
  });

  test('Expo unreachable for receipts: nothing is concluded', async () => {
    const { delivery } = await accepted();
    client.getReceipts.mockResolvedValue({ outcome: 'unavailable', code: 'http_503' });
    world.advance(15 * 60 * SEC);
    await pass();
    expect(row(delivery.id).status).toBe('accepted');
  });

  test('DeviceNotRegistered in a receipt: the delivery fails and the device (unchanged since the send) is deactivated', async () => {
    const { delivery } = await accepted();
    const other = world.addDelivery({ id: 4000, nextAttemptAt: world.now + 10 * HOUR }); // waiting, not due: still open when the receipt arrives
    client.getReceipts.mockResolvedValue({ outcome: 'ok', receipts: new Map([['ticket-1', { status: 'error', code: 'DeviceNotRegistered', message: 'x' }]]) });
    world.advance(15 * 60 * SEC);
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'failed', lastErrorCode: 'DeviceNotRegistered' });
    expect(world.devices.get(10).status).toBe('inactive');
    expect(row(other.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'device_not_registered' });
  });

  test('DeviceNotRegistered in a receipt does not deactivate a device that registered again after the send', async () => {
    await accepted();
    world.advance(5 * 60 * SEC);
    world.devices.get(10).lastRegisteredAt = new Date(world.now); // re-registered after the attempt started
    client.getReceipts.mockResolvedValue({ outcome: 'ok', receipts: new Map([['ticket-1', { status: 'error', code: 'DeviceNotRegistered' }]]) });
    world.advance(10 * 60 * SEC);
    await pass();
    expect(world.devices.get(10).status).toBe('active');
  });

  test('another permanent receipt error is a terminal failure with its code', async () => {
    const { delivery } = await accepted();
    client.getReceipts.mockResolvedValue({ outcome: 'ok', receipts: new Map([['ticket-1', { status: 'error', code: 'MismatchSenderId' }]]) });
    world.advance(15 * 60 * SEC);
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'failed', lastErrorCode: 'MismatchSenderId' });
  });

  test('receipt lookups are bounded: at most one batch of 100 per pass', async () => {
    for (let i = 0; i < 130; i += 1) world.addDelivery({ id: 5000 + i, status: 'accepted', providerMessageId: `t${i}`, acceptedAt: world.now, nextAttemptAt: world.now });
    await pass();
    expect(client.getReceipts.mock.calls[0][0]).toHaveLength(100);
    expect(client.getReceipts).toHaveBeenCalledTimes(1);
  });

  test('no receipt within 24 hours: the outcome is unknown (uncertain), not a success', async () => {
    const { delivery } = await accepted();
    client.getReceipts.mockResolvedValue({ outcome: 'ok', receipts: new Map() });
    world.advance(24 * HOUR + SEC);
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'uncertain', lastErrorCode: 'receipt_expired' });
  });
});

describe('expiry', () => {
  test('a delivery still pending after 24 hours is cancelled and never sent', async () => {
    const { delivery } = world.setup({ delivery: { createdAt: world.now - 25 * HOUR, nextAttemptAt: world.now - 25 * HOUR } });
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'expired' });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test('one that was tried and is waiting for a retry past 24 hours fails as expired', async () => {
    const { delivery } = world.setup({ delivery: { createdAt: world.now - 25 * HOUR, nextAttemptAt: world.now + HOUR, attemptCount: 1 } });
    await pass();
    expect(row(delivery.id)).toMatchObject({ status: 'failed', lastErrorCode: 'expired' });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test('a delivery just under 24 hours old is still sent', async () => {
    world.setup({ delivery: { createdAt: world.now - 23 * HOUR } });
    await pass();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('secrets', () => {
  test('the Expo token and the access token appear in no stored delivery or attempt row and no log line', async () => {
    world.setup();
    client.sendMessage.mockResolvedValueOnce({ outcome: 'retry', code: 'expo_server_error', message: `bad ${TOKEN}` });
    await pass();
    world.advance(60 * SEC);
    await pass();
    world.advance(20 * 60 * SEC);
    await pass();
    const everything = JSON.stringify([...world.deliveries.values()]) + JSON.stringify(world.attempts) + JSON.stringify([log.warn.mock.calls, log.error.mock.calls, log.info.mock.calls]);
    expect(everything).not.toContain('abcdefghijklmnopqrstuv');
    expect(everything).not.toContain(ENV.EXPO_PUSH_ACCESS_TOKEN);
  });
});
