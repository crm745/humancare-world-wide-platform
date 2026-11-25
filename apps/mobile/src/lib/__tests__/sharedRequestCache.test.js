/* global describe, test, expect, __dirname, jest, beforeEach, afterEach */
// The shared request-list cache: timestamps, the session counter that drops answers from a finished session, Home seeding the list for the two tabs, and the opt-in freshness window of useResource.
const fs = require('fs');
const path = require('path');

jest.mock('../api', () => ({ apiGet: jest.fn() }));

const cacheLib = require('../screenCache');
const { getCached, getCachedAt, sessionEpoch, setCached, clearCache } = cacheLib;
const { MY_REQUESTS_KEY, MY_REQUESTS_FRESH_MS, seedMyRequests } = require('../myRequestsResource');

const SRC = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8').split('\r\n').join('\n');
const row = (id) => ({ id, referenceNumber: `REQ-${1000 + id}`, serviceType: 'x', status: 'submitted', createdAt: '2026-11-01T10:00:00.000Z' });

beforeEach(() => { clearCache(); jest.useFakeTimers(); jest.setSystemTime(new Date('2026-11-25T10:00:00.000Z')); });
afterEach(() => { jest.useRealTimers(); });

describe('screenCache keeps getCached as it was and adds a timestamp', () => {
  test('getCached returns the stored value, or undefined when nothing is stored (also for a stored null or false)', () => {
    expect(getCached('a')).toBeUndefined();
    setCached('a', { n: 1 });
    expect(getCached('a')).toEqual({ n: 1 });
    setCached('b', null);
    expect(getCached('b')).toBeNull();
    setCached('c', false);
    expect(getCached('c')).toBe(false);
  });
  test('getCachedAt is when the value was stored, 0 when there is none, and a newer write moves it', () => {
    expect(getCachedAt('a')).toBe(0);
    setCached('a', 1);
    const first = getCachedAt('a');
    expect(first).toBe(Date.now());
    jest.advanceTimersByTime(5000);
    setCached('a', 2);
    expect(getCachedAt('a')).toBe(first + 5000);
  });
  test('clearCache empties everything', () => {
    setCached('a', 1);
    clearCache();
    expect(getCached('a')).toBeUndefined();
    expect(getCachedAt('a')).toBe(0);
  });
});

describe('the session counter', () => {
  test('a write made with the counter read before a sign-out is refused, and nothing is stored', () => {
    const before = sessionEpoch();
    clearCache(); // sign-out (or an account switch)
    expect(sessionEpoch()).toBe(before + 1);
    expect(setCached('my-requests', [row(1)], { epoch: before })).toBe(false);
    expect(getCached('my-requests')).toBeUndefined();
  });
  test('a write made inside the same session is stored, and a write without a counter is as before', () => {
    expect(setCached('a', 1, { epoch: sessionEpoch() })).toBe(true);
    expect(getCached('a')).toBe(1);
    expect(setCached('b', 2)).toBe(true);
    expect(getCached('b')).toBe(2);
  });
  test('an old account\'s answer cannot reach the next account, even when it lands after the next sign-in', () => {
    const epochOfAccountA = sessionEpoch();
    clearCache(); // A signs out
    clearCache(); // B signs in
    setCached('my-requests', [row(2)], { epoch: sessionEpoch() }); // B's own load
    expect(setCached('my-requests', [row(1)], { epoch: epochOfAccountA })).toBe(false); // A's late answer
    expect(getCached('my-requests').map((r) => r.id)).toEqual([2]);
  });
  test('the counter only moves on clearCache (a token refresh does not announce a session change, lib/session.js)', () => {
    const start = sessionEpoch();
    setCached('a', 1);
    getCached('a');
    expect(sessionEpoch()).toBe(start);
  });
});

describe('Home seeds the list for My Requests and Tracking', () => {
  test('a successful Home load stores the list items under the shared key', () => {
    expect(seedMyRequests([row(1), row(2)], sessionEpoch())).toBe(true);
    const stored = getCached(MY_REQUESTS_KEY);
    expect(stored.map((r) => r.rawId)).toEqual([1, 2]);
    expect(stored[0].raw).toEqual(row(1)); // list items, with the request as the API sent it (what the card needs)
    expect(getCachedAt(MY_REQUESTS_KEY)).toBe(Date.now());
  });
  test('a list that arrives after the person signed out is not stored', () => {
    const before = sessionEpoch();
    clearCache();
    expect(seedMyRequests([row(1)], before)).toBe(false);
    expect(getCached(MY_REQUESTS_KEY)).toBeUndefined();
  });
  test('the window is ten seconds', () => {
    expect(MY_REQUESTS_FRESH_MS).toBe(10000);
  });
});

