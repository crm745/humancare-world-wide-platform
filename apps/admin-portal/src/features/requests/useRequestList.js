import { useCallback, useEffect, useRef, useState } from 'react';
import { listRequests } from './api';

export const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 300;

/**
 * Loads one page of /admin/requests for the given status filter and search text.
 * Typing is debounced; changing the filter or the search returns to the first page; an
 * older response can never overwrite a newer one (the older request is cancelled).
 */
export function useRequestList(status) {
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const appliedSearch = useRef('');
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState({ requests: [], total: undefined, loading: true, error: null });

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchText.trim();
      // Only a real change of the search text starts over: the timer also fires after mount.
      if (next === appliedSearch.current) return;
      appliedSearch.current = next;
      setSearch(next);
      setOffset(0);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  // A different filter is a different list: start from its first page.
  useEffect(() => {
    setOffset(0);
  }, [status]);

  useEffect(() => {
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    listRequests({ status, search, limit: PAGE_SIZE, offset, signal: controller.signal })
      .then(({ requests, total }) => {
        if (controller.signal.aborted) return;
        // The list shrank under us (someone approved the last items): go back to the start.
        if (!requests.length && offset > 0) {
          setOffset(0);
          return;
        }
        setState({ requests, total, loading: false, error: null });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({ ...prev, loading: false, error: err.message || 'Could not load the requests.' }));
      });
    return () => controller.abort();
  }, [status, search, offset, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { ...state, searchText, setSearchText, search, offset, setOffset, reload };
}
