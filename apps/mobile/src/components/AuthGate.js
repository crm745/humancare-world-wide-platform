import { useEffect } from 'react';
import { View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useApp } from '../state/AppContext';
import { useNetwork } from '../state/NetworkContext';
import { cantConnectState, cantConnectText } from '../lib/cantConnect';
import { StateView } from './network/StateView';
import { TextButton } from './network/TextButton';
import { guardDecision, loginRouteFor, setCurrentPath } from '../lib/authGuard';
import { Spinner } from './Spinner';
import { COLORS } from '../theme/colors';

// The state the cover shows: 'storage' (the phone could not read the saved session) or the connection / server.
function retryView(reason, net, t) {
  const state = cantConnectState({ authStatus: reason === 'storage' ? 'error' : 'unreachable', net });
  return { icon: state.icon, title: cantConnectText(t, state.titleKey), body: cantConnectText(t, state.bodyKey), pill: state.safePill ? { icon: 'shield', text: cantConnectText(t, 'cc_safe') } : null };
}

// The one authentication gate for the whole app (see lib/authGuard.js for the rules). It sits over the
// navigator: a protected screen is covered, and never visible, until the session has been checked with
// the server; no valid session means a redirect to Login. Public screens are never covered.
export function AuthGate() {
  const { t, authStatus, retryAuth } = useApp();
  const net = useNetwork();
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
          {/* The same state layout as Can't Connect (components/network/StateView.js), in the person's language: what is wrong, Try again, and (when the connection is the problem) that the saved session is safe. */}
          <StateView
            {...retryView(decision.reason, net, t)}
            retryLabel={cantConnectText(t, 'cc_try_again')} onRetry={retryAuth} style={{ width: '100%', maxWidth: 360 }}
          />
          <TextButton title={t('login_btn')} onPress={() => router.replace(loginRouteFor(pathname))} style={{ marginTop: 6 }} />
        </>
      ) : (
        <View accessible accessibilityLabel={t('a11y_loading')} accessibilityRole="progressbar">
          <Spinner size={30} color={COLORS.primary} trackColor={COLORS.primarySoft} />
        </View>
      )}
    </View>
  );
}
