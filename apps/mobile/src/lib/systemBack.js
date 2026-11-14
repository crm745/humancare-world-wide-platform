// What the Android system back button (the bottom bar's back, or the back gesture) does. Pure (no React, no native modules), so it can be
// unit-tested; components/SystemBack.js applies it.
//
// The rule, in one place:
//   - If there is a screen to go back to, the navigator goes back to it. This is the SAME pop the app's own back button does
//     (router.back()), so the two can never disagree: Profile -> My Documents -> system back -> Profile.
//   - Only when there is NOTHING to go back to (a tab screen reached by tapping a tab, which clears the history; or a screen opened by a link)
//     the app's own fallback applies, exactly as its back button does: Home (see goBack in lib/nav.js).
//   - On Home, on the splash and on the sign-in screens there is no fallback: the phone's default stands (leaving the app).
import { isPublicRoute } from './authGuard';

// Public screens that are pages you open FROM somewhere (not where someone starts): with no history they fall back to Home like any
// other screen, as the app's back button does.
const OPENED_FROM_ELSEWHERE = new Set(['/terms', '/privacy', '/help-support']);

const normalise = (pathname) => {
  const path = String(pathname || '/').split('?')[0].split('#')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
};

// 'default': let the navigator / the phone handle it. 'home': go Home (the fallback of the app's own back button).
export function systemBackAction({ pathname, canGoBack }) {
  if (canGoBack) return 'default';
  const path = normalise(pathname);
  if (path === '/home') return 'default';
  if (isPublicRoute(path) && !OPENED_FROM_ELSEWHERE.has(path)) return 'default';
  return 'home';
}
