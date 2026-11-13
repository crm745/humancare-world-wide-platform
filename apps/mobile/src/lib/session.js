import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { hasValidTokens } from './tokens';

const TOKEN_KEY = 'humancare_token';
const REFRESH_KEY = 'humancare_refresh_token';

// expo-secure-store is iOS/Android only — it has no web implementation at all.
// The real app only ever ships on phones, but the web preview used for quick
// testing needs a fallback, so we use localStorage there instead.
const isWeb = Platform.OS === 'web';

// ---- storage, with a time limit on every operation -------------------------------------------------------
// A hung keychain must not block everything behind it (above all a sign-out), so each operation gives up after
// the limit. An operation that gives up may still finish later; `reconcileWhenSettled` below puts the storage
// back to what the app intends when it does.
let storageTimeoutMs = 8000;
export const setStorageTimeoutForTests = (ms) => { storageTimeoutMs = ms; };

function limited(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error('Secure storage timed out'); e.code = 'storage_timeout'; reject(e); }, storageTimeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const raw = {
  get: async (key) => (isWeb ? window.localStorage.getItem(key) : SecureStore.getItemAsync(key)),
  set: async (key, value) => (isWeb ? window.localStorage.setItem(key, value) : SecureStore.setItemAsync(key, value)),
  del: async (key) => (isWeb ? window.localStorage.removeItem(key) : SecureStore.deleteItemAsync(key)),
};

