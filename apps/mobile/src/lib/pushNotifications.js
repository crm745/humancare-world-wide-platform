import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { apiPost } from './api';
import { isRetryablePushFailure } from './pushRetry';

// Since Expo SDK 53, expo-notifications throws immediately when its module is even
// imported inside Expo Go on Android (remote push there needs a development build
// instead — see https://docs.expo.dev/develop/development-builds/introduction/).
// So the package is only ever imported when we're NOT running inside Expo Go.
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// Push notifications have no web implementation either, and a denied permission or
// missing projectId should never block the rest of the app, so this is best-effort.
// Resolves 'registered' (the token is saved), 'skipped' (nothing to register: web, Expo Go, permission not granted) or 'retry' (it failed for a reason a better connection can fix: Home tries once more
// when the connection returns, app/home.js). The token is saved with a plain upsert on the server, so asking again can never create a second entry.
export async function registerForPushNotifications() {
  if (Platform.OS === 'web' || isExpoGo) return 'skipped';
  try {
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
    if (status !== 'granted') return 'skipped';

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', { name: 'Default', importance: Notifications.AndroidImportance.DEFAULT });
    }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const { data: pushToken } = await Notifications.getExpoPushTokenAsync({ projectId });
    await apiPost('/auth/push-token', { pushToken });
    return 'registered';
  } catch (err) {
    // Device/simulator without push capability, or user not logged in yet — ignore. A network failure (no answer, a timeout, a server error) is worth one more try later.
    return isRetryablePushFailure(err) ? 'retry' : 'skipped';
  }
}

