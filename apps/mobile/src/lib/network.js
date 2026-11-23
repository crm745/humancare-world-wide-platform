// The network state, kept apart from React and from the native modules so every transition can be unit-tested (like authState.js).
//
//   unknown     nothing has been learned yet (the first moments after launch): treated as "not offline", so nothing flashes
//   online      the device has a link, the internet is reachable and the backend's /health answered quickly
//   slow        the backend answers, but slowly (or one /health attempt timed out)
//   offline     no link at all (NetInfo isConnected === false), or no NetInfo and no answer at all
//   serverDown  the internet works but the backend does not answer (or answers 5xx on /health)
// plus the one-off event `restored`: the state left offline / serverDown for online / slow.
//
// Three independent signals are combined, none trusted alone:
//   link        NetInfo: isConnected and isInternetReachable (tri-state: true / false / null = not known yet). Only isConnected === false is proof of "no link". isInternetReachable === false is a HINT:
//               NetInfo tests its own address (Google), which a Wi-Fi without upstream or a blocked test fails while our backend on the LAN or behind its own route works. The backend's /health decides.
//   backend     GET /health, asked only when something suggests it is worth asking (below)
//   real calls  what each API call came to (networkReporter.js: 'ok' | 'server' | 'network' | 'timeout')
// "online" means REACHABLE, not healthy: /health only shows that the server process answers, not that the database or any dependency works.
// A call that fails with a 5xx is still that call's own failure; one 5xx never makes the state serverDown.
//
// Probing is deliberately rare. /health is asked only: (1) when the link comes up or its kind changes, (2) when a real call failed without an
// answer, timed out or got a 5xx, (3) when the app returns to the foreground after a while or while degraded, (4) on a slow back-off timer, ONLY
// while the state is not online (1.5 s, 3 s, 5 s, 10 s ... then every 60 s, and not while the app is in the background). While online and healthy there is no
// timer and no polling. Two probes are never closer than MIN_PROBE_GAP_MS, and only one is ever in flight, so a burst of failing calls is one probe.
//
// TWO KINDS OF FACT, kept apart:
//   the LINK (NetInfo)   whether the phone is connected: offline comes from here, and only from here (plus the no-NetInfo fallback below)
//   the BACKEND (/health) whether our server answers: serverDown and slow come from here
// A /health failure never says "no internet" on a phone whose link is up: it says the server could not be reached. An answer is also only ever applied to the link state it was ASKED under: a
// probe that was in flight when the link changed (dropped, or came back) belongs to the past and is thrown away, so a late answer can never overwrite a newer state.
// Right after a link comes up the first questions are quick (LINK_UP_RECHECK_MS), because a radio that has just reconnected often refuses the first request; the slow back-off only starts after those.
// Two things keep recovery quick without more probing:
//   - a change of ONLY NetInfo's isInternetReachable hint (same network, same kind) is not a new link state: it neither throws away a /health answer that is on its way nor restarts the quick questions
//     (NetInfo tests its own address a few seconds after a Wi-Fi joins, and on a LAN-only Wi-Fi that test says "not reachable" while our backend is perfectly reachable);
//   - while the phone is known to be OFFLINE it re-reads the phone's connection every OFFLINE_LINK_RECHECK_MS (a local read, no request to anything) so a late or missed NetInfo event cannot keep
//     "offline" on screen;
//   - in the same watch the backend's /health is ALSO asked (single-flight): an answer from it proves the phone is connected, whatever NetInfo has or has not said yet (offlineProbe).
// Nothing here touches authentication, tokens or any request: it only reports. A network failure never signs anyone out and nothing is resent.
export const NET = Object.freeze({ UNKNOWN: 'unknown', ONLINE: 'online', OFFLINE: 'offline', SLOW: 'slow', SERVER_DOWN: 'serverDown' });

