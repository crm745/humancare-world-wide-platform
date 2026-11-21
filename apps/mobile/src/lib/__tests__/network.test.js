/* global describe, test, expect, jest, beforeEach, afterEach, __dirname */
// Phase 1 (network foundation): the network state machine (lib/network.js) with a fake NetInfo, a fake AppState and a fake /health. No device, no network.
const {
  NET, SLOW_PROBE_MS, MIN_PROBE_GAP_MS, FOREGROUND_STALE_MS, DEGRADED_RECHECK_MS, LINK_UP_RECHECK_MS, createNetworkStore, normalizeLink,
} = require('../network');

const OK = { ok: true, status: 200, ms: 120 };
const SLOW = { ok: true, status: 200, ms: SLOW_PROBE_MS + 1 };
const REFUSED = { ok: false, timedOut: false, ms: 20 }; // no answer, quickly
const TIMED_OUT = { ok: false, timedOut: true, ms: 6000 };
const BAD_GATEWAY = { ok: false, status: 502, ms: 40 };

const WIFI = { isConnected: true, isInternetReachable: true, type: 'wifi' };
const CELL = { isConnected: true, isInternetReachable: true, type: 'cellular' };
const WIFI_NO_INTERNET = { isConnected: true, isInternetReachable: false, type: 'wifi' };
const WIFI_UNSURE = { isConnected: true, isInternetReachable: null, type: 'wifi' };
const NONE = { isConnected: false, isInternetReachable: false, type: 'none' };

// A store wired to fakes. `results` is what /health answers, in order (the last one repeats).
function build(results = [OK]) {
  const linkSubs = new Set();
  const appSubs = new Set();
  let i = 0;
  const probe = jest.fn(async () => results[Math.min(i++, results.length - 1)]);
  const subscribeLink = jest.fn((cb) => { linkSubs.add(cb); return () => linkSubs.delete(cb); });
  const subscribeAppActive = jest.fn((cb) => { appSubs.add(cb); return () => appSubs.delete(cb); });
  const store = createNetworkStore({ probe, subscribeLink, subscribeAppActive });
  return {
    store, probe, subscribeLink, subscribeAppActive, linkSubs, appSubs,
    link: (state) => linkSubs.forEach((cb) => cb(state)),
    app: (active) => appSubs.forEach((cb) => cb(active)),
    setResults: (next) => { results = next; i = 0; },
  };
}
const settle = () => jest.advanceTimersByTimeAsync(0);
const advance = (ms) => jest.advanceTimersByTimeAsync(ms);
const status = (t) => t.store.getState().status;

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('normalizeLink', () => {
  test('keeps true / false and turns anything else into null (not known yet)', () => {
    expect(normalizeLink({ isConnected: true, isInternetReachable: undefined, type: 'wifi' })).toEqual({ isConnected: true, isInternetReachable: null, type: 'wifi' });
    expect(normalizeLink({ isConnected: false, isInternetReachable: false, type: 'none' })).toEqual({ isConnected: false, isInternetReachable: false, type: 'none' });
    expect(normalizeLink(null)).toEqual({ isConnected: null, isInternetReachable: null, type: 'unknown' });
    expect(normalizeLink({ isConnected: 'yes' })).toMatchObject({ isConnected: null });
  });
});

describe('start / stop: no duplicate listeners', () => {
  test('nothing happens before start()', () => {
    const t = build();
    expect(t.subscribeLink).not.toHaveBeenCalled();
    expect(t.subscribeAppActive).not.toHaveBeenCalled();
    expect(status(t)).toBe(NET.UNKNOWN);
  });
  test('start() twice attaches ONE link listener and ONE app listener', () => {
    const t = build();
    t.store.start();
    t.store.start();
    t.store.start();
    expect(t.subscribeLink).toHaveBeenCalledTimes(1);
    expect(t.subscribeAppActive).toHaveBeenCalledTimes(1);
    expect(t.linkSubs.size).toBe(1);
    expect(t.appSubs.size).toBe(1);
  });
  test('stop() removes both; stop() twice is harmless; start() again re-attaches exactly one', () => {
    const t = build();
    t.store.start();
    t.store.stop();
    t.store.stop();
    expect(t.linkSubs.size).toBe(0);
    expect(t.appSubs.size).toBe(0);
    t.store.start();
    expect(t.linkSubs.size).toBe(1);
    expect(t.appSubs.size).toBe(1);
  });
  test('React Strict Mode order (start, stop, start) leaves one listener of each', () => {
    const t = build();
    t.store.start();
    t.store.stop();
    t.store.start();
    expect(t.linkSubs.size).toBe(1);
    expect(t.appSubs.size).toBe(1);
  });
  test('after stop() nothing is probed and the state does not change', async () => {
    const t = build();
    t.store.start();
    t.store.stop();
    t.store.reportOutcome('network');
    await settle();
    expect(t.probe).not.toHaveBeenCalled();
    expect(status(t)).toBe(NET.UNKNOWN);
  });
});

