import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { isRunning, resumePayment, startPayment } from './payments';

// Drives one invoice's Pay Now on screen. All the rules live in lib/payments.js; this only turns its outcomes into what the
// row shows. `phase`:
//   idle        nothing happening (Pay Now shown when the backend says the invoice is payable)
//   working     an attempt, or a check of one, is running (button disabled)
//   confirming  Checkout is done but the backend has not confirmed it yet (button hidden; "Check again" instead)
//   paid        the backend confirmed it
//   cancelled | failed | uncertain | error   a message and Pay Now again
export function usePayment({ invoice, requestId, onChanged }) {
  const invoiceId = invoice.id;
  const [state, setState] = useState({ phase: 'idle', messageKey: null, fullyPaid: false });
  const alive = useRef(true);
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
    } finally {
      guard.current = false;
    }
  }, [apply, invoiceId]);

  const pay = useCallback(() => run(() => startPayment({ invoice, requestId, shouldStop: stopped })), [run, invoice, requestId, stopped]);
  const check = useCallback(() => run(() => resumePayment({ invoiceId, shouldStop: stopped })), [run, invoiceId, stopped]);

  useEffect(() => {
    alive.current = true;
    check(); // an attempt left open when the app was closed or left is picked up here
    const sub = AppState.addEventListener('change', (next) => { if (next === 'active') check(); });
    return () => { alive.current = false; sub.remove(); };
  }, [check]);

  return { ...state, working: state.phase === 'working', pay, check };
}
