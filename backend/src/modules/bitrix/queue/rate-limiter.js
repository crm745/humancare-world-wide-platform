// ONE token bucket plus a concurrency cap, shared by every Bitrix24 service queue (see dispatcher.js). A Bitrix24 webhook allows only a few
// requests per second sustained, so the 60-second queue schedule must never become a burst: every call takes a token first.
//   ratePerSecond   tokens added per second (default 2, the documented sustained rate for a webhook)
//   burst           bucket size (default 10)
//   maxConcurrent   calls in flight at once (default 1)
// acquire() resolves a release function, or null when no slot came free within `timeoutMs` (the caller leaves its work for the next pass).
// `now` and `sleep` are injectable so tests need no real time.
function createRateLimiter({ ratePerSecond = 2, burst = 10, maxConcurrent = 1, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let tokens = burst;
  let last = now();
  let inFlight = 0;

  const refill = () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSecond);
    last = t;
  };

  async function acquire({ timeoutMs = 10000 } = {}) {
    const deadline = now() + timeoutMs;
    for (;;) {
      refill();
      if (inFlight < maxConcurrent && tokens >= 1) {
        tokens -= 1;
        inFlight += 1;
        let released = false;
        return () => { if (!released) { released = true; inFlight -= 1; } };
      }
      const wait = inFlight >= maxConcurrent ? 25 : Math.ceil(((1 - tokens) / ratePerSecond) * 1000);
      if (now() + wait > deadline) return null;
      await sleep(Math.max(1, Math.min(wait, 250)));
    }
  }

  const snapshot = () => {
    refill();
    return { tokens: Math.floor(tokens * 100) / 100, inFlight, ratePerSecond, burst, maxConcurrent };
  };

  return { acquire, snapshot };
}

module.exports = { createRateLimiter };
