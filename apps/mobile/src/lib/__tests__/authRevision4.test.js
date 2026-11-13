/* global describe, test, expect, jest, beforeEach, __dirname */
// Phase 1, revision 4: the /auth/me confirmation header, the atomic conditional sign-out, stale sign-in
// attempts, late storage writes, and a cancelled session check. The real session.js and api.js run on an
// in-memory secure store whose operations can be delayed or made to fail, and on a fake fetch.
const fs = require('fs');
const path = require('path');

jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));
jest.mock('expo-secure-store', () => {
  const memory = new Map();
  const control = { setDelay: {}, failDeleteFor: null, failGet: false };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    __memory: memory,
    __control: control,
    setItemAsync: jest.fn(async (key, value) => {
      const delay = control.setDelay[key];
      if (delay) await wait(delay);
      memory.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key) => {
      if (control.failDeleteFor === key || control.failDeleteFor === '*') throw new Error('Keychain delete failed');
      memory.delete(key);
    }),
    getItemAsync: jest.fn(async (key) => {
      if (control.failGet) throw new Error('Keychain is locked');
      return memory.has(key) ? memory.get(key) : null;
    }),
  };
});

const SecureStore = require('expo-secure-store');
const { navReplace } = require('../nav');
const session = require('../session');
const api = require('../api');
const guard = require('../authGuard');
const { checkSession } = require('../sessionCheck');
const { createAuthStore } = require('../authState');

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const T = 'humancare_token';
const R = 'humancare_refresh_token';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const seed = (token, refresh) => { SecureStore.__memory.set(T, token); SecureStore.__memory.set(R, refresh); };
const stored = () => ({ token: SecureStore.__memory.get(T), refresh: SecureStore.__memory.get(R) });
const EMPTY = { token: undefined, refresh: undefined };

beforeEach(() => {
  jest.clearAllMocks();
  SecureStore.__memory.clear();
  SecureStore.__control.setDelay = {};
  SecureStore.__control.failDeleteFor = null;
  SecureStore.__control.failGet = false;
  session.setStorageTimeoutForTests(500);
  session.resetSessionStateForTests();
  api.setRefreshTimeoutForTests(500);
  guard.setApiAuthStatus('authed');
  guard.setCurrentPath('/home');
  global.fetch = jest.fn();
});

