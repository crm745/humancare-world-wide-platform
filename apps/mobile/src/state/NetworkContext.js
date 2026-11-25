import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createDeviceNetworkStore } from '../lib/networkDevice';
import { activateNetworkService } from '../lib/networkService';
import { NET } from '../lib/network';

// The network state for the whole app (lib/network.js). Mounted once, in app/_layout.js. Phase 1 only provides the state: no banner, no screen reacts
// to it yet. It never touches authentication, and nothing is resent when the connection returns.
const NetworkContext = createContext(null);

const UNKNOWN_STATE = Object.freeze({ status: NET.UNKNOWN, link: { isConnected: null, isInternetReachable: null, type: 'unknown' }, lastCheckedAt: null, restoredAt: null, restoredCount: 0 });
const none = () => () => {};

const flags = (state) => ({
  status: state.status,
  // "unknown" counts as not offline, so nothing is shown or disabled before the first reading.
  isOnline: state.status === NET.ONLINE || state.status === NET.UNKNOWN,
  isOffline: state.status === NET.OFFLINE,
  isSlow: state.status === NET.SLOW,
  isServerDown: state.status === NET.SERVER_DOWN,
  link: state.link,
  lastCheckedAt: state.lastCheckedAt,
  restoredAt: state.restoredAt, // when the connection last came back (null until it has)
  restoredCount: state.restoredCount, // moves by one at every restoration: a screen can watch it to know a restoration happened
});

export function NetworkProvider({ children }) {
  const [store] = useState(createDeviceNetworkStore);

  // One NetInfo listener and one AppState listener for the app's whole life; undone on unmount (and so not doubled by Strict Mode).
  useEffect(() => activateNetworkService(store), [store]);

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const check = useCallback(() => store.check(), [store]);
  const onRestored = useCallback((fn) => store.onRestored(fn), [store]);

  const value = useMemo(() => ({ ...flags(state), check, onRestored }), [state, check, onRestored]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

// Outside the provider (a test, an isolated screen) it reports "unknown", which is not offline.
const FALLBACK = { ...flags(UNKNOWN_STATE), check: () => Promise.resolve(), onRestored: none };

export function useNetwork() {
  return useContext(NetworkContext) || FALLBACK;
}
