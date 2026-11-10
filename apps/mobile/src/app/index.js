import { useEffect, useState } from 'react';
import { Animated, Easing, Image, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { LOGO, SPLASH_BG } from '../data/images';
import { navReplace } from '../lib/nav';
import { getAccessToken } from '../lib/session';

const MIN_SPLASH_MS = 5000; // kept at 5 s for now
// If reading the saved session ever hangs, give up and land on Getting Started rather than
// leaving the splash up forever.
const SESSION_TIMEOUT_MS = 4000;
// The native animation driver exists on phones only; the browser preview animates in JS.
const NATIVE = Platform.OS !== 'web';

// Sampled from the logo itself, so the loading line matches it.
const LOGO_RED = '#B41C2D';
const LOGO_BLUE = '#2F3A8D';
// The logo is 62% of the screen width, at most 320. Its height is worked out here instead of left
// to aspectRatio, which the browser preview ignores (the box came out as tall as the picture).
const LOGO_RATIO = 2440 / 1405;
const logoSize = (screenWidth) => {
  const width = Math.min(screenWidth * 0.62, 320);
  return { width, height: width / LOGO_RATIO };
};
// The moving part of the line, as a share of the track.
const SEGMENT = 0.38;
// Shown behind the globe picture until it has loaded, so nothing flashes white or dark.
const BG_COLOR = '#EEF6FD';
// The tagline uses the phone's own serif font: no font file to add or load before the splash.
const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, "Times New Roman", serif' });
const TAGLINE_STYLE = { marginTop: 14, paddingHorizontal: 28, textAlign: 'center', color: '#0D2340', fontSize: 21, fontFamily: SERIF };

// Splash: the logo centred on white with a thin line sweeping left to right under it,
// shown for at least 2s (tap to skip) while we check for a saved session. A saved token
// means they're already logged in — AppContext's own startup effect loads their real
// profile in parallel (it runs on every app launch, not just this screen), so here we
// just need to decide where to land: Home if there's a token to try, Getting Started if there's
// none.
export default function Splash() {
  const { t } = useApp();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [intro] = useState(() => new Animated.Value(0));
  const [sweep] = useState(() => new Animated.Value(0));
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timers = [];
    const wait = (ms) => new Promise((resolve) => timers.push(setTimeout(resolve, ms)));
    const session = Promise.race([getAccessToken(), wait(SESSION_TIMEOUT_MS).then(() => null)]).catch(() => null);

    Promise.all([session, wait(MIN_SPLASH_MS)]).then(([token]) => {
      if (cancelled) return;
      navReplace(token ? '/home' : '/welcome');
    });

    const fadeIn = Animated.timing(intro, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE });
    fadeIn.start();

    // The line sweeps again and again until the splash ends: each sweep starts the next one
    // when it finishes. (Animated.loop is not used: with the native driver it is not
    // available in the browser preview, and the line moved only once there.)
    let sweeping = null;
    const sweepOnce = () => {
      if (cancelled) return;
      sweep.setValue(0);
      sweeping = Animated.timing(sweep, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.cubic), useNativeDriver: NATIVE });
      sweeping.start(({ finished }) => { if (finished) sweepOnce(); });
    };
    sweepOnce();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      fadeIn.stop();
      sweeping?.stop();
    };
  }, [intro, sweep]);

  const segmentWidth = trackWidth * SEGMENT;
  const translateX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-segmentWidth, trackWidth] });

  return (
    <Pressable className="flex-1" style={{ backgroundColor: BG_COLOR }} onPress={() => navReplace('/welcome')}>
      {/* Sized to the screen: in the browser an image given only top/left/right/bottom shows at its own size. */}
      <Image source={SPLASH_BG} accessible={false} resizeMode="cover" style={{ position: 'absolute', top: 0, left: 0, width: screenW, height: screenH }} />
      <View className="flex-1 items-center justify-center" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <Animated.View
          style={{
            width: '100%',
            alignItems: 'center',
            opacity: intro,
            transform: [{ scale: intro.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
          }}
        >
          <Image source={LOGO} style={logoSize(screenW)} resizeMode="contain" />
          <Text style={TAGLINE_STYLE} maxFontSizeMultiplier={1.3}>{t('splash_tagline')}</Text>
          <View style={{ width: '50%', maxWidth: 200, marginTop: 28 }}>
            <View
              className="h-[3px] overflow-hidden rounded-full bg-line"
              onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
            >
              {trackWidth > 0 && (
                <Animated.View style={{ width: segmentWidth, height: '100%', flexDirection: 'row', transform: [{ translateX }] }}>
                  <View style={{ flex: 1, backgroundColor: LOGO_RED }} />
                  <View style={{ flex: 1, backgroundColor: LOGO_BLUE }} />
                </Animated.View>
              )}
            </View>
          </View>
        </Animated.View>
      </View>
    </Pressable>
  );
}
