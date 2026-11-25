// The device side of the idle session timeout (lib/idleSession.js): when the app returns to the front, and (on the web build used in development) the mouse and keys. Like lib/networkDevice.js and
// lib/draftStoreDevice.js it is the one place that listens: nothing else adds an AppState listener for this.
import { AppState, Platform } from 'react-native';

// callback() when the app comes back to the front. Returns the unsubscribe function.
export function subscribeAppActive(callback) {
  const subscription = AppState.addEventListener('change', (next) => { if (next === 'active') callback(); });
  return () => subscription.remove();
}

// callback() on any pointer press, key press or wheel (the web build only; on a phone the root View sees the touches). Returns the unsubscribe function.
export function subscribeWebActivity(callback) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return () => {};
  const types = ['pointerdown', 'keydown', 'wheel'];
  for (const type of types) document.addEventListener(type, callback, true);
  return () => { for (const type of types) document.removeEventListener(type, callback, true); };
}
