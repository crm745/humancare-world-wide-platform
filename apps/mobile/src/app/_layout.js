// FIRST: if this window is the Google sign-in popup coming back from Google, hand the answer over before anything else loads (the web only).
import { googleCallback } from '../lib/googleCallback';
import '../../global.css';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
// Per-weight imports so only these five font files are bundled.
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { Inter_800ExtraBold } from '@expo-google-fonts/inter/800ExtraBold';
import { AppProvider, useApp } from '../state/AppContext';
import { Toast } from '../components/widgets';
import { AuthGate } from '../components/AuthGate';
import { SosFab } from '../components/sos/SosFab';
import { RecaptchaBadgeGate } from '../components/RecaptchaBadgeGate';
import { KeyboardRoot } from '../components/keyboard';
import { SystemBack } from '../components/SystemBack';
import { GoogleCallbackScreen } from '../components/GoogleCallbackScreen';

function Shell() {
  const { isRTL } = useApp();
  // Arabic flips the layout in place, like the prototype's .phone.rtl, without an app reload.
  return (
    <View className="flex-1 bg-canvas" style={{ direction: isRTL ? 'rtl' : 'ltr' }}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#F2F6FC' } }} />
      <SosFab />
      <RecaptchaBadgeGate />
      <AuthGate />
      <Toast />
      <SystemBack />
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });
  // The Google popup, back from Google: it has handed its answer over (lib/googleCallback.web.js) and must NOT start the app (no splash, no Getting Started).
  if (googleCallback) return <GoogleCallbackScreen />;
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <KeyboardRoot>
        <AppProvider>
          <Shell />
        </AppProvider>
      </KeyboardRoot>
    </SafeAreaProvider>
  );
}
