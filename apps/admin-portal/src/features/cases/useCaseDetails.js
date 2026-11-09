import { useCallback, useEffect, useState } from 'react';
import { getCase } from './api';

/** Loads one Case. `id` null means "not a valid id": nothing is fetched. `notFound` is the server's 404. */
export function useCaseDetails(id) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState({ caseRecord: null, loading: id != null, error: null, notFound: false });

  useEffect(() => {
    if (id == null) return undefined;
    const controller = new AbortController();
    setState((prev) => ({ caseRecord: prev.caseRecord && (String(prev.caseRecord.id) === id || prev.caseRecord.referenceNumber === id) ? prev.caseRecord : null, loading: true, error: null, notFound: false }));
    getCase(id, { signal: controller.signal })
      .then((caseRecord) => {
        if (!controller.signal.aborted) setState({ caseRecord, loading: false, error: null, notFound: false });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        const notFound = err.status === 404;
        setState((prev) => ({ caseRecord: notFound ? null : prev.caseRecord, loading: false, error: notFound ? null : err.message || 'Could not load the case.', notFound }));
      });
    return () => controller.abort();
  }, [id, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  return { ...state, reload };
}
