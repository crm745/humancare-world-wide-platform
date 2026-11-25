/* global describe, test, expect, beforeEach, jest */
// Step 3D: when a PATIENT's password is set or reset (the one place their sessions are revoked: tokenVersion moves on), every push device of that patient ends and the
// patient's open push deliveries are cancelled, in the SAME transaction as the password. No database, no network, no Expo: Prisma is an in-memory fake (its
// $transaction undoes everything when the callback throws; a transaction client has no $transaction). The delivery rows live in the push worker's fake world
// (push-delivery-fake.js), so a stale worker's fenced write is checked against the same rules the worker tests use.
process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-the-safe-tests-0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-for-the-safe-tests-0123456789';
const mockWorld = {};

jest.mock('../../src/db/prisma', () => {
  const w = () => mockWorld;
  const open = (where) => (where.status && where.status.in ? where.status.in : null);
  const matchId = (cond, value) => (cond && typeof cond === 'object' && cond.in ? cond.in.includes(value) : cond === value);
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row });
  const evalData = (row, data) => { for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v; };
  const tx = {
    user: {
      findUnique: jest.fn(async ({ where }) => { const u = w().users.find((x) => x.id === where.id); return u ? { ...u } : null; }),
      updateMany: jest.fn(async ({ where, data }) => {
        const rows = w().users.filter((u) => u.id === where.id && u.isVerified === where.isVerified && u.tokenVersion === where.tokenVersion);
        rows.forEach((u) => evalData(u, data));
        return { count: rows.length };
      }),
    },
    corporateUser: {
      findUnique: jest.fn(async ({ where }) => { const c = w().corporateUsers.find((x) => x.id === where.id); return c ? { ...c } : null; }),
      update: jest.fn(async ({ where, data }) => { const c = w().corporateUsers.find((x) => x.id === where.id); Object.assign(c, data); return { ...c }; }),
    },
    notificationDevice: {
      findMany: jest.fn(async ({ where, select }) => w().devices.filter((d) => d.ownerType === where.ownerType && d.ownerId === where.ownerId).map((d) => pick(d, select))),
      findUnique: jest.fn(async ({ where }) => { const d = w().devices.find((x) => (where.deviceId !== undefined ? x.deviceId === where.deviceId : x.expoPushToken === where.expoPushToken)); return d ? { ...d } : null; }),
      updateMany: jest.fn(async ({ where, data }) => {
        const rows = w().devices.filter((d) => matchId(where.id, d.id) && d.ownerType === where.ownerType && d.ownerId === where.ownerId && d.status === where.status);
        rows.forEach((d) => Object.assign(d, data));
        return { count: rows.length };
      }),
      update: jest.fn(async ({ where, data }) => { const d = w().devices.find((x) => x.id === where.id); Object.assign(d, data); return { ...d }; }),
      create: jest.fn(async ({ data }) => { const d = { id: 500 + w().devices.length, ...data }; w().devices.push(d); return { ...d }; }),
    },
    notificationDelivery: {
      updateMany: jest.fn(async ({ where, data }) => {
        if (w().failDeliveryUpdate) throw Object.assign(new Error('simulated failure'), { code: 'P2034' });
        const statuses = open(where);
        const rows = [...w().push.deliveries.values()].filter((d) => matchId(where.deviceId, d.deviceId) && (where.recipientType === undefined || d.recipientType === where.recipientType)
          && (where.recipientId === undefined || d.recipientId === where.recipientId) && statuses.includes(d.status));
        rows.forEach((d) => Object.assign(d, data));
        return { count: rows.length };
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn) => {
      const snap = { users: w().users.map((u) => ({ ...u })), corporateUsers: w().corporateUsers.map((c) => ({ ...c })), devices: w().devices.map((d) => ({ ...d })), deliveries: [...w().push.deliveries.values()].map((d) => ({ ...d })) };
      try { return await fn({ ...tx }); } catch (err) {
        w().users.splice(0, w().users.length, ...snap.users); w().corporateUsers.splice(0, w().corporateUsers.length, ...snap.corporateUsers); w().devices.splice(0, w().devices.length, ...snap.devices);
        w().push.deliveries.clear(); snap.deliveries.forEach((d) => w().push.deliveries.set(d.id, d));
        throw err;
      }
    }),
  };
  return { prisma };
});
jest.mock('../../src/modules/auth/security-events', () => ({ ...jest.requireActual('../../src/modules/auth/security-events'), recordSecurityEvent: jest.fn(async () => undefined) }));

