/* global describe, test, expect, beforeEach, afterEach, jest, __dirname */
// Instant recovery across the whole patient app. The REAL store (lib/network.js) with stand-in probe / NetInfo / app-state sources and fake timers; nothing touches a device or a network.
// Every screen reads ONE flag (useNetwork().isOffline = status "offline"), so what is proved here is what login, registration, OTP, password recovery, Home, the service forms, request details,
// tracking, profile and notifications all see. The last block checks that no screen has a second, private source of "offline".
const fs = require('fs');
const path = require('path');
const {
  NET, DEGRADED_RECHECK_MS, MIN_PROBE_GAP_MS, OFFLINE_LINK_RECHECK_MS, OFFLINE_PROBE_EVERY, RECOVERY_PROBE_TIMEOUT_MS, SLOW_PROBE_MS, createNetworkStore,
} = require('../network');

const WIFI = { isConnected: true, isInternetReachable: true, type: 'wifi' };
const WIFI_LAN_ONLY = { isConnected: true, isInternetReachable: false, type: 'wifi' };
const CELL = { isConnected: true, isInternetReachable: true, type: 'cellular' };
const NONE = { isConnected: false, isInternetReachable: false, type: 'none' };
const OK = { ok: true, status: 200, ms: 40 };
const SLOW = { ok: true, status: 200, ms: SLOW_PROBE_MS + 500 };
const UNAVAILABLE = { ok: false, status: 503, ms: 90 };
const NO_ANSWER = { ok: false, timedOut: false, ms: 5 };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function rig({ phone = null, withRefresh = true } = {}) {
  const asked = [];
  const probe = jest.fn((options) => new Promise((resolve) => { asked.push({ resolve, options }); }));
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
    store, probe, asked, statuses, state, refreshLink,
    answer: (i, result) => asked[i].resolve(result),
    link: (s) => linkSubs.forEach((cb) => cb(s)),
    active: (value) => appSubs.forEach((cb) => cb(value)),
    status: () => store.getState().status,
    restored: () => store.getState().restoredCount,
  };
}
const flush = () => jest.advanceTimersByTimeAsync(0);
const advance = (ms) => jest.advanceTimersByTimeAsync(ms);
const goOffline = async (t) => { t.link(NONE); await flush(); expect(t.status()).toBe(NET.OFFLINE); };

