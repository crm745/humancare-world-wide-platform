/* global describe, test, expect, jest, beforeEach, __dirname */
// Phase 1 corrections: the authentication state machine (lib/authState.js), the session check, and how the
// real session.js and api.js drive it. The real session.js and api.js are used here, on top of an in-memory
// secure store and a fake fetch, so "saving tokens does not sign anyone in" is tested on the real code path.
const fs = require('fs');
const path = require('path');

jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));
jest.mock('expo-secure-store', () => {
  const memory = new Map();
  return {
    __memory: memory,
    __failReads: { on: false, hang: false },
    setItemAsync: jest.fn(async (k, v) => { memory.set(k, v); }),
    deleteItemAsync: jest.fn(async (k) => { memory.delete(k); }),
    getItemAsync: jest.fn(async function get(k) {
      const store = require('expo-secure-store');
      if (store.__failReads.hang) return new Promise(() => {});
      if (store.__failReads.on) throw new Error('Keychain is locked');
      return memory.has(k) ? memory.get(k) : null;
    }),
  };
});

const SecureStore = require('expo-secure-store');
const { navReplace } = require('../nav');
const session = require('../session');
const { apiGet } = require('../api');
const guard = require('../authGuard');
const { createAuthStore } = require('../authState');
const { checkSession } = require('../sessionCheck');

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const ME = { user: { name: 'Aisha' } };
const decide = (status, pathname = '/home') => guard.guardDecision({ pathname, status }).action;

// A store wired exactly as AppContext wires it, recording every state it reports.
function appStore(overrides = {}) {
  const seen = [];
  const store = createAuthStore({
    getToken: session.getAccessToken,
    fetchMe: (signal) => apiGet('/auth/me', { signal, validation: true }),
    onChange: (status, me) => seen.push(status + (me ? '+me' : '')),
    tokenTimeoutMs: 40,
    meTimeoutMs: 400,
    ...overrides,
  });
  const unsubscribe = session.onSessionChange((signedIn) => (signedIn ? store.signedIn() : store.signedOut()));
  return { store, seen, unsubscribe };
}

beforeEach(() => {
  jest.clearAllMocks();
  SecureStore.__memory.clear();
  SecureStore.__failReads.on = false;
  SecureStore.__failReads.hang = false;
  session.setStorageTimeoutForTests(60);
  session.resetSessionStateForTests();
  guard.setApiAuthStatus('loading');
  guard.setCurrentPath('/home');
  global.fetch = jest.fn();
});

const save = (token, refreshToken) => { SecureStore.__memory.set('humancare_token', token); SecureStore.__memory.set('humancare_refresh_token', refreshToken); };

describe('Finding 1: saving or renewing tokens does not sign anyone in', () => {
  test('saveTokens alone announces nothing; clearTokens announces a sign-out', async () => {
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    await session.saveTokens({ token: 'a', refreshToken: 'b' });
    expect(events).toEqual([]);
    await session.saveTokens({ token: 'a', refreshToken: 'b' }, { signIn: true, attempt: session.beginSignIn() });
    expect(events).toEqual([true]);
    await session.clearTokens();
    expect(events).toEqual([true, false]);
    off();
  });

  test('5. an expired access token that is renewed: nothing is granted until /auth/me succeeds', async () => {
    save('expired', 'refresh');
    let meCalls = 0;
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return reply(200, { token: 'fresh', refreshToken: 'r2' });
      meCalls += 1;
      return meCalls === 1 ? reply(401, { error: 'Token expired' }) : reply(200, ME);
    });
    const { store, seen, unsubscribe } = appStore();
    await store.validate();
    // The refresh saved new tokens in the middle of the check; the only thing reported is the final answer.
    expect(seen).toEqual(['authed+me']);
    expect(SecureStore.__memory.get('humancare_token')).toBe('fresh');
    unsubscribe();
  });

  test('12. no protected screen is allowed at any point before the server has accepted the session', async () => {
    save('expired', 'refresh');
    const seenDecisions = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) { await gate; return reply(200, { token: 'fresh', refreshToken: 'r2' }); }
      return global.fetch.mock.calls.filter((c) => String(c[0]).endsWith('/auth/me')).length === 1 ? reply(401, {}) : reply(200, ME);
    });
    const { store, unsubscribe } = appStore({ meTimeoutMs: 2000 });
    const record = () => seenDecisions.push(decide(store.getStatus()));
    const run = store.validate();
    record(); // the check is running
    await new Promise((r) => setTimeout(r, 10)); record(); // the refresh is in flight
    release();
    await new Promise((r) => setTimeout(r, 10)); record(); // tokens have been saved, /auth/me not answered yet or just answered
    await run;
    expect(seenDecisions.slice(0, 2)).toEqual(['wait', 'wait']);
    expect(decide(store.getStatus())).toBe('allow'); // allowed only after the accepted answer
    unsubscribe();
  });

  test('a refresh that finishes after the person signed out does not bring the session back', async () => {
    save('old', 'refresh');
    guard.setApiAuthStatus('authed'); // a signed-in person: the call is sent
    let finishRefresh;
    global.fetch.mockImplementation((url) => {
      if (String(url).endsWith('/auth/refresh')) return new Promise((resolve) => { finishRefresh = () => resolve(reply(200, { token: 'late', refreshToken: 'late-r' })); });
      return Promise.resolve(reply(401, { error: 'Token expired' }));
    });
    const pending = apiGet('/requests/me');
    await new Promise((r) => setTimeout(r, 10));
    await session.clearTokens(); // signs out while the refresh is in flight
    finishRefresh();
    await expect(pending).rejects.toThrow('Your session expired');
    expect(SecureStore.__memory.has('humancare_token')).toBe(false);
    expect(SecureStore.__memory.has('humancare_refresh_token')).toBe(false);
    expect(navReplace).not.toHaveBeenCalled(); // no redirect that fights the person's own sign-out
  });
});

