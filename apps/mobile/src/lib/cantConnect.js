// The "Can't connect" screen (app/cant-connect.js): what it shows and where it leaves to. Pure (no React, no native modules), so it can be unit-tested.
//
// The screen is for a returning person whose saved session the server could not validate. It is PUBLIC and STATIC: it shows no account data, no request, no
// cached medical information, only a message, "Try again", a way to log in with another account, and the emergency call (the app's one SOS confirmation).
// It never decides anything about the session: the server does, and the app moves on by itself when the authentication status changes.
export const CANT_CONNECT_PATH = '/cant-connect';

// What the screen is, from the authentication status (lib/authState.js):
//   connecting   the session is being (re)validated: a spinner, nothing else is claimed
//   unreachable  the server could not be asked: "Can't connect", Try again, Log in
//   storage      the saved session could not be READ (a storage/keychain problem, not a network one): its own wording
//   leave        the answer is known: authed -> Home; anon (none, or refused by the server) -> Login
// An unknown status counts as connecting: nothing is shown or granted on a guess.
export function cantConnectView({ authStatus } = {}) {
  switch (authStatus) {
    case 'authed': return { mode: 'leave', leaveTo: '/home' };
    case 'anon': return { mode: 'leave', leaveTo: '/login' };
    case 'unreachable': return { mode: 'unreachable', leaveTo: null };
    case 'error': return { mode: 'storage', leaveTo: null };
    default: return { mode: 'connecting', leaveTo: null };
  }
}

// Why the server could not be reached, in the words of the network state (lib/network.js): no internet, or the internet works and our servers do not answer.
export const unreachableReason = (net) => (net && net.isOffline ? 'offline' : net && net.isServerDown ? 'server' : 'generic');

// English defaults. The screen asks t(key) first, so a translation added to data/i18n.json later is used without touching the screen; until then the English
// text shows (the translation file is not edited in this phase).
export const CANT_CONNECT_TEXT = Object.freeze({
  cc_connecting_title: 'Connecting…',
  cc_connecting_body: 'Checking your saved session.',
  cc_title: "Can't connect",
  cc_body_offline: 'No internet connection. Connect to the internet and we will continue automatically.',
  cc_body_server: "We can't reach HumanCare servers right now. We will continue automatically when they are back.",
  cc_body_generic: 'We could not check your saved session. We will continue automatically when the connection is back.',
  cc_storage_title: "We couldn't open your saved session",
  cc_storage_body: 'This is a problem with the phone, not the connection. Try again, or log in again.',
  cc_try_again: 'Try again',
  cc_safe: 'Your saved session is safe',
});

export const BODY_KEY = Object.freeze({ offline: 'cc_body_offline', server: 'cc_body_server', generic: 'cc_body_generic' });

// The text for a key: the translation if there is one, else the English default.
export function cantConnectText(t, key) {
  const translated = typeof t === 'function' ? t(key) : key;
  return translated && translated !== key ? translated : CANT_CONNECT_TEXT[key] || key;
}

// What the screen shows for a state, in the shared "not available" layout (components/network/StateView.js). NO logo and no Connecting screen: while the session is checked the splash stays
// (lib/splash.js), and this screen only appears when the check failed. A press of Try again shows the same state with the button busy.
//   offline / server / generic   the connection or the server is the problem: the saved session is untouched, so the green "Your saved session is safe" pill shows
//   storage                      the saved session could not be READ on the phone: its own wording, a device icon, no pill (nothing is known to be safe)
export function cantConnectState({ authStatus, net } = {}) {
  if (cantConnectView({ authStatus }).mode === 'storage') return { reason: 'storage', icon: 'device', titleKey: 'cc_storage_title', bodyKey: 'cc_storage_body', safePill: false };
  const reason = unreachableReason(net);
  return { reason, icon: reason === 'offline' ? 'wifiOff' : 'cloudOff', titleKey: 'cc_title', bodyKey: BODY_KEY[reason], safePill: true };
}
