/* global describe, test, expect, jest, beforeEach */
// The push-device lifecycle (lib/deviceRegistry.js) with storage, Expo and the API faked: no phone, no network.
import fs from 'fs';
import path from 'path';
import { createDeviceRegistry, failureReason, INSTALL_ID_KEY, isInstallId } from '../deviceRegistry';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const T1 = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const T2 = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: jest.fn(async (k) => (k in data ? data[k] : null)), setItem: jest.fn(async (k, v) => { data[k] = v; }) };
}

// A phone: storage + an Expo token that can change + a server that records what it was told.
function setup({ storage = memoryStorage(), token = T1, uuids = [U1, U2] } = {}) {
  const phone = { token, storage };
  const server = { registered: [], unregistered: [], legacy: [], registerError: null, unregisterError: null, unregisterDelay: null };
  const uuidQueue = [...uuids];
  const registry = createDeviceRegistry({
    storage,
    newUuid: jest.fn(() => uuidQueue.shift()),
    platform: 'android',
    getExpoToken: jest.fn(async () => phone.token),
    registerDevice: jest.fn(async (body) => { if (server.registerError) throw server.registerError; server.registered.push(body); }),
    unregisterDevice: jest.fn(async (id) => {
      if (server.unregisterDelay) await server.unregisterDelay;
      if (server.unregisterError) throw server.unregisterError;
      server.unregistered.push(id);
    }),
    legacyRegister: jest.fn(async (t) => { server.legacy.push(t); }),
    unregisterTimeoutMs: 50,
  });
  return { registry, phone, server, storage };
}