const fs = require('fs');
const path = require('path');
const { prisma } = require('../../src/db/prisma');
const { setPassword, changePassword } = require('../../src/modules/auth/auth.controller');
const { signTicket, hashPassword } = require('../../src/modules/auth/auth.service');
const devicesService = require('../../src/modules/notifications/notification-devices.service');
const { makeWorld } = require('./push-delivery-fake');

const NEW_PASSWORD = 'N3w-Passw0rd-for-tests';
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOKEN = (n) => `ExponentPushToken[device${n}abcdefghijklmnop]`;
let push; // the push worker's fake world (deliveries, attempts and the fenced store)

const ticket = (over = {}) => signTicket({ step: 'set_password', sub: 55, reason: 'reset', tv: 3, ...over });
const response = () => { const res = { code: 200, body: undefined }; res.status = jest.fn((c) => { res.code = c; return res; }); res.json = jest.fn((b) => { res.body = b; return res; }); return res; };
const call = async (body) => { const res = response(); await setPassword({ body, headers: {}, ip: '127.0.0.1' }, res); return res; };
const device = (id) => mockWorld.devices.find((d) => d.id === id);
const delivery = (id) => push.deliveries.get(id);

beforeEach(async () => {
  push = makeWorld();
  Object.assign(mockWorld, {
    push,
    failDeliveryUpdate: false,
    users: [
      { id: 55, name: 'Asha Rao', email: 'a@example.test', mobile: '+910000000055', countryCode: '+91', isVerified: true, tokenVersion: 3, passwordHash: 'old-hash', failedLoginCount: 4, lockedUntil: new Date('2030-01-01') },
      { id: 56, name: 'Other Patient', email: 'b@example.test', isVerified: true, tokenVersion: 0, passwordHash: 'other-hash', failedLoginCount: 0, lockedUntil: null },
    ],
    corporateUsers: [{ id: 55, email: 'corp@example.test', passwordHash: await hashPassword('Corporate-Old-Passw0rd'), mustChangePassword: false }], // SAME numeric id as the patient
    devices: [
      { id: 10, ownerType: 'patient', ownerId: 55, deviceId: UUID(10), expoPushToken: TOKEN(10), platform: 'android', status: 'active', disabledAt: null },
      { id: 11, ownerType: 'patient', ownerId: 55, deviceId: UUID(11), expoPushToken: TOKEN(11), platform: 'ios', status: 'active', disabledAt: null },
      { id: 12, ownerType: 'patient', ownerId: 55, deviceId: UUID(12), expoPushToken: TOKEN(12), platform: 'android', status: 'inactive', disabledAt: new Date('2029-01-01') },
      { id: 20, ownerType: 'patient', ownerId: 56, deviceId: UUID(20), expoPushToken: TOKEN(20), platform: 'android', status: 'active', disabledAt: null },
      { id: 30, ownerType: 'corporate_user', ownerId: 55, deviceId: UUID(30), expoPushToken: TOKEN(30), platform: 'android', status: 'active', disabledAt: null },
    ],
  });
  // deliveries of patient 55: open (pending, sending), terminal (accepted, delivered, failed, uncertain, cancelled); and one open delivery of patient 56
  const d = (over) => push.addDelivery({ recipientType: 'patient', recipientId: 55, ...over });
  d({ id: 1, status: 'pending', deviceId: 10, destinationKey: 'device:10' });
  d({ id: 2, status: 'sending', deviceId: 11, destinationKey: 'device:11', lockedBy: 'w1', lockedUntil: push.now + 120000, attemptCount: 1 });
  d({ id: 3, status: 'accepted', deviceId: 10, destinationKey: 'device:10', providerMessageId: 't3', acceptedAt: push.now });
  d({ id: 4, status: 'delivered', deviceId: 10, destinationKey: 'device:10', deliveredAt: push.now, closedAt: push.now });
  d({ id: 5, status: 'failed', deviceId: 10, destinationKey: 'device:10', closedAt: push.now, lastErrorCode: 'MessageTooBig' });
  d({ id: 6, status: 'uncertain', deviceId: 11, destinationKey: 'device:11', closedAt: push.now, lastErrorCode: 'timeout' });
  d({ id: 7, status: 'cancelled', deviceId: 11, destinationKey: 'device:11', closedAt: push.now, lastErrorCode: 'expired' });
  d({ id: 8, status: 'pending', recipientId: 56, deviceId: 20, destinationKey: 'device:20' });
  push.attempts.push({ deliveryId: 2, attemptNumber: 1, status: 'started', startedAt: new Date(push.now), finishedAt: null, errorCode: null, providerMessageId: null });
  push.attempts.push({ deliveryId: 3, attemptNumber: 1, status: 'accepted', startedAt: new Date(push.now), finishedAt: new Date(push.now), errorCode: null, providerMessageId: 't3' });
  mockWorld.notifications = [{ id: 1, recipientType: 'patient', recipientId: 55, title: 'History' }];
  jest.clearAllMocks();
});

