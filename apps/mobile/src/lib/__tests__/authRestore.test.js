/* global describe, test, expect, jest, beforeEach, afterEach */
// Phase 3: the debounced "check the session again once the connection is back" logic (lib/authRestore.js), the Can't Connect view rules (lib/cantConnect.js)
// and where the splash goes (lib/splash.js). Pure; no network.
const { AUTH_RETRY_DEBOUNCE_MS, createRestoreRetrier } = require('../authRestore');
const { CANT_CONNECT_PATH, BODY_KEY, CANT_CONNECT_TEXT, cantConnectText, cantConnectView, unreachableReason } = require('../cantConnect');
const { CANT_CONNECT_ROUTE, HOME_ROUTE, START_ROUTE, MIN_SPLASH_MS, SESSION_TIMEOUT_MS, destinationFor, startupDestination, splashDecision } = require('../splash');

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('createRestoreRetrier', () => {
  const build = () => {
    const retry = jest.fn();
    const retrier = createRestoreRetrier({ retry });
    return { retrier, retry };
  };
  // The app's own order at start-up: the auth status first, then the network state.
  const start = (t, { auth = 'unreachable', net = 'offline', count = 0 } = {}) => {
    t.retrier.observeAuth('loading');
    t.retrier.observeAuth(auth);
    t.retrier.observeNetwork({ status: net, restoredCount: count });
  };

  test('one retry, after the debounce, when the connection returns and the session is unreachable', () => {
    const t = build();
    start(t);
    t.retrier.observeNetwork({ status: 'online', restoredCount: 1 });
    expect(t.retry).not.toHaveBeenCalled();
    expect(t.retrier.isPending()).toBe(true);
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS - 1);
    expect(t.retry).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(t.retry).toHaveBeenCalledTimes(1);
    expect(t.retrier.isPending()).toBe(false);
  });
  test('the debounce is short enough to feel immediate and long enough to absorb a flap', () => {
    expect(AUTH_RETRY_DEBOUNCE_MS).toBeGreaterThanOrEqual(500);
    expect(AUTH_RETRY_DEBOUNCE_MS).toBeLessThanOrEqual(5000);
  });
  test('a flapping connection (back, gone, back, gone, back) is ONE retry', () => {
    const t = build();
    start(t);
    t.retrier.observeNetwork({ status: 'online', restoredCount: 1 });
    jest.advanceTimersByTime(400);
    t.retrier.observeNetwork({ status: 'offline', restoredCount: 1 });
    expect(t.retrier.isPending()).toBe(false); // down again before the debounce ended
    t.retrier.observeNetwork({ status: 'online', restoredCount: 2 });
    jest.advanceTimersByTime(400);
    t.retrier.observeNetwork({ status: 'serverDown', restoredCount: 2 });
    t.retrier.observeNetwork({ status: 'online', restoredCount: 3 });
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS * 5);
    expect(t.retry).toHaveBeenCalledTimes(1);
  });
  test('two restorations inside the debounce are one retry (the timer restarts, never doubles)', () => {
    const t = build();
    start(t);
    t.retrier.observeNetwork({ status: 'online', restoredCount: 1 });
    t.retrier.observeNetwork({ status: 'online', restoredCount: 2 });
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS * 5);
    expect(t.retry).toHaveBeenCalledTimes(1);
  });
  test('going offline or down before the retry cancels it', () => {
    for (const down of ['offline', 'serverDown']) {
      const t = build();
      start(t);
      t.retrier.observeNetwork({ status: 'online', restoredCount: 1 });
      t.retrier.observeNetwork({ status: down, restoredCount: 1 });
      jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS * 5);
      expect(t.retry).not.toHaveBeenCalled();
    }
  });
  test('the retry re-checks at the moment it fires: it does not run if the status is no longer "unreachable"', () => {
    const t = build();
    start(t);
    t.retrier.observeNetwork({ status: 'online', restoredCount: 1 });
    t.retrier.observeAuth('authed'); // something else settled it
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS * 5);
    expect(t.retry).not.toHaveBeenCalled();
  });
  test.each(['authed', 'anon', 'error', 'loading'])('a restoration while the status is %s does nothing', (auth) => {
    const t = build();
    start(t, { auth });
    t.retrier.observeNetwork({ status: 'online', restoredCount: 1 });
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS * 5);
    expect(t.retry).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  test('a manual retry ("Try again") while one is waiting replaces it: never two checks', () => {
    const t = build();
    start(t);
    t.retrier.observeNetwork({ status: 'online', restoredCount: 1 });
    t.retrier.observeAuth('loading'); // the person tapped Try again: a check is running
    expect(t.retrier.isPending()).toBe(false);
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS * 5);
    expect(t.retry).not.toHaveBeenCalled();
  });
  test('the retry\'s own failure does not start another: it needs a NEW restoration (no loop)', () => {
    const t = build();
    start(t);
    t.retrier.observeNetwork({ status: 'online', restoredCount: 1 });
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS);
    expect(t.retry).toHaveBeenCalledTimes(1);
    t.retrier.observeAuth('loading'); // what the real retry does
    t.retrier.observeAuth('unreachable'); // and it failed again
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS * 20);
    expect(t.retry).toHaveBeenCalledTimes(1);
    t.retrier.observeNetwork({ status: 'offline', restoredCount: 1 });
    t.retrier.observeNetwork({ status: 'online', restoredCount: 2 }); // a new restoration
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS);
    expect(t.retry).toHaveBeenCalledTimes(2);
  });
  test('a check that was RUNNING when the connection returned and then failed is still retried once', () => {
    const t = build();
    t.retrier.observeAuth('loading');
    t.retrier.observeNetwork({ status: 'offline', restoredCount: 0 });
    t.retrier.observeNetwork({ status: 'online', restoredCount: 1 }); // back while the check runs: nothing yet
    expect(t.retrier.isPending()).toBe(false);
    t.retrier.observeAuth('unreachable'); // the check ended unreachable AFTER the connection came back
    expect(t.retrier.isPending()).toBe(true);
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS);
    expect(t.retry).toHaveBeenCalledTimes(1);
  });
  test('a check that fails while the connection is still down is not retried until it returns', () => {
    const t = build();
    t.retrier.observeAuth('loading');
    t.retrier.observeNetwork({ status: 'offline', restoredCount: 0 });
    t.retrier.observeAuth('unreachable');
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS * 20);
    expect(t.retry).not.toHaveBeenCalled();
  });
  test('the first network reading is only a starting point: a count from before is not a restoration', () => {
    const t = build();
    t.retrier.observeAuth('loading');
    t.retrier.observeAuth('unreachable');
    t.retrier.observeNetwork({ status: 'online', restoredCount: 4 });
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS * 5);
    expect(t.retry).not.toHaveBeenCalled();
  });
  test('"slow" is not an outage: a retry still goes ahead', () => {
    const t = build();
    start(t);
    t.retrier.observeNetwork({ status: 'slow', restoredCount: 1 });
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS);
    expect(t.retry).toHaveBeenCalledTimes(1);
  });
  test('dispose() cancels a waiting retry and leaves no timer', () => {
    const t = build();
    start(t);
    t.retrier.observeNetwork({ status: 'online', restoredCount: 1 });
    t.retrier.dispose();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(AUTH_RETRY_DEBOUNCE_MS * 5);
    expect(t.retry).not.toHaveBeenCalled();
  });
});