describe('installation id', () => {
  test('is generated automatically on first use and persisted in storage', async () => {
    const { registry, storage } = setup();
    expect(await registry.loadInstallId()).toBe(U1);
    expect(storage.data[INSTALL_ID_KEY]).toBe(U1);
    expect(isInstallId(U1)).toBe(true);
  });

  test('is reused on later runs: a stored id is read, never replaced', async () => {
    const storage = memoryStorage({ [INSTALL_ID_KEY]: U2 });
    const { registry } = setup({ storage });
    expect(await registry.loadInstallId()).toBe(U2);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('an unreadable stored value is replaced by a fresh UUID', async () => {
    const storage = memoryStorage({ [INSTALL_ID_KEY]: 'garbage' });
    const { registry } = setup({ storage });
    expect(await registry.loadInstallId()).toBe(U1);
    expect(storage.data[INSTALL_ID_KEY]).toBe(U1);
  });

  test('concurrent first uses create ONE id', async () => {
    const { registry, storage } = setup();
    const ids = await Promise.all([registry.loadInstallId(), registry.loadInstallId(), registry.loadInstallId()]);
    expect(new Set(ids).size).toBe(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  test('is kept after logout and reused by the next sign-in (same id, same row on the server)', async () => {
    const { registry, server, storage } = setup();
    await registry.ensureRegistered();
    await registry.unregister();
    expect(storage.data[INSTALL_ID_KEY]).toBe(U1); // not deleted
    await registry.ensureRegistered();
    expect(server.registered.map((r) => r.deviceId)).toEqual([U1, U1]);
  });

  test('storage that cannot be written means NO registration (no id is invented for one run)', async () => {
    const storage = memoryStorage();
    storage.setItem.mockRejectedValue(new Error('disk full'));
    const { registry, server } = setup({ storage });
    expect((await registry.ensureRegistered()).status).toBe('storage_failed');
    expect(server.registered).toHaveLength(0);
  });
});

describe('registration', () => {
  test('after sign-in it registers deviceId, expoPushToken and platform', async () => {
    const { registry, server } = setup();
    expect(await registry.ensureRegistered()).toEqual({ status: 'registered' });
    expect(server.registered).toEqual([{ deviceId: U1, expoPushToken: T1, platform: 'android' }]);
  });

  test('the legacy /auth/push-token call is still made, once per token', async () => {
    const { registry, server } = setup();
    await registry.ensureRegistered();
    await registry.ensureRegistered({ recheck: true });
    expect(server.legacy).toEqual([T1]);
  });

  test('no token (permission denied / Expo Go / web) registers nothing and creates no id', async () => {
    const { registry, server, storage } = setup({ token: null });
    expect((await registry.ensureRegistered()).status).toBe('no_token');
    expect(server.registered).toHaveLength(0);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('duplicate triggers: concurrent calls share ONE registration; later plain calls do nothing', async () => {
    const { registry, server } = setup();
    const results = await Promise.all([registry.ensureRegistered(), registry.ensureRegistered(), registry.ensureRegistered()]);
    expect(server.registered).toHaveLength(1);
    expect(results.map((r) => r.status)).toEqual(['registered', 'registered', 'registered']);
    expect((await registry.ensureRegistered()).status).toBe('already');
    expect((await registry.ensureRegistered({ recheck: true })).status).toBe('already'); // same token: not repeated
    expect(server.registered).toHaveLength(1);
  });

  test('Expo token rotation: a recheck with a NEW token registers again, same deviceId (the server updates that device)', async () => {
    const { registry, phone, server } = setup();
    await registry.ensureRegistered();
    phone.token = T2;
    expect((await registry.ensureRegistered({ recheck: true })).status).toBe('registered');
    expect(server.registered).toEqual([
      { deviceId: U1, expoPushToken: T1, platform: 'android' },
      { deviceId: U1, expoPushToken: T2, platform: 'android' },
    ]);
  });

  test('a failed registration is reported, not recorded: the next call tries again', async () => {
    const { registry, server } = setup();
    server.registerError = Object.assign(new Error('down'), { code: 'network' });
    expect((await registry.ensureRegistered()).status).toBe('failed');
    server.registerError = null;
    expect((await registry.ensureRegistered()).status).toBe('registered');
    expect(server.registered).toHaveLength(1);
  });

  test('a registration that finishes after a sign-out / sign-in is dropped and not remembered', async () => {
    const { registry, server } = setup();
    let release;
    registry.__gate = new Promise((r) => { release = r; });
    const slow = createDeviceRegistry({
      storage: memoryStorage(), newUuid: () => U1, platform: 'android', getExpoToken: async () => { await registry.__gate; return T1; },
      registerDevice: async (b) => { server.registered.push(b); }, unregisterDevice: async () => {},
    });
    const pending = slow.ensureRegistered();
    slow.reset(); // the session changed while the token was being fetched
    release();
    expect((await pending).status).toBe('superseded');
    expect(server.registered).toHaveLength(0);
  });
});

describe('patient A to patient B on the same phone', () => {
  test('A logs out (device unregistered), B signs in: the SAME installation id registers again for B', async () => {
    const { registry, server } = setup();
    await registry.ensureRegistered(); // A
    expect(await registry.unregister()).toEqual({ ok: true });
    registry.reset(); // B signs in (lib/pushNotifications.js resets on every session change)
    expect((await registry.ensureRegistered()).status).toBe('registered'); // B
    expect(server.unregistered).toEqual([U1]);
    expect(server.registered.map((r) => r.deviceId)).toEqual([U1, U1]);
    expect(server.registered.map((r) => r.expoPushToken)).toEqual([T1, T1]);
  });

  test('A\'s session expired (no unregister) and B signs in: B still registers (a sign-in resets the memory)', async () => {
    const { registry, server } = setup();
    await registry.ensureRegistered(); // A
    registry.reset(); // forced sign-out + B's sign-in
    expect((await registry.ensureRegistered()).status).toBe('registered');
    expect(server.registered).toHaveLength(2);
  });
});

describe('logout unregistration', () => {
  test('calls DELETE for the stored installation id and resets the session', async () => {
    const { registry, server } = setup();
    await registry.ensureRegistered();
    expect(await registry.unregister()).toEqual({ ok: true });
    expect(server.unregistered).toEqual([U1]);
    expect((await registry.ensureRegistered()).status).toBe('registered'); // a later sign-in registers again
  });

  test('works after an app restart (id only in storage)', async () => {
    const storage = memoryStorage({ [INSTALL_ID_KEY]: U2 });
    const { registry, server } = setup({ storage });
    expect(await registry.unregister()).toEqual({ ok: true });
    expect(server.unregistered).toEqual([U2]);
  });

  test('a phone that never registered has nothing to unregister: ok, no server call, no id created', async () => {
    const { registry, server, storage } = setup();
    expect(await registry.unregister()).toEqual({ ok: true, reason: 'never_registered' });
    expect(server.unregistered).toHaveLength(0);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('a registration still running is allowed to finish first, so the delete comes AFTER it', async () => {
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const registry = createDeviceRegistry({
      storage: memoryStorage(), newUuid: () => U1, platform: 'android', getExpoToken: async () => { await gate; return T1; },
      registerDevice: async () => { order.push('register'); }, unregisterDevice: async () => { order.push('unregister'); },
      unregisterTimeoutMs: 500,
    });
    const reg = registry.ensureRegistered();
    const out = registry.unregister();
    release();
    await Promise.all([reg, out]);
    expect(order).toEqual(['register', 'unregister']);
  });
});

describe('failed unregistration is reported, never pretended', () => {
  test.each([
    ['network failure', Object.assign(new Error('x'), { code: 'network' }), 'network'],
    ['expired session', Object.assign(new Error('x'), { status: 401, code: 'session_expired' }), 'session'],
    ['server error', Object.assign(new Error('x'), { status: 500 }), 'server'],
  ])('%s -> ok:false with a reason', async (_name, error, reason) => {
    const { registry, server } = setup();
    await registry.ensureRegistered();
    server.unregisterError = error;
    expect(await registry.unregister()).toEqual({ ok: false, reason });
    expect(server.unregistered).toHaveLength(0);
  });

  test('a hung server ends after the time limit with ok:false (logout is never blocked for ever)', async () => {
    const { registry, server } = setup();
    await registry.ensureRegistered();
    server.unregisterDelay = new Promise(() => {}); // never answers
    expect(await registry.unregister()).toEqual({ ok: false, reason: 'timeout' });
  });

  test('after a failed unregister the session memory is reset, so the next sign-in registers again', async () => {
    const { registry, server } = setup();
    await registry.ensureRegistered();
    server.unregisterError = Object.assign(new Error('x'), { code: 'network' });
    await registry.unregister();
    server.unregisterError = null;
    expect((await registry.ensureRegistered()).status).toBe('registered');
  });

  test('unreadable storage at logout is reported as ok:false', async () => {
    const storage = memoryStorage();
    storage.getItem.mockRejectedValue(new Error('locked'));
    const { registry } = setup({ storage });
    expect(await registry.unregister()).toEqual({ ok: false, reason: 'storage' });
  });

  test('failureReason maps errors', () => {
    expect(failureReason(null)).toBe('unknown');
    expect(failureReason(new TypeError('Network request failed'))).toBe('network');
  });
});

describe('wiring (source checks)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const push = read('../pushNotifications.js');
  const profile = read('../../app/profile.js');
  const layout = read('../../app/_layout.js');
  const handler = read('../../components/DeviceRegistrationHandler.js');
  const api = read('../notificationsApi.js');

  test('API calls: POST /notifications/devices and DELETE /notifications/devices/:deviceId', () => {
    expect(api).toContain("apiPost('/notifications/devices', device)");
    expect(api).toContain('apiDelete(`/notifications/devices/${encodeURIComponent(deviceId)}`)');
  });

  test('the legacy /auth/push-token call is kept', () => {
    expect(push).toContain("apiPost('/auth/push-token', { pushToken })");
  });

  test('every session change resets the registry', () => {
    expect(push).toContain('onSessionChange(() => registry.reset())');
  });

  test('logout: a patient unregisters BEFORE clearTokens; corporate does not', () => {
    const body = profile.slice(profile.indexOf('const signOut = async'));
    expect(body.indexOf('unregisterThisDevice()')).toBeGreaterThan(-1);
    expect(body.indexOf('unregisterThisDevice()')).toBeLessThan(body.indexOf('await clearTokens()'));
    expect(body).toContain('isCorporate ? { ok: true } : await unregisterThisDevice()');
    expect(body).toContain("toast(t('prof_logout_push_failed'))");
  });

  test('registration runs on sign-in for patients only, mounted once in the shell next to the tap handler', () => {
    expect(handler).toContain("authStatus !== 'authed' || isCorporate");
    expect(layout.match(/<DeviceRegistrationHandler \/>/g)).toHaveLength(1);
    expect(layout).toContain('<NotificationTapHandler />');
  });

  test('the installation id is never deleted', () => {
    for (const source of [push, handler, profile]) expect(source).not.toMatch(/removeItem|INSTALL_ID_KEY/);
  });
});
