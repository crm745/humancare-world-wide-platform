import { useCallback, useEffect, useRef, useState } from 'react';
import { createDownloadGuard } from './documentsView';
import { fetchQuotation, performDecision, performDownload } from './quotations';
import { quotationState } from './quotationView';

/**
 * Loads the patient's quotation for one request and runs their decisions on it.
 *   status   'loading' | 'ready' | 'hidden' (the server says this request has no quotation feature: show nothing) | 'error'
 *   state    quotationState(payload): { kind, quotation, lastDecision }
 *   busy     a decision is being sent       fileBusy   the PDF is being fetched
 * A decision names the EXACT version shown (`quotation.id`). One decision at a time: the guard is checked and set in one synchronous step, so a second tap
 * (or Accept and Reject together) cannot send a second request. A 404/409 answer means the quotation is no longer what the screen showed (a newer one,
 * an expiry, a decision made elsewhere): the screen reloads and shows what the server now holds. Every result is { ok, ... } and never throws.
 */
export function useQuotation(requestId) {
  const [load, setLoad] = useState({ status: 'loading', payload: null });
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const guard = useRef(createDownloadGuard());
  const alive = useRef(true);

  // Applies the answer of one fetch; setState only ever runs in the promise callbacks, never synchronously in an effect.
  const settle = useCallback((promise) => promise
    .then((payload) => { if (alive.current) setLoad({ status: 'ready', payload }); })
    .catch((err) => {
      if (!alive.current) return;
      if (err && err.status === 404) setLoad({ status: 'hidden', payload: null });
      else setLoad((prev) => ({ status: prev.payload ? 'ready' : 'error', payload: prev.payload })); // keep showing what we have if a refresh fails
    }), []);

  const reload = useCallback(() => (requestId == null ? Promise.resolve() : settle(fetchQuotation(requestId))), [requestId, settle]);

  useEffect(() => {
    alive.current = true;
    if (requestId != null) settle(fetchQuotation(requestId));
    return () => { alive.current = false; };
  }, [requestId, settle]);

  const decide = useCallback(async (kind, quotation, reason) => {
    let outcome = { ok: false, busy: true };
    const ran = await guard.current.run(`decide:${quotation.id}`, async () => {
      setBusy(true);
      try {
        outcome = await performDecision(kind, quotation, reason);
        if (outcome.ok || outcome.stale) await reload(); // what the server now holds, not what we assume
      } finally {
        if (alive.current) setBusy(false);
      }
    });
    return ran ? outcome : { ok: false, busy: true };
  }, [reload]);

  const download = useCallback(async (quotation, referenceNumber) => {
    let outcome = { ok: false, busy: true };
    const ran = await guard.current.run(`file:${quotation.id}`, async () => {
      setFileBusy(true);
      try {
        outcome = await performDownload(quotation, referenceNumber);
        if (!outcome.ok && outcome.stale) await reload();
      } finally {
        if (alive.current) setFileBusy(false);
      }
    });
    return ran ? outcome : { ok: false, busy: true };
  }, [reload]);

  return { status: load.status, state: quotationState(load.payload), busy, fileBusy, reload, accept: (q) => decide('accept', q), reject: (q, reason) => decide('reject', q, reason), download };
}
