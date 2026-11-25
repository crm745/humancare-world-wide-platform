/* global describe, test, expect, jest, beforeEach, afterEach */
// enqueuePushDeliveries(tx, notification): one push delivery row per eligible active device, inside the caller's transaction. A fake transaction
// client over plain objects: it ENFORCES the unique index (notification, channel, destination), and a query returns only the fields it SELECTs, so
// "the helper never reads the Expo token" is a checkable property. No database, no network.
const fs = require('fs');
const path = require('path');
const { enqueuePushDeliveries } = require('../../src/modules/notifications/push-delivery-enqueue');
const catalogue = require('../../src/modules/notifications/notification-catalogue');

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const T0 = new Date('2026-01-01T10:00:00.000Z'); // the notification is created now
const EARLIER = new Date('2026-01-01T09:00:00.000Z');
const LATER = new Date('2026-01-01T11:00:00.000Z');

const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row });
const uniqueError = (target) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });

function makeDb() {
  const db = { notifications: new Map(), prefs: new Map(), devices: [], deliveries: [], nextId: 1, createError: null, selects: [], creates: [] };
  db.tx = {
    notification: { findUnique: jest.fn(async ({ where, select }) => { const n = db.notifications.get(where.id); return n ? pick(n, select) : null; }) },
    notificationPreference: {
      findUnique: jest.fn(async ({ where, select }) => {
        const key = where.ownerType_ownerId;
        const p = db.prefs.get(`${key.ownerType}:${key.ownerId}`);
        return p ? pick(p, select) : null;
      }),
    },
    notificationDevice: {
      findMany: jest.fn(async ({ where, select, orderBy }) => {
        db.selects.push(select);
        const rows = db.devices.filter((d) => d.ownerType === where.ownerType && d.ownerId === where.ownerId && d.status === where.status
          && d.lastRegisteredAt.getTime() <= where.lastRegisteredAt.lte.getTime());
        if (orderBy && orderBy.id === 'asc') rows.sort((a, b) => a.id - b.id);
        return rows.map((d) => pick(d, select));
      }),
    },
    notificationDelivery: {
      findMany: jest.fn(async ({ where, select }) => db.deliveries.filter((d) => d.notificationId === where.notificationId && d.channel === where.channel).map((d) => pick(d, select))),
      create: jest.fn(async ({ data, select }) => {
        db.creates.push(data);
        if (db.createError) { const e = db.createError; db.createError = null; throw e; }
        if (db.deliveries.some((d) => d.notificationId === data.notificationId && d.channel === data.channel && d.destinationKey === data.destinationKey)) throw uniqueError('notification_deliveries_dest_key');
        const row = { id: db.nextId++, status: 'pending', attemptCount: 0, ...data };
        db.deliveries.push(row);
        return pick(row, select);
      }),
    },
  };
  db.addNotification = (over = {}) => { const n = { id: 500, recipientType: 'patient', recipientId: 1, kind: 'stage_update', isMandatory: false, deletedAt: null, createdAt: T0, ...over }; db.notifications.set(n.id, n); return n; };
  db.addDevice = (over = {}) => { const d = { id: db.devices.length + 10, ownerType: 'patient', ownerId: 1, status: 'active', expoPushToken: TOKEN_A, lastRegisteredAt: EARLIER, ...over }; db.devices.push(d); return d; };
  return db;
}

let db;
let realFetch;
beforeEach(() => { db = makeDb(); realFetch = global.fetch; global.fetch = jest.fn(async () => { throw new Error('network must not be used'); }); });
afterEach(() => { global.fetch = realFetch; });