describe('a patient password RESET', () => {
  test('answers exactly as before, changes the password and tokenVersion as before, and ends all of the patient\'s active devices', async () => {
    const res = await call({ ticket: ticket(), password: NEW_PASSWORD });
    expect(res.status).not.toHaveBeenCalled(); // plain 200
    expect(res.body).toEqual({ message: 'Password updated. Please log in with your new password.' });
    expect(mockWorld.users[0]).toMatchObject({ tokenVersion: 4, failedLoginCount: 0, lockedUntil: null });
    expect(mockWorld.users[0].passwordHash).not.toBe('old-hash');
    expect(mockWorld.users[0].passwordHash).not.toContain(NEW_PASSWORD);
    for (const id of [10, 11]) expect(device(id)).toMatchObject({ status: 'inactive', disabledAt: expect.any(Date) });
    expect(device(12).disabledAt).toEqual(new Date('2029-01-01')); // already inactive: untouched, not re-stamped
    expect(mockWorld.devices).toHaveLength(5); // nothing deleted
    expect(device(10).expoPushToken).toBe(TOKEN(10));
  });

  test('only that patient: another patient\'s device and the corporate-user device with the same numeric id are untouched', async () => {
    await call({ ticket: ticket(), password: NEW_PASSWORD });
    expect(device(20)).toMatchObject({ status: 'active', disabledAt: null });
    expect(device(30)).toMatchObject({ status: 'active', ownerType: 'corporate_user', disabledAt: null });
    expect(mockWorld.users[1]).toMatchObject({ tokenVersion: 0, passwordHash: 'other-hash' });
  });
});

describe('FIRST-TIME password setup', () => {
  test('behaves the same: devices end, and the response is still the new session', async () => {
    const res = await call({ ticket: ticket({ reason: 'setup' }), password: NEW_PASSWORD });
    expect(Object.keys(res.body).sort()).toEqual(['refreshToken', 'token', 'user']);
    expect(res.body.user).toMatchObject({ id: 55 });
    expect(res.body.token).toEqual(expect.any(String));
    expect(device(10).status).toBe('inactive');
    expect(device(11).status).toBe('inactive');
    expect(delivery(1).status).toBe('cancelled');
  });
});

