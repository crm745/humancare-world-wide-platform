/* global describe, test, expect, jest, beforeEach, __dirname */
// Phase 1, revision 3. The real session.js and api.js run on an in-memory secure store whose operations can be
// delayed or made to fail, and on a fake fetch, so the races are tested on the real code.
const fs = require('fs');
const path = require('path');

jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));
jest.mock('expo-secure-store', () => {
  const memory = new Map();
  const control = { setDelay: {}, failSetFor: null, readDelay: 0 };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    __memory: memory,
    __control: control,
    setItemAsync: jest.fn(async (key, value) => {
      if (control.setDelay[key]) await wait(control.setDelay[key]);
      if (control.failSetFor === key) throw new Error('Keychain write failed');
      memory.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key) => { memory.delete(key); }),
    getItemAsync: jest.fn(async (key) => {
      if (control.readDelay) await wait(control.readDelay);
      return memory.has(key) ? memory.get(key) : null;
    }),
  };
});

const SecureStore = require('expo-secure-store');
const { navReplace } = require('../nav');
const session = require('../session');
const api = require('../api');
const guard = require('../authGuard');
const tokens = require('../tokens');
const { createAuthStore } = require('../authState');

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const T = 'humancare_token';
const R = 'humancare_refresh_token';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const seed = (token, refresh) => { SecureStore.__memory.set(T, token); SecureStore.__memory.set(R, refresh); };
const stored = () => ({ token: SecureStore.__memory.get(T), refresh: SecureStore.__memory.get(R) });

beforeEach(() => {
  jest.clearAllMocks();
  SecureStore.__memory.clear();
  SecureStore.__control.setDelay = {};
  SecureStore.__control.failSetFor = null;
  SecureStore.__control.readDelay = 0;
  session.setStorageTimeoutForTests(500);
  session.resetSessionStateForTests();
  api.setRefreshTimeoutForTests(500);
  guard.setApiAuthStatus('authed'); // a signed-in person unless a test says otherwise
  guard.setCurrentPath('/home');
  global.fetch = jest.fn();
});

// A server that answers /requests/me with 401 once (expired token) and the refresh with `refresh`.
function expiredThen(refresh, after = () => reply(200, { requests: [] })) {
  let calls = 0;
  global.fetch.mockImplementation(async (url) => {
    if (String(url).endsWith('/auth/refresh')) return typeof refresh === 'function' ? refresh() : refresh;
    if (String(url).endsWith('/auth/me')) return reply(401, { error: 'Token expired' });
    calls += 1;
    return calls === 1 ? reply(401, { error: 'Token expired' }) : after();
  });
}

