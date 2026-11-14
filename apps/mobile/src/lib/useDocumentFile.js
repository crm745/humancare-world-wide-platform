/* eslint-disable react-hooks/set-state-in-effect -- the file is fetched when the preview opens (or Try again is tapped) and its state is kept here */
import { useEffect, useRef, useState } from 'react';
import { fetchDocumentFile } from './documentFile';

// The document's file for the preview screen: loading (with progress), ready (the file), or failed (the error, with a retry). One fetch per
// open; the temporary copy is released when the preview closes.
export function useDocumentFile({ id, name, enabled = true }) {
  const [state, setState] = useState({ status: enabled ? 'loading' : 'idle', progress: 0, file: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const dispose = useRef(null);

  useEffect(() => {
    if (!enabled || id === undefined || id === null || id === '') return undefined;
    let cancelled = false;
    setState({ status: 'loading', progress: 0, file: null, error: null });
    fetchDocumentFile(id, name, (progress) => { if (!cancelled) setState((s) => (s.status === 'loading' ? { ...s, progress } : s)); })
      .then((file) => {
        if (cancelled) { file.dispose(); return; }
        dispose.current = file.dispose;
        setState({ status: 'ready', progress: 1, file, error: null });
      })
      .catch((error) => { if (!cancelled) setState({ status: 'error', progress: 0, file: null, error }); });
    return () => {
      cancelled = true;
      if (dispose.current) { dispose.current(); dispose.current = null; }
    };
  }, [id, name, enabled, attempt]);

  return { ...state, retry: () => setAttempt((n) => n + 1) };
}