// ---------------------------------------------------------------------------------------------------------
describe('1. the /auth/me confirmation sends the right Authorization header', () => {
  test('after a retried 401 the confirmation carries "Bearer <the renewed token>" and nothing else is wrong with it', async () => {
    seed('old', 'old-r');
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return reply(200, { token: 'renewed-token', refreshToken: 'renewed-r' });
      if (String(url).endsWith('/auth/me')) return reply(200, { user: {} });
      return reply(401, { error: 'Incorrect code', code: 'otp_invalid' });
    });
    await expect(api.apiPost('/auth/me/contact/verify-otp', {})).rejects.toMatchObject({ status: 401 });
    const confirmation = global.fetch.mock.calls.find(([url]) => String(url).endsWith('/auth/me'));
    expect(confirmation).toBeTruthy();
    expect(confirmation[1].headers).toEqual({ Authorization: 'Bearer renewed-token' });
    expect(confirmation[1].headers.Authorization).not.toMatch(/undefined|\$\{|\[object/);
    expect(confirmation[1].signal).toBeTruthy();
  });
  test('the source builds the header from the token with a template literal, not a plain string', () => {
    expect(read('../api.js')).toContain('{ headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }');
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('2. the conditional sign-out is one step in the storage queue', () => {
  test('it clears the matching pair and tells the listeners once', async () => {
    seed('mine', 'mine-r');
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    await expect(session.compareAndClearTokens('mine')).resolves.toBe('cleared');
    expect(stored()).toEqual(EMPTY);
    expect(events).toEqual([false]);
    off();
  });
  test('it does not delete a newer token pair, and tells nobody', async () => {
    seed('newer', 'newer-r');
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    await expect(session.compareAndClearTokens('older')).resolves.toBe('superseded');
    expect(stored()).toEqual({ token: 'newer', refresh: 'newer-r' });
    expect(events).toEqual([]);
    off();
  });
  test('nothing saved: nothing to clear, nobody told', async () => {
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    await expect(session.compareAndClearTokens('anything')).resolves.toBe('superseded');
    expect(events).toEqual([]);
    off();
  });
  test('a login that is queued between the comparison and the deletion cannot be deleted (no gap)', async () => {
    seed('old', 'old-r');
    SecureStore.__control.setDelay = { [T]: 40 };
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    // the conditional clear is queued first, the login right behind it: the clear sees the old pair and deletes
    // it, then the login saves its pair. Reversed, the clear would find the new token and do nothing.
    const clearing = session.compareAndClearTokens('old');
    const attempt = session.beginSignIn();
    const saving = session.saveTokens({ token: 'new', refreshToken: 'new-r' }, { signIn: true, attempt });
    await expect(clearing).resolves.toBe('cleared');
    await saving;
    expect(stored()).toEqual({ token: 'new', refresh: 'new-r' });
    expect(events).toEqual([false, true]);
    off();
  });
  test('and the other way round: a login first, then the old session\'s conditional clear: the login survives', async () => {
    seed('old', 'old-r');
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    const attempt = session.beginSignIn();
    const saving = session.saveTokens({ token: 'new', refreshToken: 'new-r' }, { signIn: true, attempt });
    const clearing = session.compareAndClearTokens('old');
    await saving;
    await expect(clearing).resolves.toBe('superseded');
    expect(stored()).toEqual({ token: 'new', refresh: 'new-r' });
    expect(events).toEqual([true]);
    off();
  });
  test('a keychain that refuses to delete is not reported as deleted; the token is not read back as valid', async () => {
    seed('mine', 'mine-r');
    SecureStore.__control.failDeleteFor = '*';
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    await expect(session.compareAndClearTokens('mine')).resolves.toBe('failed');
    expect(events).toEqual([]); // no false "signed out" announcement
    expect(await session.getAccessToken()).toBeNull(); // ...but the token is not handed out as valid
    off();
  });
  test('a keychain that cannot be read changes nothing and reports nothing', async () => {
    seed('mine', 'mine-r');
    SecureStore.__control.failGet = true;
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    await expect(session.compareAndClearTokens('mine')).rejects.toThrow('Keychain is locked');
    SecureStore.__control.failGet = false;
    expect(stored()).toEqual({ token: 'mine', refresh: 'mine-r' });
    expect(events).toEqual([]);
    off();
  });
  test('api.js uses it instead of a separate comparison and clear', () => {
    const source = read('../api.js');
    expect(source).toContain('compareAndClearTokens(usedToken)');
    expect(source).not.toMatch(/\bclearTokens\b/);
    expect(source).toContain("if (outcome === 'cleared') navReplace(");
  });
  test('end to end: a forced sign-out of an older session redirects nobody when a newer login exists', async () => {
    seed('old', 'old-r');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return reply(401, { error: 'Invalid or expired refresh token' });
      await gate; // the call made with the OLD token is still in flight
      return reply(401, { error: 'Token expired' });
    });
    const call = api.apiGet('/requests/me').catch((e) => e);
    await wait(30); // it has read the old token and sent the request
    const attempt = session.beginSignIn();
    await session.saveTokens({ token: 'newer', refreshToken: 'newer-r' }, { signIn: true, attempt }); // the person logs in meanwhile
    release(); // the old call now fails, its refresh is refused, and it tries to end "its" session
    const err = await call;
    expect(err.code).toBe('session_expired');
    expect(stored()).toEqual({ token: 'newer', refresh: 'newer-r' });
    expect(navReplace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('3. stale sign-in attempts cannot restore a session', () => {
  test('a login response that arrives after a sign-out is refused', async () => {
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    const attempt = session.beginSignIn(); // the request is sent
    await session.clearTokens(); // the person signs out while it is in flight
    await expect(session.saveTokens({ token: 'late', refreshToken: 'late-r' }, { signIn: true, attempt })).rejects.toMatchObject({ code: 'stale_sign_in' });
    expect(stored()).toEqual(EMPTY);
    expect(events).toEqual([false]); // only the sign-out
    off();
  });
  test('an older attempt that answers after a newer one cannot overwrite it', async () => {
    const first = session.beginSignIn();
    const second = session.beginSignIn();
    await session.saveTokens({ token: 'second', refreshToken: 'second-r' }, { signIn: true, attempt: second });
    await expect(session.saveTokens({ token: 'first', refreshToken: 'first-r' }, { signIn: true, attempt: first })).rejects.toMatchObject({ code: 'stale_sign_in' });
    expect(stored()).toEqual({ token: 'second', refresh: 'second-r' });
  });
  test('an attempt made stale while it waits in the storage queue is refused too', async () => {
    SecureStore.__control.setDelay = { [T]: 40, [R]: 40 };
    const holder = session.saveTokens({ token: 'busy', refreshToken: 'busy-r' }); // keeps the queue busy
    const attempt = session.beginSignIn();
    const waiting = session.saveTokens({ token: 'waiting', refreshToken: 'waiting-r' }, { signIn: true, attempt }).catch((e) => e);
    session.beginSignIn(); // a newer attempt starts while the first one is still queued
    const result = await waiting;
    await holder;
    expect(result.code).toBe('stale_sign_in');
    expect(stored()).toEqual({ token: 'busy', refresh: 'busy-r' });
  });
  test('a sign-in must carry its attempt: without one it is refused', async () => {
    await expect(session.saveTokens({ token: 'a', refreshToken: 'b' }, { signIn: true })).rejects.toMatchObject({ code: 'stale_sign_in' });
    expect(stored()).toEqual(EMPTY);
  });
  test('the current attempt still signs in and announces', async () => {
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    const attempt = session.beginSignIn();
    await session.saveTokens({ token: 'ok', refreshToken: 'ok-r' }, { signIn: true, attempt });
    expect(stored()).toEqual({ token: 'ok', refresh: 'ok-r' });
    expect(events).toEqual([true]);
    off();
  });
  test('every sign-in flow numbers its attempt before the request and handles a stale answer silently', () => {
    const otp = read('../../components/OtpScreen.js');
    expect(otp.indexOf('beginSignIn()')).toBeLessThan(otp.indexOf('await onVerify('));
    expect(otp).toContain("err.code === 'stale_sign_in'");
    const password = read('../../app/set-password.js');
    expect(password.indexOf('beginSignIn()')).toBeLessThan(password.indexOf("apiPost('/auth/password/set'"));
    expect(password).toContain("err.code === 'stale_sign_in'");
    const social = read('../useSocialAuth.js');
    expect(social.match(/beginSignIn\(\)/g)).toHaveLength(2); // Google and Apple
    expect(social.indexOf('const attempt = beginSignIn()')).toBeLessThan(social.indexOf('google.signIn()'));
    expect(social).toContain('afterSocialLogin(await apiPost(\'/auth/google\', { idToken }), attempt)');
    expect(social).toContain('afterSocialLogin(data, attempt)');
    expect(read('../../app/login.js')).toContain('{ signIn: true, attempt }');
  });
  test('a stale answer in the state machine: a login answer after a newer sign-out leaves the app signed out', async () => {
    const store = createAuthStore({ getToken: session.getAccessToken, fetchMe: async () => ({}), tokenTimeoutMs: 100, meTimeoutMs: 100 });
    const off = session.onSessionChange((signedIn) => (signedIn ? store.signedIn() : store.signedOut()));
    const attempt = session.beginSignIn();
    await session.clearTokens();
    await session.saveTokens({ token: 'late', refreshToken: 'late-r' }, { signIn: true, attempt }).catch(() => undefined);
    expect(store.getStatus()).toBe('anon');
    off();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('4. late and out-of-order storage writes', () => {
  test('a delayed write that completes after its timeout does not leave a mixed pair', async () => {
    seed('keep', 'keep-r');
    session.setStorageTimeoutForTests(30);
    SecureStore.__control.setDelay = { [T]: 150 }; // the access-token write is slow
    const attempt = session.beginSignIn();
    await expect(session.saveTokens({ token: 'slow', refreshToken: 'slow-r' }, { signIn: true, attempt })).rejects.toMatchObject({ code: 'storage_timeout' });
    await wait(400); // the slow write lands now
    expect(stored()).toEqual({ token: 'keep', refresh: 'keep-r' }); // back to what was intended: the old pair, whole
  });
  test('an older write that finishes late does not overwrite a newer login', async () => {
    session.setStorageTimeoutForTests(30);
    SecureStore.__control.setDelay = { [T]: 150 };
    const older = session.beginSignIn();
    await expect(session.saveTokens({ token: 'older', refreshToken: 'older-r' }, { signIn: true, attempt: older })).rejects.toMatchObject({ code: 'storage_timeout' });
    SecureStore.__control.setDelay = {}; // the keychain is fast again
    const newer = session.beginSignIn();
    await session.saveTokens({ token: 'newer', refreshToken: 'newer-r' }, { signIn: true, attempt: newer });
    await wait(400); // the older write finally lands
    expect(stored()).toEqual({ token: 'newer', refresh: 'newer-r' });
  });
  test('a delayed write after a timeout cannot bring tokens back after a sign-out', async () => {
    session.setStorageTimeoutForTests(30);
    SecureStore.__control.setDelay = { [T]: 150 };
    const attempt = session.beginSignIn();
    await expect(session.saveTokens({ token: 'slow', refreshToken: 'slow-r' }, { signIn: true, attempt })).rejects.toBeTruthy();
    await session.clearTokens();
    await wait(400);
    expect(stored()).toEqual(EMPTY);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('5. a cancelled session check starts nothing', () => {
  test('an already-aborted signal: no token read and no /auth/me', async () => {
    const controller = new AbortController();
    controller.abort();
    const getToken = jest.fn(async () => 'tok');
    const fetchMe = jest.fn(async () => ({}));
    await expect(checkSession({ getToken, fetchMe, signal: controller.signal })).resolves.toEqual({ status: 'aborted' });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMe).not.toHaveBeenCalled();
  });
  test('cancelled while the token is being read: /auth/me is still not started', async () => {
    const controller = new AbortController();
    const fetchMe = jest.fn(async () => ({}));
    const getToken = jest.fn(async () => { controller.abort(); return 'tok'; });
    await expect(checkSession({ getToken, fetchMe, signal: controller.signal })).resolves.toEqual({ status: 'aborted' });
    expect(fetchMe).not.toHaveBeenCalled();
  });
  test('through the real api: an aborted validation sends no request at all', async () => {
    seed('good', 'good-r');
    guard.setApiAuthStatus('loading');
    const controller = new AbortController();
    controller.abort();
    await expect(api.apiGet('/auth/me', { signal: controller.signal, validation: true })).rejects.toMatchObject({ name: 'AbortError' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('a check superseded before its turn never reaches the network', async () => {
    seed('good', 'good-r');
    global.fetch.mockResolvedValue(reply(200, { user: {} }));
    const store = createAuthStore({ getToken: session.getAccessToken, fetchMe: (signal) => api.apiGet('/auth/me', { signal, validation: true }), tokenTimeoutMs: 200, meTimeoutMs: 200 });
    const first = store.validate();
    store.signedOut(); // cancels it at once
    await first;
    expect(global.fetch).not.toHaveBeenCalled();
    expect(store.getStatus()).toBe('anon');
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('6. what /auth/me answers decides what the check concludes', () => {
  test('401 is a refusal of the session; 403 and 404 are not treated as one', async () => {
    const run = (status) => checkSession({ getToken: async () => 'tok', fetchMe: async () => { const e = new Error('x'); e.status = status; throw e; }, tokenTimeoutMs: 50, meTimeoutMs: 50 });
    expect(await run(401)).toEqual({ status: 'anon' });
    expect(await run(403)).toEqual({ status: 'unreachable' });
  });
  test('the backend really does answer /auth/me with 401 for every bad token and never with 403', () => {
    const middleware = fs.readFileSync(path.join(__dirname, '../../../../../backend/src/common/middleware/auth.middleware.js'), 'utf8');
    const routes = fs.readFileSync(path.join(__dirname, '../../../../../backend/src/modules/auth/auth.routes.js'), 'utf8');
    expect(routes).toContain("authRouter.get('/me', requireAuth(undefined, { allowPasswordChangePending: true }), getMe)");
    // no role list on this route, and the restricted first-login token is allowed: the only 403s requireAuth can
    // produce (a wrong role, a restricted token) cannot happen here
    expect(middleware).toContain("if (allowedRoles && !allowedRoles.includes(payload.role))");
    expect(middleware).toContain('if (payload.pwc === true && !options.allowPasswordChangePending)');
    // every missing, malformed, expired or forged token is a 401
    expect(middleware.match(/status\(401\)/g).length).toBeGreaterThanOrEqual(3);
  });
});
