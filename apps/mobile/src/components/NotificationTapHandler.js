import { useEffect } from 'react';
import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { router, usePathname } from 'expo-router';
import { useApp } from '../state/AppContext';
import { targetFromPushResponse } from '../lib/notificationLink';

// Same rule as lib/pushNotifications.js: expo-notifications is never imported inside Expo Go (it throws there) or on the web.
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// Opens the right screen when a patient taps a push notification, with the SAME mapping as a tap in the Notifications list
// (lib/notificationLink.js). Nothing is rendered.
//   - app open or in the background: a response listener;
//   - app started by the tap (cold start): the last response, read once the app is signed in and past the splash screen.
// A response is only acted on while a patient is signed in, and is cleared after it has been handled (or when nobody can use it:
// signed out, or a corporate session) so a later sign-in never replays an old tap. A push without usable data just opens the app.
export function NotificationTapHandler() {
  const { authStatus, isCorporate } = useApp();
  const pathname = usePathname();
  const pastSplash = pathname !== '/'; // the splash screen replaces itself with Home; a push opened before that would be lost

  useEffect(() => {
    if (Platform.OS === 'web' || isExpoGo) return undefined;
    const signedOutOrCorporate = authStatus === 'anon' || (authStatus === 'authed' && isCorporate);
    const patientReady = authStatus === 'authed' && !isCorporate && pastSplash;
    if (!signedOutOrCorporate && !patientReady) return undefined; // still checking the session, or still on the splash: wait

    let cancelled = false;
    let subscription = null;
    (async () => {
      try {
        const Notifications = await import('expo-notifications');
        if (cancelled) return;
        if (signedOutOrCorporate) {
          Notifications.clearLastNotificationResponse();
          return;
        }
        const handle = (response) => {
          if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
          const target = targetFromPushResponse(response);
          Notifications.clearLastNotificationResponse();
          if (target) router.push(target);
        };
        subscription = Notifications.addNotificationResponseReceivedListener(handle);
        handle(Notifications.getLastNotificationResponse());
      } catch {
        // No push capability on this device/build: nothing to handle.
      }
    })();

    return () => {
      cancelled = true;
      if (subscription) subscription.remove();
    };
  }, [authStatus, isCorporate, pastSplash]);

  return null;
}
