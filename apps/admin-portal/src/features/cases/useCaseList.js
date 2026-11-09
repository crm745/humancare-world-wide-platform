import { useCallback, useEffect, useMemo, useState } from 'react';
import { listCases } from './api';
import { PAGE_SIZE, filterCases, pageOf } from './caseView.mjs';

/**
 * Loads the Cases for one status filter (the API filters by status only) and searches and pages them here.
 * A newer request cancels an older one; changing the filter or the search returns to the first page.
 */
export function useCaseList(status) {
  const [searchText, setSearchText] = useState('');
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState({ cases: [], loading: true, error: null });

  useEffect(() => {
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    listCases({ status: status === 'all' ? undefined : status, signal: controller.signal })
      .then((cases) => {
        if (!controller.signal.aborted) setState({ cases, loading: false, error: null });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({ ...prev, loading: false, error: err.message || 'Could not load the cases.' }));
      });
    return () => controller.abort();
  }, [status, reloadKey]);

  useEffect(() => setOffset(0), [status, searchText]);

  const matching = useMemo(() => filterCases(state.cases, searchText), [state.cases, searchText]);
  const rows = useMemo(() => pageOf(matching, offset), [matching, offset]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { ...state, rows, total: matching.length, searchText, setSearchText, offset, setOffset, reload, pageSize: PAGE_SIZE };
}
