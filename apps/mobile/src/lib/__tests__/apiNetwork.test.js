/* global describe, test, expect, jest, beforeEach, afterEach */
// Phase 1 (network foundation): the real api.js and session.js, on an in-memory secure store and a fake fetch. What a network failure, a timeout and a
// 5xx come to; that a write that got no answer is an UNKNOWN outcome and is never sent again by itself; and that none of it can sign anyone out.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), createDownloadResumable: jest.fn(), deleteAsync: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));
jest.mock('expo-secure-store', () => {
  const memory = new Map();
  return {
    __memory: memory,
    setItemAsync: jest.fn(async (key, value) => { memory.set(key, value); }),
    deleteItemAsync: jest.fn(async (key) => { memory.delete(key); }),
    getItemAsync: jest.fn(async (key) => (memory.has(key) ? memory.get(key) : null)),
  };
});

const SecureStore = require('expo-secure-store');
const { navReplace } = require('../nav');
const session = require('../session');
const api = require('../api');
const guard = require('../authGuard');
const { setApiOutcomeListener } = require('../networkReporter');
const { classifyApiError, isOutcomeUnknown, NETWORK_READ_MESSAGE, NETWORK_WRITE_MESSAGE, TIMEOUT_WRITE_MESSAGE } = require('../apiErrors');

const T = 'humancare_token';
const R = 'humancare_refresh_token';
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seed = (token = 'tok', refresh = 'tok-r') => { SecureStore.__memory.set(T, token); SecureStore.__memory.set(R, refresh); };
const stored = () => ({ token: SecureStore.__memory.get(T), refresh: SecureStore.__memory.get(R) });
// A fetch that never answers but honours the abort signal, like the real one.
const hang = (_url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
});
const offline = () => { throw new TypeError('Network request failed'); };

let outcomes;

beforeEach(() => {
  jest.clearAllMocks();
  SecureStore.__memory.clear();
  session.setStorageTimeoutForTests(500);
  session.resetSessionStateForTests();
  api.setRefreshTimeoutForTests(500);
  api.setWriteTimeoutForTests(60);
  guard.setApiAuthStatus('authed');
  guard.setCurrentPath('/home');
  global.fetch = jest.fn();
  outcomes = [];
  setApiOutcomeListener((outcome) => outcomes.push(outcome));
  seed();
});

afterEach(() => { setApiOutcomeListener(null); });

