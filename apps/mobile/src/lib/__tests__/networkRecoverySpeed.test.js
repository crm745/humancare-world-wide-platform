/* global describe, test, expect, beforeEach, afterEach, jest */
// Recovery after Wi-Fi comes back: how fast the app learns that the backend (here: on the LAN) is reachable again, without asking more often than needed, and with the four states kept apart
// (offline / server unavailable / slow / online). The REAL store (lib/network.js) with stand-in probe, NetInfo and app-state sources and fake timers. Nothing touches a device or a network.
const {
  NET, DEGRADED_RECHECK_MS, LINK_UP_RECHECK_MS, MIN_PROBE_GAP_MS, OFFLINE_LINK_RECHECK_MS, SLOW_PROBE_MS, RECOVERY_PROBE_TIMEOUT_MS, createNetworkStore,
} = require('../network');

const WIFI = { isConnected: true, isInternetReachable: true, type: 'wifi' };
const WIFI_UNSURE = { isConnected: true, isInternetReachable: null, type: 'wifi' }; // just joined: NetInfo has not tested the internet yet
const WIFI_LAN_ONLY = { isConnected: true, isInternetReachable: false, type: 'wifi' }; // NetInfo's own test address fails: no internet upstream, but the LAN backend can still answer
const CELL = { isConnected: true, isInternetReachable: true, type: 'cellular' };
const NONE = { isConnected: false, isInternetReachable: false, type: 'none' };
const OK = { ok: true, status: 200, ms: 40 };
const SLOW = { ok: true, status: 200, ms: SLOW_PROBE_MS + 500 };
const REFUSED = { ok: false, timedOut: false, ms: 10 };
const UNAVAILABLE = { ok: false, status: 503, ms: 90 };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// Probe answers are held until the test releases them. `phone` is what NetInfo.refresh() answers (null = no answer). Everything is observable.
function rig({ withRefresh = true, phone = null } = {}) {
  const asked = [];
  const probe = jest.fn(() => new Promise((resolve) => { asked.push(resolve); }));
  const linkSubs = new Set();
  const appSubs = new Set();
  const state = { phone };
  const refreshLink = withRefresh ? jest.fn(async () => state.phone) : null;
  const store = createNetworkStore({
    probe,
    subscribeLink: (cb) => { linkSubs.add(cb); return () => linkSubs.delete(cb); },
    subscribeAppActive: (cb) => { appSubs.add(cb); return () => appSubs.delete(cb); },
    refreshLink,
  });
  store.start();
  const statuses = [];
  store.subscribe((s) => { if (statuses[statuses.length - 1] !== s.status) statuses.push(s.status); });
  return {
    store, probe, asked, statuses, refreshLink, state,
    link: (s) => linkSubs.forEach((cb) => cb(s)),
    active: (value) => appSubs.forEach((cb) => cb(value)),
    status: () => store.getState().status,
    restored: () => store.getState().restoredCount,
  };
}
const flush = () => jest.advanceTimersByTimeAsync(0);
const advance = (ms) => jest.advanceTimersByTimeAsync(ms);

describe('the back-off while the backend is not confirmed', () => {
  test('starts at 1.5 s (it used to start at 15 s, then 5 s), grows, ends at once a minute, and is never closer than the probe gap', () => {
    expect(DEGRADED_RECHECK_MS[0]).toBe(1500);
    expect([...DEGRADED_RECHECK_MS].sort((a, b) => a - b)).toEqual([...DEGRADED_RECHECK_MS]); // never faster as it goes on
    expect(DEGRADED_RECHECK_MS[DEGRADED_RECHECK_MS.length - 1]).toBe(60000);
    expect(Math.min(...DEGRADED_RECHECK_MS)).toBeGreaterThanOrEqual(MIN_PROBE_GAP_MS);
  });
  test('a phone whose link is unknown (a build without NetInfo) that is "offline" learns within 5 s that the backend is back', async () => {
    const t = rig({ withRefresh: false });
    const first = t.store.check(); // a "Try again" while the backend is down
    t.asked[0](REFUSED); await first; await flush();
    expect(t.status()).toBe(NET.OFFLINE); // nothing is known about the link, so a failure to connect reads as no connection
    await advance(DEGRADED_RECHECK_MS[0] - 1);
    expect(t.probe).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(t.probe).toHaveBeenCalledTimes(2); // the second question, 5 s after the first
    t.asked[1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.restored()).toBe(1);
  });
  test('while the backend stays down the questions slow down (5 s, 10 s, 20 s, 40 s, then every minute) and stop at the first answer', async () => {
    const t = rig({ withRefresh: false });
    t.store.check(); t.asked[0](REFUSED); await flush();
    let expected = 1;
    for (const delay of DEGRADED_RECHECK_MS) {
      await advance(delay);
      expected += 1;
      expect(t.probe).toHaveBeenCalledTimes(expected);
      t.asked[expected - 1](REFUSED); await flush();
    }
    await advance(DEGRADED_RECHECK_MS[DEGRADED_RECHECK_MS.length - 1]);
    expect(t.probe).toHaveBeenCalledTimes(expected + 1); // the last interval repeats
    t.asked[expected](OK); await flush();
    const calls = t.probe.mock.calls.length;
    await advance(10 * 60 * 1000);
    expect(t.probe).toHaveBeenCalledTimes(calls); // online: silence
  });
});

