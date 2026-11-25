// The push-device lifecycle of ONE app installation, as plain logic with everything native injected (so it is unit-tested
// without a phone). The glue that wires the real storage, Expo and the API is lib/pushNotifications.js.
//
//   * Installation id: a UUID made once on this installation and kept in storage (AsyncStorage, like the language and the
//     payment attempts). It is NEVER deleted on logout: the same installation keeps one id for ever, and the server moves the
//     device between accounts (POST /notifications/devices takes the same row over for the signed-in patient).
//   * Register: after a patient is signed in, with { deviceId, expoPushToken, platform }. Done once per sign-in (duplicates from
//     repeated mounts / events share one call or are skipped). A different Expo token (rotation) registers again; the server
//     updates the same device row.
//   * Unregister: on patient logout, BEFORE the tokens are cleared (the call needs them). It never claims success it did not
//     get: it answers { ok: false, reason } when the server was not reached or refused, so the caller can say so.
//   * reset(): forget what was registered in this session (called on every sign-in and sign-out), so the next patient on this
//     phone always registers again, whatever the previous session did.
//
// The legacy POST /auth/push-token (User.pushToken, still what the backend senders read) is kept: `legacyRegister` is called
// best-effort once per token per session, exactly as before.

export const INSTALL_ID_KEY = 'hc_install_id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isInstallId = (value) => typeof value === 'string' && UUID_RE.test(value);

const UNREGISTER_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'timeout' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Why an unregister did not happen, in words a caller can branch on. Nothing here is shown to the person as is.
export function failureReason(err) {
  if (!err) return 'unknown';
  if (err.code === 'timeout') return 'timeout';
  if (err.status === 401 || err.code === 'session_expired' || err.code === 'not_signed_in') return 'session';
  if (err.code === 'network' || err.name === 'TypeError') return 'network';
  return 'server';
}

export function createDeviceRegistry({
  storage, newUuid, platform, getExpoToken, registerDevice, unregisterDevice, legacyRegister = async () => {}, unregisterTimeoutMs = UNREGISTER_TIMEOUT_MS,
}) {
  let installId = null; // cached after the first read / creation
  let idLoading = null; // the one read-or-create in progress
  let generation = 0; // moved by reset(): an answer that arrives after a sign-in / sign-out is dropped
  let registeredKey = null; // `${deviceId}|${token}` last accepted by the server in this session
  let legacyToken = null; // the token last sent to the legacy endpoint in this session
  let inFlight = null;

  async function readStored() {
    const stored = await storage.getItem(INSTALL_ID_KEY);
    return isInstallId(stored) ? stored.toLowerCase() : null;
  }

  // The installation id, created and saved on first use. If storage cannot be read or written this THROWS: no id is invented
  // for one run (that would leave a stale device row on the server at every start).
  function loadInstallId() {
    if (installId) return Promise.resolve(installId);
    if (!idLoading) {
      idLoading = (async () => {
        let id = await readStored();
        if (!id) {
          id = String(newUuid()).toLowerCase();
          await storage.setItem(INSTALL_ID_KEY, id);
        }
        installId = id;
        return id;
      })().finally(() => { idLoading = null; });
    }
    return idLoading;
  }

  async function run(gen) {
    let token;
    try { token = await getExpoToken(); } catch { return { status: 'unavailable' }; }
    if (!token) return { status: 'no_token' }; // permission denied, Expo Go, web, or no projectId
    let deviceId;
    try { deviceId = await loadInstallId(); } catch { return { status: 'storage_failed' }; }
    if (gen !== generation) return { status: 'superseded' };

    const key = `${deviceId}|${token}`;
    if (registeredKey === key) return { status: 'already' }; // same installation, same token: nothing changed (rotation differs here)

    let outcome = { status: 'registered' };
    try {
      await registerDevice({ deviceId, expoPushToken: token, platform });
    } catch (error) {
      outcome = { status: 'failed', error };
    }
    if (gen !== generation) return { status: 'superseded' }; // the session changed meanwhile: record nothing
    if (outcome.status === 'registered') registeredKey = key;

    if (legacyToken !== token) {
      try { await legacyRegister(token); if (gen === generation) legacyToken = token; } catch { /* best effort, as before */ }
    }
    return outcome;
  }

  /**
   * Register this installation for the signed-in patient. Concurrent calls share one run. Once registered in this session, a
   * plain call does nothing (no permission prompt, no token request); `recheck: true` asks Expo for the token again and
   * registers only if it changed (token rotation).
   */
  function ensureRegistered({ recheck = false } = {}) {
    if (inFlight) return inFlight;
    if (registeredKey && !recheck) return Promise.resolve({ status: 'already' });
    const mine = run(generation).finally(() => { if (inFlight === mine) inFlight = null; });
    inFlight = mine;
    return mine;
  }

  function reset() {
    generation += 1;
    registeredKey = null;
    legacyToken = null;
  }

  /**
   * Unregister this installation for the signed-in patient (DELETE /notifications/devices/:deviceId). Call it BEFORE the
   * tokens are cleared. Never throws. The stored installation id is kept.
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async function unregister() {
    // A registration still running would land after the delete and leave the device active: let it finish first (bounded).
    if (inFlight) await withTimeout(inFlight, unregisterTimeoutMs).catch(() => undefined);
    let deviceId;
    try {
      deviceId = installId || (await readStored());
    } catch {
      reset();
      return { ok: false, reason: 'storage' }; // the id cannot be read, so it cannot be unregistered: say so
    }
    if (!deviceId) { reset(); return { ok: true, reason: 'never_registered' }; } // no id was ever made: there is nothing on the server
    try {
      await withTimeout(unregisterDevice(deviceId), unregisterTimeoutMs);
      reset();
      return { ok: true };
    } catch (err) {
      reset(); // the session is ending either way; the next sign-in on this phone registers again from scratch
      return { ok: false, reason: failureReason(err) };
    }
  }

  return { ensureRegistered, unregister, reset, loadInstallId };
}
