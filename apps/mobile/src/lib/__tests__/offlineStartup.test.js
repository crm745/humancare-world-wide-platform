/* global describe, test, expect, jest, beforeEach, afterEach, __dirname */
// Phase 3 (authentication and emergency access), end to end: the REAL api.js, session.js, auth store, network store and restore logic, on an in-memory secure
// store and a fake fetch, with fake timers. Plus source-level checks for the screen, the banner and the emergency number.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), createDownloadResumable: jest.fn(), deleteAsync: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));
jest.mock('expo-secure-store', () => {
  const memory = new Map();
  return {
    __memory: memory,
    __control: { failRead: false },
    setItemAsync: jest.fn(async (key, value) => { memory.set(key, value); }),
    deleteItemAsync: jest.fn(async (key) => { memory.delete(key); }),
    getItemAsync: jest.fn(async (key) => {
      if (require('expo-secure-store').__control.failRead) throw new Error('Keychain read failed');
      return memory.has(key) ? memory.get(key) : null;
    }),
  };
});

const fs = require('fs');
const path = require('path');
const SecureStore = require('expo-secure-store');
const { navReplace } = require('../nav');
const session = require('../session');
const api = require('../api');
const guard = require('../authGuard');
const { createAuthStore } = require('../authState');
const { createRestoreRetrier, AUTH_RETRY_DEBOUNCE_MS } = require('../authRestore');
const { createNetworkStore } = require('../network');
const { splashDecision, MIN_SPLASH_MS, SESSION_TIMEOUT_MS } = require('../splash');
const { cantConnectView } = require('../cantConnect');
const { sosFabVisible } = require('../sos');
const { EMERGENCY_TEL, EMERGENCY_DISPLAY } = require('../../data/mock');

const T = 'humancare_token';
const R = 'humancare_refresh_token';
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const networkDown = () => { throw new TypeError('Network request failed'); };
const WIFI = { isConnected: true, isInternetReachable: true, type: 'wifi' };
const NONE = { isConnected: false, isInternetReachable: false, type: 'none' };
const settle = (ms = 0) => jest.advanceTimersByTimeAsync(ms);

