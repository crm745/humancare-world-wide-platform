import { useCallback, useRef } from 'react';
import {
  CHANNEL_NAME, PENDING_KEY, RESULT_KEY, WAIT_MAX_MS, buildGoogleAuthUrl, outcomeOf, randomToken,
} from './googleWebFlow';

// Google sign-in for the WEB build: Google's account chooser in a popup. The phone apps use googleAuth.native.js (Android's / iOS's own account
// picker) instead, because Google blocks this browser-redirect method for Android OAuth clients.
//
// The popup flow is the app's own (see lib/googleWebFlow.js for why expo-auth-session's was replaced: Google's Cross-Origin-Opener-Policy
// cuts window.opener and makes popup.closed read true, so that library gave up while the popup was still open and the popup ran the whole app).
// How it works now:
//   1. signIn() writes what it is waiting for (a random state and nonce) to localStorage and opens Google in a popup. This happens straight
//      from the tap (a browser only allows a popup that starts from one).
//   2. Google sends the popup back to the app's own origin with the answer in the address. The popup (lib/googleCallback.web.js, loaded before
//      anything else) hands the answer to this window through localStorage + a BroadcastChannel, and closes itself.
//   3. This window checks the answer is for THIS sign-in (state, and the nonce inside the token) and resolves with the ID token, which the
//      backend then verifies.
const POPUP_NAME = 'hc-google-signin';
const POPUP_FEATURES = 'popup=yes,width=500,height=650';

export const isGoogleConfigured = Boolean(process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB);

// Same shape as googleAuth.native.js: `signIn()` resolves to Google's ID token, or null if the person never finished or pressed Cancel;
// it rejects with a readable Error when something is wrong. `reopen()` brings the popup back if the person lost it (a second tap).
export function useGoogleSignIn() {
  const current = useRef(null); // { url } of the sign-in that is waiting

  const open = (url) => window.open(url, POPUP_NAME, POPUP_FEATURES);

  // Not async before window.open: the popup has to be opened inside the tap.
  const signIn = useCallback(() => {
    const clientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB;
    const state = randomToken();
    const nonce = randomToken();
    const url = buildGoogleAuthUrl({ clientId, redirectUri: window.location.origin, state, nonce });
    const pending = { state, nonce, at: Date.now() };
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    window.localStorage.removeItem(RESULT_KEY);
    current.current = { url };
    if (!open(url)) {
      window.localStorage.removeItem(PENDING_KEY);
      current.current = null;
      return Promise.reject(new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let channel = null;
      let timer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('storage', onStorage);
        if (channel) channel.close();
        window.localStorage.removeItem(RESULT_KEY); // the answer is used once and does not stay in storage
        window.localStorage.removeItem(PENDING_KEY);
        current.current = null;
        fn(value);
      };
      const onMessage = (message) => {
        const outcome = outcomeOf(message, pending);
        if (outcome.ignore) return;
        if (outcome.error) finish(reject, outcome.error);
        else finish(resolve, outcome.idToken);
      };
      function onStorage(event) {
        if (event.key !== RESULT_KEY || !event.newValue) return;
        try { onMessage(JSON.parse(event.newValue)); } catch { /* not ours */ }
      }
      window.addEventListener('storage', onStorage);
      try {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = (event) => onMessage(event.data);
      } catch { /* no BroadcastChannel: the storage event is enough */ }
      // The answer may already be there (it was written before this listener existed).
      try { const stored = window.localStorage.getItem(RESULT_KEY); if (stored) onMessage(JSON.parse(stored)); } catch { /* none */ }
      // Nobody can tell us the person closed the popup (Google cuts the link), so an attempt that is never finished ends on its own, quietly.
      timer = setTimeout(() => finish(resolve, null), WAIT_MAX_MS);
    });
  }, []);

  const reopen = useCallback(() => {
    if (current.current) open(current.current.url);
  }, []);

  return { ready: true, signIn, reopen };
}
