// The navigation guard: an accidental repeated tap does not stack the same screen twice.
//
// WHAT it stops: the SAME navigation (same method, same route, same parameters) asked again within GUARD_MS of the one before it. A person who taps a card
// that has not visibly reacted yet, or taps twice by habit, gets one screen, not two on top of each other.
// WHAT it never stops:
//   - a different route, or the same route with different parameters (request 12 then request 13);
//   - the intentional multi-step pushes (step1, then step2, then review): each one is a different route;
//   - going back: back, dismiss, dismissTo and dismissAll are never blocked, and each one forgets the last navigation, so "open X, go back, open X again" works at once;
//   - the same navigation after GUARD_MS has passed.
// Only the most recent navigation is remembered. Pure rules (`createNavGuard`) with an injected clock, so they can be unit-tested; `guardRouter` applies them to expo-router's `router` once.
export const GUARD_MS = 600;

export const GUARDED = ['push', 'navigate', 'replace'];
export const RESETTING = ['back', 'dismiss', 'dismissTo', 'dismissAll'];

// A stable text for a navigation target: a path string, or { pathname, params }.
export function targetKey(target) {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object') return String(target);
  const params = target.params && typeof target.params === 'object'
    ? Object.keys(target.params).sort().map((k) => `${k}=${String(target.params[k])}`).join('&')
    : '';
  return `${target.pathname || ''}?${params}`;
}

export function createNavGuard({ windowMs = GUARD_MS, now = () => Date.now() } = {}) {
  let last = null; // { key, at }
  return {
    // true: go ahead (and remember it). false: the same navigation was asked for a moment ago.
    allow(key) {
      const at = now();
      if (last && last.key === key && at - last.at >= 0 && at - last.at < windowMs) return false;
      last = { key, at };
      return true;
    },
    reset() { last = null; },
  };
}

export const navGuard = createNavGuard();

// Wraps router.push / navigate / replace with the guard, and makes back / dismiss* forget the last navigation. Idempotent. Anything unexpected (a method that is missing,
// an object that cannot be changed) leaves the router exactly as it was: the guard is only ever an extra.
export function guardRouter(router, guard = navGuard) {
  if (!router || router.__navGuarded) return router;
  try {
    for (const method of GUARDED) {
      const original = router[method];
      if (typeof original !== 'function') continue;
      router[method] = (...args) => (guard.allow(`${method}:${targetKey(args[0])}`) ? original.apply(router, args) : undefined);
    }
    for (const method of RESETTING) {
      const original = router[method];
      if (typeof original !== 'function') continue;
      router[method] = (...args) => { guard.reset(); return original.apply(router, args); };
    }
    router.__navGuarded = true;
  } catch { /* the router is left as it is */ }
  return router;
}
