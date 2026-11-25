/* global describe, test, expect, jest, beforeAll, beforeEach, afterAll */
// Patient device registry: POST /notifications/devices and DELETE /notifications/devices/:deviceId, over HTTP (supertest)
// through the real router, auth middleware, controller and service. Prisma is an in-memory fake that ENFORCES the two unique
// indexes (device_id, expo_push_token) and rolls a transaction back when it throws. Nothing touches a database or the network.
const mockDb = { devices: [], deliveries: [], users: [], nextId: 1, failOnce: null, calls: [] };

const uniqueError = (target) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });
const matches = (row, where) => Object.entries(where).every(([k, v]) => {
  if (k === 'NOT') return !matches(row, v);
  if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(row[k]);
  return row[k] === v;
});

function makeClient() {
  return {
    user: {
      findUnique: async ({ where }) => mockDb.users.find((u) => u.id === where.id) || null,
      // The legacy-token cleanup: the equality on pushToken is part of the WHERE, exactly like the database does it.
      updateMany: async ({ where, data }) => {
        const hit = mockDb.users.filter((u) => matches(u, where));
        hit.forEach((u) => Object.assign(u, data));
        mockDb.calls.push(['user.updateMany', where, data]);
        return { count: hit.length };
      },
    },
    notificationDevice: {
      findUnique: async ({ where }) => mockDb.devices.find((d) => matches(d, where)) || null,
      create: async ({ data }) => {
        if (mockDb.failOnce === 'create') { mockDb.failOnce = null; throw uniqueError('notification_devices_device_id_key'); }
        if (mockDb.devices.some((d) => d.deviceId === data.deviceId)) throw uniqueError('notification_devices_device_id_key');
        if (mockDb.devices.some((d) => d.expoPushToken === data.expoPushToken)) throw uniqueError('notification_devices_expo_push_token_key');
        const row = { id: mockDb.nextId++, lastSeenAt: null, disabledAt: null, ...data };
        mockDb.devices.push(row);
        mockDb.calls.push(['device.create', data]);
        return { ...row };
      },
      update: async ({ where, data }) => {
        if (mockDb.failOnce === 'update') { mockDb.failOnce = null; throw new Error('simulated failure after the legacy token step'); }
        const row = mockDb.devices.find((d) => d.id === where.id);
        if (data.expoPushToken && mockDb.devices.some((d) => d.id !== row.id && d.expoPushToken === data.expoPushToken)) throw uniqueError('notification_devices_expo_push_token_key');
        Object.assign(row, data);
        mockDb.calls.push(['device.update', where.id, data]);
        return { ...row };
      },
      updateMany: async ({ where, data }) => {
        const hit = mockDb.devices.filter((d) => matches(d, where));
        hit.forEach((d) => Object.assign(d, data));
        mockDb.calls.push(['device.updateMany', where, data]);
        return { count: hit.length };
      },
    },
    notificationDelivery: {
      updateMany: async ({ where, data }) => {
        const hit = mockDb.deliveries.filter((d) => matches(d, where));
        hit.forEach((d) => Object.assign(d, data));
        mockDb.calls.push(['delivery.updateMany', where, data]);
        return { count: hit.length };
      },
    },
  };
}

// An empty shell: the fake client is attached below (a jest.mock factory cannot see out-of-scope helpers).
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { prisma } = require('../../src/db/prisma');
const { notificationsRouter } = require('../../src/modules/notifications/notifications.routes');

// Wire the fake into the mocked module (jest.mock factories cannot reference out-of-scope variables directly).
Object.assign(prisma, makeClient(), {
  $transaction: async (fn) => {
    const snapshot = JSON.stringify({ devices: mockDb.devices, deliveries: mockDb.deliveries, users: mockDb.users });
    try {
      return await fn(makeClient());
    } catch (err) {
      const restored = JSON.parse(snapshot, (k, v) => (/At$/.test(k) && typeof v === 'string' ? new Date(v) : v));
      mockDb.devices = restored.devices;
      mockDb.deliveries = restored.deliveries;
      mockDb.users = restored.users;
      throw err;
    }
  },
});