describe('devices', () => {
  test('one active device: one delivery, with the actual schema fields and a device reference (no token)', async () => {
    db.addNotification();
    const device = db.addDevice();
    const result = await enqueuePushDeliveries(db.tx, { id: 500 });
    expect(result).toEqual({ notificationId: 500, enqueued: 1, alreadyQueued: 0, skipped: null });
    expect(db.creates).toEqual([{
      notificationId: 500, recipientType: 'patient', recipientId: 1, channel: 'push', provider: 'expo', deviceId: device.id, destinationKey: `device:${device.id}`,
    }]);
  });

  test('several active devices: exactly one delivery per device, in id order', async () => {
    db.addNotification();
    const [a, b, c] = [db.addDevice({ expoPushToken: TOKEN_A }), db.addDevice({ expoPushToken: TOKEN_B }), db.addDevice()];
    const result = await enqueuePushDeliveries(db.tx, { id: 500 });
    expect(result).toMatchObject({ enqueued: 3, alreadyQueued: 0, skipped: null });
    expect(db.deliveries.map((d) => d.destinationKey)).toEqual([`device:${a.id}`, `device:${b.id}`, `device:${c.id}`]);
    expect(new Set(db.deliveries.map((d) => d.deviceId)).size).toBe(3);
  });

  test('no active devices: nothing is created and the reason is reported', async () => {
    db.addNotification();
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toEqual({ notificationId: 500, enqueued: 0, alreadyQueued: 0, skipped: 'no_active_devices' });
    expect(db.deliveries).toHaveLength(0);
  });

  test('inactive devices are excluded', async () => {
    db.addNotification();
    db.addDevice({ status: 'inactive' });
    const active = db.addDevice();
    await enqueuePushDeliveries(db.tx, { id: 500 });
    expect(db.deliveries.map((d) => d.deviceId)).toEqual([active.id]);
  });

  test('devices of another patient (or of a corporate user) are excluded', async () => {
    db.addNotification();
    db.addDevice({ ownerId: 2 });
    db.addDevice({ ownerType: 'corporate_user', ownerId: 1 });
    const mine = db.addDevice();
    await enqueuePushDeliveries(db.tx, { id: 500 });
    expect(db.deliveries.map((d) => d.deviceId)).toEqual([mine.id]);
  });

  test('a device registered AFTER the notification was created never receives it (also when the helper is called again later)', async () => {
    db.addNotification();
    const early = db.addDevice();
    await enqueuePushDeliveries(db.tx, { id: 500 });
    const late = db.addDevice({ lastRegisteredAt: LATER }); // a new phone, or an account that just signed in
    const again = await enqueuePushDeliveries(db.tx, { id: 500 });
    expect(again).toMatchObject({ enqueued: 0, alreadyQueued: 1 });
    expect(db.deliveries.map((d) => d.deviceId)).toEqual([early.id]);
    expect(db.deliveries.some((d) => d.deviceId === late.id)).toBe(false);
  });
});

describe('who the recipient is', () => {
  test('ownership comes from the persisted notification, never from the object the caller passes', async () => {
    db.addNotification({ recipientId: 1 });
    const mine = db.addDevice({ ownerId: 1 });
    db.addDevice({ ownerId: 99 });
    const forged = { id: 500, recipientType: 'corporate_user', recipientId: 99, kind: 'security_new_login', isMandatory: true, deletedAt: null, ownerId: 99 };
    const result = await enqueuePushDeliveries(db.tx, forged);
    expect(result.enqueued).toBe(1);
    expect(db.deliveries).toEqual([expect.objectContaining({ recipientType: 'patient', recipientId: 1, deviceId: mine.id })]);
  });

  test('only the id is used: an unknown id creates nothing, a non-id is refused', async () => {
    db.addNotification();
    db.addDevice();
    expect(await enqueuePushDeliveries(db.tx, { id: 777 })).toEqual({ notificationId: 777, enqueued: 0, alreadyQueued: 0, skipped: 'notification_not_found' });
    for (const bad of [null, undefined, {}, { id: 0 }, { id: -1 }, { id: '500' }, { id: 1.5 }, 500]) {
      await expect(enqueuePushDeliveries(db.tx, bad)).rejects.toMatchObject({ code: 'notification_id_invalid' });
    }
    expect(db.deliveries).toHaveLength(0);
  });
});