// ---- one queue for every token operation -----------------------------------------------------------------
// Reads, saves, the refresh's compare-and-save, the conditional clear and the sign-out all run one after another,
// in the order they were asked for. So a sign-out that comes after a refresh's save runs after it (and wins), a
// refresh whose save comes after the sign-out finds the tokens gone and saves nothing, and nobody ever reads one
// token from before a change and the other from after it.
let chain = Promise.resolve();
function serialize(task) {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

// What the storage is meant to hold right now: { token, refreshToken }, 'none' (signed out), or null (nothing
// decided yet). Set by every successful save, every clear and every rolled-back save.
let intended = null;
// Whether the person has signed out (so a refresh must not save), and whether the keychain refused to delete
// (so nothing is read back as signed in until the next sign-in).
let wantCleared = false;
let deleteFailed = false;
export const resetSessionStateForTests = () => { wantCleared = false; deleteFailed = false; intended = null; };

async function readPair() {
  return { token: await limited(raw.get(TOKEN_KEY)), refreshToken: await limited(raw.get(REFRESH_KEY)) };
}

async function deleteBoth() {
  const results = await Promise.allSettled([limited(raw.del(TOKEN_KEY)), limited(raw.del(REFRESH_KEY))]);
  return results.every((r) => r.status === 'fulfilled');
}

// A write that timed out (or was rolled back) may still land later, and could then overwrite a newer login, mix two
// logins' tokens, or bring back tokens the person signed out of. When it settles, the storage is put back to what
// is intended now: the newest saved pair, or nothing after a sign-out.
function reconcileWhenSettled(pending) {
  pending.then(() => undefined, () => undefined).then(() => serialize(async () => {
    if (intended === null) return;
    try {
      const current = await readPair();
      if (intended === 'none') {
        if (current.token != null || current.refreshToken != null) await deleteBoth();
      } else if (current.token !== intended.token || current.refreshToken !== intended.refreshToken) {
        await limited(raw.set(TOKEN_KEY, intended.token));
        await limited(raw.set(REFRESH_KEY, intended.refreshToken));
      }
    } catch { /* nothing more can be done here; the next save or sign-out sets it again */ }
  }));
}

// Both tokens or neither: if the second write fails, the first is rolled back, and if that cannot be done both are
// removed. Only the keys that were actually written (or whose write timed out, so it may still land) are rolled
// back; a key whose write failed outright still holds its old value and is left alone.
async function writePair(token, refreshToken) {
  const previous = await readPair();
  const pending = [];
  const touched = [];
  try {
    for (const [key, value] of [[TOKEN_KEY, token], [REFRESH_KEY, refreshToken]]) {
      const op = raw.set(key, value);
      pending.push(op);
      try {
        await limited(op);
        touched.push(key);
      } catch (err) {
        if (err.code === 'storage_timeout') touched.push(key);
        throw err;
      }
    }
  } catch (err) {
    // What is meant to be stored is what was there before.
    intended = previous.token != null && previous.refreshToken != null ? { token: previous.token, refreshToken: previous.refreshToken } : 'none';
    pending.forEach(reconcileWhenSettled);
    const restores = [];
    try {
      for (const key of touched) {
        const old = key === TOKEN_KEY ? previous.token : previous.refreshToken;
        const op = old == null ? raw.del(key) : raw.set(key, old);
        restores.push(op);
        await limited(op);
      }
    } catch (rollbackErr) {
      // A slow keychain: the restore may still land, and reconcile puts the storage back to the intended pair
      // when everything has settled. Anything else (a hard failure): leave nothing half-written.
      restores.forEach(reconcileWhenSettled);
      if (rollbackErr.code !== 'storage_timeout') {
        await deleteBoth().catch(() => undefined);
        intended = 'none';
      }
    }
    throw err;
  }
  intended = { token, refreshToken };
  wantCleared = false;
  deleteFailed = false;
}

// ---- who is told about a sign-in or a sign-out ------------------------------------------------------------
// Saving tokens is NOT a sign-in: a refresh saves tokens too and must not grant anything, so only a caller that
// has just had credentials verified by the server (a login, an account activation) says so with { signIn: true }.
const listeners = new Set();
export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const announce = (signedIn) => listeners.forEach((fn) => { try { fn(signedIn); } catch { /* one listener must not stop the rest */ } });

const invalidCredentials = () => {
  const err = new Error('We could not complete sign-in. Please try again.');
  err.code = 'invalid_credentials_response';
  return err;
};
const staleSignIn = () => {
  const err = new Error('This sign-in was replaced by a newer one.');
  err.code = 'stale_sign_in';
  return err;
};

// ---- sign-in attempts -------------------------------------------------------------------------------------
// Every sign-in (password + code, Google/Apple, account activation) starts with beginSignIn() BEFORE its request
// is sent, and passes the number it got to saveTokens. A response that arrives after the person has started a
// newer sign-in, or signed out, is stale: it is refused, stores nothing and announces nothing, so a slow older
// attempt can never restore a session over what the person did since.
let signInAttempt = 0;
export const beginSignIn = () => { signInAttempt += 1; return signInAttempt; };

// Saves new credentials. Throws, stores nothing and announces nothing if a token is missing or not a non-empty
// string, if the two writes cannot both be done, or (for a sign-in) if the attempt is no longer the current one.
export async function saveTokens(tokens, { signIn = false, attempt } = {}) {
  if (!hasValidTokens(tokens)) throw invalidCredentials();
  if (signIn && attempt !== signInAttempt) throw staleSignIn();
  await serialize(async () => {
    // Checked again inside the queue: a sign-out or a newer attempt may have come while this waited its turn.
    if (signIn && attempt !== signInAttempt) throw staleSignIn();
    await writePair(tokens.token, tokens.refreshToken);
  });
  if (signIn) announce(true);
}

// The refresh's save: stores the new pair only if the refresh token that was used is still the saved one. If the
// person signed out, or signed in again, while the refresh was running, nothing is written and `false` is returned.
export async function compareAndSaveTokens({ expectedRefreshToken, token, refreshToken }) {
  if (!hasValidTokens({ token, refreshToken })) throw invalidCredentials();
  return serialize(async () => {
    if (wantCleared || deleteFailed) return false;
    if ((await limited(raw.get(REFRESH_KEY))) !== expectedRefreshToken) return false;
    await writePair(token, refreshToken);
    return true;
  });
}

// Signs out. Even if the keychain refuses to delete, nothing is read back as signed in until the next sign-in,
// and the app state moves to signed out. A sign-in that was still waiting for its server answer is made stale.
export async function clearTokens() {
  signInAttempt += 1;
  await serialize(async () => {
    wantCleared = true; // set when this runs, so a save queued before it cannot undo it
    intended = 'none';
    deleteFailed = !(await deleteBoth());
  });
  announce(false);
}

// Ends a session only if the saved access token is still `expectedAccessToken`: the comparison and the deletion are
// one step in the queue, so a login that saved a newer pair first is never deleted. Resolves to
//   'cleared'     the matching pair was deleted: listeners are told (signed out)
//   'superseded'  a different (or no) token is saved: nothing was touched and nobody is told
//   'failed'      the token matched but the keychain would not delete it: nobody is told it succeeded (the
//                 token is not read back as valid until the next sign-in)
// Rejects if the saved token cannot be read at all (nothing is known, nothing is touched).
export async function compareAndClearTokens(expectedAccessToken) {
  const outcome = await serialize(async () => {
    const current = await limited(raw.get(TOKEN_KEY));
    if (current == null || current !== expectedAccessToken) return 'superseded';
    wantCleared = true;
    intended = 'none';
    if (await deleteBoth()) {
      deleteFailed = false;
      return 'cleared';
    }
    deleteFailed = true;
    return 'failed';
  });
  if (outcome === 'cleared') announce(false);
  return outcome;
}

export async function getAccessToken() {
  return serialize(async () => (deleteFailed ? null : limited(raw.get(TOKEN_KEY))));
}

export async function getRefreshToken() {
  return serialize(async () => (deleteFailed ? null : limited(raw.get(REFRESH_KEY))));
}
