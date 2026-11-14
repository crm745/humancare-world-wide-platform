import { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GettingStartedIntro } from '../components/GettingStartedIntro';

const MAX_COLUMN = 480;

// "Get Started" opens Login. New people use "Sign up" on the Login screen to reach Create Account.
const finish = () => router.push('/login');

// Getting Started: one page (GettingStartedIntro) with its own Get Started button. The earlier first page ("All your care in one place",
// with Skip, dots and Next) is gone, so there is no pager any more. The page is laid out left to right even in Arabic, as before.
export default function Welcome() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pageW = Math.min(width, MAX_COLUMN);
  const [pageH, setPageH] = useState(0);

  return (
    <View style={{ flex: 1, backgroundColor: '#FFFFFF', paddingTop: insets.top, direction: 'ltr' }}>
      <View
        style={{ flex: 1, width: '100%', maxWidth: MAX_COLUMN, alignSelf: 'center' }}
        onLayout={(e) => setPageH(Math.round(e.nativeEvent.layout.height))}
      >
        <GettingStartedIntro width={pageW} height={pageH} onNext={finish} />
      </View>
    </View>
  );
}
