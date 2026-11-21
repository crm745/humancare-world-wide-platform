import { useEffect } from 'react';
import { View } from 'react-native';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useNetwork } from '../state/NetworkContext';
import { navReplace } from '../lib/nav';
import { CANT_CONNECT_PATH, cantConnectState, cantConnectText, cantConnectView } from '../lib/cantConnect';
import { StateView } from '../components/network/StateView';
import { Reveal } from '../components/skeleton/Reveal';

// "Can't connect": where a returning person waits when their SAVED session could not be validated because the connection or the server is down (the splash sends them here, lib/splash.js,
// only AFTER the check failed: while the session is being checked the splash itself stays on screen). It is a public, static screen: it shows no account, request, document or other cached data,
// and it decides nothing about the session. When the server answers it moves on by itself (valid -> Home, refused -> Login); when the connection returns the app checks again once on its own
// (lib/authRestore.js). "Try again" checks now. The saved session is never cleared by anything here. It has no logo, no SOS and no way to log in as someone else: the state layout
// (components/network/StateView.js), one filled Try again button, and a pill that says the saved session is safe (not shown when the phone itself could not read it).
export default function CantConnect() {
  const { t, authStatus, retryAuth } = useApp();
  const net = useNetwork();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const view = cantConnectView({ authStatus });
  const text = (key) => cantConnectText(t, key);

  // The answer arrived (also a slow one, after the splash gave up waiting): go where it says. Only while this screen is the one in front.
  useEffect(() => {
    if (view.leaveTo && pathname === CANT_CONNECT_PATH) navReplace(view.leaveTo);
  }, [view.leaveTo, pathname]);

  // A check that is running again (Try again, or one that was still going when the person arrived) keeps the last state on screen with the button busy: no separate "Connecting…" screen.
  const checking = view.mode === 'connecting' || view.mode === 'leave';
  const state = cantConnectState({ authStatus, net });

  return (
    <View style={{ flex: 1, backgroundColor: '#F2F6FC', paddingTop: insets.top, paddingBottom: insets.bottom + 16, paddingHorizontal: 26, alignItems: 'center', justifyContent: 'center' }}>
      <Reveal animate style={{ width: '100%', maxWidth: 360 }}>
      <StateView
        icon={state.icon} title={text(state.titleKey)} body={text(state.bodyKey)}
        retryLabel={text('cc_try_again')} onRetry={retryAuth} retrying={checking}
        pill={state.safePill ? { icon: 'shield', text: text('cc_safe') } : null}
        style={{ width: '100%' }}
      />
      </Reveal>
    </View>
  );
}