describe('Wi-Fi comes back but NetInfo is late or never says so (the delay the person saw)', () => {
  test('the backend is asked while "offline"; when it answers, the buttons work within about a second and a half, whatever NetInfo has said', async () => {
    const t = rig({ phone: NONE }); // the phone keeps saying "no link"
    await goOffline(t);
    await advance(OFFLINE_LINK_RECHECK_MS * OFFLINE_PROBE_EVERY); await flush();
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0].options).toEqual({ timeoutMs: RECOVERY_PROBE_TIMEOUT_MS }); // the short limit: a dead link never holds it for long
    t.answer(0, OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.store.getState().link.isConnected).toBe(true);
    expect(t.restored()).toBe(1);
    expect(t.statuses).toEqual([NET.OFFLINE, NET.UNKNOWN, NET.ONLINE]); // offline, then usable while the answer is awaited, then online
  });
  test('worst case after Wi-Fi is back: one re-read period times OFFLINE_PROBE_EVERY (1.5 s), not 5-10 s', () => {
    expect(OFFLINE_LINK_RECHECK_MS * OFFLINE_PROBE_EVERY).toBeLessThanOrEqual(1500);
  });
  test('the answer of a backend that is DOWN (503) frees the buttons but is "server unavailable", never "online"', async () => {
    const t = rig({ phone: NONE });
    await goOffline(t);
    await advance(OFFLINE_LINK_RECHECK_MS * OFFLINE_PROBE_EVERY); await flush();
    t.answer(0, UNAVAILABLE); await flush();
    expect(t.status()).toBe(NET.SERVER_DOWN);
    expect(t.store.getState().link.isConnected).toBe(true);
  });
  test('a slow answer is "slow", not "online"', async () => {
    const t = rig({ phone: NONE });
    await goOffline(t);
    await advance(OFFLINE_LINK_RECHECK_MS * OFFLINE_PROBE_EVERY); await flush();
    t.answer(0, SLOW); await flush();
    expect(t.status()).toBe(NET.SLOW);
  });
  test('no answer at all (really no link): still offline, nothing flaps, and the next question is asked later (never two at once)', async () => {
    const t = rig({ phone: NONE });
    await goOffline(t);
    await advance(OFFLINE_LINK_RECHECK_MS * OFFLINE_PROBE_EVERY * 2); await flush();
    expect(t.asked).toHaveLength(1); // the first is still unanswered: single-flight
    t.answer(0, NO_ANSWER); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
    await advance(OFFLINE_LINK_RECHECK_MS * OFFLINE_PROBE_EVERY); await flush();
    expect(t.asked).toHaveLength(2);
    t.answer(1, { ok: false, timedOut: true, ms: 2000 }); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
    expect(t.statuses).toEqual([NET.OFFLINE]); // never flapped
  });
  test('a STALE answer is thrown away: the link changed (came up, went down) while the offline question was out', async () => {
    const t = rig({ phone: NONE });
    await goOffline(t);
    await advance(OFFLINE_LINK_RECHECK_MS * OFFLINE_PROBE_EVERY); await flush();
    t.link(WIFI); await flush(); // NetInfo wakes up: a recovery question for the new link
    t.link(NONE); await flush(); // and it drops again
    expect(t.status()).toBe(NET.OFFLINE);
    t.answer(0, OK); await flush(); // the old offline question answers late
    expect(t.status()).toBe(NET.OFFLINE);
    expect(t.restored()).toBe(0);
  });
  test('a stale answer to a recovery question never overrides a newer outage (rapid Wi-Fi <-> off switching)', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    t.answer(0, OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    for (let i = 0; i < 4; i += 1) { t.link(NONE); await flush(); t.link(WIFI); await flush(); }
    t.link(NONE); await flush();
    for (let i = 1; i < t.asked.length; i += 1) t.answer(i, OK); // every question asked on the way answers late, "fine"
    await flush();
    expect(t.status()).toBe(NET.OFFLINE);
  });
  test('the answer of the offline question arriving after the app was stopped changes nothing', async () => {
    const t = rig({ phone: NONE });
    await goOffline(t);
    await advance(OFFLINE_LINK_RECHECK_MS * OFFLINE_PROBE_EVERY); await flush();
    t.store.stop();
    t.answer(0, OK); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('in the background nothing is asked; coming back to the front asks at once', async () => {
    const t = rig({ phone: NONE });
    await goOffline(t);
    t.active(false);
    await advance(30000);
    expect(t.probe).not.toHaveBeenCalled();
    t.active(true); await flush();
    t.state.phone = WIFI; // the phone is connected now
    await advance(OFFLINE_LINK_RECHECK_MS); await flush();
    expect(t.status()).not.toBe(NET.OFFLINE);
    expect(t.asked.length).toBeGreaterThan(0);
  });
});

