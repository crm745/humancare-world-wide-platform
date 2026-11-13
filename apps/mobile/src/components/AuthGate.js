import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useApp } from '../state/AppContext';
import { guardDecision, loginRouteFor, setCurrentPath } from '../lib/authGuard';
import { Spinner } from './Spinner';
import { Text } from './ui';

// The one authentication gate for the whole app (see lib/authGuard.js for the rules). It sits over the
// navigator: a protected screen is covered, and never visible, until the session has been checked with
// the server; no valid session means a redirect to Login. Public screens are never covered.
export function AuthGate() {
  const { authStatus, retryAuth } = useApp();
  const pathname = usePathname();
  const decision = guardDecision({ pathname, status: authStatus });

  useEffect(() => { setCurrentPath(pathname); }, [pathname]);

  const target = decision.action === 'redirect' ? decision.redirect : null;
  useEffect(() => {
    // The target is a public screen, so this cannot redirect again (no loop).
    if (target && target !== pathname) router.replace(target);
  }, [target, pathname]);

  if (decision.action === 'allow') return null;

  return (
    <View
      accessibilityViewIsModal
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100, backgroundColor: '#F2F6FC', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      {decision.action === 'retry' ? (
        <>
          <Text className="font-inter-bold" style={{ fontSize: 16, color: '#0D2340', textAlign: 'center' }}>
            {decision.reason === 'storage' ? "We couldn't open your saved session" : "We can't reach the server"}
          </Text>
          <Text style={{ marginTop: 6, fontSize: 13.5, color: '#5B6B84', textAlign: 'center' }}>
            {decision.reason === 'storage' ? 'Try again, or log in again.' : 'Check your connection and try again.'}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Try again" onPress={retryAuth} style={{ marginTop: 18, minHeight: 44, minWidth: 140, borderRadius: 12, backgroundColor: '#1A73E8', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 }}>
            <Text className="font-inter-bold" style={{ fontSize: 14.5, color: '#FFFFFF' }}>Try again</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Log in" onPress={() => router.replace(loginRouteFor(pathname))} style={{ marginTop: 6, minHeight: 44, justifyContent: 'center' }}>
            <Text className="font-inter-bold" style={{ fontSize: 14, color: '#1A5FC4' }}>Log in</Text>
          </Pressable>
        </>
      ) : (
        <View accessible accessibilityLabel="Loading" accessibilityRole="progressbar">
          <Spinner size={30} color="#1A73E8" trackColor="#E7F0FE" />
        </View>
      )}
    </View>
  );
}