describe('the link', () => {
  test('no link at all -> offline, and /health is NOT asked', async () => {
    const t = build();
    t.store.start();
    t.link(NONE);
    await settle();
    expect(status(t)).toBe(NET.OFFLINE);
    expect(t.probe).not.toHaveBeenCalled();
  });
  test('Wi-Fi connected, NetInfo says "internet not reachable", the backend answers -> ONLINE (/health IS asked)', async () => {
    const t = build();
    t.store.start();
    t.link(WIFI_NO_INTERNET);
    await settle();
    expect(t.probe).toHaveBeenCalledTimes(1);
    expect(status(t)).toBe(NET.ONLINE);
    expect(t.store.getState().link).toMatchObject({ isConnected: true, isInternetReachable: false });
  });
  test('a link that is up asks /health once and becomes online when it answers', async () => {
    const t = build([OK]);
    t.store.start();
    t.link(WIFI);
    expect(status(t)).toBe(NET.UNKNOWN); // not "online" until the backend has answered
    await settle();
    expect(t.probe).toHaveBeenCalledTimes(1);
    expect(status(t)).toBe(NET.ONLINE);
  });
  test('"unknown" is not offline: nothing is claimed before the first reading', () => {
    const t = build();
    t.store.start();
    expect(status(t)).toBe(NET.UNKNOWN);
  });
  test('reachability not known yet (null) still asks the backend', async () => {
    const t = build([OK]);
    t.store.start();
    t.link(WIFI_UNSURE);
    await settle();
    expect(status(t)).toBe(NET.ONLINE);
  });
  test('the same link state announced again does nothing (no second probe)', async () => {
    const t = build([OK]);
    t.store.start();
    t.link(WIFI);
    await settle();
    t.link(WIFI);
    t.link({ ...WIFI });
    await advance(MIN_PROBE_GAP_MS * 3);
    expect(t.probe).toHaveBeenCalledTimes(1);
  });
  test('Wi-Fi -> mobile data while online: one new probe, and the state stays online meanwhile', async () => {
    const t = build([OK]);
    t.store.start();
    t.link(WIFI);
    await settle();
    t.link(CELL);
    expect(status(t)).toBe(NET.ONLINE); // no flicker while it checks
    await settle();
    expect(t.probe).toHaveBeenCalledTimes(2);
    expect(status(t)).toBe(NET.ONLINE);
  });
  test('the link going down while a probe is in flight: the link wins, the late answer is ignored', async () => {
    let finish;
    const t = build();
    t.probe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    t.store.start();
    t.link(WIFI);
    t.link(NONE);
    expect(status(t)).toBe(NET.OFFLINE);
    finish(OK);
    await settle();
    expect(status(t)).toBe(NET.OFFLINE);
  });
});

