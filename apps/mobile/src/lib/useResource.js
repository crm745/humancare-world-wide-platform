/* eslint-disable react-hooks/set-state-in-effect -- a screen that moves to another request id (or key) starts over from what is cached for it */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCached, getCachedAt, sessionEpoch, setCached } from './screenCache';
import { HIGHLIGHT_MS, newIds } from './newItems';
import { useNetwork } from '../state/NetworkContext';
import { retryOnRestoration } from './networkUi';

// The one way a data screen loads what it shows (the same rules on every screen):
//   - the FIRST load, with nothing to show yet, is `loading` (the screen draws its skeleton);
//   - data kept from an earlier visit (lib/screenCache.js) is shown at once and refreshed quietly: no skeleton;
//   - if the first load fails there is nothing to show: `error` is set and the screen offers "Try again" (`reload`);
//   - a failed refresh keeps what is on screen;
//   - `onRefresh` is for pull-to-refresh: `refreshing` is true ONLY while a pull is in progress (a background refetch never turns the
//     spinner on), the content stays on screen, and an item whose id was not there before the pull is in `highlight` for 1.8 s.
//
// `key`: the cache key (it includes the request id where there is one); `fetcher`: () => Promise<data>; `idsOf`: data => array of
// ids (for the new-item highlight); `onRefreshError`: called when a pull fails (the screen says "Couldn't refresh...").
// `freshMs` (optional, off by default): when the screen opens (or its key changes) and what is cached for it is younger than this, the opening load is skipped: another screen loaded the same
// thing a moment ago. It applies ONLY to that opening load: `reload` (focus refresh, "Try again", connection restored) and pull-to-refresh always ask the server.
export function useResource({ key, fetcher, idsOf, onRefreshError, enabled = true, freshMs = 0 }) {
  const [data, setData] = useState(() => getCached(key));
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [highlight, setHighlight] = useState([]);
  const fetcherRef = useRef(fetcher);
  const dataRef = useRef(data);
  const keyRef = useRef(key);
  const refreshingRef = useRef(false);
  const failRef = useRef(onRefreshError);
  const idsRef = useRef(idsOf);
  // A read that failed is read again ONCE when the connection comes back. useResource only ever loads data, so this can never resend a write.
  const { restoredCount } = useNetwork();
  const failedRef = useRef(false);
  const restoredSeenRef = useRef(restoredCount);
  useEffect(() => { fetcherRef.current = fetcher; failRef.current = onRefreshError; idsRef.current = idsOf; });
  useEffect(() => { dataRef.current = data; }, [data]);

  // Runs the fetch for `forKey`; the answer of a screen that has since moved to another key is dropped.
  const run = useCallback(async (forKey) => {
    const epoch = sessionEpoch(); // read before asking: an answer that arrives after a sign-out or an account switch belongs to the old session and is dropped (lib/screenCache.js)
    const next = await fetcherRef.current();
    if (keyRef.current !== forKey) return undefined;
    if (!setCached(forKey, next, { epoch })) return undefined;
    dataRef.current = next;
    setData(next);
    setError(null);
    failedRef.current = false;
    return next;
  }, []);

  // first load, and a quiet refresh when something is already on screen
  const reload = useCallback(() => {
    const forKey = keyRef.current;
    if (dataRef.current === undefined) setError(null);
    return run(forKey).catch((err) => { failedRef.current = true; if (keyRef.current === forKey && dataRef.current === undefined) setError(err); });
  }, [run]);

  useEffect(() => {
    keyRef.current = key;
    const cached = getCached(key);
    dataRef.current = cached;
    setData(cached);
    setError(null);
    setHighlight([]);
    failedRef.current = false;
    const fresh = freshMs > 0 && cached !== undefined && Date.now() - getCachedAt(key) < freshMs;
    if (enabled && !fresh) reload();
  }, [key, enabled, reload, freshMs]);

  const onRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const before = idsRef.current && dataRef.current !== undefined ? idsRef.current(dataRef.current) : null;
    try {
      const next = await run(keyRef.current);
      if (before && idsRef.current && next !== undefined) {
        const fresh = newIds(before, idsRef.current(next));
        if (fresh.length) {
          setHighlight(fresh);
          setTimeout(() => setHighlight([]), HIGHLIGHT_MS + 200);
        }
      }
    } catch (err) {
      failedRef.current = true; // what is on screen stays; it is refreshed once when the connection returns
      if (failRef.current) failRef.current(err);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [run]);

  // Once per restoration: if the last read failed (a first load with nothing to show, or a quiet refresh that left older data on screen), read again ONCE.
  // The flag is spent as it is used, so a second failure waits for the NEXT restoration: no loop, no timer, no polling.
  useEffect(() => {
    const next = retryOnRestoration({ restoredCount, seen: restoredSeenRef.current, enabled, failed: failedRef.current });
    restoredSeenRef.current = next.seen;
    failedRef.current = next.failed;
    if (next.retry) reload();
  }, [restoredCount, enabled, reload]);

  return { data, loading: data === undefined && !error, error, reload, refresh: onRefresh, onRefresh, refreshing, highlight };
}
