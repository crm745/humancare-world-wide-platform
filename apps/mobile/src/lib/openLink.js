// Opening a link outside the app (a phone call, an email, a web page). Pure: the opener is passed in, so every outcome is unit-tested; lib/useOpenLink.js is the hook the screens use.
// A phone with no handler for the link (no dialer, no mail app, no browser) makes Linking.openURL REJECT. Left alone that is a silent failure plus an unhandled promise rejection; here it ends
// in `onError`, which says so in the person's language. Resolves true when the link was handed to the system, false when it was not. Never throws.
export async function openLink(url, { open, onError }) {
  try {
    if (typeof url !== 'string' || !url) throw new Error('No link');
    await open(url);
    return true;
  } catch (err) {
    if (onError) { try { onError(err); } catch { /* showing the message must not throw either */ } }
    return false;
  }
}

// How long a message stays on screen: long enough to read. The base time plus a little per character, between 2.2 s and 7 s (a short "Saved." keeps the old 2.2 s).
export const TOAST_MIN_MS = 2200;
export const TOAST_MAX_MS = 7000;
const PER_CHAR_MS = 45;
const READ_FREE_CHARS = 28; // up to this many characters fit the minimum
export function toastDuration(message) {
  const length = typeof message === 'string' ? Array.from(message).length : 0;
  return Math.min(TOAST_MAX_MS, Math.max(TOAST_MIN_MS, TOAST_MIN_MS + (length - READ_FREE_CHARS) * PER_CHAR_MS));
}
