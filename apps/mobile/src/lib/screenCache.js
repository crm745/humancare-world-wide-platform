// What each data screen last loaded, kept in memory, so coming back to a screen (or switching tabs) shows it at once and refreshes
// quietly instead of starting from a skeleton. It lives only as long as the app is open and is emptied the moment the person
// signs out or in (AppContext calls clearCache from its session listener), so one account's requests can never show for the next.
//
// Each entry remembers when it was stored (getCachedAt), so a screen can skip a load that would only repeat one made a moment ago (lib/useResource.js `freshMs`).
//
// The session counter: clearCache() also advances it. A load notes the counter BEFORE it asks the server and passes it back when it writes (or checks sessionEpoch itself before using the
// answer), so an answer that was still on its way when the person signed out or into another account is dropped instead of being stored for the next account.
const cache = new Map(); // key -> { value, at }
let epoch = 0;

export const getCached = (key) => (cache.has(key) ? cache.get(key).value : undefined);
export const getCachedAt = (key) => (cache.has(key) ? cache.get(key).at : 0);
export const sessionEpoch = () => epoch;
// `options.epoch`: the counter read before the load started. A write with an older one is refused (returns false). Without it the write is made, as before.
export const setCached = (key, value, options) => {
  if (options && options.epoch !== undefined && options.epoch !== epoch) return false;
  cache.set(key, { value, at: Date.now() });
  return true;
};
export const clearCache = () => { epoch += 1; cache.clear(); };
