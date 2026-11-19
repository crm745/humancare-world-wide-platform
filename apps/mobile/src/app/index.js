import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Platform, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { LOGO, SPLASH_BG } from '../data/images';
import { navReplace } from '../lib/nav';
import { MIN_SPLASH_MS, SESSION_TIMEOUT_MS, splashDecision } from '../lib/splash';
import { COLORS } from '../theme/colors';

// The native animation driver exists on phones only; the browser preview animates in JS.
const NATIVE = Platform.OS !== 'web';

// Sampled from the logo itself, so the loading line matches it.
const LOGO_RED = '#B41C2D';
const LOGO_BLUE = COLORS.primary;
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

// Splash: the logo centred over the globe picture with a thin line sweeping left to right under it. It is shown for at least 3 seconds (MIN_SPLASH_MS, lib/splash.js) on
// every launch, and it is NOT interactive: a tap does nothing, so nothing can skip the session check. AppContext checks the saved session with the server in parallel
// (authStatus, lib/authState.js); when the minimum has passed and that check has an answer, the splash goes ONE place: Home when the server accepted the session
// ('authed'), Getting Started for everything else (a new person, a logged-out person, a refused or unreadable session, a server that could not be asked). A check that has
// not answered by SESSION_TIMEOUT_MS (4 s) also goes to Getting Started, so the splash is never stuck. It never goes twice.
export default function Splash() {
  const { t, authStatus } = useApp();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [intro] = useState(() => new Animated.Value(0));
  const [sweep] = useState(() => new Animated.Value(0));
  const [trackWidth, setTrackWidth] = useState(0);
  const [minElapsed, setMinElapsed] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const navigated = useRef(false);

  // The two clocks: the minimum time on screen, and the longest the session check is waited for. Both start when the splash appears.
  useEffect(() => {
    const minimum = setTimeout(() => setMinElapsed(true), MIN_SPLASH_MS);
    const limit = setTimeout(() => setTimedOut(true), SESSION_TIMEOUT_MS);
    return () => { clearTimeout(minimum); clearTimeout(limit); };
  }, []);

  // Goes once, from the resolved authentication state (lib/splash.js splashDecision): never earlier than the minimum, never on a guess.
  useEffect(() => {
    const route = splashDecision({ status: authStatus, minElapsed, timedOut, navigated: navigated.current });
    if (!route) return;
    navigated.current = true;
    navReplace(route);
  }, [authStatus, minElapsed, timedOut]);

  useEffect(() => {
    let cancelled = false;

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
      fadeIn.stop();
      sweeping?.stop();
    };
  }, [intro, sweep]);

  const segmentWidth = trackWidth * SEGMENT;
  const translateX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-segmentWidth, trackWidth] });

  return (
    <View className="flex-1" style={{ backgroundColor: BG_COLOR }}>
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
    </View>
  );
}
