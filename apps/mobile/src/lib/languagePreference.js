// The saved language, and the language the app starts in. The preference is not sensitive, so it lives in
// AsyncStorage under its own key and never next to the sign-in tokens (which are in the secure store).
//
// Order at start: a saved language the app still supports, else the phone's language if the app has it, else English.
// Starting never writes: only the person choosing a language does, so a device guess is never saved as a choice and
// a saved choice is never overwritten.

import { DEFAULT_LANGUAGE, isSupportedLanguage, matchDeviceLanguage } from '../data/languages';

export const LANGUAGE_STORAGE_KEY = 'humancare_language';
// How long the app waits for storage at start before it carries on with the device language: a stuck read must not
// leave the app on a blank screen.
export const LANGUAGE_READ_TIMEOUT_MS = 2500;

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('language read timed out')), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

// The saved language code, or null: nothing saved, a value that is not a supported code, or storage failing.
export async function loadSavedLanguage(storage, timeoutMs = LANGUAGE_READ_TIMEOUT_MS) {
  try {
    const value = await withTimeout(Promise.resolve(storage.getItem(LANGUAGE_STORAGE_KEY)), timeoutMs);
    return isSupportedLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

// The phone's language as one of ours (English when it has none of them or cannot be read).
export function deviceLanguage(getLocales) {
  try {
    return matchDeviceLanguage(getLocales());
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

// { storage, getLocales } -> the language code to start in. Never throws.
export async function resolveInitialLanguage({ storage, getLocales, timeoutMs }) {
  const saved = await loadSavedLanguage(storage, timeoutMs);
  return saved ?? deviceLanguage(getLocales);
}

// Saves the person's choice. Resolves true when it was written, false when it was not (an unsupported code, or
// storage failing): a failed save is not an error for the app, the choice still applies until it is closed.
export async function saveLanguage(storage, code) {
  if (!isSupportedLanguage(code)) return false;
  try {
    await storage.setItem(LANGUAGE_STORAGE_KEY, code);
    return true;
  } catch {
    return false;
  }
}