describe('a read with no connection', () => {
  test('is a user-safe, retry-safe error, never the raw "Network request failed"', async () => {
    global.fetch.mockImplementation(offline);
    const err = await api.apiGet('/requests/me').catch((e) => e);
    expect(err.message).toBe(NETWORK_READ_MESSAGE);
    expect(err.message).not.toMatch(/Network request failed/);
    expect(err).toMatchObject({ code: 'network', failure: 'network', outcomeUnknown: false });
    expect(err.status).toBeUndefined(); // "no answer": code that tells that from a refusal keeps working
    expect(classifyApiError(err)).toBe('network');
    expect(isOutcomeUnknown(err)).toBe(false);
  });
  test('the person stays signed in: tokens kept, no redirect', async () => {
    global.fetch.mockImplementation(offline);
    await api.apiGet('/requests/me').catch(() => {});
    expect(stored()).toEqual({ token: 'tok', refresh: 'tok-r' });
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('is reported to the network service as "network"', async () => {
    global.fetch.mockImplementation(offline);
    await api.apiGet('/requests/me').catch(() => {});
    expect(outcomes).toEqual(['network']);
  });
});

describe('a write with no connection: the outcome is UNKNOWN', () => {
  test('POST', async () => {
    global.fetch.mockImplementation(offline);
    const err = await api.apiPost('/requests', { serviceType: 'x' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'network', outcomeUnknown: true });
    expect(err.message).toBe(NETWORK_WRITE_MESSAGE);
    expect(isOutcomeUnknown(err)).toBe(true);
  });
  test('PATCH', async () => {
    global.fetch.mockImplementation(offline);
    const err = await api.apiPatch('/auth/me', { name: 'A' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'network', outcomeUnknown: true });
  });
  test('is sent EXACTLY ONCE: nothing resends it, then or later', async () => {
    global.fetch.mockImplementation(offline);
    await api.apiPost('/requests', { serviceType: 'x' }).catch(() => {});
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await wait(150);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  test('the person stays signed in', async () => {
    global.fetch.mockImplementation(offline);
    await api.apiPost('/requests', {}).catch(() => {});
    expect(stored()).toEqual({ token: 'tok', refresh: 'tok-r' });
    expect(navReplace).not.toHaveBeenCalled();
  });
});

describe('a write that gets no answer in time', () => {
  test('ends as a timeout with an unknown outcome, after the bounded wait', async () => {
    global.fetch.mockImplementation(hang);
    const started = Date.now();
    const err = await api.apiPost('/requests', { serviceType: 'x' }).catch((e) => e);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(err).toMatchObject({ code: 'timeout', failure: 'timeout', outcomeUnknown: true });
    expect(err.message).toBe(TIMEOUT_WRITE_MESSAGE);
    expect(classifyApiError(err)).toBe('timeout');
  });
  test('PATCH too', async () => {
    global.fetch.mockImplementation(hang);
    const err = await api.apiPatch('/auth/me', {}).catch((e) => e);
    expect(err).toMatchObject({ code: 'timeout', outcomeUnknown: true });
  });
  test('is NOT sent again, and the person stays signed in', async () => {
    global.fetch.mockImplementation(hang);
    await api.apiPost('/requests', {}).catch(() => {});
    await wait(150);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual({ token: 'tok', refresh: 'tok-r' });
    expect(navReplace).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['timeout']);
  });
  test('the request itself is aborted when the time is up (the connection is not left open)', async () => {
    let signal;
    global.fetch.mockImplementation((url, init) => { signal = init.signal; return hang(url, init); });
    await api.apiPost('/requests', {}).catch(() => {});
    expect(signal.aborted).toBe(true);
  });
  test('the answer began but its body never finished in time: an unknown outcome, NOT a success with an empty body', async () => {
    global.fetch.mockImplementation((url, init) => Promise.resolve({
      ok: true,
      status: 201,
      json: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    }));
    const err = await api.apiPost('/requests', {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 'timeout', outcomeUnknown: true });
  });
  test('a fast answer is untouched by the deadline, and the timer is cleared (it cannot abort a later request)', async () => {
    let signal;
    global.fetch.mockImplementation(async (url, init) => { signal = init.signal; return reply(201, { request: { id: 1 } }); });
    const out = await api.apiPost('/requests', {});
    expect(out).toEqual({ request: { id: 1 } });
    await wait(120); // longer than the 60 ms write deadline
    expect(signal.aborted).toBe(false);
  });
  test('time spent waiting for the session check does NOT count against the write', async () => {
    guard.setApiAuthStatus('loading');
    global.fetch.mockImplementation(async () => reply(201, { ok: true }));
    const call = api.apiPost('/requests', {});
    await wait(150); // longer than the write deadline: the call is still held, not sent
    expect(global.fetch).not.toHaveBeenCalled();
    guard.setApiAuthStatus('authed');
    await expect(call).resolves.toEqual({ ok: true });
  });
  test('the write deadline does not apply to reads: a GET slower than it still succeeds', async () => {
    global.fetch.mockImplementation(async () => { await wait(120); return reply(200, { requests: [] }); });
    await expect(api.apiGet('/requests/me')).resolves.toEqual({ requests: [] }); // slower than the 60 ms WRITE deadline, and fine
  });
});

describe('reads that time out', () => {
  test('apiGet keeps its message and code, and now says the read is safe to repeat', async () => {
    global.fetch.mockImplementation(hang);
    const err = await api.apiGet('/requests/me', { timeoutMs: 40 }).catch((e) => e);
    expect(err.message).toBe('The server took too long to answer. Please try again.');
    expect(err).toMatchObject({ code: 'timeout', failure: 'timeout', outcomeUnknown: false });
    expect(outcomes).toEqual(['timeout']);
    expect(stored()).toEqual({ token: 'tok', refresh: 'tok-r' });
    expect(navReplace).not.toHaveBeenCalled();
  });
});

describe('what an answer comes to', () => {
  test('a 5xx keeps the server\'s own message and status, is tagged "server", and signs nobody out', async () => {
    global.fetch.mockImplementation(async () => reply(503, { error: 'Service unavailable' }));
    const err = await api.apiPost('/requests', {}).catch((e) => e);
    expect(err).toMatchObject({ status: 503, message: 'Service unavailable', failure: 'server' });
    expect(err.outcomeUnknown).toBeUndefined(); // the server ANSWERED: it said no
    expect(classifyApiError(err)).toBe('server');
    expect(outcomes).toEqual(['server']);
    expect(stored()).toEqual({ token: 'tok', refresh: 'tok-r' });
    expect(navReplace).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  test('a 4xx refusal is "ok" for the network (the server is reachable) and keeps its shape', async () => {
    global.fetch.mockImplementation(async () => reply(400, { error: 'Bad field', code: 'invalid', data: 1 }));
    const err = await api.apiPost('/requests', {}).catch((e) => e);
    expect(err).toMatchObject({ status: 400, message: 'Bad field', code: 'invalid' });
    expect(err.failure).toBeUndefined();
    expect(outcomes).toEqual(['ok']);
  });
  test('a success is "ok"', async () => {
    global.fetch.mockImplementation(async () => reply(200, { a: 1 }));
    await expect(api.apiGet('/requests/me')).resolves.toEqual({ a: 1 });
    expect(outcomes).toEqual(['ok']);
  });
  test('the request is still sent as before: method, body, bearer token, JSON header', async () => {
    global.fetch.mockImplementation(async () => reply(201, {}));
    await api.apiPost('/requests', { serviceType: 'x' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/requests$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ serviceType: 'x' }));
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: 'Bearer tok' });
    expect(init.timeoutMs).toBeUndefined(); // the deadline is ours, not a fetch option
  });
});

describe("the caller's own cancel is not a network event", () => {
  test('stays an abort, is not reported, and the session check can still tell it apart', async () => {
    global.fetch.mockImplementation(hang);
    const controller = new AbortController();
    const call = api.apiGet('/auth/me', { signal: controller.signal, validation: true });
    await wait(10);
    controller.abort();
    const err = await call.catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(err.code).not.toBe('network');
    expect(outcomes).toEqual([]);
    expect(stored()).toEqual({ token: 'tok', refresh: 'tok-r' });
  });
});

describe('authentication safety (the existing rules, unchanged)', () => {
  test('401, then the refresh cannot reach the server: credentials kept, nobody redirected', async () => {
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) throw new TypeError('Network request failed');
      return reply(401, { error: 'expired' });
    });
    const err = await api.apiPost('/requests', {}).catch((e) => e);
    expect(err.code).toBe('network');
    expect(stored()).toEqual({ token: 'tok', refresh: 'tok-r' });
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('401, then the refresh answers 503: credentials kept', async () => {
    global.fetch.mockImplementation(async (url) => (String(url).endsWith('/auth/refresh') ? reply(503, {}) : reply(401, {})));
    await api.apiPost('/requests', {}).catch(() => {});
    expect(stored()).toEqual({ token: 'tok', refresh: 'tok-r' });
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('401, then the refresh times out: credentials kept', async () => {
    api.setRefreshTimeoutForTests(30);
    global.fetch.mockImplementation(async (url, init) => (String(url).endsWith('/auth/refresh') ? hang(url, init) : reply(401, {})));
    await api.apiPost('/requests', {}).catch(() => {});
    expect(stored()).toEqual({ token: 'tok', refresh: 'tok-r' });
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('ONLY a server-confirmed invalid refresh token ends the session', async () => {
    global.fetch.mockImplementation(async (url) => (String(url).endsWith('/auth/refresh') ? reply(401, { error: 'invalid' }) : reply(401, {})));
    const err = await api.apiPost('/requests', {}).catch((e) => e);
    expect(err.code).toBe('session_expired');
    expect(stored()).toEqual({ token: undefined, refresh: undefined });
    expect(navReplace).toHaveBeenCalledTimes(1);
  });
  test('a successful renewal still repeats the call once and saves the new tokens', async () => {
    let first = true;
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return reply(200, { token: 'new', refreshToken: 'new-r' });
      if (first) { first = false; return reply(401, {}); }
      return reply(201, { done: true });
    });
    await expect(api.apiPost('/requests', {})).resolves.toEqual({ done: true });
    expect(stored()).toEqual({ token: 'new', refresh: 'new-r' });
    const posts = global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/requests'));
    expect(posts).toHaveLength(2); // the one the server refused with 401 (it never acted on it) and its single repeat
  });
  test('a write with no connection is not "repeated after a refresh": no 401 means no repeat', async () => {
    global.fetch.mockImplementation(offline);
    await api.apiPost('/requests', {}).catch(() => {});
    expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(0);
  });
  test('protected calls are still refused without a validated session (nothing is sent)', async () => {
    guard.setApiAuthStatus('unreachable');
    const err = await api.apiPost('/requests', {}).catch((e) => e);
    expect(err.code).toBe('session_unverified');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('the reporter', () => {
  test('a listener that throws never fails an API call', async () => {
    setApiOutcomeListener(() => { throw new Error('bad listener'); });
    global.fetch.mockImplementation(async () => reply(200, { a: 1 }));
    await expect(api.apiGet('/requests/me')).resolves.toEqual({ a: 1 });
  });
  test('with no listener registered (the unit tests, startup) nothing happens', async () => {
    setApiOutcomeListener(null);
    global.fetch.mockImplementation(async () => reply(200, { a: 1 }));
    await expect(api.apiGet('/requests/me')).resolves.toEqual({ a: 1 });
  });
});
