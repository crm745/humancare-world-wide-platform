// When a loading skeleton may be on screen. Pure (no React, no timers), so it can be unit-tested; components/skeleton/hooks.js
// applies it with real time.
//
//   - It appears only if loading takes longer than SHOW_AFTER_MS, so a quick load never flashes it.
//   - Once it has appeared it stays for at least MIN_SHOW_MS, so it never blinks.
//   - It is for the FIRST load only: a screen that already has data (cached, or from an earlier load) does not start loading at all.
export const SHOW_AFTER_MS = 150;
export const MIN_SHOW_MS = 400;

// `startedAt`: when loading began (null = not loading); `endedAt`: when it finished (null = still going); `now`.
export function skeletonVisible({ startedAt, endedAt = null, now }) {
  if (startedAt === null || startedAt === undefined) return false;
  const showAt = startedAt + SHOW_AFTER_MS;
  if (endedAt !== null && endedAt <= showAt) return false; // done before it would have shown
  if (now < showAt) return false;
  if (endedAt === null) return true;
  return now < Math.max(endedAt, showAt + MIN_SHOW_MS);
}

// The next moment the answer can change (to schedule one timer), or null when it will not change on its own.
export function nextChangeAt({ startedAt, endedAt = null, now }) {
  if (startedAt === null || startedAt === undefined) return null;
  const showAt = startedAt + SHOW_AFTER_MS;
  if (now < showAt) return endedAt !== null && endedAt <= showAt ? null : showAt;
  if (endedAt === null) return null;
  const hideAt = Math.max(endedAt, showAt + MIN_SHOW_MS);
  return now < hideAt ? hideAt : null;
}