export const SLOW_PROBE_MS = 3500; // a /health answer slower than this is "slow"
export const MIN_PROBE_GAP_MS = 1500; // no two probes closer than this (unless a link change forces one)
export const FOREGROUND_STALE_MS = 30000; // returning to the app re-checks only if the last probe is older than this
export const DEGRADED_RECHECK_MS = Object.freeze([1500, 3000, 5000, 10000, 20000, 40000, 60000]); // back-off while not online (never closer than MIN_PROBE_GAP_MS); the last value repeats, so never faster than once a minute at the end
export const LINK_UP_RECHECK_MS = Object.freeze([500, 1000, 1500, 2500, 4000, 6000]); // the first questions after a link comes up: the radio may not be ready yet
export const OFFLINE_LINK_RECHECK_MS = 500; // while the phone is KNOWN to have no link, ask the phone (not the backend) this often whether it has one: NetInfo's event can be late or missed
export const OFFLINE_PROBE_EVERY = 3; // while OFFLINE, every this many link re-reads (500 ms each) the backend's /health is ALSO asked once: reaching it proves the phone is connected whatever NetInfo says
export const RECOVERY_PROBE_TIMEOUT_MS = 2000; // a probe asked while recovering gives up after this (a just-reconnected radio often swallows packets); normal probes keep the probe's own limit

const DEGRADED = new Set([NET.OFFLINE, NET.SERVER_DOWN, NET.SLOW]);
const OUTAGE = new Set([NET.OFFLINE, NET.SERVER_DOWN]);

const tri = (value) => (value === true ? true : value === false ? false : null);

// A NetInfo state -> the small, stable shape used here.
export const normalizeLink = (state) => ({
  isConnected: tri(state && state.isConnected),
  isInternetReachable: tri(state && state.isInternetReachable),
  type: (state && state.type) || 'unknown',
});

const linkKey = (link) => `${link.isConnected}|${link.isInternetReachable}|${link.type}`;
// Which network the phone is on: connected or not, and of which kind. The reachability hint is not part of it.
const networkKey = (link) => `${link.isConnected}|${link.type}`;
// Hard offline: the phone has no link. NetInfo's isInternetReachable === false alone does NOT count: it says nothing about our backend, which /health is asked about.
const linkIsDown = (link) => link.isConnected === false;

const INITIAL = Object.freeze({
  status: NET.UNKNOWN,
  link: Object.freeze({ isConnected: null, isInternetReachable: null, type: 'unknown' }),
  lastCheckedAt: null, // when the state was last confirmed by a probe or a real call
  restoredAt: null,
  restoredCount: 0,
});

