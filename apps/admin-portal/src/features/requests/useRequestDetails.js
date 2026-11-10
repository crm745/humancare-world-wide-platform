import { useCallback, useEffect, useState } from 'react';
import { getRequest } from './api';

/**
 * Loads one request for the details page. `id` null means "not a valid id": nothing is fetched.
 * Navigating to another request cancels the one in flight, so a slow earlier response can never
 * replace the page the Admin is now looking at. `notFound` is the server's 404.
 */
export function useRequestDetails(id) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState({ request: null, loading: id != null, error: null, notFound: false });

  useEffect(() => {
    if (id == null) return undefined;
    const controller = new AbortController();
    // Keep what is on screen while the same request is refreshed; drop it when the id changed.
    setState((prev) => ({ request: prev.request?.id === Number(id) ? prev.request : null, loading: true, error: null, notFound: false }));
    getRequest(id, { signal: controller.signal })
      .then((request) => {
        if (!controller.signal.aborted) setState({ request, loading: false, error: null, notFound: false });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        const notFound = err.status === 404;
        setState((prev) => ({
          request: notFound ? null : prev.request,
          loading: false,
          error: notFound ? null : err.message || 'Could not load the request.',
          notFound,
        }));
      });
    return () => controller.abort();
  }, [id, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  return { ...state, reload };
}
