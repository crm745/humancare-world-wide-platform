import { useCallback, useEffect, useState } from 'react';
import { listRequests } from '../requests/api';
import { STAT_STATUS, buildStats, countFrom, isFailed } from './dashboardStats.mjs';

// Three calls, made once per load and in parallel: one-row request lists (only their `total` is used). Operational Cases is
// not requested at all: it cannot be calculated accurately from the existing APIs. Each figure fails on its own. A newer load cancels an older one.
export function useDashboardStats() {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState({ values: null, loading: true, failed: 0 });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState((prev) => ({ ...prev, loading: true }));
    const count = (status) => listRequests({ status, limit: 1, signal }).then(countFrom);
    // Started on the next tick: when React's development double-run mounts, unmounts and mounts again at once, the
    // first run is cancelled here before it sends anything, so each source is requested once.
    const timer = setTimeout(() => {
      Promise.allSettled([count(STAT_STATUS.pending), count(STAT_STATUS.awaitingPatient), count(STAT_STATUS.approved)]).then((results) => {
        if (signal.aborted) return;
        const [pending, awaitingPatient, approved] = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
        const failed = results.filter((r) => r.status === 'rejected').length;
        setState({ values: { pending, awaitingPatient, approved }, loading: false, failed });
      });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const stats = state.values ? buildStats(state.values) : null;
  return { stats, loading: state.loading, failed: state.failed, hasUnavailable: stats ? stats.some(isFailed) : false, allFailed: stats ? stats.filter((s) => !s.unsupported).every(isFailed) : false, reload };
}