describe('failed password updates change nothing', () => {
  test.each([
    ['a ticket for an older tokenVersion (already used)', () => ({ ticket: ticket({ tv: 2 }), password: NEW_PASSWORD }), 401],
    ['a ticket for another step', () => ({ ticket: signTicket({ step: 'something_else', sub: 55, tv: 3 }), password: NEW_PASSWORD }), 401],
    ['a garbage ticket', () => ({ ticket: 'not-a-ticket', password: NEW_PASSWORD }), 401],
    ['a too-short password', () => ({ ticket: ticket(), password: 'short' }), 400],
    ['a missing password', () => ({ ticket: ticket() }), 400],
  ])('%s', async (_name, body, code) => {
    const before = JSON.stringify([mockWorld.devices, [...push.deliveries.values()], push.attempts, mockWorld.users]);
    const res = await call(body());
    expect(res.code).toBe(code);
    expect(JSON.stringify([mockWorld.devices, [...push.deliveries.values()], push.attempts, mockWorld.users])).toBe(before);
  });

  test('a ticket for an unverified account changes nothing', async () => {
    mockWorld.users[0].isVerified = false;
    const res = await call({ ticket: ticket(), password: NEW_PASSWORD });
    expect(res.code).toBe(401);
    expect(device(10).status).toBe('active');
  });

  test('if ending the devices fails, the password is NOT changed (one transaction), the error is not swallowed, and the same ticket works on retry', async () => {
    mockWorld.failDeliveryUpdate = true;
    await expect(call({ ticket: ticket(), password: NEW_PASSWORD })).rejects.toMatchObject({ code: 'P2034' });
    expect(mockWorld.users[0]).toMatchObject({ tokenVersion: 3, passwordHash: 'old-hash', failedLoginCount: 4 });
    expect(device(10).status).toBe('active');
    expect(delivery(1).status).toBe('pending');
    mockWorld.failDeliveryUpdate = false;
    const retry = await call({ ticket: ticket(), password: NEW_PASSWORD });
    expect(retry.body).toEqual({ message: 'Password updated. Please log in with your new password.' });
    expect(device(10).status).toBe('inactive');
  });

  test('replaying the used ticket after the patient registered a device again does not end that new device', async () => {
    const t = ticket();
    await call({ ticket: t, password: NEW_PASSWORD });
    await devicesService.registerPatientDevice(55, { deviceId: UUID(10), expoPushToken: TOKEN(10), platform: 'android' });
    expect(device(10).status).toBe('active');
    const replay = await call({ ticket: t, password: NEW_PASSWORD });
    expect(replay.code).toBe(401);
    expect(device(10).status).toBe('active');
  });
});

describe('deliveries and history', () => {
  test('open deliveries (pending, sending) of the patient are cancelled with session_revoked and no lease; every other status is unchanged', async () => {
    const before = Object.fromEntries([3, 4, 5, 6, 7, 8].map((id) => [id, JSON.stringify(delivery(id))]));
    await call({ ticket: ticket(), password: NEW_PASSWORD });
    for (const id of [1, 2]) expect(delivery(id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'session_revoked', lockedBy: null, lockedUntil: null, closedAt: expect.any(Date) });
    for (const id of [3, 4, 5, 6, 7, 8]) expect(JSON.stringify(delivery(id))).toBe(before[id]); // terminal rows and the other patient's delivery
    expect(delivery(3)).toMatchObject({ status: 'accepted', providerMessageId: 't3' }); // an accepted delivery still gets its receipt checked
    expect(delivery(8).status).toBe('pending');
  });

  test('attempt history and the in-app notification history are preserved', async () => {
    const attempts = JSON.stringify(push.attempts);
    const notifications = JSON.stringify(mockWorld.notifications);
    await call({ ticket: ticket(), password: NEW_PASSWORD });
    expect(JSON.stringify(push.attempts)).toBe(attempts);
    expect(JSON.stringify(mockWorld.notifications)).toBe(notifications);
    expect(push.deliveries.size).toBe(8); // nothing deleted
  });

  test('a worker that held a claim before the reset cannot overwrite the cancellation (its fenced writes return 0)', async () => {
    const claimed = { id: 2, workerId: 'w1' };
    await call({ ticket: ticket(), password: NEW_PASSWORD });
    expect(await push.store.writeSendOutcome(prisma, claimed, { status: 'accepted', ticketId: 'late', receiptDelaySeconds: 900 })).toBe(0);
    expect(await push.store.recordAttemptOutcome(prisma, claimed, 1, { status: 'accepted', ticketId: 'late' })).toBe(0);
    expect(await push.store.writeReceiptOutcome(prisma, claimed, { status: 'delivered' })).toBe(0);
    expect(delivery(2)).toMatchObject({ status: 'cancelled', lastErrorCode: 'session_revoked', providerMessageId: null });
    // and a worker can no longer claim the cancelled delivery
    expect(await push.store.claim(prisma, { id: 2, workerId: 'w2', leaseSeconds: 120 })).toBeNull();
    expect(await push.store.claim(prisma, { id: 1, workerId: 'w2', leaseSeconds: 120 })).toBeNull();
  });
});