// The app in miniature, wired exactly as AppContext does it.
function startApp({ saved = true, me = networkDown, refresh = () => reply(401, { error: 'invalid' }) } = {}) {
  if (saved) { SecureStore.__memory.set(T, 'access'); SecureStore.__memory.set(R, 'refresh'); }
  const behaviour = { me, refresh, other: async () => reply(200, { requests: [] }) };
  global.fetch = jest.fn(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/auth/me')) return behaviour.me(init);
    if (u.endsWith('/auth/refresh')) return behaviour.refresh(init);
    return behaviour.other(url, init);
  });
  const statuses = [];
  const savedEvents = [];
  let retrier;
  const auth = createAuthStore({
    getToken: session.getAccessToken,
    fetchMe: (signal) => api.apiGet('/auth/me', { signal, validation: true }),
    onChange: (status) => { statuses.push(status); if (retrier) retrier.observeAuth(status); },
    onSavedSession: (value) => savedEvents.push(value),
  });
  retrier = createRestoreRetrier({ retry: () => auth.retry() });
  const linkSubs = new Set();
  const probe = jest.fn(async () => ({ ok: true, status: 200, ms: 40 }));
  const net = createNetworkStore({ probe, subscribeLink: (cb) => { linkSubs.add(cb); return () => linkSubs.delete(cb); } });
  net.subscribe((state) => retrier.observeNetwork({ status: state.status, restoredCount: state.restoredCount }));
  retrier.observeAuth('loading');
  retrier.observeNetwork({ status: net.getState().status, restoredCount: net.getState().restoredCount });
  net.start();
  return {
    auth, net, retrier, statuses, savedEvents, behaviour,
    link: (state) => linkSubs.forEach((cb) => cb(state)),
    meCalls: () => global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/me')).length,
    refreshCalls: () => global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh')).length,
    tokens: () => ({ token: SecureStore.__memory.get(T), refresh: SecureStore.__memory.get(R) }),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  SecureStore.__memory.clear();
  SecureStore.__control.failRead = false;
  session.setStorageTimeoutForTests(500);
  session.resetSessionStateForTests();
  api.setRefreshTimeoutForTests(500);
  guard.setApiAuthStatus('loading');
  guard.setCurrentPath('/cant-connect');
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('1. a returning patient starts offline', () => {
  test('the session is kept, the status is "unreachable", and the splash goes to Can\'t Connect, not Getting Started', async () => {
    const app = startApp();
    app.link(NONE);
    await app.auth.validate();
    await settle();
    expect(app.auth.getStatus()).toBe('unreachable');
    expect(app.auth.getSavedSession()).toBe(true);
    expect(app.tokens()).toEqual({ token: 'access', refresh: 'refresh' }); // NOTHING was cleared by the network failure
    expect(navReplace).not.toHaveBeenCalled(); // and nobody was sent to Login
    const route = splashDecision({ status: app.auth.getStatus(), savedSession: app.auth.getSavedSession(), minElapsed: true, timedOut: false });
    expect(route).toBe('/cant-connect');
    expect(cantConnectView({ authStatus: app.auth.getStatus() }).mode).toBe('unreachable');
  });
  test('the server being down (5xx) and no answer in time are the same: kept, unreachable', async () => {
    for (const me of [async () => reply(503, { error: 'down' }), () => new Promise(() => {})]) {
      SecureStore.__memory.clear();
      const app = startApp({ me });
      const done = app.auth.validate();
      await settle(21000);
      await done;
      expect(app.auth.getStatus()).toBe('unreachable');
      expect(app.tokens()).toEqual({ token: 'access', refresh: 'refresh' });
      app.net.stop();
    }
  });
  test('a refresh that cannot be answered (the server down) keeps the credentials too', async () => {
    const app = startApp({ me: async () => reply(401, {}), refresh: networkDown });
    await app.auth.validate();
    expect(app.auth.getStatus()).toBe('unreachable');
    expect(app.tokens()).toEqual({ token: 'access', refresh: 'refresh' });
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('while the session is being checked the screen says "Connecting…", with nothing granted', async () => {
    const app = startApp({ me: () => new Promise(() => {}) });
    app.auth.validate();
    await settle(100);
    expect(app.auth.getStatus()).toBe('loading');
    expect(app.auth.getSavedSession()).toBe(true); // known as soon as the credentials are read, before the server answers
    expect(cantConnectView({ authStatus: 'loading' }).mode).toBe('connecting');
    expect(guard.guardDecision({ pathname: '/home', status: 'loading' })).toEqual({ action: 'wait' });
  });
});

describe('2. a new user starts offline', () => {
  test('nothing saved: no request is made, the status is "anon", and the splash goes to Getting Started', async () => {
    const app = startApp({ saved: false });
    app.link(NONE);
    await app.auth.validate();
    expect(app.auth.getStatus()).toBe('anon');
    expect(app.auth.getSavedSession()).toBe(false);
    expect(app.meCalls()).toBe(0);
    expect(splashDecision({ status: 'anon', savedSession: false, minElapsed: true })).toBe('/welcome');
  });
  test('a person who logged out is the same: nothing saved', async () => {
    const app = startApp({ saved: true });
    SecureStore.__memory.clear();
    await app.auth.validate();
    expect(splashDecision({ status: app.auth.getStatus(), savedSession: app.auth.getSavedSession(), minElapsed: true })).toBe('/welcome');
  });
  test('"saved" is not "valid": an unreachable check with nothing saved can never reach Can\'t Connect', () => {
    expect(splashDecision({ status: 'unreachable', savedSession: false, minElapsed: true })).toBe('/welcome');
    expect(splashDecision({ status: 'unreachable', savedSession: null, minElapsed: true })).toBe('/welcome');
  });
});

describe('3. a saved session is validated after a slow response', () => {
  test('the splash stays while the saved session is checked (no Connecting screen), and the app moves to Home by itself when the server says yes', async () => {
    const app = startApp({ me: () => new Promise((resolve) => setTimeout(() => resolve(reply(200, { user: { id: 1, name: 'A' } })), 6000)) });
    // A protected call made now is held until the session is known (it cannot run on a guess).
    let held = 'pending';
    api.apiGet('/requests/me').then(() => { held = 'ran'; });
    const done = app.auth.validate();
    const decide = (minElapsed, timedOut) => splashDecision({ status: app.auth.getStatus(), savedSession: app.auth.getSavedSession(), minElapsed, timedOut });

    await settle(MIN_SPLASH_MS);
    expect(app.auth.getStatus()).toBe('loading');
    expect(decide(true, false)).toBeNull(); // 3 s: still checking, the splash waits
    await settle(SESSION_TIMEOUT_MS - MIN_SPLASH_MS);
    expect(decide(true, true)).toBeNull(); // 4 s: the splash STAYS (no separate Connecting screen); it never goes to Getting Started
    expect(cantConnectView({ authStatus: app.auth.getStatus() }).mode).toBe('connecting');
    expect(held).toBe('pending');

    await settle(2000);
    await done;
    expect(app.auth.getStatus()).toBe('authed'); // the late answer is NOT ignored
    expect(cantConnectView({ authStatus: 'authed' })).toEqual({ mode: 'leave', leaveTo: '/home' });
    await settle();
    expect(held).toBe('ran'); // and the held call was released only now
  });
  test('a late answer that says the session is refused leads to Login, not Home', async () => {
    const app = startApp({ me: () => new Promise((resolve) => setTimeout(() => resolve(reply(401, {})), 6000)) });
    const done = app.auth.validate();
    await settle(7000);
    await done;
    expect(app.auth.getStatus()).toBe('anon');
    expect(cantConnectView({ authStatus: 'anon' })).toEqual({ mode: 'leave', leaveTo: '/login' });
  });
});

describe('4. connectivity returns and triggers exactly ONE auth retry', () => {
  test('offline start -> back online -> one check -> Home', async () => {
    const app = startApp();
    app.link(NONE);
    await app.auth.validate();
    await settle();
    expect(app.auth.getStatus()).toBe('unreachable');
    expect(app.meCalls()).toBe(1);

    app.behaviour.me = async () => reply(200, { user: { id: 1, name: 'A' } });
    app.link(WIFI);
    await settle(); // the link is up: /health answers, the state becomes online
    expect(app.meCalls()).toBe(1); // nothing yet: the debounce
    await settle(AUTH_RETRY_DEBOUNCE_MS - 1);
    expect(app.meCalls()).toBe(1);
    await settle(1);
    expect(app.meCalls()).toBe(2); // exactly one more
    expect(app.auth.getStatus()).toBe('authed');
    expect(cantConnectView({ authStatus: app.auth.getStatus() }).leaveTo).toBe('/home');
    await settle(60000);
    expect(app.meCalls()).toBe(2); // and no more, ever, by itself
  });
  test('the server is still unreachable after the connection returns: the screen stays, and there is no loop', async () => {
    const app = startApp();
    app.link(NONE);
    await app.auth.validate();
    await settle();
    app.link(WIFI);
    await settle(AUTH_RETRY_DEBOUNCE_MS + 10);
    expect(app.meCalls()).toBe(2);
    expect(app.auth.getStatus()).toBe('unreachable');
    expect(cantConnectView({ authStatus: 'unreachable' }).mode).toBe('unreachable');
    expect(app.tokens()).toEqual({ token: 'access', refresh: 'refresh' });
    await settle(10 * 60 * 1000);
    expect(app.meCalls()).toBe(2); // waits for the NEXT restoration or a tap on Try again
  });
  test('the "Try again" button checks once, now', async () => {
    const app = startApp();
    await app.auth.validate();
    app.behaviour.me = async () => reply(200, { user: { id: 1 } });
    await app.auth.retry();
    expect(app.meCalls()).toBe(2);
    expect(app.auth.getStatus()).toBe('authed');
  });
});

describe('5. the session is confirmed invalid after reconnection', () => {
  test('kept while offline; after reconnection the server\'s refusal ends it through the EXISTING sign-out, once', async () => {
    const app = startApp();
    app.link(NONE);
    await app.auth.validate();
    await settle();
    expect(app.tokens()).toEqual({ token: 'access', refresh: 'refresh' }); // offline: untouched
    expect(navReplace).not.toHaveBeenCalled();

    app.behaviour.me = async () => reply(401, { error: 'expired' });
    app.behaviour.refresh = async () => reply(401, { error: 'invalid refresh token' }); // the server CONFIRMS it is invalid
    app.link(WIFI);
    await settle(AUTH_RETRY_DEBOUNCE_MS + 10);
    expect(app.auth.getStatus()).toBe('anon');
    expect(app.auth.getSavedSession()).toBe(false);
    expect(app.tokens()).toEqual({ token: undefined, refresh: undefined }); // cleared by the existing compare-and-clear, only now
    expect(navReplace).toHaveBeenCalledTimes(1);
    expect(navReplace).toHaveBeenCalledWith('/login'); // the existing login flow (the screen is not Corporate)
    expect(cantConnectView({ authStatus: 'anon' }).leaveTo).toBe('/login');
    expect(app.refreshCalls()).toBe(1);
  });
  test('a refresh that is merely unreachable after reconnection does NOT end the session', async () => {
    const app = startApp();
    app.link(NONE);
    await app.auth.validate();
    await settle();
    app.behaviour.me = async () => reply(401, {});
    app.behaviour.refresh = async () => reply(503, {});
    app.link(WIFI);
    await settle(AUTH_RETRY_DEBOUNCE_MS + 10);
    expect(app.auth.getStatus()).toBe('unreachable');
    expect(app.tokens()).toEqual({ token: 'access', refresh: 'refresh' });
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('an expired access token that CAN be renewed after reconnection continues to Home', async () => {
    const app = startApp();
    app.link(NONE);
    await app.auth.validate();
    await settle();
    let first = true;
    app.behaviour.me = async () => { if (first) { first = false; return reply(401, {}); } return reply(200, { user: { id: 1 } }); };
    app.behaviour.refresh = async () => reply(200, { token: 'new-access', refreshToken: 'new-refresh' });
    app.link(WIFI);
    await settle(AUTH_RETRY_DEBOUNCE_MS + 10);
    expect(app.auth.getStatus()).toBe('authed');
    expect(app.tokens()).toEqual({ token: 'new-access', refresh: 'new-refresh' });
  });
});

describe('6. network flapping does not create duplicate checks', () => {
  test('back, gone, back, gone, back within the debounce: one check', async () => {
    const app = startApp();
    app.link(NONE);
    await app.auth.validate();
    await settle();
    expect(app.meCalls()).toBe(1);
    for (let n = 0; n < 4; n += 1) {
      app.link(WIFI);
      await settle(300);
      app.link(NONE);
      await settle(300);
    }
    app.link(WIFI);
    await settle(AUTH_RETRY_DEBOUNCE_MS + 10);
    expect(app.meCalls()).toBe(2); // the initial one and exactly one retry
  });
  test('a restoration while a check is already running starts no second check', async () => {
    const app = startApp();
    app.link(NONE);
    await app.auth.validate();
    await settle();
    let release;
    app.behaviour.me = () => new Promise((resolve) => { release = () => resolve(reply(200, { user: { id: 1 } })); });
    const manual = app.auth.retry(); // the person taps Try again
    await settle();
    app.link(WIFI); // and the connection returns at the same time
    await settle(AUTH_RETRY_DEBOUNCE_MS + 10);
    expect(app.meCalls()).toBe(2); // one initial + the one manual check; the restoration added none
    release();
    await manual;
    expect(app.auth.getStatus()).toBe('authed');
    expect(app.meCalls()).toBe(2);
  });
  test('the network store asks /health once for a burst of link events, so the retrier hears one restoration', async () => {
    const app = startApp();
    app.link(NONE);
    await app.auth.validate();
    await settle();
    app.link(WIFI);
    app.link(WIFI);
    app.link({ ...WIFI });
    await settle(AUTH_RETRY_DEBOUNCE_MS + 10);
    expect(app.meCalls()).toBe(2);
  });
});

describe('7. keychain / storage errors stay distinct from network errors', () => {
  test('an unreadable saved session is "error": nothing is known, the splash does NOT take the Can\'t Connect road, and the screen uses its own wording', async () => {
    SecureStore.__control.failRead = true;
    const app = startApp();
    await app.auth.validate();
    expect(app.auth.getStatus()).toBe('error');
    expect(app.auth.getStatus()).not.toBe('unreachable');
    expect(app.auth.getSavedSession()).toBeNull();
    expect(splashDecision({ status: 'error', savedSession: app.auth.getSavedSession(), minElapsed: true })).toBe('/welcome');
    expect(cantConnectView({ authStatus: 'error' }).mode).toBe('storage');
    expect(app.meCalls()).toBe(0); // the server was never asked: there was nothing to ask with
  });
  test('a restoration does not "retry" a storage error automatically (it is not a network problem)', async () => {
    SecureStore.__control.failRead = true;
    const app = startApp();
    app.link(NONE);
    await app.auth.validate();
    app.link(WIFI);
    await settle(AUTH_RETRY_DEBOUNCE_MS * 5);
    expect(app.auth.getStatus()).toBe('error');
    expect(app.meCalls()).toBe(0);
  });
  test('a network failure and a storage failure produce different states', async () => {
    const network = startApp();
    await network.auth.validate();
    SecureStore.__control.failRead = true;
    const storage = startApp({ saved: false });
    await storage.auth.validate();
    expect([network.auth.getStatus(), storage.auth.getStatus()]).toEqual(['unreachable', 'error']);
    expect(guard.guardDecision({ pathname: '/home', status: 'unreachable' })).toEqual({ action: 'retry', reason: 'network' });
    expect(guard.guardDecision({ pathname: '/home', status: 'error' })).toEqual({ action: 'retry', reason: 'storage' });
  });
  test('an outdated check cannot report anything about the saved credentials', async () => {
    const app = startApp({ saved: true });
    let tokenAnswer;
    const slow = createAuthStore({
      getToken: () => new Promise((resolve) => { tokenAnswer = resolve; }),
      fetchMe: async () => ({ user: {} }),
    });
    slow.validate();
    slow.signedOut(); // a sign-out starts a newer generation: savedSession is false
    tokenAnswer('late-token');
    await settle();
    expect(slow.getSavedSession()).toBe(false);
    expect(app.auth.getSavedSession()).toBeNull(); // (the other store has not run)
  });
});

describe('8. protected data is never exposed before the server validates the session', () => {
  const PROTECTED = ['/home', '/my-requests', '/request-details', '/tracking', '/profile', '/my-documents', '/notifications', '/request/review', '/service/air', '/corporate-dashboard'];
  test.each(['loading', 'unreachable', 'error', 'anon'])('every protected route is covered or redirected while the status is %s', (status) => {
    for (const pathname of PROTECTED) expect(guard.guardDecision({ pathname, status }).action).not.toBe('allow');
  });
  test('only a validated session lets a protected route through (default-deny is unchanged)', () => {
    for (const pathname of PROTECTED) expect(guard.guardDecision({ pathname, status: 'authed' })).toEqual({ action: 'allow' });
    expect(guard.isPublicRoute('/some-new-screen')).toBe(false);
    expect(guard.isPublicRoute('/home')).toBe(false);
  });
  test('the Can\'t Connect route is public and static: it is the one new public route', () => {
    expect(guard.isPublicRoute('/cant-connect')).toBe(true);
    expect(guard.guardDecision({ pathname: '/cant-connect', status: 'unreachable' })).toEqual({ action: 'allow' });
  });
  test('protected API calls are refused without a request while the session is unreachable, and held while loading', async () => {
    guard.setApiAuthStatus('unreachable');
    global.fetch = jest.fn();
    const err = await api.apiGet('/requests/me').catch((e) => e);
    expect(err.code).toBe('session_unverified');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('no protected call is ever made on a saved token alone: a saved token is not a session until the server says so', async () => {
    const app = startApp({ me: () => new Promise(() => {}) });
    let ran = false;
    api.apiGet('/requests/me').then(() => { ran = true; }, () => { ran = true; });
    app.auth.validate();
    await settle(15000);
    expect(ran).toBe(false);
    expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/requests/me'))).toHaveLength(0);
  });
  test('the Can\'t Connect screen loads no data and reads no cache, profile or draft', () => {
    const screen = fs.readFileSync(path.join(__dirname, '../../app/cant-connect.js'), 'utf8');
    for (const forbidden of ['apiGet', 'apiPost', 'apiPatch', 'useResource', 'screenCache', 'getCached', 'profile', 'draft', 'requests', 'refreshProfile']) {
      expect(screen).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });
});

describe('what Phase 3 must not change', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
  test('the new auth code never touches tokens or the sign-out', () => {
    for (const file of ['lib/authRestore.js', 'lib/cantConnect.js', 'app/cant-connect.js']) {
      expect(read(file)).not.toMatch(/clearTokens|compareAndClearTokens|saveTokens|compareAndSaveTokens|getAccessToken|getRefreshToken|endSession|from '\.\.?\/(lib\/)?session'/);
    }
  });
  test('api.js keeps the compare-and-clear sign-out and the single shared refresh', () => {
    const source = read('lib/api.js');
    expect(source).toMatch(/compareAndClearTokens\(usedToken\)/);
    expect(source).toMatch(/if \(outcome === 'cleared'\) navReplace\(loginRouteFor\(getCurrentPath\(\)\)\);/);
    expect(source).toMatch(/if \(err\.kind === 'invalid'\)/);
    expect(source).toMatch(/if \(!refreshPromise\) refreshPromise = runRefresh\(\)/);
  });
  test('the guard\'s rules are as they were: the public list gained only /cant-connect, everything else is default-deny', () => {
    expect([...guard.PUBLIC_ROUTES].sort()).toEqual([
      '/', '/cant-connect', '/choose-login', '/complete-profile', '/corporate-login', '/corporate-otp', '/forgot-password', '/forgot-password-otp', '/help-support', '/login',
      '/login-otp', '/privacy', '/register', '/register-otp', '/reset-password', '/set-password', '/terms', '/welcome',
    ]);
  });
});

describe('9. the emergency call on Can\'t Connect and on the offline banner', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
  test('Can\'t Connect has no SOS button and no "log in with another account": the message and Try again only', () => {
    const screen = read('app/cant-connect.js');
    expect(screen).not.toMatch(/SosModal|variant="sos"|cc_login_other|router\.replace\('\/login'\)/);
    expect(screen).toMatch(/retryLabel=\{text\('cc_try_again'\)\} onRetry=\{retryAuth\}/);
    expect(screen).not.toMatch(/LOGO|Image\b/); // no logo on Can't Connect
  });
  test('the network banner has no SOS and no buttons: a message under the header that takes no touch', () => {
    const banner = read('components/network/ConnectionBanner.js');
    expect(banner).not.toMatch(/SosModal|sos_|bannerOffersEmergency|Pressable|Button/);
    expect(banner).toMatch(/pointerEvents="none"/);
    expect(banner).not.toMatch(/messageBottom|bottomBars|ABOVE_BOTTOM_BARS/);
  });
  test('the confirmation is unchanged and needs no login or data: a plain tel: link behind the existing modal', () => {
    const modal = read('components/sos/SosModal.js');
    expect(modal).toMatch(/const call = \(\) => \{ onClose\(\); open\(emergencyUrl\(EMERGENCY_TEL\)\); \};/);
    expect(modal).toMatch(/title=\{t\('sos_modal_cancel'\)\}/);
    expect(modal).toMatch(/title=\{t\('sos_modal_call'\)\}/);
    expect(modal).not.toMatch(/useNetwork|authStatus|apiGet|apiPost/);
  });
});

describe('10. the emergency call does not appear on Welcome', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
  test('the floating SOS button is hidden there for every authentication state', () => {
    for (const authStatus of ['loading', 'authed', 'anon', 'unreachable', 'error']) {
      expect(sosFabVisible({ pathname: '/welcome', authStatus })).toBe(false);
      expect(sosFabVisible({ pathname: '/cant-connect', authStatus })).toBe(false);
    }
  });
  test('the Welcome screen and its page have no emergency control and no tel: link', () => {
    for (const file of ['app/welcome.js', 'components/GettingStartedIntro.js']) {
      expect(read(file)).not.toMatch(/Sos|SOS|EMERGENCY|emergency|tel:|ConnectionBanner/);
    }
  });
  test('the splash sends a returning person to Can\'t Connect, never to Welcome with an SOS added', () => {
    expect(read('app/index.js')).not.toMatch(/Sos|EMERGENCY|tel:/);
  });
});

describe('11. the emergency number is unchanged', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
  test('the existing constants are exactly as they were', () => {
    expect(EMERGENCY_TEL).toBe('+919699999065');
    expect(EMERGENCY_DISPLAY).toBe('+91 96999 99065');
    expect(read('data/mock.js')).toMatch(/export const EMERGENCY_TEL = '\+919699999065';/);
    expect(read('data/mock.js')).toMatch(/export const EMERGENCY_DISPLAY = '\+91 96999 99065';/);
  });
  test('no Phase 3 file contains a phone number of its own: the number only ever comes from the constants, through the existing modal', () => {
    for (const file of ['app/cant-connect.js', 'components/network/ConnectionBanner.js', 'lib/cantConnect.js', 'lib/networkUi.js', 'lib/authRestore.js', 'lib/splash.js']) {
      const source = read(file);
      expect(source).not.toMatch(/\+91|9699999065|96999 99065|tel:/);
      expect(source).not.toMatch(/EMERGENCY_TEL|EMERGENCY_DISPLAY/); // not even referenced: the modal owns them
    }
  });
  test('the one place that dials still uses the constant', () => {
    expect(read('components/sos/SosModal.js')).toMatch(/emergencyUrl\(EMERGENCY_TEL\)/);
    expect(require('../sos').emergencyUrl(EMERGENCY_TEL)).toBe('tel:+919699999065');
  });
});