const SECRET = 'fake-route-jwt-secret-0123456789';
const token = (payload) => jwt.sign(payload, SECRET, { expiresIn: '5m' });
const P1 = token({ sub: 1, role: 'patient' });
const P2 = token({ sub: 2, role: 'patient' });
const CORPORATE = token({ sub: 1, role: 'corporate', corporateId: 1 });
const ADMIN = token({ sub: 1, role: 'admin' });

const app = express();
app.use(express.json());
app.use('/notifications', notificationsRouter);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Internal server error', ...(err.publicCode ? { code: err.publicCode } : {}) }));

let savedSecret;
beforeAll(() => { savedSecret = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = SECRET; });
afterAll(() => { if (savedSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = savedSecret; });

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const TOKEN_1 = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_2 = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const TOKEN_3 = 'ExponentPushToken[cccccccccccccccccccccc]';

const body = (over = {}) => ({ deviceId: UUID_A, expoPushToken: TOKEN_1, platform: 'android', ...over });
const post = (payload, tok) => { const r = request(app).post('/notifications/devices'); return (tok ? r.set('Authorization', `Bearer ${tok}`) : r).send(payload); };
const del = (id, tok) => { const r = request(app).delete(`/notifications/devices/${id}`); return tok ? r.set('Authorization', `Bearer ${tok}`) : r; };
const device = (over = {}) => ({ id: mockDb.nextId++, ownerType: 'patient', ownerId: 1, deviceId: UUID_A, expoPushToken: TOKEN_1, platform: 'android', status: 'active', lastRegisteredAt: new Date('2026-01-01'), lastSeenAt: null, disabledAt: null, ...over });
const delivery = (over = {}) => ({ id: mockDb.nextId++, deviceId: 1, recipientType: 'patient', recipientId: 1, channel: 'push', status: 'pending', closedAt: null, ...over });

beforeEach(() => {
  mockDb.devices = []; mockDb.deliveries = []; mockDb.users = [{ id: 1 }, { id: 2 }]; mockDb.nextId = 1; mockDb.failOnce = null; mockDb.calls = [];
});

describe('POST /notifications/devices: registration', () => {
  test('registers a new device for the authenticated patient; the token is never returned', async () => {
    const res = await post(body(), P1);
    expect(res.status).toBe(200);
    expect(res.body.device).toEqual({ deviceId: UUID_A, platform: 'android', status: 'active', lastRegisteredAt: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain('ExponentPushToken');
    expect(mockDb.devices).toHaveLength(1);
    expect(mockDb.devices[0]).toMatchObject({ ownerType: 'patient', ownerId: 1, deviceId: UUID_A, expoPushToken: TOKEN_1, status: 'active', disabledAt: null });
  });

  test('an upper-case UUID is stored lower-case (one installation, one row)', async () => {
    await post(body({ deviceId: UUID_A.toUpperCase() }), P1);
    const res = await post(body({ deviceId: UUID_A }), P1);
    expect(res.status).toBe(200);
    expect(mockDb.devices).toHaveLength(1);
    expect(mockDb.devices[0].deviceId).toBe(UUID_A);
  });

  test('registering an existing device again keeps the same row and refreshes lastRegisteredAt', async () => {
    mockDb.devices = [device()];
    const before = mockDb.devices[0].lastRegisteredAt;
    const res = await post(body(), P1);
    expect(res.status).toBe(200);
    expect(mockDb.devices).toHaveLength(1);
    expect(mockDb.devices[0].id).toBe(1);
    expect(mockDb.devices[0].lastRegisteredAt.getTime()).toBeGreaterThan(before.getTime());
    expect(mockDb.deliveries).toHaveLength(0);
  });

  test('re-registering a deactivated device of the same patient reactivates it and clears disabledAt', async () => {
    mockDb.devices = [device({ status: 'inactive', disabledAt: new Date('2026-02-01') })];
    expect((await post(body(), P1)).status).toBe(200);
    expect(mockDb.devices[0]).toMatchObject({ status: 'active', disabledAt: null });
  });

  test('Expo token rotation: the same installation gets a new token on the SAME row', async () => {
    mockDb.devices = [device()];
    const res = await post(body({ expoPushToken: TOKEN_2 }), P1);
    expect(res.status).toBe(200);
    expect(mockDb.devices).toHaveLength(1);
    expect(mockDb.devices[0].expoPushToken).toBe(TOKEN_2);
  });

  test('one patient can have several devices; the others stay active', async () => {
    await post(body(), P1);
    await post(body({ deviceId: UUID_B, expoPushToken: TOKEN_2 }), P1);
    expect(mockDb.devices.filter((d) => d.ownerId === 1 && d.status === 'active')).toHaveLength(2);
  });

  test('ownership transfer A -> B: same row, B owns it, A\'s pending and sending deliveries are cancelled first', async () => {
    mockDb.devices = [device({ ownerId: 1 })];
    mockDb.deliveries = [
      delivery({ id: 10, status: 'pending' }), delivery({ id: 11, status: 'sending' }),
      delivery({ id: 12, status: 'accepted' }), delivery({ id: 13, status: 'failed' }),
    ];
    mockDb.nextId = 20;
    const res = await post(body(), P2);
    expect(res.status).toBe(200);
    expect(mockDb.devices).toHaveLength(1);
    expect(mockDb.devices[0]).toMatchObject({ id: 1, ownerType: 'patient', ownerId: 2, status: 'active' });
    const byId = (id) => mockDb.deliveries.find((d) => d.id === id);
    expect(byId(10)).toMatchObject({ status: 'cancelled', lastErrorCode: 'device_owner_changed' });
    expect(byId(10).closedAt).toBeInstanceOf(Date);
    expect(byId(11).status).toBe('cancelled');
    expect(byId(12).status).toBe('accepted'); // history is left alone
    expect(byId(13).status).toBe('failed');
    // cancelled BEFORE the owner changed
    const calls = mockDb.calls.map((c) => c[0]);
    expect(calls.indexOf('delivery.updateMany')).toBeLessThan(calls.indexOf('device.update'));
  });

  test('the same patient re-registering does not cancel their own open deliveries', async () => {
    mockDb.devices = [device()];
    mockDb.deliveries = [delivery({ id: 10, status: 'pending' })];
    await post(body({ expoPushToken: TOKEN_2 }), P1);
    expect(mockDb.deliveries[0].status).toBe('pending');
  });

  test('token conflict: a different installation holding the token is released, so the token is never on two rows', async () => {
    // Old install (UUID_B) of patient 1 holds TOKEN_1 with an open delivery; the app was reinstalled as UUID_A.
    mockDb.devices = [device({ id: 1, deviceId: UUID_B, ownerId: 1, expoPushToken: TOKEN_1 })];
    mockDb.deliveries = [delivery({ id: 10, deviceId: 1, status: 'pending' })];
    mockDb.nextId = 20;
    const res = await post(body({ deviceId: UUID_A, expoPushToken: TOKEN_1 }), P1);
    expect(res.status).toBe(200);
    expect(mockDb.devices).toHaveLength(2);
    const old = mockDb.devices.find((d) => d.deviceId === UUID_B);
    const fresh = mockDb.devices.find((d) => d.deviceId === UUID_A);
    expect(fresh).toMatchObject({ ownerId: 1, expoPushToken: TOKEN_1, status: 'active' });
    expect(old.status).toBe('inactive');
    expect(old.disabledAt).toBeInstanceOf(Date);
    expect(old.expoPushToken).not.toBe(TOKEN_1);
    expect(old.expoPushToken).toMatch(/^released:/);
    expect(mockDb.deliveries[0]).toMatchObject({ status: 'cancelled', lastErrorCode: 'device_token_reassigned' });
    expect(mockDb.devices.filter((d) => d.expoPushToken === TOKEN_1 && d.status === 'active')).toHaveLength(1);
  });

  test('token conflict across patients: patient 2 takes a token that patient 1\'s other installation held', async () => {
    mockDb.devices = [device({ id: 1, deviceId: UUID_B, ownerId: 1, expoPushToken: TOKEN_1 })];
    const res = await post(body({ deviceId: UUID_C, expoPushToken: TOKEN_1 }), P2);
    expect(res.status).toBe(200);
    expect(mockDb.devices.find((d) => d.deviceId === UUID_C)).toMatchObject({ ownerId: 2, expoPushToken: TOKEN_1, status: 'active' });
    expect(mockDb.devices.find((d) => d.deviceId === UUID_B)).toMatchObject({ ownerId: 1, status: 'inactive' });
  });

  test('transfer and token conflict together (A\'s row moves to B, B\'s old row held the new token)', async () => {
    mockDb.devices = [device({ id: 1, deviceId: UUID_A, ownerId: 1, expoPushToken: TOKEN_1 }), device({ id: 2, deviceId: UUID_B, ownerId: 2, expoPushToken: TOKEN_2 })];
    mockDb.deliveries = [delivery({ id: 10, deviceId: 1, recipientId: 1 }), delivery({ id: 11, deviceId: 2, recipientId: 2 })];
    const res = await post(body({ deviceId: UUID_A, expoPushToken: TOKEN_2 }), P2);
    expect(res.status).toBe(200);
    expect(mockDb.devices.find((d) => d.deviceId === UUID_A)).toMatchObject({ ownerId: 2, expoPushToken: TOKEN_2, status: 'active' });
    expect(mockDb.devices.find((d) => d.deviceId === UUID_B).status).toBe('inactive');
    expect(mockDb.deliveries.every((d) => d.status === 'cancelled')).toBe(true);
  });

  test('a concurrent unique conflict (P2002) is retried once and then succeeds', async () => {
    mockDb.failOnce = 'create';
    const res = await post(body(), P1);
    expect(res.status).toBe(200);
    expect(mockDb.devices).toHaveLength(1);
  });

  test('a conflict that persists after the retry is a 409 with a public code', async () => {
    const original = prisma.$transaction;
    prisma.$transaction = jest.fn(async () => { throw uniqueError('notification_devices_device_id_key'); });
    try {
      const res = await post(body(), P1);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('device_conflict');
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    } finally { prisma.$transaction = original; }
  });

  test('an unexpected database error is NOT swallowed or retried: generic 500, nothing leaked', async () => {
    const original = prisma.$transaction;
    prisma.$transaction = jest.fn(async () => { throw Object.assign(new Error('connection lost: secret-host'), { code: 'P1001' }); });
    try {
      const res = await post(body(), P1);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    } finally { prisma.$transaction = original; }
  });

  test('a failure mid-transaction rolls everything back (no half-moved device)', async () => {
    mockDb.devices = [device({ ownerId: 1 })];
    mockDb.deliveries = [delivery({ id: 10 })];
    const original = prisma.$transaction;
    // run the real fake transaction, but make the final update fail
    const failing = makeClient();
    failing.notificationDevice.update = async () => { throw Object.assign(new Error('boom'), { code: 'P2000' }); };
    prisma.$transaction = async (fn) => {
      const snapshot = JSON.stringify({ devices: mockDb.devices, deliveries: mockDb.deliveries });
      try { return await fn({ ...makeClient(), notificationDevice: { ...makeClient().notificationDevice, update: failing.notificationDevice.update } }); } catch (err) {
        const restored = JSON.parse(snapshot, (k, v) => (/At$/.test(k) && typeof v === 'string' ? new Date(v) : v));
        mockDb.devices = restored.devices; mockDb.deliveries = restored.deliveries; throw err;
      }
    };
    try {
      expect((await post(body(), P2)).status).toBe(500);
      expect(mockDb.devices[0].ownerId).toBe(1);
      expect(mockDb.deliveries[0].status).toBe('pending');
    } finally { prisma.$transaction = original; }
  });

  test('the owner comes only from the token: ownerId / ownerType / status in the body are rejected', async () => {
    for (const extra of [{ ownerId: 2 }, { ownerType: 'corporate_user' }, { status: 'inactive' }, { id: 5 }]) {
      const res = await post(body(extra), P1);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_device');
    }
    expect(mockDb.devices).toHaveLength(0);
  });

  test('invalid deviceId, token, platform and shape are 400', async () => {
    const bad = [
      body({ deviceId: 'not-a-uuid' }), body({ deviceId: 123 }), body({ deviceId: undefined }),
      body({ expoPushToken: 'abc' }), body({ expoPushToken: 'ExponentPushToken[]' }), body({ expoPushToken: 'ExponentPushToken[a b]' }), body({ expoPushToken: 5 }),
      body({ platform: 'web' }), body({ platform: 'ANDROID' }), body({ platform: undefined }),
      [], 'x', {},
    ];
    for (const payload of bad) {
      const res = await post(payload, P1);
      expect(res.status).toBe(400);
    }
    expect(mockDb.devices).toHaveLength(0);
  });

  test('an unknown (deleted) patient gets 404 and no device row', async () => {
    mockDb.users = [];
    expect((await post(body(), P1)).status).toBe(404);
    expect(mockDb.devices).toHaveLength(0);
  });

  test('authentication: no token 401; corporate and admin tokens refused; nothing written', async () => {
    expect((await post(body())).status).toBe(401);
    expect((await post(body(), CORPORATE)).status).toBe(403);
    expect((await post(body(), ADMIN)).status).toBe(401);
    expect((await del(UUID_A, CORPORATE)).status).toBe(403);
    expect((await del(UUID_A, ADMIN)).status).toBe(401);
    expect((await del(UUID_A)).status).toBe(401);
    expect(mockDb.devices).toHaveLength(0);
  });

  test('a password-change-pending token is still refused (authentication is not weakened)', async () => {
    const pwc = token({ sub: 1, role: 'patient', pwc: true });
    expect((await post(body(), pwc)).status).toBe(403);
  });

  test('the registration rate limit is per account (active outside the test environment)', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const tok = token({ sub: 77, role: 'patient' });
      mockDb.users = [{ id: 1 }, { id: 77 }];
      let last;
      for (let i = 0; i < 31; i += 1) last = await post(body(), tok);
      expect(last.status).toBe(429);
      // another patient has their own budget
      expect((await post(body({ deviceId: UUID_B, expoPushToken: TOKEN_2 }), P1)).status).toBe(200);
    } finally { process.env.NODE_ENV = saved; }
  });
});

describe('DELETE /notifications/devices/:deviceId: unregistration', () => {
  test('deactivates the patient\'s own device, cancels their open deliveries, keeps the row: 204', async () => {
    mockDb.devices = [device()];
    mockDb.deliveries = [delivery({ id: 10, status: 'pending' }), delivery({ id: 11, status: 'sending' }), delivery({ id: 12, status: 'accepted' })];
    const res = await del(UUID_A, P1);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(mockDb.devices).toHaveLength(1);
    expect(mockDb.devices[0]).toMatchObject({ status: 'inactive', ownerId: 1 });
    expect(mockDb.devices[0].disabledAt).toBeInstanceOf(Date);
    expect(mockDb.deliveries.map((d) => d.status)).toEqual(['cancelled', 'cancelled', 'accepted']);
    expect(mockDb.deliveries[0].lastErrorCode).toBe('device_unregistered');
  });

  test('patient A cannot unregister patient B\'s device: same 204 as unknown, nothing changes', async () => {
    mockDb.devices = [device({ ownerId: 2 })];
    mockDb.deliveries = [delivery({ recipientId: 2 })];
    const foreign = await del(UUID_A, P1);
    const unknown = await del(UUID_B, P1);
    expect(foreign.status).toBe(204);
    expect(unknown.status).toBe(204);
    expect(foreign.text).toBe(unknown.text);
    expect(mockDb.devices[0]).toMatchObject({ status: 'active', ownerId: 2, disabledAt: null });
    expect(mockDb.deliveries[0].status).toBe('pending');
  });

  test('unregistering one device leaves the patient\'s other devices (and their deliveries) untouched', async () => {
    mockDb.devices = [device({ id: 1, deviceId: UUID_A }), device({ id: 2, deviceId: UUID_B, expoPushToken: TOKEN_2 })];
    mockDb.deliveries = [delivery({ id: 10, deviceId: 1 }), delivery({ id: 11, deviceId: 2 })];
    expect((await del(UUID_A, P1)).status).toBe(204);
    expect(mockDb.devices.find((d) => d.id === 1).status).toBe('inactive');
    expect(mockDb.devices.find((d) => d.id === 2)).toMatchObject({ status: 'active', disabledAt: null });
    expect(mockDb.deliveries.find((d) => d.id === 10).status).toBe('cancelled');
    expect(mockDb.deliveries.find((d) => d.id === 11).status).toBe('pending');
  });

  test('unregistering twice is safe and keeps the first disabledAt', async () => {
    mockDb.devices = [device()];
    expect((await del(UUID_A, P1)).status).toBe(204);
    const first = mockDb.devices[0].disabledAt;
    expect((await del(UUID_A, P1)).status).toBe(204);
    expect(mockDb.devices[0].disabledAt).toBe(first);
    expect(mockDb.devices).toHaveLength(1);
  });

  test('the id is matched case-insensitively and a malformed id is 400 (reveals nothing)', async () => {
    mockDb.devices = [device()];
    expect((await del(UUID_A.toUpperCase(), P1)).status).toBe(204);
    expect(mockDb.devices[0].status).toBe('inactive');
    expect((await del('not-a-uuid', P1)).status).toBe(400);
  });

  test('after A unregisters, B registering the same installation works and A has nothing active on it', async () => {
    mockDb.devices = [device()];
    await del(UUID_A, P1);
    expect((await post(body(), P2)).status).toBe(200);
    expect(mockDb.devices).toHaveLength(1);
    expect(mockDb.devices[0]).toMatchObject({ ownerId: 2, status: 'active' });
  });

  test('an unexpected database error is a generic 500', async () => {
    const original = prisma.$transaction;
    prisma.$transaction = jest.fn(async () => { throw new Error('db down'); });
    try {
      const res = await del(UUID_A, P1);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    } finally { prisma.$transaction = original; }
  });
});

describe('legacy User.pushToken cleanup (exact match only)', () => {
  const legacy = (id) => mockDb.users.find((u) => u.id === id).pushToken;
  const userUpdates = () => mockDb.calls.filter((c) => c[0] === 'user.updateMany');

  describe('unregister', () => {
    test('a legacy token that is exactly this device\'s token is cleared, by one conditional UPDATE built from the device row', async () => {
      mockDb.devices = [device()];
      mockDb.users[0].pushToken = TOKEN_1;
      expect((await del(UUID_A, P1)).status).toBe(204);
      expect(legacy(1)).toBeNull();
      expect(userUpdates()).toEqual([['user.updateMany', { id: 1, pushToken: TOKEN_1 }, { pushToken: null }]]);
      expect(mockDb.devices[0].status).toBe('inactive'); // the existing behaviour is unchanged
    });

    test('a different legacy token (another phone\'s) is preserved', async () => {
      mockDb.devices = [device(), device({ id: 2, deviceId: UUID_B, expoPushToken: TOKEN_2 })];
      mockDb.users[0].pushToken = TOKEN_2;
      expect((await del(UUID_A, P1)).status).toBe(204);
      expect(legacy(1)).toBe(TOKEN_2);
      expect(mockDb.devices.find((d) => d.id === 2).status).toBe('active');
    });

    test('a missing legacy token is harmless (null, absent)', async () => {
      mockDb.devices = [device()];
      mockDb.users[0].pushToken = null;
      expect((await del(UUID_A, P1)).status).toBe(204);
      expect(legacy(1)).toBeNull();
      mockDb.devices = [device({ id: 5 })];
      delete mockDb.users[0].pushToken;
      expect((await del(UUID_A, P1)).status).toBe(204);
      expect(mockDb.devices[0].status).toBe('inactive');
    });

    test('only the unregistering patient\'s own row can change: another patient with the same token string is untouched', async () => {
      mockDb.devices = [device()];
      mockDb.users[0].pushToken = TOKEN_1;
      mockDb.users[1].pushToken = TOKEN_1; // inconsistent data on purpose
      await del(UUID_A, P1);
      expect(legacy(1)).toBeNull();
      expect(legacy(2)).toBe(TOKEN_1);
    });

    test('a device that is not the caller\'s (or unknown) changes nothing at all, including the legacy token', async () => {
      mockDb.devices = [device()];
      mockDb.users[0].pushToken = TOKEN_1;
      expect((await del(UUID_A, P2)).status).toBe(204); // someone else's device
      expect((await del(UUID_B, P1)).status).toBe(204); // unknown device
      expect(legacy(1)).toBe(TOKEN_1);
      expect(userUpdates()).toHaveLength(0);
    });

    test('unregistering twice stays safe: a legacy token saved in between that is different is kept', async () => {
      mockDb.devices = [device()];
      mockDb.users[0].pushToken = TOKEN_1;
      await del(UUID_A, P1);
      expect(legacy(1)).toBeNull();
      mockDb.users[0].pushToken = TOKEN_3; // another phone saved its own legacy token
      expect((await del(UUID_A, P1)).status).toBe(204);
      expect(legacy(1)).toBe(TOKEN_3);
      expect(mockDb.devices).toHaveLength(1);
    });
  });

  describe('transfer to another patient', () => {
    const transfer = (over = {}) => post(body({ expoPushToken: TOKEN_2, ...over }), P2);

    test('the previous owner\'s legacy token is cleared when it is exactly the token the installation held before', async () => {
      mockDb.devices = [device()];
      mockDb.deliveries = [delivery({ deviceId: 1 })];
      mockDb.users[0].pushToken = TOKEN_1;
      expect((await transfer()).status).toBe(200);
      expect(legacy(1)).toBeNull();
      expect(userUpdates()).toEqual([['user.updateMany', { id: 1, pushToken: TOKEN_1 }, { pushToken: null }]]);
      // the existing protections are intact
      expect(mockDb.devices[0]).toMatchObject({ ownerId: 2, expoPushToken: TOKEN_2, status: 'active' });
      expect(mockDb.deliveries[0]).toMatchObject({ status: 'cancelled', lastErrorCode: 'device_owner_changed' });
    });

    test('an unrelated legacy token of the previous owner is preserved', async () => {
      mockDb.devices = [device()];
      mockDb.users[0].pushToken = TOKEN_3;
      await transfer();
      expect(legacy(1)).toBe(TOKEN_3);
    });

    test('the INCOMING token is never used for the cleanup: a previous-owner token equal to the new token stays', async () => {
      mockDb.devices = [device()]; // held TOKEN_1 before
      mockDb.users[0].pushToken = TOKEN_2; // equals the incoming token, not the old one
      await transfer();
      expect(legacy(1)).toBe(TOKEN_2);
      expect(userUpdates().map((c) => c[1].pushToken)).toEqual([TOKEN_1]); // the condition was built from the OLD token
    });

    test('the new owner\'s own legacy token is never touched, whatever it holds', async () => {
      for (const newOwnerToken of [TOKEN_1, TOKEN_2, TOKEN_3, null]) {
        mockDb.devices = [device()]; mockDb.calls = [];
        mockDb.users[0].pushToken = TOKEN_1; mockDb.users[1].pushToken = newOwnerToken;
        await transfer();
        expect(legacy(2)).toBe(newOwnerToken);
        expect(userUpdates().every((c) => c[1].id === 1)).toBe(true);
        mockDb.devices = [];
      }
    });

    test('a transfer that keeps the same token still clears the previous owner\'s matching legacy token', async () => {
      mockDb.devices = [device()];
      mockDb.users[0].pushToken = TOKEN_1;
      expect((await transfer({ expoPushToken: TOKEN_1 })).status).toBe(200);
      expect(legacy(1)).toBeNull();
      expect(mockDb.devices[0]).toMatchObject({ ownerId: 2, expoPushToken: TOKEN_1 });
    });

    test('a transfer that fails rolls back everything together: both owners\' legacy tokens, the device and the deliveries', async () => {
      mockDb.devices = [device()];
      mockDb.deliveries = [delivery({ deviceId: 1 })];
      mockDb.users[0].pushToken = TOKEN_1;
      mockDb.users[1].pushToken = TOKEN_3;
      mockDb.failOnce = 'update';
      const res = await transfer();
      expect(res.status).toBe(500);
      expect(legacy(1)).toBe(TOKEN_1);
      expect(legacy(2)).toBe(TOKEN_3);
      expect(mockDb.devices[0]).toMatchObject({ ownerId: 1, expoPushToken: TOKEN_1, status: 'active' });
      expect(mockDb.deliveries[0].status).toBe('pending');
    });

    test('no cleanup outside a transfer: the same patient registering again (even with a rotated token) keeps their legacy token', async () => {
      mockDb.devices = [device()];
      mockDb.users[0].pushToken = TOKEN_1;
      expect((await post(body({ expoPushToken: TOKEN_2 }), P1)).status).toBe(200);
      expect(legacy(1)).toBe(TOKEN_1);
      expect(userUpdates()).toHaveLength(0);
    });

    test('a row owned by a corporate user with the same numeric id is not a patient: no legacy token is cleared', async () => {
      mockDb.devices = [device({ ownerType: 'corporate_user', ownerId: 1 })];
      mockDb.users[0].pushToken = TOKEN_1;
      expect((await transfer()).status).toBe(200);
      expect(legacy(1)).toBe(TOKEN_1);
      expect(userUpdates()).toHaveLength(0);
    });
  });

  describe('regression', () => {
    test('patient device registration still works as before (new installation, no legacy writes)', async () => {
      mockDb.users[0].pushToken = TOKEN_3;
      const res = await post(body(), P1);
      expect(res.status).toBe(200);
      expect(res.body.device).toEqual({ deviceId: UUID_A, platform: 'android', status: 'active', lastRegisteredAt: expect.any(String) });
      expect(legacy(1)).toBe(TOKEN_3);
      expect(userUpdates()).toHaveLength(0);
    });

    test('the legacy /auth/push-token endpoint and the users.push_token column remain', () => {
      const fs = require('fs');
      const path = require('path');
      expect(fs.readFileSync(require.resolve('../../src/modules/auth/auth.routes'), 'utf8')).toContain("'/push-token'");
      expect(fs.readFileSync(require.resolve('../../src/modules/auth/auth.controller'), 'utf8')).toMatch(/async function savePushToken[\s\S]*?data: \{ pushToken \}/);
      expect(fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8')).toMatch(/pushToken\s+String\?\s+@map\("push_token"\)/);
    });

    test('the cleanup is only in the patient device service: no corporate or authentication code clears it, and nothing reads it for sending', () => {
      const fs = require('fs');
      const path = require('path');
      const src = path.join(__dirname, '../../src');
      const writers = [];
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        if (p.endsWith('.js') && /pushToken: null/.test(fs.readFileSync(p, 'utf8'))) writers.push(path.relative(src, p).split(path.sep).join('/'));
        return undefined;
      });
      walk(src);
      expect(writers).toEqual(['modules/notifications/notification-devices.service.js']);
      expect(fs.readFileSync(path.join(src, 'modules/notifications/push-delivery-enqueue.js'), 'utf8').replace(/\/\/.*$/gm, '')).not.toMatch(/pushToken/);
    });
  });
});

describe('route compatibility', () => {
  test('the existing /:id and /:id/read routes are not shadowed by /devices', async () => {
    const files = require('fs').readFileSync(require.resolve('../../src/modules/notifications/notifications.routes'), 'utf8');
    expect(files).toContain("'/devices'");
    expect(files).toContain("'/devices/:deviceId'");
    // legacy endpoint untouched
    const authRoutes = require('fs').readFileSync(require.resolve('../../src/modules/auth/auth.routes'), 'utf8');
    expect(authRoutes).toContain("'/push-token'");
  });
});