describe('eligibility', () => {
  test.each([
    ['deleted by the patient', { deletedAt: new Date() }, 'notification_deleted'],
    ['a corporate notification', { recipientType: 'corporate_user' }, 'recipient_not_patient'],
    ['an unknown kind', { kind: 'made_up' }, 'kind_not_eligible'],
    ['an invalid recipient id', { recipientId: 0 }, 'recipient_invalid'],
  ])('%s gets no delivery', async (_name, over, reason) => {
    db.addNotification(over);
    db.addDevice({ ownerId: over.recipientId === 0 ? 0 : 1 });
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toEqual({ notificationId: 500, enqueued: 0, alreadyQueued: 0, skipped: reason });
    expect(db.deliveries).toHaveLength(0);
    expect(db.creates).toHaveLength(0);
  });
});

describe('push preference', () => {
  test('pushEnabled=false stops a non-mandatory notification (nothing created, no device is even looked up)', async () => {
    db.addNotification();
    db.addDevice();
    db.prefs.set('patient:1', { inAppEnabled: true, pushEnabled: false });
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toMatchObject({ enqueued: 0, skipped: 'push_disabled' });
    expect(db.tx.notificationDevice.findMany).not.toHaveBeenCalled();
  });

  test('a mandatory catalogue notification bypasses pushEnabled=false', async () => {
    db.addNotification({ kind: 'payment_received', isMandatory: true });
    db.addDevice();
    db.prefs.set('patient:1', { inAppEnabled: false, pushEnabled: false });
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toMatchObject({ enqueued: 1, skipped: null });
  });

  test('"mandatory" needs BOTH the catalogue and the stored snapshot: either alone does not bypass', async () => {
    db.addDevice();
    db.prefs.set('patient:1', { inAppEnabled: true, pushEnabled: false });
    db.addNotification({ id: 501, kind: 'payment_received', isMandatory: false }); // catalogue says mandatory, the row does not
    db.addNotification({ id: 502, kind: 'stage_update', isMandatory: true }); // the row says mandatory, the catalogue does not
    expect(await enqueuePushDeliveries(db.tx, { id: 501 })).toMatchObject({ skipped: 'push_disabled' });
    expect(await enqueuePushDeliveries(db.tx, { id: 502 })).toMatchObject({ skipped: 'push_disabled' });
    expect(db.deliveries).toHaveLength(0);
  });

  test('inAppEnabled=false does NOT stop a push (only pushEnabled does); the helper never reads inAppEnabled', async () => {
    db.addNotification();
    db.addDevice();
    db.prefs.set('patient:1', { inAppEnabled: false, pushEnabled: true });
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toMatchObject({ enqueued: 1, skipped: null });
    expect(db.tx.notificationPreference.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: { pushEnabled: true } }));
  });

  test('no preference row is the default (push ON)', async () => {
    db.addNotification();
    db.addDevice();
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toMatchObject({ enqueued: 1 });
  });

  test('quotation_ready is NOT mandatory: pushEnabled=false stops it, even if its row claims to be mandatory', async () => {
    expect(catalogue.classifyMandatory('quotation_ready')).toBe(false);
    for (const kind of ['stage_update', 'document', 'system']) expect(catalogue.classifyMandatory(kind)).toBe(false);
    for (const kind of ['security_password_changed', 'security_new_login', 'payment_received', 'payment_failed', 'payment_refunded']) expect(catalogue.classifyMandatory(kind)).toBe(true);
    db.addNotification({ kind: 'quotation_ready', isMandatory: true });
    db.addDevice();
    db.prefs.set('patient:1', { inAppEnabled: true, pushEnabled: false });
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toMatchObject({ enqueued: 0, skipped: 'push_disabled' });
  });
});

