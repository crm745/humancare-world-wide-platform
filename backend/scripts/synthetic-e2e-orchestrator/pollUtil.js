// Shared bounded-polling helper: retry handling, timeout handling and diagnostics in one place, used
// by waitForScan.js and waitForApproval.js (and available to anything else that needs a safe,
// bounded wait loop).
class PollTimeoutError extends Error {
  constructor(message, lastDiagnostic) {
    super(message);
    this.name = 'PollTimeoutError';
    this.code = 'poll_timeout';
    this.lastDiagnostic = lastDiagnostic;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `check()` returns { done: true, value } | { done: false, diagnostic } | throws (a terminal failure
// the caller should not keep retrying for, e.g. a revoked marker). `onTick(diagnostic)` is called
// after every unsuccessful attempt (used to re-run processGuard / egress isolation safety re-checks and to
// log progress) — if it throws, polling stops immediately and that error propagates.
async function pollUntil({ check, onTick, intervalMs = 5000, timeoutMs = 10 * 60 * 1000, now = Date.now }) {
  const deadline = now() + timeoutMs;
  let lastDiagnostic = null;
  for (;;) {
    const result = await check();
    if (result.done) return result.value;
    lastDiagnostic = result.diagnostic;
    if (now() >= deadline) throw new PollTimeoutError(`timed out after ${timeoutMs}ms waiting for condition`, lastDiagnostic);
    if (onTick) await onTick(lastDiagnostic);
    const remaining = deadline - now();
    await sleep(Math.min(intervalMs, Math.max(remaining, 0)));
  }
}

module.exports = { pollUntil, PollTimeoutError, sleep };
