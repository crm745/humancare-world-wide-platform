// The device side of the network service: NetInfo for the link, AppState for foreground/background, and the backend's GET /health for the server.
// The decisions are all in lib/network.js; this file only plugs the real modules into it.
import { AppState } from 'react-native';
import { API_BASE_URL } from './api';
import { createHealthProbe } from './healthProbe';
import { createNetworkStore } from './network';

// NetInfo is a NATIVE module: an app build made before it was added (an older development build, Expo Go) does not contain it, and importing it then throws "NativeModule.RNCNetInfo is null"
// and takes the whole app down at start. So it is loaded defensively: without it there are simply no link events, and the network service still works from the backend's /health probe
// (the app starts and every call reports its own failures). A build that includes the module behaves exactly as before.
let NetInfo = null;
try {
  NetInfo = require('@react-native-community/netinfo').default;} catch {
  NetInfo = null;
}

// NetInfo calls back at once with the current state and then on every change. Its own reachability test (isInternetReachable) uses NetInfo's
// default addresses: it answers "does the internet work?", independently of our backend, which is asked separately through /health. Only isConnected === false means "no link"; a false isInternetReachable
// is a hint (a Wi-Fi without upstream, or NetInfo's own test address blocked) and never stops /health from being asked: the backend's answer decides online / slow / serverDown (lib/network.js).
export const subscribeLink = (callback) => (NetInfo ? NetInfo.addEventListener(callback) : () => {});

// true when the app is in front, false when it is not (background, or the short "inactive" step on iOS).
export function subscribeAppActive(callback) {
  const subscription = AppState.addEventListener('change', (next) => callback(next === 'active'));
  return () => subscription.remove();
}

// The connection NOW (NetInfo.refresh re-reads it, including whether the internet is reachable); without the module there is nothing to ask.
export const refreshLink = () => (NetInfo ? (NetInfo.refresh ? NetInfo.refresh() : NetInfo.fetch()) : Promise.resolve(null));

export const createDeviceNetworkStore = () => createNetworkStore({
  probe: createHealthProbe({ baseUrl: API_BASE_URL }),
  subscribeLink,
  subscribeAppActive,
  refreshLink,
});