describe('a change of only NetInfo\'s reachability hint is not a new link state', () => {
  test('the answer of a probe that was already on its way is KEPT (it used to be thrown away, starting the whole wait again)', async () => {
    const t = rig();
    t.link(WIFI_UNSURE); await flush();
    expect(t.asked).toHaveLength(1);
    t.link(WIFI_LAN_ONLY); await flush(); // NetInfo finished its own test: "no internet" (a LAN-only Wi-Fi)
    expect(t.asked).toHaveLength(1); // no second question: the first one is still valid
    t.asked[0](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE); // the backend answered: reachable, whatever NetInfo's own test said
    expect(t.restored()).toBe(0); // it was never "offline" here, so nothing is announced as restored
  });
  test('a hint that turns true while a question is already in flight adds no second question', async () => {
    const t = rig();
    t.link(WIFI_UNSURE); await flush();
    t.link(WIFI); await flush();
    expect(t.asked).toHaveLength(1);
    t.asked[0](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
  });
  test('after the backend answered, a hint change asks nothing at all', async () => {
    const t = rig();
    t.link(WIFI_UNSURE); await flush();
    t.asked[0](OK); await flush();
    for (const hint of [WIFI_LAN_ONLY, WIFI, WIFI_UNSURE, WIFI_LAN_ONLY]) { t.link(hint); await flush(); }
    expect(t.probe).toHaveBeenCalledTimes(1);
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.store.getState().link).toMatchObject({ isInternetReachable: false }); // the hint itself is recorded
  });
  test('when the internet is newly confirmed while the backend is still unconfirmed (server unavailable), ONE question is asked at once', async () => {
    const t = rig();
    t.link(WIFI_LAN_ONLY); await flush();
    t.asked[0](UNAVAILABLE); await flush();
    expect(t.status()).toBe(NET.SERVER_DOWN);
    const before = t.probe.mock.calls.length;
    t.link(WIFI); await flush(); // NetInfo's test now succeeds
    expect(t.probe).toHaveBeenCalledTimes(before + 1);
    t.asked[before](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.restored()).toBe(1);
  });
  test('a different NETWORK (Wi-Fi to mobile data) is still a new link state: the old answer is dropped and a new question is asked', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    t.link(CELL); await flush();
    expect(t.asked).toHaveLength(2);
    t.asked[0](REFUSED); await flush(); // the old answer, about Wi-Fi
    expect(t.status()).not.toBe(NET.SERVER_DOWN);
    t.asked[1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
  });
});

describe('the four states stay apart, and internet reachability is never proof against the LAN backend', () => {
  test('a LAN-only Wi-Fi (NetInfo says no internet) with an answering backend is ONLINE, never offline or server-down', async () => {
    const t = rig();
    t.link(WIFI_LAN_ONLY); await flush();
    t.asked[0](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.statuses).not.toContain(NET.OFFLINE);
    expect(t.statuses).not.toContain(NET.SERVER_DOWN);
  });
  test('connected but the backend refuses: server unavailable (not offline)', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    t.asked[0](REFUSED); await flush();
    expect(t.status()).toBe(NET.SERVER_DOWN);
    expect(t.statuses).not.toContain(NET.OFFLINE);
  });
  test('connected and the backend answers slowly: slow', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    t.asked[0](SLOW); await flush();
    expect(t.status()).toBe(NET.SLOW);
  });
  test('no link and nowhere to ask the phone: offline, and nothing is asked of the backend (the offline watch needs a way to read the phone)', async () => {
    const t = rig({ withRefresh: false });
    t.link(NONE); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
    await advance(60000);
    expect(t.probe).not.toHaveBeenCalled();
  });
  test('the order of a full outage and recovery: online, offline, (unknown while the backend is asked), online with one "restored"', async () => {
    const t = rig();
    t.link(WIFI); await flush(); t.asked[0](OK); await flush();
    t.link(NONE); await flush();
    t.link(WIFI_UNSURE); await flush();
    expect(t.status()).toBe(NET.UNKNOWN); // not offline: the buttons are usable while the backend is asked
    t.asked[1](OK); await flush();
    expect(t.statuses).toEqual([NET.UNKNOWN, NET.ONLINE, NET.OFFLINE, NET.UNKNOWN, NET.ONLINE]);
    expect(t.restored()).toBe(1);
  });
});

