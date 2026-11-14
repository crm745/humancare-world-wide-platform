import { Text, View } from 'react-native';

// What the Google sign-in popup shows once Google has sent it back to the app (see lib/googleCallback.web.js). It is only here for the moment
// before the popup closes itself. It has no providers and no navigation of its own on purpose: the popup must not start the app.
export function GoogleCallbackScreen() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', padding: 24 }}>
      <Text style={{ fontSize: 18, fontWeight: '700', color: '#0D2340', textAlign: 'center' }}>Signing you in…</Text>
      <Text style={{ marginTop: 8, fontSize: 14, color: '#5B6B84', textAlign: 'center' }}>You can close this window.</Text>
    </View>
  );
}