// probe()              -> Promise<{ ok, status?, timedOut?, ms }>   (healthProbe.js; never rejects)
// subscribeLink(cb)    -> unsubscribe   cb(netInfoState), also once straight away with the current state
// subscribeAppActive(cb) -> unsubscribe   cb(true) when the app comes to the foreground, cb(false) when it leaves it
// refreshLink()        -> Promise<netInfoState | null>   (optional) asks the phone for its connection NOW, instead of waiting for the next NetInfo event
export function createNetworkStore({ probe, subscribeLink, subscribeAppActive = () => () => {}, refreshLink = null, now = () => Date.now() }) {
  let state = INITIAL;
  const listeners = new Set();
  const restoredListeners = new Set();
  let started = false;
  let unsubLink = null;
  let unsubApp = null;
  let appActive = true;
  let probePromise = null;
  let lastProbeAt = 0;
  let failStreak = 0;
  let recheckTimer = null;
  let recheckIndex = 0;
  let offlineTimer = null;
  let offlineTick = 0;
  let offlineProbing = false; // single-flight for the probe asked while OFFLINE
  let generation = 0; // moved by stop(), so an answer that arrives after it is dropped
  let linkEpoch = 0; // moved by every change of the link: a /health answer is applied only to the epoch it was asked in
  let probeEpoch = -1; // the epoch of the probe in flight
  let fastIndex = LINK_UP_RECHECK_MS.length; // < length: the quick questions after a link came up are still to be asked
  let recovering = false; // the link came back after being down and the backend has not answered yet: the phone is no longer OFFLINE, the outage is not over

  const emit = () => listeners.forEach((fn) => { try { fn(state); } catch { /* a faulty subscriber must not stop the others */ } });

  function set(patch) {
    const next = { ...state, ...patch };
    const changed = Object.keys(patch).some((key) => key === 'link' ? linkKey(patch.link) !== linkKey(state.link) : patch[key] !== state[key]);
    if (!changed) return;
    const wasOutage = OUTAGE.has(state.status) || recovering;
    state = next;
    if (OUTAGE.has(next.status)) recovering = false; // still (or again) down: the plain outage rule applies
    if (wasOutage && (next.status === NET.ONLINE || next.status === NET.SLOW)) {
      recovering = false;
      state = { ...state, restoredAt: now(), restoredCount: state.restoredCount + 1 };
      emit();
      restoredListeners.forEach((fn) => { try { fn(state); } catch { /* same */ } });
      return;
    }
    emit();
  }

  const clearRecheck = () => { if (recheckTimer) { clearTimeout(recheckTimer); recheckTimer = null; } };
  const clearOfflineWatch = () => { if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; } };
  // While the link is known to be down (and the app is in front, and the phone can be asked), re-read the phone's connection every OFFLINE_LINK_RECHECK_MS. No backend traffic.
  function scheduleOfflineWatch() {
    clearOfflineWatch();
    if (!started || !appActive || !refreshLink || !linkIsDown(state.link) || state.status !== NET.OFFLINE) return;
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      refresh();
      offlineTick += 1;
      if (offlineTick % OFFLINE_PROBE_EVERY === 0) offlineProbe();
      scheduleOfflineWatch();
    }, OFFLINE_LINK_RECHECK_MS);
  }

  // The phone says it has no link, but a late or missed NetInfo event (Android can take seconds to report a Wi-Fi that is already usable) must not keep "offline" on screen: the backend is ALSO asked, single-flight,
  // with the short recovery limit. While there is really no link the request fails at once and nothing changes. If the backend ANSWERS (any HTTP answer), the phone is plainly connected: the outage is
  // over for the phone (buttons work), the answer is applied as that of a link that has just come up, and the restoration is announced like any other. An answer for a link state that has since changed is thrown away.
  function offlineProbe() {
    if (offlineProbing || !started || !appActive || state.status !== NET.OFFLINE || !linkIsDown(state.link)) return;
    offlineProbing = true;
    const mine = generation;
    const epoch = linkEpoch;
    (async () => {
      let result;
      try { result = await probe({ timeoutMs: RECOVERY_PROBE_TIMEOUT_MS }); } catch { result = { ok: false, ms: 0 }; }
      if (mine !== generation || !started || epoch !== linkEpoch || state.status !== NET.OFFLINE) return;
      if (!result.ok && !result.status) return; // no answer: still no link (or the backend is unreachable too: the phone's own word stands)
      linkEpoch += 1;
      clearOfflineWatch();
      const type = state.link.type && state.link.type !== 'none' ? state.link.type : 'unknown';
      recovering = true;
      state = { ...state, link: { isConnected: true, isInternetReachable: true, type }, status: NET.UNKNOWN };
      emit();
      recheckIndex = 0;
      applyProbe(result, true);
    })().finally(() => { offlineProbing = false; });
  }

  // The slow back-off, only while degraded, only while the app is in front, and never while the link is known to be down (NetInfo then wakes us).
  function scheduleRecheck() {
    clearRecheck();
    if (!started || !appActive || linkIsDown(state.link)) return;
    const quickPhase = fastIndex < LINK_UP_RECHECK_MS.length; // the quick questions after a link-up are still to be asked (also while the state is not degraded yet)
    if (!quickPhase && !DEGRADED.has(state.status) && !recovering) return;
    let delay;
    if (quickPhase) { delay = LINK_UP_RECHECK_MS[fastIndex]; fastIndex += 1; } else { delay = DEGRADED_RECHECK_MS[Math.min(recheckIndex, DEGRADED_RECHECK_MS.length - 1)]; recheckIndex += 1; }
    recheckTimer = setTimeout(() => { recheckTimer = null; runProbe({ force: true, recovery: quickPhase }); }, delay);
  }

  function settle(next) {
    if (next === NET.ONLINE) { failStreak = 0; recheckIndex = 0; fastIndex = LINK_UP_RECHECK_MS.length; clearRecheck(); }
    set({ status: next, lastCheckedAt: now() });
    if (next !== NET.ONLINE) scheduleRecheck();
  }

  // What a finished probe means.
  function applyProbe(result, recovery = false) {
    // A recovery probe that timed out proves nothing: not ONLINE, not SLOW. The next quick question follows; only when the quick ones are used up is the backend called unreachable.
    if (recovery && result.timedOut) {
      if (fastIndex >= LINK_UP_RECHECK_MS.length) return settle(NET.SERVER_DOWN);
      scheduleRecheck();
      return undefined;
    }
    if (result.ok) {
      failStreak = 0;
      settle(result.ms >= SLOW_PROBE_MS ? NET.SLOW : NET.ONLINE);
      return;
    }
    failStreak += 1;
    if (result.status) return settle(NET.SERVER_DOWN); // it answered, but not OK (502, 503, ...)
    // No answer at all.
    if (result.timedOut) return settle(failStreak < 2 && state.status !== NET.SERVER_DOWN && state.status !== NET.OFFLINE ? NET.SLOW : NET.SERVER_DOWN);
    // A quick failure to connect. With the link UP the phone is connected: it is the backend that could not be reached (or the radio is still waking up, which the quick re-asks after a link-up cover),
    // never "no internet". Only when nothing is known about the link at all (a build without NetInfo) does a failure to connect say offline.
    // (NetInfo saying "internet not reachable" does not change that: the answer of our own /health is what counts.)
    return settle(state.link.isConnected === true || state.link.isInternetReachable === true ? NET.SERVER_DOWN : NET.OFFLINE);
  }

  function runProbe({ force = false, recovery = false } = {}) {
    if (!started) return Promise.resolve();
    if (linkIsDown(state.link)) return Promise.resolve(); // known offline: nothing to ask
    if (probePromise && probeEpoch === linkEpoch) return probePromise; // one at a time, for the link state we are in
    if (!force && lastProbeAt && now() - lastProbeAt < MIN_PROBE_GAP_MS) return Promise.resolve();
    lastProbeAt = now();
    const mine = generation;
    const epoch = linkEpoch;
    probeEpoch = epoch;
    const current = (async () => {
      let result;
      try { result = await (recovery ? probe({ timeoutMs: RECOVERY_PROBE_TIMEOUT_MS }) : probe()); } catch { result = { ok: false, timedOut: false, ms: 0 }; }
      if (mine !== generation || !started) return; // stopped meanwhile
      if (epoch !== linkEpoch) return; // the link changed while asking: this answer is about a state that no longer exists
      if (linkIsDown(state.link)) return; // went offline while asking: the link wins
      applyProbe(result, recovery);
    })().finally(() => { if (probePromise === current) probePromise = null; });
    probePromise = current;
    return current;
  }

  function onLink(netInfoState) {
    const link = normalizeLink(netInfoState);
    if (linkKey(link) === linkKey(state.link) && state.status !== NET.UNKNOWN) return; // the same thing said again: nothing to do
    const previous = state.link;
    // Only the reachability HINT changed (same network: same connected flag and kind): that says nothing about OUR backend, so it is not a new link state. A probe in flight stays valid, the quick
    // questions are not restarted, and when the internet has just been confirmed while the backend is still unconfirmed, one question is asked (single-flight, so never a second).
    // (A link that was not known before - connected null - is never a hint change: the first real reading always starts the questions.)
    if (previous.isConnected !== null && networkKey(link) === networkKey(previous)) {
      set({ link });
      if (link.isInternetReachable === true && (DEGRADED.has(state.status) || recovering || state.status === NET.UNKNOWN)) runProbe({ force: true, recovery: recovering });
      return;
    }
    linkEpoch += 1; // every real change of the link starts a new epoch: probes asked before it are dropped
    if (linkIsDown(link)) {
      recovering = false;
      fastIndex = LINK_UP_RECHECK_MS.length;
      clearRecheck();
      failStreak = 0;
      recheckIndex = 0;
      offlineTick = 0;
      set({ link, status: NET.OFFLINE, lastCheckedAt: now() });
      scheduleOfflineWatch();
      return;
    }
    clearOfflineWatch();
    set({ link });
    // The link is up again after being down: the phone is no longer offline (a Verify or Submit button is enabled at once), while the backend is asked. It is "not known yet" until that answers, and the
    // outage is only over (the restoration is announced) when it does.
    if (state.status === NET.OFFLINE) { recovering = true; set({ status: NET.UNKNOWN }); }
    // A link has come up, or its kind changed (Wi-Fi <-> mobile): find out whether the backend answers. Shown state stays as it was until it does.
    if (linkKey(link) !== linkKey(previous) || state.status === NET.UNKNOWN) { recheckIndex = 0; fastIndex = 0; runProbe({ force: true, recovery: true }); }
  }

  // Asks the phone for its connection NOW (NetInfo can be late with its event) and feeds the answer through the same path as an event. Errors and a missing answer change nothing.
  function refresh() {
    if (!refreshLink || !started) return;
    Promise.resolve().then(refreshLink).then((netInfoState) => { if (netInfoState && started) onLink(netInfoState); }).catch(() => undefined);
  }

  function onAppActive(active) {
    appActive = active === true;
    if (!appActive) { clearRecheck(); clearOfflineWatch(); return; }
    refresh();
    scheduleOfflineWatch();
    const stale = !lastProbeAt || now() - lastProbeAt > FOREGROUND_STALE_MS;
    // Coming back to the app (e.g. from the Wi-Fi settings) while the backend is not confirmed: ask NOW, not after the gap.
    if (DEGRADED.has(state.status) || state.status === NET.UNKNOWN || stale) runProbe({ force: DEGRADED.has(state.status) || state.status === NET.UNKNOWN });
    scheduleRecheck();
  }

  function reportOutcome(outcome) {
    if (!started) return;
    if (outcome === 'ok') {
      // An HTTP answer below 500 arrived: the server is reachable, whatever else was believed (NetInfo can lag behind).
      if (state.status !== NET.ONLINE) { failStreak = 0; settle(NET.ONLINE); }
      return;
    }
    // A call that got no answer: ask the phone whether it is still connected (its event may be late), and ask /health (gap-limited and single-flight).
    if (outcome === 'network' || outcome === 'timeout') refresh();
    if (outcome === 'network' || outcome === 'timeout' || outcome === 'server') runProbe();
  }

  const store = {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onRestored(fn) { restoredListeners.add(fn); return () => restoredListeners.delete(fn); },
    reportOutcome,
    // Asks now (a "Try again" tap): bypasses the gap, still single-flight.
    check: () => { refresh(); return runProbe({ force: true }); },

    // Idempotent: a second start() adds no second listener.
    start() {
      if (started) return undefined;
      started = true;
      generation += 1;
      unsubApp = subscribeAppActive(onAppActive);
      unsubLink = subscribeLink(onLink);
      return undefined;
    },
    stop() {
      if (!started) return;
      started = false;
      generation += 1;
      clearRecheck();
      clearOfflineWatch();
      if (unsubLink) { unsubLink(); unsubLink = null; }
      if (unsubApp) { unsubApp(); unsubApp = null; }
      probePromise = null;
    },
    // For tests: how many listeners are attached.
    listenerCount: () => listeners.size + restoredListeners.size,
  };
  return store;
}
