import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useNetwork } from '../state/NetworkContext';
import { createRefreshGuard, runNetworkRefresh } from './networkRefresh';

// The hook behind pull-to-refresh on a screen that has no list of its own data (lib/networkRefresh.js says what it does and never does).
//   reload   (optional) an async READ of the screen's server data; leave it out on a form, where a pull only re-checks the connection
// Returns { refreshing, onRefresh } for components/AppRefreshControl.js. `refreshing` is true only while a pull is being worked on; a second pull while one runs is the same run.
// A failed read says "Couldn't refresh" (the shared sk_refresh_failed text, in every language) and keeps what is on screen.
export function useNetworkRefresh({ reload } = {}) {
  const { t, toast } = useApp();
  const { check } = useNetwork();
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef({ t, toast, check, reload });
  const mounted = useRef(true);
  useEffect(() => { latest.current = { t, toast, check, reload }; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const [guard] = useState(createRefreshGuard); // one at a time: a second pull while one runs is the same run
  const onRefresh = useCallback(() => guard.run(async () => {
    if (mounted.current) setRefreshing(true);
    try {
      const now = latest.current;
      const { failed } = await runNetworkRefresh({ check: now.check, reload: now.reload });
      if (failed && mounted.current) latest.current.toast(latest.current.t('sk_refresh_failed'));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }), [guard]);
  return { refreshing, onRefresh };
}