describe('a radio that has just reconnected is given quick chances, not a long wait', () => {
  test('the first questions after the link comes up are refused, then answered: online within about a second', async () => {
    const t = rig();
    t.link(NONE); await flush();
    t.link(WIFI_UNSURE); await flush();
    t.asked[0](REFUSED); await flush(); // the radio is not ready yet
    expect(t.status()).not.toBe(NET.OFFLINE);
    await advance(LINK_UP_RECHECK_MS[0]);
    expect(t.asked).toHaveLength(2); // the next question follows after 500 ms, not after a back-off
    t.asked[1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.restored()).toBe(1);
  });
  test('a recovery question gives up after 2 s, so a swallowed packet costs a couple of seconds, not a whole timeout', () => {
    expect(RECOVERY_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    expect(LINK_UP_RECHECK_MS[0]).toBeLessThanOrEqual(500);
  });
});

describe('while the phone is offline it re-reads its own connection (no request to anything)', () => {
  test('every OFFLINE_LINK_RECHECK_MS (0.5 s), until the link is back', async () => {
    const t = rig({ phone: NONE });
    t.link(NONE); await flush();
    expect(t.refreshLink).not.toHaveBeenCalled();
    await advance(OFFLINE_LINK_RECHECK_MS);
    expect(t.refreshLink).toHaveBeenCalledTimes(1);
    await advance(OFFLINE_LINK_RECHECK_MS);
    expect(t.refreshLink).toHaveBeenCalledTimes(2);
    expect(t.probe).not.toHaveBeenCalled(); // the backend is not touched while there is no link
    expect(t.status()).toBe(NET.OFFLINE);
  });
  test('a missed NetInfo event no longer keeps "offline" on screen: the re-read finds the link and the backend is asked at once', async () => {
    const t = rig({ phone: NONE });
    t.link(NONE); await flush();
    t.state.phone = WIFI_UNSURE; // the phone is connected again, but NetInfo never sent the event
    await advance(OFFLINE_LINK_RECHECK_MS); await flush();
    expect(t.status()).not.toBe(NET.OFFLINE);
    expect(t.asked).toHaveLength(1);
    t.asked[0](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.restored()).toBe(1);
  });
  test('it stops when the link comes back, when the app goes to the background, and when the service is stopped', async () => {
    const t = rig({ phone: NONE });
    t.link(NONE); await flush();
    await advance(OFFLINE_LINK_RECHECK_MS);
    const calls = t.refreshLink.mock.calls.length;
    t.link(WIFI_UNSURE); await flush();
    await advance(60000);
    expect(t.refreshLink).toHaveBeenCalledTimes(calls); // link up: no more re-reads
    t.asked[0](OK); await flush();

    const u = rig({ phone: NONE });
    u.link(NONE); await flush();
    u.active(false);
    await advance(30000);
    expect(u.refreshLink).not.toHaveBeenCalled(); // in the background: silence
    u.active(true); await flush();
    const afterForeground = u.refreshLink.mock.calls.length; // coming back asks once at once, then the watch restarts
    await advance(OFFLINE_LINK_RECHECK_MS);
    expect(u.refreshLink.mock.calls.length).toBeGreaterThan(afterForeground);
    u.store.stop();
    const stopped = u.refreshLink.mock.calls.length;
    await advance(60000);
    expect(u.refreshLink).toHaveBeenCalledTimes(stopped);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('without a way to ask the phone (no NetInfo) there is no such timer', async () => {
    const t = rig({ withRefresh: false });
    t.link(NONE); await flush();
    expect(jest.getTimerCount()).toBe(0);
  });
  test('no timer is left running once online', async () => {
    const t = rig({ phone: NONE });
    t.link(NONE); await flush();
    t.link(WIFI); await flush();
    t.asked[0](OK); await flush();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('probes stay rare and single-flight', () => {
  test('a burst of failed calls and hint changes during one outstanding question makes no second question', async () => {
    const t = rig();
    t.link(WIFI_UNSURE); await flush();
    for (let i = 0; i < 5; i += 1) { t.store.reportOutcome('network'); t.link(i % 2 ? WIFI_LAN_ONLY : WIFI_UNSURE); }
    await flush();
    expect(t.asked).toHaveLength(1);
  });
  test('while healthy nothing is asked, however long it runs', async () => {
    const t = rig();
    t.link(WIFI); await flush(); t.asked[0](OK); await flush();
    await advance(30 * 60 * 1000);
    expect(t.probe).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
