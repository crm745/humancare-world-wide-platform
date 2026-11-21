// What the shared offline experience shows, decided apart from React so every case can be unit-tested (Phase 2 of the network work).
// It only READS the network state (lib/network.js, through useNetwork()); it never touches authentication and never sends or resends anything.
import { classifyApiError, isOutcomeUnknown } from './apiErrors';

// ---- the global banner ---------------------------------------------------------------------------------------------------------------------
//   offline     no internet connection
//   slow        the connection is slow
//   serverDown  the internet works, our servers do not answer
//   restored    the connection is back (shown briefly, then hidden)
// One banner at a time.
// WHEN a banner shows (the 1 s / 3 s delays, "Back online" for 2.5 s) is decided once for the whole app: lib/bannerPresenter.js.
export { RESTORED_VISIBLE_MS } from './bannerPresenter';

// What each banner says and shows (components/network/ConnectionBanner.js): a title key and an optional text key (data/i18n.json net_*), the icon (components/network/icons.js) and the tone
// (theme/colors.js NOTICE). "Back online" is a title only.
export const BANNER = Object.freeze({
  offline: Object.freeze({ titleKey: 'net_offline', textKey: 'net_offline_text', icon: 'wifiOff', tone: 'warning' }),
  serverDown: Object.freeze({ titleKey: 'net_server_down', textKey: 'net_server_down_text', icon: 'cloudOff', tone: 'warning' }),
  slow: Object.freeze({ titleKey: 'net_slow', textKey: 'net_slow_text', icon: 'signal', tone: 'slow' }),
  restored: Object.freeze({ titleKey: 'net_restored', textKey: null, icon: 'wifi', tone: 'success' }),
});

export function bannerKind({ status, restoredVisible = false } = {}) {
  if (status === 'offline') return 'offline';
  if (status === 'serverDown') return 'serverDown';
  if (status === 'slow') return 'slow';
  return restoredVisible ? 'restored' : null; // online or not yet known: nothing, unless a restoration is being announced
}

// ---- actions that need the internet -------------------------------------------------------------------------------------------------------------
// Only a known-OFFLINE state blocks an action. "Slow" and "server unavailable" do not: those states come from a probe that may be stale, and a person
// must always be able to try (the call itself tells the truth, and its failure is worded safely). Forms stay editable: only the button that SENDS is blocked.
export const blocksNetworkAction = (net) => !!net && net.isOffline === true;

// ---- reading again once the connection is back ---------------------------------------------------------------------------------------------------
// useResource calls this whenever the restoration count may have moved. `seen` is the count it has already dealt with (it starts at the count the screen
// mounted with, so a restoration from before the screen existed is ignored), `failed` is whether its last READ failed.
//   returns { seen, retry, failed }: `retry` is true at most once per restoration, and only when the last read failed; the failure flag is spent as it
//   is used, so a retry that fails again waits for the NEXT restoration. Nothing here can resend a write: useResource only loads data.
export function retryOnRestoration({ restoredCount, seen, enabled = true, failed = false }) {
  if (restoredCount === seen) return { seen, retry: false, failed };
  const retry = !!enabled && !!failed;
  return { seen: restoredCount, retry, failed: retry ? false : failed };
}

// ---- what a failed load says ---------------------------------------------------------------------------------------------------------------------
// The translation key for the failure message of a READ, or null to keep the caller's own message (the screen's "couldn't load" text).
//   - a write whose outcome is unknown is never worded as a plain failure ("we couldn't confirm that this went through")
//   - no answer from the network: no internet, or (when the service knows) the servers are down
//   - no answer in time, or a 5xx: the servers are the problem
//   - a refusal or a session problem (the server ANSWERED) keeps the screen's own message
//   - no error at all (a screen that only knows it failed): what the network state says, if it says something
export function loadFailureKey({ error, net } = {}) {
  const state = net || {};
  if (isOutcomeUnknown(error)) return 'net_unconfirmed';
  const kind = error ? classifyApiError(error) : null;
  if (kind === 'network') return state.isServerDown ? 'net_load_server' : 'net_load_offline';
  if (kind === 'timeout') return 'net_load_timeout';
  if (kind === 'server') return 'net_load_server';
  if (error && kind !== 'unknown') return null;
  if (state.isOffline) return 'net_load_offline';
  if (state.isServerDown) return 'net_load_server';
  return null;
}

// ---- what a screen that could not load shows ----------------------------------------------------------------------------------------------------
// The icon and the title of the shared "could not load" layout (components/LoadFailure.js), from the same reading of the error as loadFailureKey:
//   no internet            wifi-off icon, the screen's own title ("Couldn't load your requests", ...), the offline text
//   servers unreachable    cloud-off icon, "Can't reach HumanCare", the server text
//   too slow               hourglass icon, "This is taking too long", the timeout text
//   anything else (a refusal, a missing item, a write of unknown outcome)  alert icon, the screen's own title, the screen's own text
// `screenTitleKey` is the screen's title key (lf_title_*); a screen that names none gets the generic one.
export function loadFailureView({ error, net, screenTitleKey } = {}) {
  const own = screenTitleKey || 'lf_title_generic';
  const key = loadFailureKey({ error, net });
  if (key === 'net_load_offline') return { reason: 'offline', icon: 'wifiOff', titleKey: own, bodyKey: key };
  if (key === 'net_load_server') return { reason: 'server', icon: 'cloudOff', titleKey: 'lf_title_server', bodyKey: key };
  if (key === 'net_load_timeout') return { reason: 'slow', icon: 'hourglass', titleKey: 'lf_title_slow', bodyKey: key };
  return { reason: 'other', icon: 'alert', titleKey: own, bodyKey: key };
}

// A toast that only repeats what the network banner already says ("No internet connection…", "Could not reach the server…"): while that message is on screen the toast is not drawn, so
// the person never sees two messages about the same thing at the bottom (components/widgets.js Toast).
const NETWORK_TOAST = /internet connection|reach the server|reach humancare|check your connection|connection was lost|took too long to answer|slow internet/i;
export const isNetworkToast = (message) => typeof message === 'string' && NETWORK_TOAST.test(message);
// ONLY while a problem banner is really on the screen the person is looking at (`bannerVisible`: lib/bannerPresenter.js isVisible). A screen with no header (login, register, the code screens, ...)
// has no banner, so an error there is never left out: the toast is the only thing that tells the person what happened.
export const hideToastForBanner = ({ message, bannerVisible = false } = {}) => bannerVisible === true && isNetworkToast(message);
