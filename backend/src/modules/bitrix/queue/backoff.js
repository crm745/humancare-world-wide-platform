// Exponential backoff with jitter, shared by every service queue. Pure: `rng` returns [0, 1).
// attempt 1 -> about `baseSeconds`, doubling each attempt, never above `maxSeconds`, then spread by +-jitter (the result never exceeds maxSeconds).
const DEFAULTS = Object.freeze({ baseSeconds: 60, factor: 2, maxSeconds: 60 * 60, jitter: 0.2 });

function backoffSeconds(attempt, { rng = Math.random, ...options } = {}) {
  const { baseSeconds, factor, maxSeconds, jitter } = { ...DEFAULTS, ...options };
  const n = Math.max(1, Math.floor(Number(attempt)) || 1);
  const base = Math.min(maxSeconds, baseSeconds * factor ** (n - 1));
  const spread = 1 + (rng() * 2 - 1) * jitter;
  return Math.max(1, Math.min(maxSeconds, Math.round(base * spread)));
}

module.exports = { backoffSeconds, DEFAULTS };
