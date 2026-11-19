/* eslint-disable react-hooks/set-state-in-effect -- a screen that moves to another request id (or key) starts over from what is cached for it */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCached, setCached } from './screenCache';
import { HIGHLIGHT_MS, newIds } from './newItems';

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
export function useResource({ key, fetcher, idsOf, onRefreshError, enabled = true }) {
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
  useEffect(() => { fetcherRef.current = fetcher; failRef.current = onRefreshError; idsRef.current = idsOf; });
  useEffect(() => { dataRef.current = data; }, [data]);

  // Runs the fetch for `forKey`; the answer of a screen that has since moved to another key is dropped.
  const run = useCallback(async (forKey) => {
    const next = await fetcherRef.current();
    if (keyRef.current !== forKey) return undefined;
    setCached(forKey, next);
    dataRef.current = next;
    setData(next);
    setError(null);
    return next;
  }, []);

  // first load, and a quiet refresh when something is already on screen
  const reload = useCallback(() => {
    const forKey = keyRef.current;
    if (dataRef.current === undefined) setError(null);
    return run(forKey).catch((err) => { if (keyRef.current === forKey && dataRef.current === undefined) setError(err); });
  }, [run]);

  useEffect(() => {
    keyRef.current = key;
    const cached = getCached(key);
    dataRef.current = cached;
    setData(cached);
    setError(null);
    setHighlight([]);
    if (enabled) reload();
  }, [key, enabled, reload]);

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
      if (failRef.current) failRef.current(err);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [run]);

  return { data, loading: data === undefined && !error, error, reload, refresh: onRefresh, onRefresh, refreshing, highlight };
}
