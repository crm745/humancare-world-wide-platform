// WHEN the connection banner is on screen, as one app-wide fact. Pure (no React, no native modules; timers injectable), so every case is unit-tested.
//
// The network state itself (lib/network.js) is untouched: this only decides what to SHOW of it, and when.
//   - "No internet" and "We can't reach HumanCare servers" show only if the problem lasts longer than OUTAGE_DELAY_MS (1 s): a shorter blip shows nothing.
//   - "Slow connection" shows only if it lasts SLOW_DELAY_MS (3 s).
//   - A banner that is already showing changes to the new state at once (the screen cross-fades it in place): no waiting, no close and reopen.
//   - "Back online" shows only after a problem banner was really on screen. It stays RESTORED_VISIBLE_MS (2.5 s), then the banner closes.
//   - An unknown state (right after app start) shows nothing, and a state that is fine (online) shows nothing.
//
// It is ONE shared fact for the whole app (a singleton, fed by components/network/BannerDriver.js): every header that mounts a banner reads it, so a screen that opens while the phone is
// already offline finds the banner already there and draws it in place, with no enter animation (components/network/ConnectionBanner.js).
export const OUTAGE_DELAY_MS = 1000;
export const SLOW_DELAY_MS = 3000;
export const RESTORED_VISIBLE_MS = 2500;

const PROBLEM = { offline: 'offline', serverDown: 'serverDown', slow: 'slow' };
export const problemKindOf = (status) => PROBLEM[status] || null; // online, unknown and anything else are "fine"
export const delayFor = (kind) => (kind === 'slow' ? SLOW_DELAY_MS : OUTAGE_DELAY_MS);

export function createBannerPresenter({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let shown = null; // 'offline' | 'serverDown' | 'slow' | 'restored' | null: what is on screen now
  let pending = null; // { kind, timer }: a problem that has not lasted long enough yet
  let restoredTimer = null;
  const listeners = new Set();
  // The banners that are on the screen the person is LOOKING at (each header's banner registers while its screen is focused). A screen with no header has none.
  let hosts = 0;
  const visibleListeners = new Set();
  const isVisible = () => hosts > 0 && (shown === 'offline' || shown === 'serverDown' || shown === 'slow');
  const notifyVisible = () => { for (const listener of [...visibleListeners]) listener(); };

  const set = (next) => {
    if (next === shown) return;
    shown = next;
    for (const listener of [...listeners]) listener();
    notifyVisible();
  };
  const cancelPending = () => { if (pending) { clearTimer(pending.timer); pending = null; } };
  const cancelRestored = () => { if (restoredTimer !== null) { clearTimer(restoredTimer); restoredTimer = null; } };

  return {
    get: () => shown,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },

    // Whether a PROBLEM banner (offline, servers unreachable, slow) is really on the screen the person is looking at: a banner is showing AND the focused screen has one. A message that only
    // repeats the banner may be left out ONLY then (components/widgets.js Toast); on a screen with no header nothing says it, so the message must show.
    registerHost() { hosts += 1; notifyVisible(); let done = false; return () => { if (done) return; done = true; hosts -= 1; notifyVisible(); }; },
    isVisible,
    subscribeVisible(listener) { visibleListeners.add(listener); return () => { visibleListeners.delete(listener); }; },

    // Called with the network status ('online' | 'offline' | 'slow' | 'serverDown' | 'unknown') whenever it changes.
    observe(status) {
      const kind = problemKindOf(status);
      if (kind) {
        cancelRestored();
        if (shown) { cancelPending(); set(kind); return; } // already showing something: change it in place, at once
        if (pending && pending.kind === kind) return; // the same problem is already being timed
        cancelPending();
        pending = { kind, timer: setTimer(() => { pending = null; set(kind); }, delayFor(kind)) };
        return;
      }
      cancelPending(); // the problem ended before it lasted long enough: nothing was shown, so nothing is announced
      if (shown && shown !== 'restored') {
        set('restored');
        cancelRestored();
        restoredTimer = setTimer(() => { restoredTimer = null; set(null); }, RESTORED_VISIBLE_MS);
      }
    },

    dispose() { cancelPending(); cancelRestored(); listeners.clear(); visibleListeners.clear(); },
  };
}

// The one presenter of the app.
export const bannerPresenter = createBannerPresenter();
