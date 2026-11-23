// The 30-minute idle session timeout. Pure (timers and the clock are injected), so every rule can be unit-tested with a fake clock.
//
// "Idle" means the person has not touched the screen or typed for IDLE_LIMIT_MS (30 minutes), counting the time the app spent in the background. When that happens the session is ended exactly like a
// sign-out (the server is told, the tokens are cleared, the app goes to the login screen). It never ends a session while work the person started is still running: an upload, a download or a
// submission waiting for its answer holds the timeout (holdIdle below / isBusy), and the idle clock starts again when that work is finished.
//   * It only watches while signed in (the caller starts it then and stops it on sign-out).
//   * Activity is any touch, key press or return to the app. Returning to the app after the limit has passed ends the session at once.
//   * The check runs every CHECK_EVERY_MS (15 s) while the app is in front, so the session ends within 15 seconds after the 30 minutes.
export const IDLE_LIMIT_MS = 30 * 60 * 1000;
export const CHECK_EVERY_MS = 15 * 1000;

// ---- work that must not be cut off -------------------------------------------------------------------------------------------------
let holds = 0;
// Called by long-running work (uploads, downloads); the returned function releases it (once).
export function holdIdle() {
  holds += 1;
  let released = false;
  return () => { if (!released) { released = true; holds -= 1; } };
}
export const isIdleHeld = () => holds > 0;
export const resetIdleHoldsForTests = () => { holds = 0; };

// ---- the monitor ---------------------------------------------------------------------------------------------------------------------
export function createIdleSession({
  limitMs = IDLE_LIMIT_MS,
  checkEveryMs = CHECK_EVERY_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id),
  isBusy = () => false,
  onExpire = null,
} = {}) {
  let handler = onExpire;
  let running = false;
  let lastActivity = 0;
  let timer = null;

  function stop() {
    running = false;
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  // Ends the session once: stopped first, so a second check can never fire it again.
  function check() {
    if (!running) return false;
    let busy = false;
    try { busy = Boolean(isBusy()); } catch { busy = false; }
    if (busy) { lastActivity = now(); return false; } // work is running: the idle time counts from when it ends
    if (now() - lastActivity < limitMs) return false;
    stop();
    try { if (handler) handler(); } catch { /* signing out must not throw into the timer */ }
    return true;
  }

  return {
    start() {
      stop();
      running = true;
      lastActivity = now();
      timer = setTimer(check, checkEveryMs);
    },
    stop,
    // What to do when the time runs out (replaceable: the screen sets it with the language and account kind it has now).
    setOnExpire(fn) { handler = typeof fn === 'function' ? fn : null; },
    // A touch, a key press. Ignored while stopped.
    touch() { if (running) lastActivity = now(); },
    // The app came back to the front: the time spent away counts, so this may end the session at once.
    resume() { return check(); },
    check,
    isRunning: () => running,
    // When the session would end if nothing happens (ms since epoch), or null when stopped.
    expiresAt: () => (running ? lastActivity + limitMs : null),
  };
}