describe('where the splash goes (startupDestination, splashDecision)', () => {
  test.each([
    ['authed', true, HOME_ROUTE],
    ['authed', false, HOME_ROUTE],
    ['anon', false, START_ROUTE],
    ['anon', true, START_ROUTE],
    ['unreachable', true, CANT_CONNECT_ROUTE], // a returning person: a saved session the server could not check
    ['unreachable', false, START_ROUTE], // a new person: nothing saved
    ['unreachable', null, START_ROUTE],
    ['unreachable', undefined, START_ROUTE],
    ['error', true, START_ROUTE], // a storage error is NOT a network problem: it never takes the Can't Connect road
    ['error', null, START_ROUTE],
  ])('%s with savedSession %s -> %s', (status, savedSession, expected) => {
    expect(startupDestination({ status, savedSession })).toBe(expected);
  });
  test("only a validated session goes Home; destinationFor itself is unchanged", () => {
    expect(destinationFor('authed')).toBe(HOME_ROUTE);
    for (const status of ['anon', 'unreachable', 'error', 'loading']) expect(destinationFor(status)).toBe(START_ROUTE);
    expect(CANT_CONNECT_ROUTE).toBe('/cant-connect');
    expect(CANT_CONNECT_ROUTE).toBe(CANT_CONNECT_PATH);
  });
  const at = (ms, args) => splashDecision({ ...args, minElapsed: ms >= MIN_SPLASH_MS, timedOut: ms >= SESSION_TIMEOUT_MS });
  test('the minimum splash time is unchanged: nothing leaves before 3 s, whatever the state', () => {
    for (const status of ['authed', 'anon', 'unreachable', 'error', 'loading']) for (const savedSession of [true, false, null]) {
      expect(at(MIN_SPLASH_MS - 1, { status, savedSession })).toBeNull();
    }
    expect([MIN_SPLASH_MS, SESSION_TIMEOUT_MS]).toEqual([3000, 4000]);
  });
  test('a saved session that is unreachable goes to Can\'t Connect at 3 s; a new person goes to Getting Started', () => {
    expect(at(3000, { status: 'unreachable', savedSession: true })).toBe('/cant-connect');
    expect(at(3000, { status: 'unreachable', savedSession: false })).toBe('/welcome');
  });
  test('still checking: a saved session keeps the splash (no Connecting screen) for as long as the check runs; anything else goes to Getting Started at 4 s', () => {
    expect(at(3500, { status: 'loading', savedSession: true })).toBeNull();
    expect(at(4000, { status: 'loading', savedSession: true })).toBeNull();
    expect(at(60000, { status: 'loading', savedSession: true })).toBeNull(); // the check has its own time limit (lib/api.js), so it ends with an answer
    expect(at(4000, { status: 'loading', savedSession: false })).toBe('/welcome');
    expect(at(4000, { status: 'loading', savedSession: null })).toBe('/welcome');
    expect(at(4000, { status: 'loading' })).toBe('/welcome');
  });
  test('a quick answer is not stretched, and the splash still goes only once', () => {
    expect(at(3000, { status: 'authed', savedSession: true })).toBe('/home');
    expect(splashDecision({ status: 'unreachable', savedSession: true, minElapsed: true, timedOut: true, navigated: true })).toBeNull();
  });
});

