import { useCallback, useEffect, useRef, useState } from 'react';
import { isRunning, resumePayment, startPayment } from './payments';

// Drives one invoice's Pay Now on screen. All the rules live in lib/payments.js; this only turns its outcomes into what the
// row shows. `phase`:
//   idle        nothing happening (Pay Now shown when the backend says the invoice is payable)
//   working     an attempt, or a check of one, is running (button disabled)
//   confirming  the browser reported a submitted payment and the backend has not confirmed it yet (button hidden; "Check again" instead)
//   paid        the backend confirmed it
//   cancelled | failed | uncertain | error   a message and Pay Now again
// The look at an attempt left open (one request) must end by itself: if it hangs (a session wait, a stalled request) the row shows an error
// and Pay Now again instead of "Working on your payment…" for ever.
export const CHECK_TIMEOUT_MS = 20000;
const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

export function usePayment({ invoice, requestId, onChanged }) {
  const invoiceId = invoice.id;
  const [state, setState] = useState({ phase: 'idle', messageKey: null, fullyPaid: false });
  const alive = useRef(true);
  const checkedFor = useRef(null); // the invoice whose open attempt was looked at on this screen: a re-render never looks again
  const guard = useRef(false); // a tap is handled synchronously, before any re-render could disable the button
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; });
  const stopped = useCallback(() => !alive.current, []);

  const apply = useCallback((result) => {
    if (!alive.current || !result || result.outcome === 'busy') return;
    if (result.outcome === 'paid') setState({ phase: 'paid', messageKey: null, fullyPaid: !!result.fullyPaid });
    else if (result.outcome === 'confirming') setState({ phase: 'confirming', messageKey: null, fullyPaid: false });
    else if (result.outcome === 'cancelled') setState({ phase: 'cancelled', messageKey: 'payment_cancelled', fullyPaid: false });
    else setState({ phase: result.outcome === 'failed' ? 'failed' : result.outcome === 'uncertain' ? 'uncertain' : 'error', messageKey: result.messageKey || 'payment_error_generic', fullyPaid: false });
    if (result.outcome === 'paid' || result.refresh || result.outcome === 'failed') changed.current && changed.current();
  }, []);

  const run = useCallback(async (task) => {
    if (guard.current || isRunning(invoiceId)) return;
    guard.current = true;
    setState((s) => ({ ...s, phase: 'working' }));
    try {
      const result = await task();
      if (result == null) setState((s) => (s.phase === 'working' ? { phase: 'idle', messageKey: null, fullyPaid: false } : s));
      else apply(result);
    } catch {
      // Whatever went wrong (storage, a bad answer), the screen must not stay "working": show a message and Pay Now again.
      if (alive.current) setState({ phase: 'error', messageKey: 'payment_error_generic', fullyPaid: false });
    } finally {
      guard.current = false;
    }
  }, [apply, invoiceId]);

  const pay = useCallback(() => run(() => startPayment({ invoice, requestId, shouldStop: stopped })), [run, invoice, requestId, stopped]);
  const check = useCallback(() => run(() => withTimeout(resumePayment({ invoiceId, shouldStop: stopped }), CHECK_TIMEOUT_MS)), [run, invoiceId, stopped]);

  // An attempt left open when the app was closed or left is looked at ONCE when the screen shows (resumePayment settles it with one request).
  // Neither a re-render, nor the app regaining focus, nor the screen's own focus refresh looks again: only "Check again" and Pay Now do.
  useEffect(() => {
    alive.current = true;
    if (checkedFor.current !== invoiceId) {
      checkedFor.current = invoiceId;
      check();
    }
    return () => { alive.current = false; };
  }, [check, invoiceId]);

  // Pay Now is on offer in every phase except paid (done) and confirming (a submitted payment awaits the backend); it is only DISABLED while working.
  return { ...state, working: state.phase === 'working', payNowOffered: state.phase !== 'paid' && state.phase !== 'confirming', pay, check };
}
