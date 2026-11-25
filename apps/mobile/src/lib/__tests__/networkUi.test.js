/* global describe, test, expect, jest, beforeEach, afterEach */
// Phase 2 (shared offline experience): what the banner shows, the "Back online" notice, which actions are blocked, the wording of a failed load, and
// the rule "read again ONCE after the connection returns". Pure logic plus the real network store (lib/network.js) with a fake NetInfo and /health.
const {
  RESTORED_VISIBLE_MS, BANNER, bannerKind, blocksNetworkAction, loadFailureKey, retryOnRestoration,
} = require('../networkUi');
const { createNetworkStore, MIN_PROBE_GAP_MS } = require('../network');
const { noAnswerError } = require('../apiErrors');

const OK = { ok: true, status: 200, ms: 100 };
const SLOW = { ok: true, status: 200, ms: 9000 };
const REFUSED = { ok: false, timedOut: false, ms: 10 };
const WIFI = { isConnected: true, isInternetReachable: true, type: 'wifi' };
const NONE = { isConnected: false, isInternetReachable: false, type: 'none' };
const WIFI_NO_INTERNET = { isConnected: true, isInternetReachable: false, type: 'wifi' };

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('bannerKind', () => {
  test.each([
    ['offline', false, 'offline'],
    ['offline', true, 'offline'], // the worst state wins over a pending "Back online"
    ['slow', false, 'slow'],
    ['slow', true, 'slow'],
    ['serverDown', false, 'serverDown'],
    ['serverDown', true, 'serverDown'],
    ['online', false, null],
    ['online', true, 'restored'],
    ['unknown', false, null],
    ['unknown', true, 'restored'],
  ])('status %s, restoredVisible %s -> %s', (status, restoredVisible, expected) => {
    expect(bannerKind({ status, restoredVisible })).toBe(expected);
  });
  test('nothing known -> nothing shown', () => {
    expect(bannerKind()).toBeNull();
    expect(bannerKind({})).toBeNull();
  });
  test('every banner has a translation key and a tone', () => {
    expect(Object.keys(BANNER).sort()).toEqual(['offline', 'restored', 'serverDown', 'slow']);
    expect(BANNER.offline).toMatchObject({ titleKey: 'net_offline', textKey: 'net_offline_text', icon: 'wifiOff', tone: 'warning' });
    expect(BANNER.serverDown).toMatchObject({ titleKey: 'net_server_down', textKey: 'net_server_down_text', icon: 'cloudOff', tone: 'warning' });
    expect(BANNER.slow).toMatchObject({ titleKey: 'net_slow', textKey: 'net_slow_text', icon: 'signal', tone: 'slow' });
    expect(BANNER.restored).toMatchObject({ titleKey: 'net_restored', textKey: null, icon: 'wifi', tone: 'success' }); // a title only
  });
  test('"Back online" is brief', () => {
    expect(RESTORED_VISIBLE_MS).toBeGreaterThanOrEqual(1500);
    expect(RESTORED_VISIBLE_MS).toBeLessThanOrEqual(5000);
  });
});