describe('the backend (GET /health)', () => {
  test('the internet works but the backend does not answer -> serverDown (not offline)', async () => {
    const t = build([REFUSED]);
    t.store.start();
    t.link(WIFI);
    await settle();
    expect(status(t)).toBe(NET.SERVER_DOWN);
  });
  test('the backend answers 502/503 -> serverDown', async () => {
    const t = build([BAD_GATEWAY]);
    t.store.start();
    t.link(WIFI);
    await settle();
    expect(status(t)).toBe(NET.SERVER_DOWN);
  });
  test('a quick failure to connect with the link UP -> serverDown, never "no internet" (the phone is connected: the backend could not be reached)', async () => {
    const t = build([REFUSED]);
    t.store.start();
    t.link(WIFI_UNSURE);
    await settle();
    expect(status(t)).toBe(NET.SERVER_DOWN);
  });
  test('with NOTHING known about the link (a build without NetInfo) a quick failure to connect still says offline', async () => {
    const t = build([REFUSED]);
    t.store.start();
    t.link({ isConnected: null, isInternetReachable: null, type: 'unknown' });
    await settle();
    expect(status(t)).toBe(NET.OFFLINE);
  });
  test('a slow /health answer -> slow', async () => {
    const t = build([SLOW]);
    t.store.start();
    t.link(WIFI);
    await settle();
    expect(status(t)).toBe(NET.SLOW);
  });
  test('the slow threshold is exact: just under is online, at it is slow', async () => {
    const under = build([{ ok: true, status: 200, ms: SLOW_PROBE_MS - 1 }]);
    under.store.start();
    under.link(WIFI);
    await settle();
    expect(status(under)).toBe(NET.ONLINE);
    const at = build([{ ok: true, status: 200, ms: SLOW_PROBE_MS }]);
    at.store.start();
    at.link(WIFI);
    await settle();
    expect(status(at)).toBe(NET.SLOW);
  });
  test('one (normal) /health timeout is "slow"; a second in a row is serverDown', async () => {
    const t = build([OK, TIMED_OUT, TIMED_OUT]);
    t.store.start();
    t.link(WIFI);
    await settle();
    expect(status(t)).toBe(NET.ONLINE);
    await advance(MIN_PROBE_GAP_MS);
    t.store.check(); // a normal probe (not a link-up recovery probe): the normal 6 s limit and classification
    await settle();
    expect(status(t)).toBe(NET.SLOW);
    await advance(DEGRADED_RECHECK_MS[0]);
    expect(status(t)).toBe(NET.SERVER_DOWN);
  });
  test('a probe that throws is treated as no answer, never as a crash', async () => {
    const t = build();
    t.probe.mockImplementation(async () => { throw new Error('boom'); });
    t.store.start();
    t.link(WIFI);
    await settle();
    expect(status(t)).toBe(NET.SERVER_DOWN);
  });
  test('"online" means reachable: a 200 from /health is all it takes, and a later 5xx call does not undo it by itself', async () => {
    const t = build([OK, OK]);
    t.store.start();
    t.link(WIFI);
    await settle();
    t.store.reportOutcome('server'); // one failing call: gap-limited, and a good /health keeps the state online
    await advance(MIN_PROBE_GAP_MS);
    t.store.reportOutcome('server');
    await settle();
    expect(status(t)).toBe(NET.ONLINE);
  });
});