describe('cantConnectView', () => {
  test.each([
    ['loading', 'connecting', null],
    [undefined, 'connecting', null],
    [null, 'connecting', null],
    ['something-else', 'connecting', null], // nothing is claimed or granted on a guess
    ['unreachable', 'unreachable', null],
    ['error', 'storage', null],
    ['authed', 'leave', '/home'],
    ['anon', 'leave', '/login'],
  ])('%s -> %s (leaves to %s)', (authStatus, mode, leaveTo) => {
    expect(cantConnectView({ authStatus })).toEqual({ mode, leaveTo });
  });
  test('a storage problem has its own wording, never the network wording', () => {
    expect(CANT_CONNECT_TEXT.cc_storage_title).toMatch(/saved session/);
    expect(CANT_CONNECT_TEXT.cc_storage_body).toMatch(/phone, not the connection/);
    expect(CANT_CONNECT_TEXT.cc_title).not.toBe(CANT_CONNECT_TEXT.cc_storage_title);
  });
  test('the reason follows the network state', () => {
    expect(unreachableReason({ isOffline: true })).toBe('offline');
    expect(unreachableReason({ isServerDown: true })).toBe('server');
    expect(unreachableReason({})).toBe('generic');
    expect(unreachableReason(null)).toBe('generic');
    for (const reason of ['offline', 'server', 'generic']) expect(CANT_CONNECT_TEXT[BODY_KEY[reason]]).toBeDefined();
  });
  test('texts: a translation wins, the English default fills in (no key is ever shown to a person)', () => {
    expect(cantConnectText((k) => k, 'cc_title')).toBe("Can't connect");
    expect(cantConnectText((k) => (k === 'cc_title' ? 'Verbindung fehlgeschlagen' : k), 'cc_title')).toBe('Verbindung fehlgeschlagen');
    for (const key of Object.keys(CANT_CONNECT_TEXT)) expect(cantConnectText((k) => k, key)).toBe(CANT_CONNECT_TEXT[key]);
  });
  test('the saved session being safe is its own pill (it is: nothing is cleared by a network failure), not part of the body', () => {
    expect(CANT_CONNECT_TEXT.cc_safe).toMatch(/safe/);
    for (const key of Object.values(BODY_KEY)) expect(CANT_CONNECT_TEXT[key]).not.toMatch(/safe/);
  });
});