describe('fresh sign-ins still work', () => {
  test.each([['1. fresh patient login'], ['2. fresh corporate login'], ['3. account activation / set-password']])('%s', async () => {
    const { store, seen, unsubscribe } = appStore();
    await store.validate(); // opened signed out
    expect(store.getStatus()).toBe('anon');
    expect(decide('anon')).toBe('redirect');
    await session.saveTokens({ token: 'issued', refreshToken: 'issued-r' }, { signIn: true, attempt: session.beginSignIn() }); // what the three flows do
    expect(store.getStatus()).toBe('authed');
    expect(decide(store.getStatus())).toBe('allow');
    expect(seen).toEqual(['anon', 'authed']);
    unsubscribe();
  });

  test('every place that signs a person in says so (patient, corporate, social, activation)', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
    expect(read('../../components/OtpScreen.js')).toContain('signIn: true, attempt'); // patient and corporate codes
    expect(read('../../app/login.js')).toContain('signIn: true, attempt'); // Google / Apple
    expect(read('../../app/set-password.js')).toContain('signIn: true, attempt'); // account activation
  });

  test('a refresh does not count as a sign-in (api.js passes no signIn)', () => {
    const api = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
    expect(api).not.toMatch(/signIn: true/);
  });

  test('a login while an older check is still running is not overwritten by it', async () => {
    save('stale', 'r');
    let finishMe;
    global.fetch.mockImplementation((url) => {
      if (String(url).endsWith('/auth/refresh')) return Promise.resolve(reply(200, { token: 'renewed', refreshToken: 'renewed-r' }));
      if (finishMe === undefined) return new Promise((resolve) => { finishMe = () => resolve(reply(401, { error: 'Token expired' })); });
      return Promise.resolve(reply(200, ME));
    });
    const { store, seen, unsubscribe } = appStore({ meTimeoutMs: 2000 });
    const check = store.validate();
    await new Promise((r) => setTimeout(r, 10));
    await session.saveTokens({ token: 'issued', refreshToken: 'ir' }, { signIn: true, attempt: session.beginSignIn() });
    finishMe();
    await check;
    expect(store.getStatus()).toBe('authed');
    expect(seen).toEqual(['authed']);
    unsubscribe();
  });

  test('an older session failing after a new login does not clear the new login', async () => {
    save('stale', 'stale-r');
    let finishMe;
    global.fetch.mockImplementation((url) => {
      if (String(url).endsWith('/auth/refresh')) return Promise.resolve(reply(401, { error: 'Invalid or expired refresh token' }));
      return new Promise((resolve) => { finishMe = () => resolve(reply(401, { error: 'Token expired' })); });
    });
    const { store, unsubscribe } = appStore({ meTimeoutMs: 2000 });
    const check = store.validate();
    await new Promise((r) => setTimeout(r, 10));
    await session.saveTokens({ token: 'issued', refreshToken: 'ir' }, { signIn: true, attempt: session.beginSignIn() }); // the person logs in meanwhile
    finishMe(); // the old call now fails, and its refresh is refused
    await check;
    expect(store.getStatus()).toBe('authed'); // still signed in
    expect(SecureStore.__memory.get('humancare_token')).toBe('issued'); // the new tokens survived
    expect(navReplace).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('the saved session is checked with the server', () => {
  test('4. a valid saved session', async () => {
    save('good', 'r');
    global.fetch.mockResolvedValue(reply(200, ME));
    const { store, seen, unsubscribe } = appStore();
    await store.validate();
    expect(seen).toEqual(['authed+me']);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer good');
    unsubscribe();
  });

  test('6. a rejected refresh token signs out, clears the tokens, and never grants access', async () => {
    save('expired', 'bad-refresh');
    global.fetch.mockImplementation(async (url) => (String(url).endsWith('/auth/refresh') ? reply(401, { error: 'Invalid or expired refresh token' }) : reply(401, { error: 'Token expired' })));
    const { store, seen, unsubscribe } = appStore();
    await store.validate();
    expect(store.getStatus()).toBe('anon');
    expect(seen).not.toContain('authed');
    expect(SecureStore.__memory.size).toBe(0);
    expect(navReplace).toHaveBeenCalledTimes(1);
    expect(navReplace).toHaveBeenCalledWith('/login');
    unsubscribe();
  });

  test.each([[401]])('7. a forged or revoked access token (%i) is refused, whatever is in storage', async (status) => {
    save('forged', 'also-forged');
    global.fetch.mockImplementation(async (url) => (String(url).endsWith('/auth/refresh') ? reply(401, { error: 'Invalid or expired refresh token' }) : reply(status, { error: 'Invalid token' })));
    const { store, unsubscribe } = appStore();
    await store.validate();
    expect(store.getStatus()).toBe('anon');
    expect(decide('anon')).toBe('redirect');
    unsubscribe();
  });

  test('a 403 from /auth/me is not a refusal of the session: nothing granted, tokens kept, retry offered', async () => {
    save('good', 'r');
    global.fetch.mockResolvedValue(reply(403, { error: 'Not authorized for this action' }));
    const { store, seen, unsubscribe } = appStore();
    await store.validate();
    expect(store.getStatus()).toBe('unreachable');
    expect(seen).not.toContain('authed');
    expect(seen).not.toContain('anon');
    expect(SecureStore.__memory.get('humancare_token')).toBe('good');
    unsubscribe();
  });

  test('8. the network or the server is unavailable: nothing granted, tokens kept, retry offered', async () => {
    save('good', 'r');
    global.fetch.mockRejectedValue(new TypeError('Network request failed'));
    const { store, seen, unsubscribe } = appStore();
    await store.validate();
    expect(store.getStatus()).toBe('unreachable');
    expect(guard.guardDecision({ pathname: '/home', status: 'unreachable' })).toEqual({ action: 'retry', reason: 'network' });
    expect(SecureStore.__memory.get('humancare_token')).toBe('good');
    expect(seen).not.toContain('authed');
    // ...and a server error (500) is the same
    global.fetch.mockResolvedValue(reply(500, { error: 'boom' }));
    await store.retry();
    expect(store.getStatus()).toBe('unreachable');
    // a retry that finds the server back grants access
    global.fetch.mockResolvedValue(reply(200, ME));
    await store.retry();
    expect(store.getStatus()).toBe('authed');
    unsubscribe();
  });

  test('a server that never answers does not leave the app loading forever', async () => {
    save('good', 'r');
    global.fetch.mockImplementation(() => new Promise(() => {}));
    const { store, unsubscribe } = appStore({ meTimeoutMs: 30 });
    await store.validate();
    expect(store.getStatus()).toBe('unreachable');
    unsubscribe();
  });

  test('9. a secure storage failure grants nothing and does not stay loading', async () => {
    SecureStore.__failReads.on = true;
    const { store, seen, unsubscribe } = appStore();
    await store.validate();
    expect(store.getStatus()).toBe('error');
    expect(guard.guardDecision({ pathname: '/profile', status: 'error' })).toEqual({ action: 'retry', reason: 'storage' });
    expect(seen).toEqual(['error']);
    expect(global.fetch).not.toHaveBeenCalled();
    // once storage works again, a retry finishes the check
    SecureStore.__failReads.on = false;
    save('good', 'r');
    global.fetch.mockResolvedValue(reply(200, ME));
    await store.retry();
    expect(store.getStatus()).toBe('authed');
    unsubscribe();
  });

  test('9. secure storage that hangs is given up on', async () => {
    SecureStore.__failReads.hang = true;
    const { store, unsubscribe } = appStore({ tokenTimeoutMs: 30 });
    await store.validate();
    expect(store.getStatus()).toBe('error');
    unsubscribe();
  });

  test('storage failing after the server call (to tell a refusal from an outage) is still an error, not access', async () => {
    let reads = 0;
    const out = await checkSession({
      getToken: async () => { reads += 1; if (reads === 1) return 'tok'; throw new Error('Keychain is locked'); },
      fetchMe: async () => { throw new Error('Network request failed'); },
      tokenTimeoutMs: 40,
    });
    expect(out).toEqual({ status: 'error' });
  });
});

describe('Findings 2: overlapping checks', () => {
  test('10. an older check that finishes last cannot overwrite a newer retry', async () => {
    const answers = [];
    const store = createAuthStore({
      getToken: async () => 'tok',
      fetchMe: () => new Promise((resolve, reject) => answers.push({ resolve, reject })),
      tokenTimeoutMs: 100,
      meTimeoutMs: 2000,
    });
    const first = store.validate();
    await new Promise((r) => setTimeout(r, 5));
    const second = store.retry(); // a newer check
    await new Promise((r) => setTimeout(r, 5));
    answers[1].resolve(ME); // the newer one answers first: authed
    await second;
    expect(store.getStatus()).toBe('authed');
    const stale = Object.assign(new Error('refused'), { status: 401 });
    answers[0].reject(stale); // the older one answers later: refused
    await first;
    expect(store.getStatus()).toBe('authed'); // the outdated answer was dropped
  });

  test('10. the reverse order: an older success cannot overwrite a newer refusal', async () => {
    const answers = [];
    const store = createAuthStore({
      getToken: async () => 'tok',
      fetchMe: () => new Promise((resolve, reject) => answers.push({ resolve, reject })),
      tokenTimeoutMs: 100,
      meTimeoutMs: 2000,
    });
    const first = store.validate();
    await new Promise((r) => setTimeout(r, 5));
    const second = store.retry();
    await new Promise((r) => setTimeout(r, 5));
    answers[1].reject(Object.assign(new Error('refused'), { status: 401 }));
    await second;
    expect(store.getStatus()).toBe('anon');
    answers[0].resolve(ME);
    await first;
    expect(store.getStatus()).toBe('anon');
  });

  test('repeated retries all end on the answer of the last one', async () => {
    let n = 0;
    const store = createAuthStore({
      getToken: async () => 'tok',
      fetchMe: async () => { n += 1; if (n < 3) throw new TypeError('down'); return ME; },
      tokenTimeoutMs: 100,
      meTimeoutMs: 1000,
    });
    await store.retry();
    expect(store.getStatus()).toBe('unreachable');
    await store.retry();
    expect(store.getStatus()).toBe('unreachable');
    await store.retry();
    expect(store.getStatus()).toBe('authed');
  });

  test('11. signing out while /auth/me is running: the late success does not sign the person back in', async () => {
    save('good', 'r');
    let finishMe;
    global.fetch.mockImplementation(() => new Promise((resolve) => { finishMe = () => resolve(reply(200, ME)); }));
    const { store, seen, unsubscribe } = appStore({ meTimeoutMs: 2000 });
    const check = store.validate();
    await new Promise((r) => setTimeout(r, 10));
    await session.clearTokens(); // sign out
    expect(store.getStatus()).toBe('anon');
    finishMe();
    await check;
    expect(store.getStatus()).toBe('anon');
    expect(seen).toEqual(['anon']);
    expect(decide(store.getStatus())).toBe('redirect');
    unsubscribe();
  });
});

describe('wiring', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  test('AppContext uses the store and no longer treats a token event as a sign-in', () => {
    const ctx = read('../../state/AppContext.js');
    expect(ctx).toContain('createAuthStore(');
    expect(ctx).toContain('authStore.signedIn()');
    expect(ctx).toContain('authStore.signedOut()');
    expect(ctx).not.toContain('authEpoch');
  });
  test('the cover screen tells a storage failure from a network failure', () => {
    const gate = read('../../components/AuthGate.js');
    expect(gate).toContain("decision.reason === 'storage'");
  });
});