describe('useResource: the answer of a finished session is dropped, and freshness applies only to the opening load', () => {
  const hook = read('lib/useResource.js');
  test('the counter is read before the request and checked when the answer is written', () => {
    expect(hook).toContain("import { getCached, getCachedAt, sessionEpoch, setCached } from './screenCache';");
    expect(hook.indexOf('const epoch = sessionEpoch();')).toBeLessThan(hook.indexOf('await fetcherRef.current()'));
    expect(hook).toContain('if (!setCached(forKey, next, { epoch })) return undefined;');
    // a dropped answer touches no state: it comes before setData / setError / dataRef
    expect(hook.indexOf('if (!setCached(forKey, next, { epoch })) return undefined;')).toBeLessThan(hook.indexOf('dataRef.current = next;'));
  });
  test('freshMs is opt-in (0 by default) and is read in the opening effect only', () => {
    expect(hook).toContain('enabled = true, freshMs = 0 })');
    expect(hook).toContain('const fresh = freshMs > 0 && cached !== undefined && Date.now() - getCachedAt(key) < freshMs;');
    expect(hook).toContain('if (enabled && !fresh) reload();');
    const outsideOpening = hook.slice(hook.indexOf('const onRefresh = useCallback'));
    expect(outsideOpening).not.toContain('freshMs');
    expect(hook.slice(hook.indexOf('const reload = useCallback'), hook.indexOf('useEffect(() => {\n    keyRef.current = key;'))).not.toContain('freshMs');
  });
  test('reload, pull-to-refresh, retry and connection restore all go through run/reload, never the freshness check', () => {
    expect(hook).toContain('if (next.retry) reload();'); // connection restored
    expect(hook).toContain('const next = await run(keyRef.current);'); // pull
    expect(hook).toContain('return run(forKey).catch(');
  });
  test('only the two request tabs opt in; every other screen loads as before', () => {
    expect(read('app/(tabs)/my-requests.js')).toContain('freshMs: MY_REQUESTS_FRESH_MS,');
    expect(read('app/(tabs)/active-tracking.js')).toContain('freshMs: MY_REQUESTS_FRESH_MS,');
    for (const file of ['app/(tabs)/home.js', 'app/request-tracking.js', 'app/request-details.js', 'app/my-documents.js', 'app/notifications.js', 'app/(tabs)/profile.js']) {
      expect({ file, uses: /freshMs/.test(read(file)) }).toEqual({ file, uses: false });
    }
  });
  test('the focus refresh keeps asking the server: useRefreshOnFocus calls reload', () => {
    const focus = read('lib/useTabRefresh.js');
    expect(focus).toContain('reload();');
    expect(focus).not.toContain('freshMs');
  });
});

describe('Home keeps its own data: the notification dot is independent of the shared list', () => {
  const home = read('app/(tabs)/home.js');
  test('Home still loads under its own key, with the notifications call, and the dot reads only that', () => {
    expect(home).toContain("key: 'home',");
    expect(home).toContain("apiGet('/notifications?unreadOnly=true')");
    expect(home).toContain('hasUnread: unread.status === \'fulfilled\' && unread.value.notifications.length > 0');
    expect(home).toContain('const hasUnread = home ? home.hasUnread : false;');
  });
  test('seeding happens only after the list call succeeded, with the counter read before the calls', () => {
    expect(home.indexOf('const epoch = sessionEpoch();')).toBeLessThan(home.indexOf("apiGet('/requests/me')"));
    expect(home.indexOf("if (mine.status === 'rejected') throw mine.reason;")).toBeLessThan(home.indexOf('seedMyRequests(mine.value.requests, epoch);'));
  });
  test('the cache is still cleared on every sign-in and sign-out', () => {
    expect(read('state/AppContext.js')).toContain('onSessionChange((signedIn) => { clearCache();');
  });
});
