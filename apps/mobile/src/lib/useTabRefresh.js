import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { lastTabSwitchAt } from './nav';

// The tab screens stay mounted (app/(tabs)/_layout.js), so they no longer load their data again each time they are opened. This brings it up to date when a tab comes back into front,
// quietly (the list stays on screen; no skeleton, no spinner), and not more often than needed:
//   - a HOP between tabs (the bottom bar was just tapped): only when what is shown is older than HOP_GAP_MS, so going Home -> Requests -> Home does not ask the server three times;
//   - a RETURN from a screen above the tabs (a request was just sent, a case was just created, a document was opened): when it is older than RETURN_GAP_MS, so a new request is on Home at once.
// The first time a tab comes into front is its mount, which loads its data by itself.
export const HOP_GAP_MS = 30 * 1000;
export const RETURN_GAP_MS = 2 * 1000;
export const SWITCH_WINDOW_MS = 600; // a focus this soon after a tap on the bottom bar is a hop

// Pure, so it can be unit-tested: `lastLoadAt` when the data on screen was loaded, `lastSwitchAt` when the bottom bar was last tapped (0: never).
export function shouldRefreshOnFocus({ now, lastLoadAt, lastSwitchAt }) {
  const hop = lastSwitchAt > 0 && now - lastSwitchAt >= 0 && now - lastSwitchAt <= SWITCH_WINDOW_MS;
  return now - lastLoadAt >= (hop ? HOP_GAP_MS : RETURN_GAP_MS);
}

// `reload`: the screen's useResource reload (it keeps what is on screen if the read fails). `enabled` false: nothing is loaded for this screen (a corporate account on Home).
export function useRefreshOnFocus(reload, { enabled = true } = {}) {
  const loadedAt = useRef(0); // set at the first focus, which is the mount that loaded the data
  const firstFocus = useRef(true);
  useFocusEffect(useCallback(() => {
    if (firstFocus.current) { firstFocus.current = false; loadedAt.current = Date.now(); return; } // the mount already loaded it
    if (!enabled) return;
    const now = Date.now();
    if (shouldRefreshOnFocus({ now, lastLoadAt: loadedAt.current, lastSwitchAt: lastTabSwitchAt() })) {
      loadedAt.current = now;
      reload();
    }
  }, [reload, enabled]));
}
