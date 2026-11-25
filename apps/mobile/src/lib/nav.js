import { router } from 'expo-router';
import { createNavGuard, targetKey } from './navGuard';

// A second tap on the same tab (or the same redirect) within a moment is ignored: it would only dismiss and replace the screen all over again. Its own guard, apart from the router's.
const replaceGuard = createNavGuard();

// ---- the bottom tabs ---------------------------------------------------------------------------------------------------------------
// Home, Tracking, Requests, Profile (Cases for a corporate account) live in one tab navigator (app/(tabs)/_layout.js) and stay mounted. A tab is SWITCHED in place (router.navigate),
// never cleared and rebuilt. The group name is not part of an address, so these are the same routes as ever.
export const TAB_PATHS = ['/home', '/active-tracking', '/my-requests', '/profile', '/corporate-dashboard'];
const pathOf = (target) => (typeof target === 'string' ? target.split('?')[0] : (target && target.pathname) || '');
export const isTabTarget = (target) => TAB_PATHS.includes(pathOf(target));

// How many tab navigators are on screen (the tabs layout registers itself). Normally one; none before sign-in and after sign-out.
let tabsMounted = 0;
export function registerTabs() {
  tabsMounted += 1;
  return () => { tabsMounted = Math.max(0, tabsMounted - 1); };
}
export const tabsAreMounted = () => tabsMounted > 0;

// When the last tab switch (a tap on the bottom bar) happened: a screen that comes into front right after it knows it was a tab hop, not a return from a screen above it (lib/tabFocus.js).
let lastSwitchAt = 0;
export const lastTabSwitchAt = () => lastSwitchAt;

// Tapping another tab on the bottom bar: show that tab, which is already built (or is built now, the first time). Nothing is dismissed and no history is cleared.
export function switchTab(target) {
  lastSwitchAt = Date.now();
  router.navigate(target);
}

// Mirrors the prototype's navReplace(): clear history, then show `path`.
// A tab (Home after a request is sent, "All Active Requests") while the tabs are on screen: go back to them in place, so the screens that are already built are shown, and whatever sits above
// them is closed. Everything else (sign-in, sign-out, a screen that is not a tab, or a tab when none is on screen yet) clears the history and replaces, exactly as before.
export function navReplace(path) {
  if (!replaceGuard.allow(targetKey(path))) return;
  if (tabsMounted > 0 && isTabTarget(path)) {
    // The tab is already built, so its params would not change if they were the same as last time ("All Active Requests" twice): `at` makes each request new, and the screen reads it.
    router.navigate(typeof path === 'object' && path.params ? { ...path, params: { ...path.params, at: String(Date.now()) } } : path);
    return;
  }
  if (router.canDismiss()) router.dismissAll();
  router.replace(path);
}

// Tapping the tab you are already on: screens listen and scroll back to the top.
const reselectListeners = new Set();
export function onTabReselect(fn) {
  reselectListeners.add(fn);
  return () => reselectListeners.delete(fn);
}
export function emitTabReselect() {
  reselectListeners.forEach((fn) => fn());
}

// Mirrors the prototype's back(): pop, or fall back to Home when there is nothing to pop.
export function goBack() {
  if (router.canGoBack()) router.back();
  else navReplace('/home');
}