describe('corporate password operations are unaffected', () => {
  test('a corporate change of password (same numeric id as the patient) changes the corporate account only', async () => {
    const res = response();
    const oldHash = mockWorld.corporateUsers[0].passwordHash;
    await changePassword({ user: { id: 55, role: 'corporate' }, body: { currentPassword: 'Corporate-Old-Passw0rd', newPassword: NEW_PASSWORD } }, res);
    expect(res.body).toMatchObject({ message: 'Password updated.', token: expect.any(String), refreshToken: expect.any(String) }); // the corporate response, as it always was
    expect(mockWorld.corporateUsers[0].passwordHash).not.toBe(oldHash);
    expect(device(10).status).toBe('active');
    expect(device(30).status).toBe('active');
    expect(delivery(1).status).toBe('pending');
    expect(mockWorld.users[0].tokenVersion).toBe(3);
  });

  test('the device revocation is called from exactly one place: the patient setPassword (never the corporate reset or change)', () => {
    const text = fs.readFileSync(path.join(__dirname, '../../src/modules/auth/auth.controller.js'), 'utf8');
    expect(text.match(/revokePatientDevices/g)).toHaveLength(2); // the import and the one call
    const body = text.slice(text.indexOf('async function setPassword'), text.indexOf('\nasync function', text.indexOf('async function setPassword') + 10));
    expect(body).toMatch(/await revokePatientDevices\(tx, step\.sub\)/);
    expect(text.slice(text.indexOf('async function resetPassword'))).not.toMatch(/revokePatientDevices\(/);
  });

  test('requireAuth and the token rules are untouched: the middleware does not mention devices or tokenVersion', () => {
    const mw = fs.readFileSync(path.join(__dirname, '../../src/common/middleware/auth.middleware.js'), 'utf8');
    expect(mw).not.toMatch(/tokenVersion|revoke|NotificationDevice/);
  });
});

describe('registering again after signing in with the new password', () => {
  test('the existing registration endpoint logic re-activates the same device row for its owner (new token, same installation)', async () => {
    await call({ ticket: ticket(), password: NEW_PASSWORD });
    expect(device(10).status).toBe('inactive');
    const out = await devicesService.registerPatientDevice(55, { deviceId: UUID(10), expoPushToken: TOKEN(99), platform: 'android' });
    expect(out).toMatchObject({ deviceId: UUID(10), status: 'active' });
    expect(out).not.toHaveProperty('expoPushToken'); // the response still carries no token
    expect(device(10)).toMatchObject({ status: 'active', disabledAt: null, expoPushToken: TOKEN(99), ownerId: 55 });
    expect(device(11).status).toBe('inactive'); // the patient's other phones stay off until they sign in again themselves
  });

  test('a brand-new installation registers normally too', async () => {
    await call({ ticket: ticket(), password: NEW_PASSWORD });
    const out = await devicesService.registerPatientDevice(55, { deviceId: UUID(77), expoPushToken: TOKEN(77), platform: 'ios' });
    expect(out.status).toBe('active');
    expect(mockWorld.devices.filter((d) => d.ownerId === 55 && d.ownerType === 'patient' && d.status === 'active')).toHaveLength(1); // only the new one: the reset ended the others
  });
});

describe('revokePatientDevices on its own', () => {
  test('a patient with no devices is a no-op; an invalid id is refused', async () => {
    expect(await devicesService.revokePatientDevices(prisma, 999)).toEqual({ devices: 0, deliveries: 0 });
    for (const bad of [0, -1, 1.5, '55', null, undefined]) await expect(devicesService.revokePatientDevices(prisma, bad)).rejects.toThrow(/patient id/);
  });

  test('reports how many devices and deliveries it ended, and a second call changes nothing', async () => {
    expect(await devicesService.revokePatientDevices(prisma, 55)).toEqual({ devices: 2, deliveries: 2 });
    expect(await devicesService.revokePatientDevices(prisma, 55)).toEqual({ devices: 0, deliveries: 0 });
  });
});
