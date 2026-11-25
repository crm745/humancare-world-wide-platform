import { useEffect, useRef } from 'react';
import { useNetwork } from '../state/NetworkContext';
import { retryOnRestoration } from './networkUi';

// For a screen that loads its own data (not through lib/useResource.js, which already does this): when the connection comes back, a READ that failed is run again ONCE.
//   failed   whether the last read failed (the screen's own flag)
//   retry    runs that read again
// The same rule as useResource (lib/networkUi.js retryOnRestoration): a restoration that happened before the screen existed is ignored, the retry happens at most once per restoration, and only when
// the last read failed. It only ever calls the READ you pass in: nothing here can resend a write, an upload or a submission.
export function useRetryOnRestore({ failed, retry, enabled = true }) {
  const { restoredCount } = useNetwork();
  const seen = useRef(restoredCount);
  const failedRef = useRef(failed);
  const retryRef = useRef(retry);
  useEffect(() => { failedRef.current = failed; retryRef.current = retry; });
  useEffect(() => {
    const next = retryOnRestoration({ restoredCount, seen: seen.current, enabled, failed: failedRef.current });
    seen.current = next.seen;
    if (next.retry && retryRef.current) retryRef.current();
  }, [restoredCount, enabled]);
}
