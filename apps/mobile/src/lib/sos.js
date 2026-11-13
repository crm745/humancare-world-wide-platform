// The floating SOS button's rules. Pure (no React, no native modules), so they can be unit-tested.
//
// What the button does is not decided here: it opens the same "Call Emergency Assistance?" confirmation as the red SOS
// banner on Home (components/sos/SosModal.js), which dials the same 24/7 line. This file only says WHERE the button
// shows and WHERE it sits.
export const FAB_CORE = 56; // the red circle (the only tappable part)
export const FAB_RIGHT = 16; // the core's distance from the right edge
export const FAB_GAP = 16; // the core's distance above whatever is under it
export const FAB_RING = 80; // the pulse ring, the biggest of the circles
export const FAB_CONTENT_PAD = 96; // extra room at the end of a scrolling screen, so the last item clears the button
export const TAB_BAR_HEIGHT = 64; // the bottom tab bar (BottomNav), before the safe-area inset

const normalise = (pathname) => {
  const path = String(pathname || '/').split('?')[0].split('#')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
};

// The screens that carry the bottom tab bar, and show this button above it.
export const TAB_ROUTES = ['/all-services', '/my-requests', '/profile'];

// Routes with no button. Home keeps its own red banner. The splash, Getting Started, login, create account and OTP /
// password screens are for someone who is not signed in yet. Corporate screens are matched by prefix, the request form
// by its folder.
const HIDDEN_ROUTES = new Set([
  '/home',
  '/', '/welcome',
  '/login', '/login-otp', '/choose-login',
  '/register', '/register-otp', '/complete-profile',
  '/forgot-password', '/forgot-password-otp', '/reset-password', '/set-password',
]);

export function isHiddenRoute(pathname) {
  const path = normalise(pathname);
  return HIDDEN_ROUTES.has(path) || path.startsWith('/corporate') || path === '/request' || path.startsWith('/request/');
}

// Whether the button shows. Signed-in patients only: not while the session is unknown, signed out or unreachable, and
// never for a corporate account. Everything else follows the route.
export function sosFabVisible({ pathname, authStatus, isCorporate = false, keyboardOpen = false } = {}) {
  if (authStatus !== 'authed') return false;
  if (isCorporate) return false;
  if (keyboardOpen) return false;
  return !isHiddenRoute(pathname);
}

export const isTabRoute = (pathname) => TAB_ROUTES.includes(normalise(pathname));

// How far the button's core sits above the bottom of the screen.
//   a tab screen                              16 above the tab bar (64 + the inset)
//   a screen with its own fixed bottom bar    16 above THAT bar (`barHeight` is its whole height, inset included)
//   anything else                             16 above the bottom safe-area inset
export function fabBottom({ pathname, insetBottom = 0, barHeight = 0 }) {
  const inset = Number.isFinite(insetBottom) && insetBottom > 0 ? insetBottom : 0;
  if (isTabRoute(pathname)) return TAB_BAR_HEIGHT + inset + FAB_GAP;
  if (Number.isFinite(barHeight) && barHeight > 0) return barHeight + FAB_GAP;
  return inset + FAB_GAP;
}

// The extra bottom padding a scrolling screen gets while the button shows.
export const fabContentPad = (visible) => (visible ? FAB_CONTENT_PAD : 0);

// The number the confirmation dials: the app's one 24/7 emergency line (data/mock.js EMERGENCY_TEL).
export const emergencyUrl = (tel) => `tel:${tel}`;

// ---- the pulse -----------------------------------------------------------------------------------------------------
export const PULSE = Object.freeze({ runs: 3, duration: 1800, rest: 500, scaleFrom: 0.86, scaleTo: 1.2, opacityFrom: 0.6, opacityTo: 0 });

// A fixed bottom bar on the screen in front reports its height here, so the button can sit above it. A plain store
// (no React) with one value; components/sos/useFixedBar.js connects screens to it.
let fixedBar = 0;
const listeners = new Set();
export const getFixedBar = () => fixedBar;
export function setFixedBar(height) {
  const next = Number.isFinite(height) && height > 0 ? Math.round(height) : 0;
  if (next === fixedBar) return;
  fixedBar = next;
  listeners.forEach((fn) => fn());
}
export function subscribeFixedBar(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
