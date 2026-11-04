import { router } from 'expo-router';

// Mirrors the prototype's navReplace(): clear history, then show `path`.
export function navReplace(path) {
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
