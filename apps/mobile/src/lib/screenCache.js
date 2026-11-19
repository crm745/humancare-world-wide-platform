// What each data screen last loaded, kept in memory, so coming back to a screen (or switching tabs) shows it at once and refreshes
// quietly instead of starting from a skeleton. It lives only as long as the app is open and is emptied the moment the person
// signs out or in (AppContext calls clearCache from its session listener), so one account's requests can never show for the next.
const cache = new Map();

export const getCached = (key) => (cache.has(key) ? cache.get(key) : undefined);
export const setCached = (key, value) => { cache.set(key, value); };
export const clearCache = () => { cache.clear(); };