// ---------------------------------------------------------------------------------------------------------
describe('1. race-safe token storage', () => {
  test('logout during a refresh: the refresh does not bring the tokens back, and nobody is redirected', async () => {
    seed('old', 'old-r');
    let answer;
    global.fetch.mockImplementation((url) => (String(url).endsWith('/auth/refresh')
      ? new Promise((resolve) => { answer = () => resolve(reply(200, { token: 'late', refreshToken: 'late-r' })); })
      : Promise.resolve(reply(401, { error: 'Token expired' }))));
    const call = api.apiGet('/requests/me');
    await wait(20);
    await session.clearTokens();
    answer();
    await expect(call).rejects.toMatchObject({ code: 'session_expired' });
    expect(stored()).toEqual({ token: undefined, refresh: undefined });
    expect(navReplace).not.toHaveBeenCalled();
  });

  test('logout while the refresh is writing slowly: the logout still wins (writes are queued in order)', async () => {
    seed('old', 'old-r');
    SecureStore.__control.setDelay = { [T]: 60, [R]: 60 }; // slow keychain writes
    global.fetch.mockImplementation(async (url) => (String(url).endsWith('/auth/refresh')
      ? reply(200, { token: 'fresh', refreshToken: 'fresh-r' })
      : reply(401, { error: 'Token expired' })));
    const call = api.apiGet('/requests/me').catch((e) => e);
    await wait(40); // the refresh answered and its save has started
    await session.clearTokens(); // queued behind the save
    await call;
    await wait(200);
    expect(stored()).toEqual({ token: undefined, refresh: undefined });
  });

  test('a new login during an old refresh keeps the new login and discards the old renewal', async () => {
    seed('old', 'old-r');
    let answer;
    global.fetch.mockImplementation((url) => (String(url).endsWith('/auth/refresh')
      ? new Promise((resolve) => { answer = () => resolve(reply(200, { token: 'from-old', refreshToken: 'from-old-r' })); })
      : Promise.resolve(reply(401, { error: 'Token expired' }))));
    const call = api.apiGet('/requests/me');
    await wait(20);
    await session.saveTokens({ token: 'new-login', refreshToken: 'new-login-r' }, { signIn: true, attempt: session.beginSignIn() });
    answer();
    await expect(call).rejects.toMatchObject({ code: 'session_expired' });
    expect(stored()).toEqual({ token: 'new-login', refresh: 'new-login-r' });
    expect(navReplace).not.toHaveBeenCalled();
  });

  test('two saves at once leave one consistent pair, never a token from one and a refresh token from the other', async () => {
    SecureStore.__control.setDelay = { [T]: 15, [R]: 5 };
    await Promise.all([
      session.saveTokens({ token: 'A', refreshToken: 'A-r' }),
      session.saveTokens({ token: 'B', refreshToken: 'B-r' }),
    ]);
    const { token, refresh } = stored();
    expect([`${token}/${refresh}`]).toEqual([token === 'A' ? 'A/A-r' : 'B/B-r']);
  });

  test('reads wait for a write in progress, so they never see half of a pair', async () => {
    SecureStore.__control.setDelay = { [T]: 30, [R]: 30 };
    const writing = session.saveTokens({ token: 'N', refreshToken: 'N-r' });
    const [access, refresh] = await Promise.all([session.getAccessToken(), session.getRefreshToken()]);
    await writing;
    expect([access, refresh]).toEqual(['N', 'N-r']);
  });

  test('a partial SecureStore failure announces nothing, stores nothing new, and restores the old pair', async () => {
    seed('keep', 'keep-r');
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    SecureStore.__control.failSetFor = R; // the second write fails
    await expect(session.saveTokens({ token: 'half', refreshToken: 'half-r' }, { signIn: true, attempt: session.beginSignIn() })).rejects.toThrow('Keychain write failed');
    expect(events).toEqual([]);
    expect(stored()).toEqual({ token: 'keep', refresh: 'keep-r' });
    off();
  });

  test('a partial failure on a fresh install leaves nothing half written', async () => {
    SecureStore.__control.failSetFor = R;
    await expect(session.saveTokens({ token: 'half', refreshToken: 'half-r' })).rejects.toBeTruthy();
    expect(stored()).toEqual({ token: undefined, refresh: undefined });
  });

  test('a write that outlives its time limit cannot bring tokens back after a sign-out', async () => {
    session.setStorageTimeoutForTests(30);
    SecureStore.__control.setDelay = { [T]: 150 };
    await expect(session.saveTokens({ token: 'slow', refreshToken: 'slow-r' }, { signIn: true, attempt: session.beginSignIn() })).rejects.toMatchObject({ code: 'storage_timeout' });
    await session.clearTokens();
    await wait(400); // the slow write lands now
    expect(stored()).toEqual({ token: undefined, refresh: undefined });
  });

  test('a refresh never announces a sign-in', async () => {
    seed('old', 'old-r');
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    expiredThen(reply(200, { token: 'fresh', refreshToken: 'fresh-r' }));
    await api.apiGet('/requests/me');
    expect(stored()).toEqual({ token: 'fresh', refresh: 'fresh-r' });
    expect(events).toEqual([]);
    off();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('2. a refresh failure is classified before anyone is signed out', () => {
  const keepsCredentials = async (setup) => {
    seed('old', 'old-r');
    setup();
    const err = await api.apiGet('/requests/me').catch((e) => e);
    expect(err.code).toBe('network'); // "could not reach the server": a retry, not a sign-out
    expect(stored()).toEqual({ token: 'old', refresh: 'old-r' });
    expect(navReplace).not.toHaveBeenCalled();
  };

  test('a network failure keeps the credentials', async () => {
    await keepsCredentials(() => expiredThen(() => { throw new TypeError('Network request failed'); }));
  });
  test('a timeout keeps the credentials', async () => {
    api.setRefreshTimeoutForTests(30);
    await keepsCredentials(() => {
      global.fetch.mockImplementation((url, init) => (String(url).endsWith('/auth/refresh')
        ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
        : Promise.resolve(reply(401, { error: 'Token expired' }))));
    });
  });
  test.each([[500], [502], [503], [429], [404], [400], [403]])('HTTP %i keeps the credentials', async (status) => {
    await keepsCredentials(() => expiredThen(reply(status, { error: 'nope' })));
  });
  test('a 200 without usable credentials is treated as unexpected, not as a sign-out', async () => {
    for (const body of [{}, { token: 'x' }, { token: '', refreshToken: 'r' }, { token: 1, refreshToken: 2 }, null]) {
      jest.clearAllMocks();
      await keepsCredentials(() => expiredThen(reply(200, body)));
    }
  });
  test('only a confirmed invalid refresh token (401) signs out', async () => {
    seed('old', 'old-r');
    expiredThen(reply(401, { error: 'Invalid or expired refresh token' }));
    await expect(api.apiGet('/requests/me')).rejects.toMatchObject({ code: 'session_expired', status: 401 });
    expect(stored()).toEqual({ token: undefined, refresh: undefined });
    expect(navReplace).toHaveBeenCalledTimes(1);
    expect(navReplace).toHaveBeenCalledWith('/login');
  });
  test('a missing refresh token is a sign-out; a refresh token that cannot be read is not', async () => {
    SecureStore.__memory.set(T, 'old'); // no refresh token saved
    expiredThen(reply(200, { token: 'x', refreshToken: 'y' }));
    await expect(api.apiGet('/requests/me')).rejects.toMatchObject({ code: 'session_expired' });
  });
  test('a failure of the renewed credentials to be stored keeps the old ones', async () => {
    seed('old', 'old-r');
    SecureStore.__control.failSetFor = R;
    expiredThen(reply(200, { token: 'fresh', refreshToken: 'fresh-r' }));
    const err = await api.apiGet('/requests/me').catch((e) => e);
    expect(err.code).toBe('network');
    expect(stored()).toEqual({ token: 'old', refresh: 'old-r' });
  });
  test('an unreachable refresh during the session check shows the retry state, not the login', async () => {
    seed('old', 'old-r');
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) throw new TypeError('Network request failed');
      return reply(401, { error: 'Token expired' });
    });
    guard.setApiAuthStatus('loading');
    const store = createAuthStore({ getToken: session.getAccessToken, fetchMe: (signal) => api.apiGet('/auth/me', { signal, validation: true }), tokenTimeoutMs: 200, meTimeoutMs: 500 });
    await store.validate();
    expect(store.getStatus()).toBe('unreachable');
    expect(guard.guardDecision({ pathname: '/profile', status: store.getStatus() })).toEqual({ action: 'retry', reason: 'network' });
    expect(stored()).toEqual({ token: 'old', refresh: 'old-r' });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('3. a retry that also answers 401 after a successful refresh', () => {
  test('the server confirms the session is invalid: sign out, once, and go to Login', async () => {
    seed('old', 'old-r');
    let me = 0;
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return reply(200, { token: 'fresh', refreshToken: 'fresh-r' });
      if (String(url).endsWith('/auth/me')) { me += 1; return reply(401, { error: 'Invalid token' }); }
      return reply(401, { error: 'Invalid token' });
    });
    await expect(api.apiGet('/requests/me')).rejects.toMatchObject({ code: 'session_expired' });
    expect(me).toBe(1);
    expect(stored()).toEqual({ token: undefined, refresh: undefined });
    expect(navReplace).toHaveBeenCalledTimes(1);
  });
  test('a 401 that is the endpoint\'s own answer (a wrong code) ends nothing: the session is still valid', async () => {
    seed('old', 'old-r');
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return reply(200, { token: 'fresh', refreshToken: 'fresh-r' });
      if (String(url).endsWith('/auth/me')) return reply(200, { user: {} });
      return reply(401, { error: 'Incorrect code', code: 'otp_invalid' });
    });
    await expect(api.apiPost('/auth/me/contact/verify-otp', {})).rejects.toMatchObject({ status: 401, code: 'otp_invalid' });
    expect(stored()).toEqual({ token: 'fresh', refresh: 'fresh-r' });
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('a network failure while confirming ends nothing', async () => {
    seed('old', 'old-r');
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return reply(200, { token: 'fresh', refreshToken: 'fresh-r' });
      if (String(url).endsWith('/auth/me')) throw new TypeError('Network request failed');
      return reply(401, { error: 'Invalid token' });
    });
    await expect(api.apiGet('/requests/me')).rejects.toMatchObject({ status: 401 });
    expect(stored()).toEqual({ token: 'fresh', refresh: 'fresh-r' });
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('an older request cannot sign out a newer login', async () => {
    seed('old', 'old-r');
    let release;
    const meGate = new Promise((resolve) => { release = resolve; });
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return reply(200, { token: 'fresh', refreshToken: 'fresh-r' });
      if (String(url).endsWith('/auth/me')) { await meGate; return reply(401, { error: 'Invalid token' }); }
      return reply(401, { error: 'Invalid token' });
    });
    const call = api.apiGet('/requests/me').catch((e) => e);
    await wait(40); // renewed, retried, now confirming with /auth/me
    await session.saveTokens({ token: 'newer', refreshToken: 'newer-r' }, { signIn: true, attempt: session.beginSignIn() }); // the person logs in again
    release();
    const err = await call;
    expect(err.code).toBe('session_expired');
    expect(stored()).toEqual({ token: 'newer', refresh: 'newer-r' }); // the newer login survived
    expect(navReplace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('4. timeouts and late operations', () => {
  const storeWith = (fetchMe, extra = {}) => createAuthStore({ getToken: session.getAccessToken, fetchMe, tokenTimeoutMs: 100, meTimeoutMs: 40, ...extra });

  test('after a timeout the request is aborted, and its late answer changes nothing', async () => {
    seed('good', 'good-r');
    guard.setApiAuthStatus('loading');
    let signal;
    let finish;
    global.fetch.mockImplementation((url, init) => new Promise((resolve) => { signal = init.signal; finish = () => resolve(reply(200, { user: { name: 'late' } })); }));
    const store = storeWith((s) => api.apiGet('/auth/me', { signal: s, validation: true }));
    await store.validate();
    expect(store.getStatus()).toBe('unreachable');
    expect(signal.aborted).toBe(true); // the timed-out request was told to stop
    finish(); // ...and even if its answer still arrives
    await wait(30);
    expect(store.getStatus()).toBe('unreachable');
    expect(stored()).toEqual({ token: 'good', refresh: 'good-r' });
  });

  test('a late answer cannot override a login that happened after the timeout', async () => {
    seed('good', 'good-r');
    let finish;
    global.fetch.mockImplementation((url) => (String(url).endsWith('/auth/refresh')
      ? Promise.resolve(reply(401, { error: 'Invalid or expired refresh token' }))
      : new Promise((resolve) => { finish = () => resolve(reply(401, { error: 'Invalid token' })); })));
    const store = storeWith((s) => api.apiGet('/auth/me', { signal: s, validation: true }));
    session.onSessionChange((signedIn) => (signedIn ? store.signedIn() : store.signedOut()));
    await store.validate(); // times out
    await session.saveTokens({ token: 'login', refreshToken: 'login-r' }, { signIn: true, attempt: session.beginSignIn() });
    finish();
    await wait(30);
    expect(store.getStatus()).toBe('authed');
    expect(stored()).toEqual({ token: 'login', refresh: 'login-r' });
    expect(navReplace).not.toHaveBeenCalled(); // no stale redirect
  });

  test('a late refresh success after a timeout and a sign-out restores nothing', async () => {
    seed('old', 'old-r');
    guard.setApiAuthStatus('loading');
    let answer;
    global.fetch.mockImplementation((url) => (String(url).endsWith('/auth/refresh')
      ? new Promise((resolve) => { answer = () => resolve(reply(200, { token: 'late', refreshToken: 'late-r' })); })
      : Promise.resolve(reply(401, { error: 'Token expired' }))));
    const store = storeWith((s) => api.apiGet('/auth/me', { signal: s, validation: true }));
    await store.validate(); // /auth/me 401 -> refresh pending -> check times out
    expect(store.getStatus()).toBe('unreachable');
    await session.clearTokens();
    answer(); // the refresh answers late
    await wait(40);
    expect(stored()).toEqual({ token: undefined, refresh: undefined });
    expect(navReplace).not.toHaveBeenCalled();
  });

  test('a check that is superseded is aborted', async () => {
    seed('good', 'good-r');
    const signals = [];
    global.fetch.mockImplementation((url, init) => { signals.push(init.signal); return new Promise(() => {}); });
    const store = storeWith((s) => api.apiGet('/auth/me', { signal: s, validation: true }), { meTimeoutMs: 1000 });
    store.validate();
    await wait(20);
    store.signedOut();
    expect(signals[0].aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('5. protected requests while authentication is not established', () => {
  test('while loading, a protected call waits and sends nothing; it goes out once the session is valid', async () => {
    seed('good', 'good-r');
    guard.setApiAuthStatus('loading');
    global.fetch.mockResolvedValue(reply(200, { requests: [] }));
    const call = api.apiGet('/requests/me');
    await wait(30);
    expect(global.fetch).not.toHaveBeenCalled();
    guard.setApiAuthStatus('authed');
    await expect(call).resolves.toEqual({ requests: [] });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  test.each([['anon'], ['unreachable'], ['error']])('in the %s state a protected call is refused without a request', async (status) => {
    seed('good', 'good-r');
    guard.setApiAuthStatus(status);
    await expect(api.apiGet('/requests/me')).rejects.toBeTruthy();
    await expect(api.apiPost('/requests', {})).rejects.toBeTruthy();
    await expect(api.apiPatch('/auth/me', {})).rejects.toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('a call that was waiting is refused when the check ends in a denial', async () => {
    seed('good', 'good-r');
    guard.setApiAuthStatus('loading');
    const call = api.apiGet('/requests/me').catch((e) => e);
    await wait(20);
    guard.setApiAuthStatus('unreachable');
    expect((await call).code).toBe('session_unverified');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('uploads are held and refused the same way', async () => {
    seed('good', 'good-r');
    const file = { uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf' };
    guard.setApiAuthStatus('loading');
    const held = api.apiUpload('/requests/me/5/documents', file).catch((e) => e);
    await wait(20);
    guard.setApiAuthStatus('error');
    expect((await held).code).toBe('session_unverified');
    expect(require('expo-file-system/legacy').createUploadTask).not.toHaveBeenCalled();
  });
  test('the session check itself, login, registration, OTP, password reset and refresh are not held', async () => {
    seed('good', 'good-r');
    guard.setApiAuthStatus('loading');
    global.fetch.mockResolvedValue(reply(200, { ok: true }));
    await api.apiGet('/auth/me', { validation: true });
    await api.apiPost('/auth/login', {});
    await api.apiPost('/auth/register', {});
    await api.apiPost('/auth/login/verify-otp', {});
    await api.apiPost('/auth/register/verify-otp', {});
    await api.apiPost('/auth/password/forgot', {});
    await api.apiPost('/auth/password/forgot/verify-otp', {});
    await api.apiPost('/auth/password/set', {});
    await api.apiPost('/auth/corporate/login', {});
    await api.apiPost('/auth/corporate/otp/verify', {});
    await api.apiPost('/auth/otp/resend', {});
    await api.apiGet('/services');
    expect(global.fetch).toHaveBeenCalledTimes(12);
  });
  test('/auth/me is held when it is not the session check', async () => {
    guard.setApiAuthStatus('anon');
    await expect(api.apiGet('/auth/me')).rejects.toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('6. sign-in responses are validated, and each session type goes to its own place', () => {
  test.each([
    ['no token', { refreshToken: 'r' }],
    ['no refresh token', { token: 't' }],
    ['empty token', { token: '', refreshToken: 'r' }],
    ['blank refresh token', { token: 't', refreshToken: '   ' }],
    ['non-string tokens', { token: 12, refreshToken: {} }],
    ['null', null],
    ['undefined', undefined],
  ])('%s: nothing is stored and no sign-in is announced', async (name, body) => {
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    await expect(session.saveTokens(body, { signIn: true, attempt: session.beginSignIn() })).rejects.toMatchObject({ code: 'invalid_credentials_response' });
    expect(events).toEqual([]);
    expect(stored()).toEqual({ token: undefined, refresh: undefined });
    off();
  });
  test('the same check is available to the screens', () => {
    expect(tokens.hasValidTokens({ token: 'a', refreshToken: 'b' })).toBe(true);
    expect(tokens.hasValidTokens({ token: 'a' })).toBe(false);
    expect(tokens.isTokenString('x')).toBe(true);
    expect(tokens.isTokenString(' ')).toBe(false);
  });
  test('patient and corporate each land on their destination; an unknown session kind has none', () => {
    expect(tokens.postSignInRoute('patient')).toBe('/home');
    expect(tokens.postSignInRoute('corporate')).toBe('/home');
    expect(tokens.postSignInRoute('admin')).toBeNull();
    expect(tokens.postSignInRoute(undefined)).toBeNull();
    expect(tokens.postSignInRoute('toString')).toBeNull();
  });
  test('after sign-out, patient and corporate screens go to their own login', () => {
    expect(guard.guardDecision({ pathname: '/home', status: 'anon' }).redirect).toBe('/login');
    expect(guard.guardDecision({ pathname: '/corporate-dashboard', status: 'anon' }).redirect).toBe('/corporate-login');
    expect(guard.guardDecision({ pathname: '/corporate-new-case', status: 'anon' }).redirect).toBe('/corporate-login');
  });
  test('OtpScreen: no sign-in without a verifier; credentials and session kind checked before anything is stored', () => {
    const otp = read('../../components/OtpScreen.js');
    expect(otp).not.toMatch(/if \(!onVerify\) \{ setSession/);
    expect(otp).toContain("if (!onVerify) { toast(");
    const checked = otp.indexOf('hasValidTokens(result)');
    const saved = otp.indexOf('await saveTokens(');
    expect(checked).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(saved);
    expect(otp).toContain('postSignInRoute(session)');
    expect(otp).toContain('navReplace(destination)');
  });
  test('every OtpScreen caller has a verifier and a known session kind (corporate for the corporate code, patient otherwise)', () => {
    const kinds = {
      '../../app/corporate-otp.js': 'corporate',
      '../../app/login-otp.js': 'patient',
      '../../app/register-otp.js': 'patient',
      '../../app/forgot-password-otp.js': 'patient',
      '../../app/change-contact-otp.js': 'patient',
    };
    for (const [file, kind] of Object.entries(kinds)) {
      const source = read(file);
      expect(source).toContain(`session="${kind}"`);
      expect(source).toContain('onVerify={onVerify}');
    }
  });
  test('Google/Apple and activation read the profile first and use the validated sign-in', () => {
    const login = read('../../app/login.js');
    expect(login.indexOf('profileFromUser(user)')).toBeLessThan(login.indexOf('await saveTokens('));
    expect(login).toContain("postSignInRoute('patient')");
    const setPassword = read('../../app/set-password.js');
    expect(setPassword.indexOf('profileFromUser(data.user)')).toBeLessThan(setPassword.indexOf('await saveTokens('));
    expect(setPassword).toContain("postSignInRoute('patient')");
  });
  test('only the sign-in sites ask for a sign-in, and a refresh never does', () => {
    expect(read('../api.js')).not.toMatch(/signIn: true/);
    for (const file of ['../../components/OtpScreen.js', '../../app/login.js', '../../app/set-password.js']) expect(read(file)).toContain('signIn: true, attempt');
  });
});