describe('idempotency and history', () => {
  test('calling it again for the same notification creates nothing new', async () => {
    db.addNotification();
    db.addDevice();
    db.addDevice();
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toMatchObject({ enqueued: 2, alreadyQueued: 0 });
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toMatchObject({ enqueued: 0, alreadyQueued: 2, skipped: null });
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toMatchObject({ enqueued: 0, alreadyQueued: 2 });
    expect(db.deliveries).toHaveLength(2);
  });

  test('existing delivery history is preserved: a delivery already sent, failed or cancelled is never changed, recreated or deleted', async () => {
    db.addNotification();
    const [a, b, c] = [db.addDevice(), db.addDevice(), db.addDevice()];
    db.deliveries.push(
      { id: 90, notificationId: 500, channel: 'push', destinationKey: `device:${a.id}`, status: 'accepted', attemptCount: 1, providerMessageId: 'T1' },
      { id: 91, notificationId: 500, channel: 'push', destinationKey: `device:${b.id}`, status: 'failed', attemptCount: 3, lastErrorCode: 'attempts_exhausted' },
    );
    const before = JSON.stringify(db.deliveries);
    const result = await enqueuePushDeliveries(db.tx, { id: 500 });
    expect(result).toMatchObject({ enqueued: 1, alreadyQueued: 2 });
    expect(JSON.stringify(db.deliveries.slice(0, 2))).toBe(JSON.stringify(JSON.parse(before)));
    expect(db.deliveries.map((d) => d.deviceId).filter(Boolean)).toEqual([c.id]);
  });

  test('a concurrent duplicate (unique violation on the destination index) counts as already queued', async () => {
    db.addNotification();
    db.addDevice();
    db.createError = uniqueError('notification_deliveries_dest_key');
    expect(await enqueuePushDeliveries(db.tx, { id: 500 })).toMatchObject({ enqueued: 0, alreadyQueued: 1, skipped: null });
  });

  test('any other database error is NOT swallowed (the caller\'s transaction rolls back)', async () => {
    db.addNotification();
    db.addDevice();
    const boom = Object.assign(new Error('connection lost'), { code: 'P1001' });
    db.createError = boom;
    await expect(enqueuePushDeliveries(db.tx, { id: 500 })).rejects.toBe(boom);
    db.createError = uniqueError('notifications_idempotency_key_key'); // a unique violation of ANOTHER index is not a duplicate delivery
    await expect(enqueuePushDeliveries(db.tx, { id: 500 })).rejects.toMatchObject({ code: 'P2002' });
    db.createError = Object.assign(new Error('x'), { code: 'P2002' }); // no target at all
    await expect(enqueuePushDeliveries(db.tx, { id: 500 })).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('transaction', () => {
  test('only the caller\'s transaction client is used: the shared client (which can open a transaction) is refused', async () => {
    db.addNotification();
    db.addDevice();
    await expect(enqueuePushDeliveries({ ...db.tx, $transaction: jest.fn() }, { id: 500 })).rejects.toMatchObject({ code: 'tx_required' });
    for (const bad of [null, undefined, {}, { notification: {} }]) await expect(enqueuePushDeliveries(bad, { id: 500 })).rejects.toMatchObject({ code: 'tx_invalid' });
    expect(db.deliveries).toHaveLength(0);
  });

  test('every write goes through the client it was given', async () => {
    db.addNotification();
    db.addDevice();
    await enqueuePushDeliveries(db.tx, { id: 500 });
    expect(db.tx.notificationDelivery.create).toHaveBeenCalledTimes(1);
  });
});

describe('secrets and the network', () => {
  test('the Expo token is never read, copied, returned or logged', async () => {
    const spies = ['log', 'warn', 'error', 'info', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    try {
      db.addNotification();
      db.addDevice({ expoPushToken: TOKEN_A });
      db.addDevice({ expoPushToken: TOKEN_B });
      const result = await enqueuePushDeliveries(db.tx, { id: 500 });
      expect(db.selects).toEqual([{ id: true }]); // the device query selects the row id and nothing else
      expect(JSON.stringify(db.creates)).not.toMatch(/ExponentPushToken|expoPushToken|pushToken/);
      expect(JSON.stringify(db.deliveries)).not.toMatch(/ExponentPushToken|aaaaaaaa|bbbbbbbb/);
      expect(JSON.stringify(result)).not.toMatch(/ExponentPushToken|aaaaaaaa|bbbbbbbb/);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { spies.forEach((spy) => spy.mockRestore()); }
  });

  test('no network request is made, however many devices there are', async () => {
    db.addNotification();
    for (let i = 0; i < 4; i += 1) db.addDevice();
    await enqueuePushDeliveries(db.tx, { id: 500 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('the module cannot reach Expo or the legacy token: no client, fetch, network or User.pushToken in its code', () => {
    const code = fs.readFileSync(path.join(__dirname, '../../src/modules/notifications/push-delivery-enqueue.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bfetch\b|expo-push|push-delivery\.service|push-delivery\.store|require\(['"](?:https?|net|node:http)/);
    expect(code).not.toMatch(/pushToken|expoPushToken/);
    expect(code).not.toMatch(/prisma\b.*require|require\(['"].*db\/prisma/);
    expect([...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])).toEqual(['./notification-catalogue']);
  });

  test('every business sender calls it (quotations, Bitrix inbox, cases) and none reads a push token; only the auth endpoint and the legacy sender file still mention one', () => {
    const src = path.join(__dirname, '../../src');
    const callers = [];
    const tokenMentions = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!p.endsWith('.js')) return undefined;
      const rel = path.relative(src, p).split(path.sep).join('/');
      const text = fs.readFileSync(p, 'utf8');
      if (!p.endsWith('push-delivery-enqueue.js') && /enqueuePushDeliveries|push-delivery-enqueue|suppressedEnqueuePush/.test(text)) callers.push(rel);
      if (/pushToken|push_token/.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) tokenMentions.push(rel);
      return undefined;
    });
    walk(src);
    // single-deal-detect.js only passes the explicit no-op (suppressedEnqueuePush) to the inbox.
    expect(callers.sort()).toEqual([
      'modules/bitrix/deal-inbox.service.js', 'modules/bitrix/single-deal-detect.js', 'modules/cases/case-stage-notice.js', 'modules/cases/cases.service.js', // case-stage-notice.js: the patient's stage notice (moved out of cases.service.js)
      'modules/quotations/quotation-auto-publish.service.js', 'modules/quotations/quotations.service.js',
    ]);
    // The legacy column is still WRITTEN by /auth/push-token and the old sender function still exists; no business event reads or sends through it.
    // notification-devices.service.js only CLEARS it (exact match, on unregister / transfer): it never selects or sends it. No business sender mentions it.
    expect(tokenMentions.sort()).toEqual(['integrations/push/expo-push.service.js', 'modules/auth/auth.controller.js', 'modules/notifications/notification-devices.service.js']);
    const deviceService = fs.readFileSync(path.join(src, 'modules/notifications/notification-devices.service.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(deviceService).not.toMatch(/select:[^}]*pushToken|sendExpoPush|expo-push\.service/);
    expect(deviceService.replace(/pushToken: oldToken/g, '').replace(/pushToken: null/g, '')).not.toMatch(/pushToken/); // only the exact-match condition and the clearing value
    for (const file of ['modules/bitrix/deal-inbox.service.js', 'modules/quotations/quotations.service.js', 'modules/cases/cases.service.js', 'modules/cases/case-stage-notice.js']) {
      expect(fs.readFileSync(path.join(src, file), 'utf8').replace(/\/\/.*$/gm, '')).not.toMatch(/sendExpoPush|expo-push\.service/);
    }
  });
});

describe('the kill-switch is still the only thing that sends', () => {
  test('delivery rows may exist while the worker is off: a pass makes no Expo request', async () => {
    jest.resetModules();
    jest.doMock('../../src/db/prisma', () => ({ prisma: {} }));
    const { runPushDelivery } = require('../../src/modules/notifications/push-delivery.service');
    db.addNotification();
    db.addDevice();
    await enqueuePushDeliveries(db.tx, { id: 500 });
    expect(db.deliveries).toHaveLength(1);
    const client = { verifyCredentials: jest.fn(), sendMessage: jest.fn(), getReceipts: jest.fn() };
    const store = new Proxy({}, { get() { throw new Error('the store must not be used while the worker is off'); } });
    expect(await runPushDelivery({ env: {}, client, store, prisma: {} })).toEqual({ active: false, problem: 'switch_off' });
    expect(client.verifyCredentials).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.getReceipts).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    jest.dontMock('../../src/db/prisma');
  });
});
