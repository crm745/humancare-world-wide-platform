import { CHANNEL_NAME, PENDING_KEY, RESULT_KEY, isOurCallback, parseCallbackHash } from './googleWebFlow';

// The WEB popup, back from Google. This module is the FIRST thing the app loads (app/_layout.js imports it before everything else), so it
// runs before any screen and before any redirect: if this window was opened for a Google sign-in and Google has just sent it back, it hands the
// answer to the window that is waiting (same-origin storage + BroadcastChannel, which work even when Google's Cross-Origin-Opener-Policy has cut
// window.opener), takes the answer out of the address, and tries to close itself. The app is NOT started in this window: _layout shows a
// "Signing you in" note instead, so the popup never walks through the splash and Getting Started.
function read() {
  if (typeof window === 'undefined') return null;
  try {
    const callback = parseCallbackHash(window.location.hash);
    if (!callback) return null;
    const pending = JSON.parse(window.localStorage.getItem(PENDING_KEY) || 'null');
    return isOurCallback(callback, pending, Date.now()) ? callback : null;
  } catch {
    return null;
  }
}

export const googleCallback = read();

function hand(callback) {
  const message = { state: callback.state, idToken: callback.idToken, error: callback.error };
  try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* the address keeps its fragment: harmless */ }
  try { window.localStorage.setItem(RESULT_KEY, JSON.stringify({ ...message, at: Date.now() })); } catch { /* storage blocked: the channel below may still reach it */ }
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(message);
    channel.close();
  } catch { /* no BroadcastChannel: the storage event reaches the other window */ }
  try { window.close(); } catch { /* a window the browser will not let us close stays, saying that it can be closed */ }
}

if (googleCallback) hand(googleCallback);
