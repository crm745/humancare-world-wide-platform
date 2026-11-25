import { useEffect } from 'react';
import { useApp } from '../state/AppContext';
import { pushSupported, registerForPushNotifications } from '../lib/pushNotifications';

// Registers this phone's push device for the signed-in PATIENT as soon as the sign-in is accepted (a login, or a saved session the
// server accepted), not only when Home opens. Nothing is rendered. Corporate sessions are never registered.
// Repeats are harmless: lib/deviceRegistry.js shares one call between concurrent triggers and does nothing once the session is registered.
// An Expo/FCM token change while signed in registers again (the server updates the same device row).
export function DeviceRegistrationHandler() {
  const { authStatus, isCorporate } = useApp();

  useEffect(() => {
    if (authStatus !== 'authed' || isCorporate) return undefined;
    registerForPushNotifications();
    if (!pushSupported) return undefined;

    let cancelled = false;
    let subscription = null;
    (async () => {
      try {
        const Notifications = await import('expo-notifications');
        if (cancelled) return;
        subscription = Notifications.addPushTokenListener(() => { registerForPushNotifications({ recheck: true }); });
      } catch {
        // No push capability on this device/build: nothing to watch.
      }
    })();

    return () => {
      cancelled = true;
      if (subscription) subscription.remove();
    };
  }, [authStatus, isCorporate]);

  return null;
}
