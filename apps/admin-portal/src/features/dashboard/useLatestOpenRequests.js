import { useCallback, useEffect, useState } from 'react';
import { listRequests } from '../requests/api';
import { OPEN_STATUSES } from '../requests/requestStatus.mjs';

export const LATEST_LIMIT = 8;

// The newest requests that are submitted but not yet approved (the same filter as the Incomplete
// Submissions page), from the existing GET /admin/requests: one small page, newest first. `total` is the
// server's own count of ALL open requests, so the panel can say how many are not shown.
// A newer load cancels an older one.
export function useLatestOpenRequests() {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState({ requests: [], total: undefined, loading: true, error: null });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    // Started on the next tick, like the dashboard counts: React's development double-run mounts, unmounts and
    // mounts again at once, so the first run is cancelled here before it sends anything.
    const timer = setTimeout(() => {
      listRequests({ status: OPEN_STATUSES, limit: LATEST_LIMIT, signal })
        .then(({ requests, total }) => {
          if (!signal.aborted) setState({ requests, total, loading: false, error: null });
        })
        .catch((err) => {
          if (signal.aborted) return;
          setState((prev) => ({ ...prev, loading: false, error: err.message || 'Could not load the latest requests.' }));
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  return { ...state, reload };
}
