import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { apiPost } from './api';
import { onSessionChange } from './session';
import { registerDevice, unregisterDevice } from './notificationsApi';
import { createDeviceRegistry } from './deviceRegistry';
import { isRetryablePushFailure } from './pushRetry';

// Since Expo SDK 53, expo-notifications throws immediately when its module is even
// imported inside Expo Go on Android (remote push there needs a development build
// instead — see https://docs.expo.dev/develop/development-builds/introduction/).
// So the package is only ever imported when we're NOT running inside Expo Go.
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// Push notifications have no web implementation either.
export const pushSupported = Platform.OS !== 'web' && !isExpoGo;

// The Expo push token of this phone, or null when there is none (denied permission, missing projectId, no push on this
// device/build). A denied permission or missing projectId never blocks the rest of the app.
async function getExpoPushToken() {
  if (!pushSupported) return null;
  const Notifications = await import('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Default', importance: Notifications.AndroidImportance.DEFAULT });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const { data: pushToken } = await Notifications.getExpoPushTokenAsync({ projectId });
  return pushToken;
}

// The one registry of this app run (lib/deviceRegistry.js holds the rules). The installation id is kept in AsyncStorage.
const registry = createDeviceRegistry({
  storage: AsyncStorage,
  newUuid: () => Crypto.randomUUID(),
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  getExpoToken: getExpoPushToken,
  registerDevice,
  unregisterDevice,
  // The legacy single-token endpoint stays until the backend senders read the device registry.
  legacyRegister: (pushToken) => apiPost('/auth/push-token', { pushToken }),
});

// Every sign-in and sign-out forgets what was registered in the session before, so the next patient on this phone registers again.
onSessionChange(() => registry.reset());

// Best-effort and de-duplicated: callable from any number of places (the sign-in handler, Home); concurrent calls share one run and an
// already registered session does nothing. Never throws. `recheck: true` (Expo token changed) registers again only if the token differs.
// Resolves 'registered' (this phone is registered, now or already), 'skipped' (nothing to register: web, Expo Go, permission not granted, no projectId) or 'retry' (it failed for a reason a better
// connection can fix: Home tries once more when the connection returns, app/home.js). The registration is an upsert on the server, so asking again can never create a second entry.
export async function registerForPushNotifications(options) {
  try {
    const outcome = await registry.ensureRegistered(options);
    if (outcome.status === 'failed') throw outcome.error;
    if (outcome.status === 'registered' || outcome.status === 'already') return 'registered';
    return 'skipped';
  } catch (err) {
    // Device/simulator without push capability, or user not logged in yet — ignore. A network failure (no answer, a timeout, a server error) is worth one more try later.
    return isRetryablePushFailure(err) ? 'retry' : 'skipped';
  }
}

// Patient logout: removes this phone from the signed-in patient BEFORE the tokens are cleared. Resolves { ok, reason? }; ok is false when
// the server did not confirm it, so the caller can tell the person. The installation id is kept for the next sign-in.
export function unregisterThisDevice() {
  return registry.unregister();
}
