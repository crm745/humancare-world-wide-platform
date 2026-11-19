// Which items a pull-to-refresh brought that were not there before. Pure, so it can be unit-tested.
//
// "New" is an id that was not in the list before the pull. There is no highlight on the first load (nothing was there before), and
// none when the earlier list is unknown.
export function newIds(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const seen = new Set(before);
  return after.filter((id) => !seen.has(id));
}

// How long a new item stays highlighted while its colour fades back to the card colour.
export const HIGHLIGHT_MS = 1800;
export const HIGHLIGHT_FROM = '#E2E3EF';