describe('the restored event', () => {
  test('offline -> online fires it once, with the time and a count', async () => {
    const t = build([OK]);
    const restored = jest.fn();
    t.store.onRestored(restored);
    t.store.start();
    t.link(NONE);
    await settle();
    expect(restored).not.toHaveBeenCalled();
    t.link(WIFI);
    await settle();
    expect(status(t)).toBe(NET.ONLINE);
    expect(restored).toHaveBeenCalledTimes(1);
    expect(t.store.getState().restoredCount).toBe(1);
    expect(t.store.getState().restoredAt).not.toBeNull();
  });
  test('the first connection after launch is NOT a restoration', async () => {
    const t = build([OK]);
    const restored = jest.fn();
    t.store.onRestored(restored);
    t.store.start();
    t.link(WIFI);
    await settle();
    expect(restored).not.toHaveBeenCalled();
    expect(t.store.getState().restoredCount).toBe(0);
  });
  test('serverDown -> online (a real call got an answer) fires it', async () => {
    const t = build([REFUSED]);
    const restored = jest.fn();
    t.store.onRestored(restored);
    t.store.start();
    t.link(WIFI);
    await settle();
    expect(status(t)).toBe(NET.SERVER_DOWN);
    t.store.reportOutcome('ok');
    expect(status(t)).toBe(NET.ONLINE);
    expect(restored).toHaveBeenCalledTimes(1);
  });
  test('offline -> slow also counts as restored (the connection is back, if slowly)', async () => {
    const t = build([SLOW]);
    const restored = jest.fn();
    t.store.onRestored(restored);
    t.store.start();
    t.link(NONE);
    await settle();
    t.link(WIFI);
    await settle();
    expect(status(t)).toBe(NET.SLOW);
    expect(restored).toHaveBeenCalledTimes(1);
  });
  test('online -> slow -> online is NOT a restoration (slow is not an outage)', async () => {
    const t = build([OK, SLOW, OK]);
    const restored = jest.fn();
    t.store.onRestored(restored);
    t.store.start();
    t.link(WIFI);
    await settle();
    t.link(CELL);
    await settle();
    expect(status(t)).toBe(NET.SLOW);
    t.store.reportOutcome('ok');
    expect(status(t)).toBe(NET.ONLINE);
    expect(restored).not.toHaveBeenCalled();
  });
  test('each outage is its own restoration (count moves by one)', async () => {
    const t = build([OK]);
    t.store.start();
    t.link(WIFI);
    await settle();
    for (let n = 1; n <= 3; n += 1) {
      t.link(NONE);
      await settle();
      t.link(WIFI);
      await settle();
      expect(t.store.getState().restoredCount).toBe(n);
    }
  });
  test('an unsubscribed listener is not called; a faulty one does not stop the others', async () => {
    const t = build([OK]);
    const gone = jest.fn();
    const good = jest.fn();
    const off = t.store.onRestored(gone);
    t.store.onRestored(() => { throw new Error('bad listener'); });
    t.store.onRestored(good);
    off();
    t.store.start();
    t.link(NONE);
    await settle();
    t.link(WIFI);
    await settle();
    expect(gone).not.toHaveBeenCalled();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('real API outcomes', () => {
  async function online(results = [OK]) {
    const t = build(results);
    t.store.start();
    t.link(WIFI);
    await settle();
    return t;
  }
  test('"ok" while online changes nothing and asks nothing', async () => {
    const t = await online();
    const before = t.store.getState();
    for (let n = 0; n < 50; n += 1) t.store.reportOutcome('ok');
    expect(t.store.getState()).toBe(before);
    expect(t.probe).toHaveBeenCalledTimes(1);
  });
  test('"ok" after a state NetInfo got wrong (it said no link, the server answered) -> online', async () => {
    const t = build();
    t.store.start();
    t.link(NONE);
    await settle();
    expect(status(t)).toBe(NET.OFFLINE);
    t.store.reportOutcome('ok');
    expect(status(t)).toBe(NET.ONLINE);
  });
  test('a burst of failing calls is ONE probe', async () => {
    const t = await online([OK, REFUSED]);
    await advance(MIN_PROBE_GAP_MS);
    for (let n = 0; n < 20; n += 1) t.store.reportOutcome('network');
    await settle();
    expect(t.probe).toHaveBeenCalledTimes(2); // the link probe + one for the whole burst
  });
  test('two failures closer than the gap do not probe twice', async () => {
    const t = await online([OK, OK, OK]);
    await advance(MIN_PROBE_GAP_MS);
    t.store.reportOutcome('timeout');
    await settle();
    await advance(MIN_PROBE_GAP_MS - 1);
    t.store.reportOutcome('timeout');
    await settle();
    expect(t.probe).toHaveBeenCalledTimes(2);
    await advance(1);
    t.store.reportOutcome('timeout');
    await settle();
    expect(t.probe).toHaveBeenCalledTimes(3);
  });
  test('a failing call while the link is known down asks nothing (the answer is already known)', async () => {
    const t = build();
    t.store.start();
    t.link(NONE);
    await settle();
    t.store.reportOutcome('network');
    await advance(MIN_PROBE_GAP_MS);
    expect(t.probe).not.toHaveBeenCalled();
  });
  test('a failing call while online asks /health; if the backend then does not answer -> serverDown', async () => {
    const t = await online([OK, REFUSED]);
    await advance(MIN_PROBE_GAP_MS);
    t.store.reportOutcome('network');
    await settle();
    expect(status(t)).toBe(NET.SERVER_DOWN);
  });
  test('a single 5xx call does not by itself make the state serverDown', async () => {
    const t = await online([OK, OK]);
    await advance(MIN_PROBE_GAP_MS);
    t.store.reportOutcome('server');
    await settle();
    expect(status(t)).toBe(NET.ONLINE);
  });
  test('a call timing out with a healthy /health leaves the state online', async () => {
    const t = await online([OK, OK]);
    await advance(MIN_PROBE_GAP_MS);
    t.store.reportOutcome('timeout');
    await settle();
    expect(status(t)).toBe(NET.ONLINE);
  });
  test('a call timing out AND /health timing out -> slow', async () => {
    const t = await online([OK, TIMED_OUT]);
    await advance(MIN_PROBE_GAP_MS);
    t.store.reportOutcome('timeout');
    await settle();
    expect(status(t)).toBe(NET.SLOW);
  });
  test('outcomes before start() are ignored', async () => {
    const t = build();
    t.store.reportOutcome('network');
    t.store.reportOutcome('ok');
    await settle();
    expect(t.probe).not.toHaveBeenCalled();
    expect(status(t)).toBe(NET.UNKNOWN);
  });
  test('an unknown outcome word is ignored', async () => {
    const t = await online();
    t.store.reportOutcome('banana');
    await advance(MIN_PROBE_GAP_MS);
    expect(t.probe).toHaveBeenCalledTimes(1);
  });
});

describe('no polling while healthy; a slow back-off only while degraded', () => {
  test('online and healthy: NO timer, NO probe, for ten minutes', async () => {
    const t = build([OK]);
    t.store.start();
    t.link(WIFI);
    await settle();
    await advance(10 * 60 * 1000);
    expect(t.probe).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('serverDown after a link came up re-checks quickly (500 ms ... 6 s), then at 15 s, 30 s, then every 60 s, and stops once online', async () => {
    const t = build([REFUSED]);
    t.store.start();
    t.link(WIFI);
    await settle();
    let expected = 1;
    expect(t.probe).toHaveBeenCalledTimes(expected);
    for (const delay of LINK_UP_RECHECK_MS) {
      await advance(delay - 1);
      expect(t.probe).toHaveBeenCalledTimes(expected);
      await advance(1);
      expected += 1;
      expect(t.probe).toHaveBeenCalledTimes(expected);
    }
    await advance(DEGRADED_RECHECK_MS[0] - 1);
    expect(t.probe).toHaveBeenCalledTimes(expected);
    await advance(1);
    expected += 1;
    expect(t.probe).toHaveBeenCalledTimes(expected);
    await advance(DEGRADED_RECHECK_MS[1]);
    expected += 1;
    expect(t.probe).toHaveBeenCalledTimes(expected);
    await advance(DEGRADED_RECHECK_MS[2]);
    expected += 1;
    expect(t.probe).toHaveBeenCalledTimes(expected);
    await advance(DEGRADED_RECHECK_MS[2]); // the last interval repeats: never faster than once a minute
    expected += 1;
    expect(t.probe).toHaveBeenCalledTimes(expected);
    t.setResults([OK]);
    await advance(DEGRADED_RECHECK_MS[2]);
    expect(status(t)).toBe(NET.ONLINE);
    const calls = t.probe.mock.calls.length;
    await advance(10 * 60 * 1000);
    expect(t.probe).toHaveBeenCalledTimes(calls); // healthy again: silence
    expect(jest.getTimerCount()).toBe(0);
  });
  test('the back-off is never faster than the gap', () => {
    expect(Math.min(...DEGRADED_RECHECK_MS)).toBeGreaterThanOrEqual(MIN_PROBE_GAP_MS);
  });
  test('when the link is known to be down there is no timer at all (NetInfo will say when it changes)', async () => {
    const t = build();
    t.store.start();
    t.link(NONE);
    await settle();
    await advance(10 * 60 * 1000);
    expect(t.probe).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  test('going to the background stops the back-off; coming back asks once', async () => {
    const t = build([REFUSED]);
    t.store.start();
    t.link(WIFI);
    await settle();
    t.app(false);
    expect(jest.getTimerCount()).toBe(0);
    await advance(5 * 60 * 1000);
    expect(t.probe).toHaveBeenCalledTimes(1);
    t.app(true);
    await settle();
    expect(t.probe).toHaveBeenCalledTimes(2);
  });
  test('returning to the app while healthy and recently checked does NOT probe', async () => {
    const t = build([OK]);
    t.store.start();
    t.link(WIFI);
    await settle();
    await advance(FOREGROUND_STALE_MS - 1000);
    t.app(false);
    t.app(true);
    await settle();
    expect(t.probe).toHaveBeenCalledTimes(1);
  });
  test('returning to the app after a long time re-checks once', async () => {
    const t = build([OK]);
    t.store.start();
    t.link(WIFI);
    await settle();
    await advance(FOREGROUND_STALE_MS + 1000);
    t.app(false);
    t.app(true);
    await settle();
    expect(t.probe).toHaveBeenCalledTimes(2);
  });
  test('rapid foreground flapping is still one probe at a time', async () => {
    const t = build([REFUSED]);
    t.store.start();
    t.link(WIFI);
    await settle();
    await advance(MIN_PROBE_GAP_MS);
    const before = t.probe.mock.calls.length; // the quick re-asks after the link-up have run meanwhile
    for (let n = 0; n < 10; n += 1) { t.app(false); t.app(true); }
    await settle();
    expect(t.probe.mock.calls.length - before).toBeLessThanOrEqual(1);
  });
  test('only one probe is ever in flight', async () => {
    let calls = 0;
    const t = build();
    t.probe.mockImplementation(() => { calls += 1; return new Promise(() => {}); }); // never answers
    t.store.start();
    t.link(WIFI);
    t.store.check();
    t.store.check();
    t.store.reportOutcome('network');
    await advance(MIN_PROBE_GAP_MS * 4);
    expect(calls).toBe(1);
  });
});

describe('check() (a "Try again" tap)', () => {
  test('asks now, even inside the gap', async () => {
    const t = build([OK, OK]);
    t.store.start();
    t.link(WIFI);
    await settle();
    await t.store.check();
    expect(t.probe).toHaveBeenCalledTimes(2);
  });
  test('does nothing while the link is known down', async () => {
    const t = build();
    t.store.start();
    t.link(NONE);
    await settle();
    await t.store.check();
    expect(t.probe).not.toHaveBeenCalled();
  });
  test('does nothing before start()', async () => {
    const t = build();
    await t.store.check();
    expect(t.probe).not.toHaveBeenCalled();
  });
});

describe('stopping mid-probe', () => {
  test('an answer that arrives after stop() changes nothing', async () => {
    let finish;
    const t = build();
    t.probe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    t.store.start();
    t.link(WIFI);
    t.store.stop();
    finish(OK);
    await settle();
    expect(status(t)).toBe(NET.UNKNOWN);
  });
});

describe('subscribers', () => {
  test('are told of a change, once per real change, and can unsubscribe', async () => {
    const t = build([OK]);
    const seen = [];
    // The link changing is itself a change (state.link), so the same status can be announced again; what matters is the order of statuses.
    const off = t.store.subscribe((state) => { if (seen[seen.length - 1] !== state.status) seen.push(state.status); });
    t.store.start();
    t.link(NONE);
    await settle();
    t.link(WIFI);
    await settle();
    expect(seen).toEqual([NET.OFFLINE, NET.UNKNOWN, NET.ONLINE]); // the link coming back ends OFFLINE at once (UNKNOWN: the backend is being asked), then the answer
    off();
    t.link(NONE);
    await settle();
    expect(seen).toEqual([NET.OFFLINE, NET.UNKNOWN, NET.ONLINE]);
  });
  test('the state object is replaced only when something changed (safe for useSyncExternalStore)', async () => {
    const t = build([OK]);
    t.store.start();
    t.link(WIFI);
    await settle();
    const a = t.store.getState();
    t.store.reportOutcome('ok');
    t.link(WIFI);
    expect(t.store.getState()).toBe(a);
  });
  test('a faulty subscriber does not stop the others', async () => {
    const t = build();
    const good = jest.fn();
    t.store.subscribe(() => { throw new Error('bad'); });
    t.store.subscribe(good);
    t.store.start();
    t.link(NONE);
    await settle();
    expect(good).toHaveBeenCalled();
  });
  test('listenerCount reflects subscriptions', () => {
    const t = build();
    const a = t.store.subscribe(() => {});
    const b = t.store.onRestored(() => {});
    expect(t.store.listenerCount()).toBe(2);
    a();
    b();
    expect(t.store.listenerCount()).toBe(0);
  });
});

describe('the store never touches authentication', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  test.each(['network.js', 'networkService.js', 'networkReporter.js', 'healthProbe.js', 'apiErrors.js', 'networkDevice.js'])('%s does not import the session, the tokens or navigation', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from '\.\/(session|tokens|nav|authState|authGuard|sessionCheck)'/);
    expect(source).not.toMatch(/clearTokens|compareAndClearTokens|saveTokens|navReplace|endSession/);
  });
});
