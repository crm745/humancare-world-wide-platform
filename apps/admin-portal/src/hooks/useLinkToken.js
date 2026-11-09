import { useEffect, useState } from 'react';
import { clearFragment, readFragmentToken } from '@/utils/linkToken';

/**
 * The one-time token from the invitation link's fragment, held in component memory only.
 * The fragment is removed from the address bar as soon as the page mounts. Call `forget()` once the
 * token has been exchanged so it does not stay in memory any longer than needed.
 * The initial read has no side effects, so React StrictMode's second mount sees the same state.
 */
export function useLinkToken() {
  const [token, setToken] = useState(() => readFragmentToken());
  useEffect(() => {
    clearFragment();
  }, []);
  return [token, () => setToken(null)];
}