describe('the banner, driven by the REAL network store through the presenter', () => {
  const { createBannerPresenter, OUTAGE_DELAY_MS, SLOW_DELAY_MS } = require('../bannerPresenter');
  function rig(results = [OK]) {
    const linkSubs = new Set();
    let i = 0;
    const probe = jest.fn(async () => results[Math.min(i++, results.length - 1)]);
    const store = createNetworkStore({ probe, subscribeLink: (cb) => { linkSubs.add(cb); return () => linkSubs.delete(cb); } });
    const presenter = createBannerPresenter();
    const banners = [];
    presenter.subscribe(() => banners.push(presenter.get()));
    const feed = (state) => presenter.observe(state.status);
    feed(store.getState());
    store.subscribe(feed);
    store.start();
    return { store, probe, banners, presenter, link: (s) => linkSubs.forEach((cb) => cb(s)) };
  }
  const settle = () => jest.advanceTimersByTimeAsync(0);

  test('offline -> "No internet connection" after 1 s; back -> "Back online" -> gone', async () => {
    const t = rig();
    t.link(WIFI);
    await settle();
    expect(t.banners).toEqual([]);
    t.link(NONE);
    await settle();
    expect(t.banners).toEqual([]); // not yet: a blip shows nothing
    await jest.advanceTimersByTimeAsync(OUTAGE_DELAY_MS);
    expect(t.banners).toEqual(['offline']);
    t.link(WIFI);
    await settle();
    expect(t.banners).toEqual(['offline', 'restored']);
    await jest.advanceTimersByTimeAsync(RESTORED_VISIBLE_MS);
    expect(t.banners).toEqual(['offline', 'restored', null]);
  });
  test('Wi-Fi connected, NetInfo says no internet, the backend answers -> NO banner', async () => {
    const t = rig();
    t.link(WIFI_NO_INTERNET);
    await jest.advanceTimersByTimeAsync(OUTAGE_DELAY_MS + 100);
    expect(t.banners).toEqual([]);
  });
  test('Wi-Fi connected, NetInfo says no internet, the backend does not answer -> "can\'t reach servers" (never "No internet")', async () => {
    const t = rig([{ ok: false, timedOut: false, ms: 10 }]);
    t.link(WIFI_NO_INTERNET);
    await jest.advanceTimersByTimeAsync(OUTAGE_DELAY_MS + 100);
    expect(t.banners).toEqual(['serverDown']);
  });
  test('slow connection -> "Slow internet connection" after 3 s', async () => {
    const t = rig([SLOW]);
    t.link(WIFI);
    await jest.advanceTimersByTimeAsync(SLOW_DELAY_MS - 1);
    expect(t.banners).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.banners).toEqual(['slow']);
  });
  test('backend unavailable while the internet works -> "We can\'t reach HumanCare servers" (after 1 s)', async () => {
    const t = rig([REFUSED]);
    t.link(WIFI);
    await jest.advanceTimersByTimeAsync(OUTAGE_DELAY_MS);
    expect(t.banners).toEqual(['serverDown']);
  });
  test('the servers come back (a real call is answered) -> "Back online"', async () => {
    const t = rig([REFUSED]);
    t.link(WIFI);
    await jest.advanceTimersByTimeAsync(OUTAGE_DELAY_MS);
    t.store.reportOutcome('ok');
    expect(t.banners).toEqual(['serverDown', 'restored']);
  });
  test('flapping never leaves two banners or a stale timer', async () => {
    const t = rig([OK]);
    t.link(WIFI);
    await settle();
    for (let n = 0; n < 5; n += 1) {
      t.link(NONE);
      await settle();
      t.link(WIFI);
      await settle();
    }
    await jest.advanceTimersByTimeAsync(RESTORED_VISIBLE_MS + OUTAGE_DELAY_MS);
    expect(t.presenter.get()).toBeNull();
    expect(t.banners).toEqual([]); // every drop was shorter than 1 s: nothing was ever shown
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('blocksNetworkAction: only a known-offline state blocks', () => {
  test.each([
    [{ isOffline: true }, true],
    [{ isOffline: false, isSlow: true }, false],
    [{ isOffline: false, isServerDown: true }, false],
    [{ isOffline: false, isOnline: true }, false],
    [{}, false],
    [null, false],
    [undefined, false],
  ])('%j -> %s', (net, expected) => {
    expect(blocksNetworkAction(net)).toBe(expected);
  });
});

describe('loadFailureKey: what a failed read says', () => {
  const answered = (status) => Object.assign(new Error('x'), { status });
  const online = { isOffline: false, isServerDown: false };
  test.each([
    ['no answer, state offline', noAnswerError({ method: 'GET' }), { isOffline: true }, 'net_load_offline'],
    ['no answer, state unknown', noAnswerError({ method: 'GET' }), online, 'net_load_offline'],
    ['no answer, servers known down', noAnswerError({ method: 'GET' }), { isServerDown: true }, 'net_load_server'],
    ['timed out', noAnswerError({ method: 'GET', timedOut: true }), online, 'net_load_timeout'],
    ['HTTP 503', answered(503), online, 'net_load_server'],
    ['HTTP 500', answered(500), online, 'net_load_server'],
    ["HTTP 404 keeps the screen's own message", answered(404), online, null],
    ["HTTP 400 keeps the screen's own message", answered(400), online, null],
    ["HTTP 401 keeps the screen's own message", answered(401), online, null],
    ['HTTP 404 while the state says offline: the server ANSWERED, so its message stands', answered(404), { isOffline: true }, null],
    ['no error, state offline', undefined, { isOffline: true }, 'net_load_offline'],
    ['no error, servers down', undefined, { isServerDown: true }, 'net_load_server'],
    ['no error, all fine', undefined, online, null],
    ['a plain error with no status, state offline', new Error('boom'), { isOffline: true }, 'net_load_offline'],
    ['a plain error with no status, all fine', new Error('boom'), online, null],
    ['nothing at all', undefined, undefined, null],
  ])('%s -> %s', (_name, error, net, expected) => {
    expect(loadFailureKey({ error, net })).toBe(expected);
  });
  test('the raw "Network request failed" is never the message (the key is always a translated one)', () => {
    const key = loadFailureKey({ error: new TypeError('Network request failed'), net: { isOffline: true } });
    expect(key).toBe('net_load_offline');
  });
  test('a WRITE whose outcome is unknown is never worded as a plain failure', () => {
    for (const net of [{ isOffline: true }, { isServerDown: true }, {}]) {
      expect(loadFailureKey({ error: noAnswerError({ method: 'POST' }), net })).toBe('net_unconfirmed');
      expect(loadFailureKey({ error: noAnswerError({ method: 'POST', timedOut: true }), net })).toBe('net_unconfirmed');
    }
  });
  test('a write the server ANSWERED (refused) is not "unconfirmed"', () => {
    expect(loadFailureKey({ error: answered(400), net: {} })).toBeNull();
  });
});

describe('retryOnRestoration: read again ONCE after the connection returns', () => {
  test('nothing moved -> nothing happens', () => {
    expect(retryOnRestoration({ restoredCount: 2, seen: 2, enabled: true, failed: true })).toEqual({ seen: 2, retry: false, failed: true });
  });
  test('a restoration and a failed read -> exactly one retry, and the flag is spent', () => {
    expect(retryOnRestoration({ restoredCount: 3, seen: 2, enabled: true, failed: true })).toEqual({ seen: 3, retry: true, failed: false });
  });
  test('a restoration but nothing failed -> no retry (screens that loaded fine are not reloaded)', () => {
    expect(retryOnRestoration({ restoredCount: 3, seen: 2, enabled: true, failed: false })).toEqual({ seen: 3, retry: false, failed: false });
  });
  test('a disabled screen does not read, and keeps its failure for later', () => {
    expect(retryOnRestoration({ restoredCount: 3, seen: 2, enabled: false, failed: true })).toEqual({ seen: 3, retry: false, failed: true });
  });

  // A driver that behaves like useResource: a reload that fails marks the read as failed again.
  function driver({ reloadFails }) {
    let seen = 0;
    let failed = true; // the first load failed while offline
    let reloads = 0;
    return {
      restore(count) {
        const next = retryOnRestoration({ restoredCount: count, seen, enabled: true, failed });
        seen = next.seen;
        failed = next.failed;
        if (next.retry) { reloads += 1; if (reloadFails) failed = true; }
      },
      reloads: () => reloads,
    };
  }
  test('at most ONE retry per restoration, even if it fails again and the count is announced repeatedly', () => {
    const d = driver({ reloadFails: true });
    d.restore(1);
    d.restore(1);
    d.restore(1);
    expect(d.reloads()).toBe(1); // no loop: the failed retry waits for the next restoration
    d.restore(2);
    expect(d.reloads()).toBe(2);
    d.restore(2);
    expect(d.reloads()).toBe(2);
  });
  test('a retry that succeeds is not repeated at the next restoration', () => {
    const d = driver({ reloadFails: false });
    d.restore(1);
    d.restore(2);
    d.restore(3);
    expect(d.reloads()).toBe(1);
  });
  test('driven by the real store: a failed read is retried once when the connection returns, never while offline, never again by itself', async () => {
    const linkSubs = new Set();
    const store = createNetworkStore({ probe: async () => OK, subscribeLink: (cb) => { linkSubs.add(cb); return () => linkSubs.delete(cb); } });
    store.start();
    let seen = store.getState().restoredCount;
    let failed = true;
    let reloads = 0;
    store.subscribe((state) => {
      const next = retryOnRestoration({ restoredCount: state.restoredCount, seen, enabled: true, failed });
      seen = next.seen; failed = next.failed;
      if (next.retry) reloads += 1;
    });
    const link = (s) => linkSubs.forEach((cb) => cb(s));
    const settle = () => jest.advanceTimersByTimeAsync(0);
    link(WIFI); await settle();
    link(NONE); await settle();
    expect(reloads).toBe(0); // offline: nothing is retried while it cannot work
    link(WIFI); await settle();
    expect(reloads).toBe(1);
    await jest.advanceTimersByTimeAsync(MIN_PROBE_GAP_MS * 10);
    expect(reloads).toBe(1);
  });
});
