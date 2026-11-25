// How the network messages MOVE. Pure numbers and rules (no React, no animation library), so they are unit-tested; the components apply them with react-native-reanimated, which runs on the UI thread
// (nothing sets React state on a frame: state changes once, when the banner changes).
export const BANNER_ENTER_MS = 220; // height 0 -> full, content fades in and slides down 8 px; ease-out cubic-bezier(0.2, 0, 0, 1)
export const BANNER_EXIT_MS = 180; // the reverse; ease-in cubic-bezier(0.4, 0, 1, 1)
export const BANNER_SWAP_MS = 200; // a state change while visible: icon, text and colours cross-fade in place (and the height, if it differs)
export const BANNER_SLIDE_PX = 8;
export const COLLAPSE_MS = 180; // the helper lines: fade in + height expand, and the reverse
export const BUTTON_FADE_MS = 150; // a button going pale (offline) or back
export const REDUCED_FADE_MS = 100; // Reduce Motion: no sliding and no height animation, at most this short fade

export const EASE_OUT = [0.2, 0, 0, 1];
export const EASE_IN = [0.4, 0, 1, 1];

// What to do when the banner to show changes. `mounted` is false on the very first render of a screen's banner: a screen that opens while the phone is already offline shows it in place.
//   none    nothing changes
//   settle  first render with a banner already showing: draw it as it is, no animation at all
//   enter   nothing -> a banner
//   exit    a banner -> nothing
//   swap    one banner -> another: cross-fade in place, never close and reopen
export function planBannerTransition(previous, next, { mounted = true } = {}) {
  if (!mounted) return next ? 'settle' : 'none';
  if (previous === next) return 'none';
  if (!previous && next) return 'enter';
  if (previous && !next) return 'exit';
  return 'swap';
}

// The timings of one transition. Reduce Motion: no slide, no height animation (the height is set at once), only a very short fade.
export function bannerTimings(plan, reduceMotion) {
  if (plan === 'none' || plan === 'settle') return { fadeMs: 0, heightMs: 0, slidePx: 0 };
  if (reduceMotion) return { fadeMs: REDUCED_FADE_MS, heightMs: 0, slidePx: 0 };
  if (plan === 'enter') return { fadeMs: BANNER_ENTER_MS, heightMs: BANNER_ENTER_MS, slidePx: BANNER_SLIDE_PX, easing: EASE_OUT };
  if (plan === 'exit') return { fadeMs: BANNER_EXIT_MS, heightMs: BANNER_EXIT_MS, slidePx: BANNER_SLIDE_PX, easing: EASE_IN };
  return { fadeMs: BANNER_SWAP_MS, heightMs: BANNER_SWAP_MS, slidePx: 0, easing: EASE_OUT };
}

// The same for a helper line (Collapse) and for a button's opacity.
export function collapseTimings(reduceMotion) {
  return reduceMotion ? { fadeMs: REDUCED_FADE_MS, heightMs: 0 } : { fadeMs: COLLAPSE_MS, heightMs: COLLAPSE_MS };
}
export const buttonFadeMs = (reduceMotion) => (reduceMotion ? 0 : BUTTON_FADE_MS);

// The height a banner of this kind had the last time it was measured, so a screen that opens with it already showing can draw it at full height at once (no jump when the real
// measurement arrives). Kept per kind for the session; a first-ever guess is the usual two-line height.
export const DEFAULT_BANNER_HEIGHT = 57;
const measured = new Map();
export const rememberBannerHeight = (kind, height) => { if (kind && Number.isFinite(height) && height > 0) measured.set(kind, Math.round(height)); };
export const bannerHeightFor = (kind) => measured.get(kind) || DEFAULT_BANNER_HEIGHT;
