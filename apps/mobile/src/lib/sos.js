// The floating SOS button's rules. Pure (no React, no native modules), so they can be unit-tested.
//
// What the button does is not decided here: it opens the same "Call Emergency Assistance?" confirmation as the red SOS
// banner on Home (components/sos/SosModal.js), which dials the same 24/7 line. This file only says WHERE the button
// shows and WHERE it sits.
export const FAB_CORE = 56; // the red circle (the only tappable part)
export const FAB_RIGHT = 16; // the core's distance from the right edge
export const FAB_GAP = 16; // the core's distance above where the tab bar ends
export const FAB_RING = 80; // the pulse ring, the biggest of the circles
export const TAB_BAR_HEIGHT = 64; // the bottom tab bar (BottomNav), before the safe-area inset

const normalise = (pathname) => {
  const path = String(pathname || '/').split('?')[0].split('#')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
};

// Routes with no button. Home keeps its own red banner. The splash, Getting Started, login, create account and OTP /
// password screens are for someone who is not signed in yet. Corporate screens are matched by prefix, the request form
// by its folder.
const HIDDEN_ROUTES = new Set([
  '/home',
  '/document-preview', // a full-screen preview: the button would sit on the document
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

// How far the button's core sits above the bottom of the screen: the SAME place on every screen, 16 above where the tab bar
// ends (64 plus the bottom inset). Tab screens have the bar there; the other screens leave that space empty, so the button
// does not move when you go from one screen to another.
export function fabBottom({ insetBottom = 0 } = {}) {
  const inset = Number.isFinite(insetBottom) && insetBottom > 0 ? insetBottom : 0;
  return TAB_BAR_HEIGHT + inset + FAB_GAP;
}

// ---- room at the end of a scrolling screen --------------------------------------------------------------------------------
// The button floats over the bottom of every screen it shows on, so the last item of a long list must be able to scroll above
// it. ONE rule for every screen, measured from the bottom edge of the scroll area:
//   clearance  how far the top of the button (plus 16) is above that edge. The button's core spans from fabBottom() to
//              fabBottom() + 56 above the SCREEN's bottom; a scroll area that ends above the tab bar, or above the screen's
//              own bottom bar (`edge` tall, safe-area inset included), starts that much higher. On a tab screen
//              (edge 64 + inset) this is 16 + 56 + 16 = 88.
//   padding    max(the screen's own bottom padding, the clearance): never the two added together. The inset is not added
//              again where a bar already covers it: it is in `edge`, and cancels.
//   fits       when the last item already ends above the button's zone, nothing is added, so a screen whose content fits does
//              not scroll for the button's sake.
export function fabClearance({ edge = 0, insetBottom = 0 } = {}) {
  const e = Number.isFinite(edge) && edge > 0 ? edge : 0;
  return Math.max(0, fabBottom({ insetBottom }) + FAB_CORE + FAB_GAP - e);
}

// `itemsHeight`: the height of the scrolling content WITHOUT its bottom padding; `viewHeight`: the height of the scroll area.
// Both 0 (not measured yet) means "assume it overflows".
export function scrollPadFor({ ownPad = 0, visible = false, clearance = 0, itemsHeight = 0, viewHeight = 0 } = {}) {
  const own = Number.isFinite(ownPad) && ownPad > 0 ? ownPad : 0;
  if (!visible) return own;
  if (itemsHeight > 0 && viewHeight > 0 && itemsHeight <= viewHeight - clearance) return own;
  return Math.max(own, clearance);
}

// The number the confirmation dials: the app's one 24/7 emergency line (data/mock.js EMERGENCY_TEL).
export const emergencyUrl = (tel) => `tel:${tel}`;

// ---- the pulse -----------------------------------------------------------------------------------------------------
export const PULSE = Object.freeze({ runs: 3, duration: 1800, rest: 500, scaleFrom: 0.86, scaleTo: 1.2, opacityFrom: 0.6, opacityTo: 0 });