describe('NetInfo says the link is up (the usual case): the backend is asked at once, not after a timer', () => {
  test('Wi-Fi back: not offline at once (buttons work), /health asked in the same moment, online when it answers', async () => {
    const t = rig();
    t.link(WIFI); await flush(); t.answer(0, OK); await flush();
    await goOffline(t);
    t.link(WIFI); await flush();
    expect(t.status()).toBe(NET.UNKNOWN);
    expect(t.asked).toHaveLength(2); // asked in the same tick the link came up
    t.answer(1, OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.restored()).toBe(1);
  });
  test('mobile data back is the same', async () => {
    const t = rig();
    t.link(CELL); await flush(); t.answer(0, OK); await flush();
    await goOffline(t);
    t.link(CELL); await flush();
    expect(t.asked).toHaveLength(2);
    t.answer(1, OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
  });
  test('Wi-Fi -> mobile data: the question for the old network is dropped, the new one decides', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    t.link(CELL); await flush();
    expect(t.asked).toHaveLength(2);
    t.answer(0, UNAVAILABLE); await flush(); // the answer for Wi-Fi, late
    expect(t.status()).toBe(NET.UNKNOWN);
    t.answer(1, OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
  });
  test('LAN-only Wi-Fi ("no internet" per NetInfo) with a reachable backend is online; with an unreachable backend it is "server unavailable", never offline', async () => {
    const t = rig();
    t.link(WIFI_LAN_ONLY); await flush();
    t.answer(0, OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    const u = rig();
    u.link(WIFI_LAN_ONLY); await flush();
    u.answer(0, UNAVAILABLE); await flush();
    expect(u.status()).toBe(NET.SERVER_DOWN);
  });
  test('Wi-Fi connected is never online by itself: until /health answers the state is unknown (not online), and the banner stays quiet', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    expect(t.status()).toBe(NET.UNKNOWN);
    t.answer(0, UNAVAILABLE); await flush();
    expect(t.status()).toBe(NET.SERVER_DOWN);
  });
});

describe('router restart / backend downtime: the retry timers start fast and a return to the app does not wait for a gap', () => {
  test('after a failed question the next one comes after 1.5 s (it used to be 5 s)', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    t.answer(0, OK); await flush();
    await advance(MIN_PROBE_GAP_MS);
    t.store.reportOutcome('server'); await flush(); // a real call failed with a 5xx while online
    t.answer(1, UNAVAILABLE); await flush();
    expect(t.status()).toBe(NET.SERVER_DOWN);
    const before = t.asked.length;
    await advance(DEGRADED_RECHECK_MS[0] - 1);
    expect(t.asked).toHaveLength(before);
    await advance(1);
    expect(t.asked.length).toBe(before + 1);
    t.answer(before, OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.restored()).toBe(1);
  });
  test('coming back to the app while the backend is unconfirmed asks at once, even right after the last question', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    t.answer(0, UNAVAILABLE); await flush();
    t.active(false);
    t.active(true); await flush();
    const asked = t.asked.length;
    expect(asked).toBeGreaterThan(1); // not swallowed by the probe gap
    t.answer(asked - 1, OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
  });
  test('a real call that gets an answer frees the state at once, without waiting for a probe', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    t.answer(0, UNAVAILABLE); await flush();
    t.store.reportOutcome('ok');
    expect(t.status()).toBe(NET.ONLINE);
  });
  test('single-flight: a burst of failures and link events is one question at a time', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    for (let i = 0; i < 6; i += 1) t.store.reportOutcome('network');
    await flush();
    expect(t.asked).toHaveLength(1);
  });
});

describe('every screen reads the one flag, and what the flag does to a screen is undone by the same flag', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
  const files = ['app', 'components', 'state'].flatMap(walk).filter((f) => f.endsWith('.js'));

  test('no screen or component has its own private source of "offline" (NetInfo is only used by lib/networkDevice.js)', () => {
    for (const f of files) {
      const text = read(f);
      expect({ f, own: /netinfo|navigator\.onLine|NetInfo\./i.test(text.replace(/\/\/.*$/gm, '')) }).toEqual({ f, own: false });
    }
  });
  test('the disabled look and the explanatory line come from useNetwork().isOffline on login, register, OTP, password screens and the shared Button', () => {
    expect(read('components/ui.js')).toMatch(/const blocked = !!needsNetwork && isOffline/);
    for (const f of ['app/login.js', 'app/register.js', 'app/forgot-password.js', 'app/reset-password.js', 'app/set-password.js', 'components/OtpScreen.js']) {
      expect({ f, has: /NeedsInternet|needsNetwork|isOffline/.test(read(f)) }).toEqual({ f, has: true });
    }
    expect(read('components/network/NeedsInternet.js')).toContain('<Collapse show={isOffline}>');
  });
  test('the status that disables buttons is exactly "offline": unknown, slow and serverDown never disable anything', () => {
    const ctx = read('state/NetworkContext.js');
    expect(ctx).toContain('isOffline: state.status === NET.OFFLINE');
    expect(ctx).toContain('isOnline: state.status === NET.ONLINE || state.status === NET.UNKNOWN');
  });
});
