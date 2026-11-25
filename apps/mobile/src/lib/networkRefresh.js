// Pull-to-refresh for the screens that are not a list of server data (the request forms, the service detail, the personal details): one gesture that asks the network service whether the backend answers NOW
// (the same check as a "Try again" tap, so a form's Submit and the other network buttons wake up without waiting for the next timer) and, where the screen has something to read, reads it again.
// Pure (no React, no native modules); lib/useNetworkRefresh.js is the thin hook around it.
//
// What it never does: change anything the person entered or saved. It only RUNS the two functions it is given: `check()` (the network service's re-check) and, optionally, `reload()` (a READ of the
// screen's own server data). A form's fields, its documents and its saved draft are not touched, nothing is resent, no upload is retried, and no submission is repeated.
//
//   createRefreshGuard()        { run(task), isRunning() }: runs `task` once at a time; while a run is going, `run` returns THAT run (no duplicate refresh, no second request)
//   runNetworkRefresh(options)  { failed } after: the re-check and the read run together; the spinner shows for at least `minMs` (so a refresh that ends at once still looks like one) and at most
//                               `maxMs` (a check that hangs does not spin for ever); a failed read is reported as `failed: true`, never thrown
export const REFRESH_MIN_MS = 600;
export const REFRESH_MAX_MS = 8000;

export function createRefreshGuard() {
  let running = null;
  return {
    isRunning: () => running !== null,
    run(task) {
      if (running) return running;
      running = Promise.resolve()
        .then(task)
        .finally(() => { running = null; });
      return running;
    },
  };
}

const wait = (ms, setTimer) => new Promise((resolve) => { setTimer(resolve, ms); });

export async function runNetworkRefresh({ check, reload, minMs = REFRESH_MIN_MS, maxMs = REFRESH_MAX_MS, setTimer = setTimeout } = {}) {
  const work = (async () => {
    const [, read] = await Promise.allSettled([
      Promise.resolve().then(() => (typeof check === 'function' ? check() : undefined)),
      Promise.resolve().then(() => (typeof reload === 'function' ? reload() : undefined)),
    ]);
    return { failed: read.status === 'rejected' };
  })();
  // never longer than maxMs; the work itself is not cancelled, only waited for no longer
  const limited = Promise.race([work, wait(maxMs, setTimer).then(() => ({ failed: false, timedOut: true }))]);
  const [outcome] = await Promise.all([limited, wait(minMs, setTimer)]);
  return outcome;
}
