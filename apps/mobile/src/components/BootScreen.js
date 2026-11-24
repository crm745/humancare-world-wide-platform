import { Image, View, useWindowDimensions } from 'react-native';
import { LOGO, SPLASH_BG } from '../data/images';

// What is on screen in the very short moment between the app starting and its fonts being ready (app/_layout.js), instead of an empty page: the splash's own picture (the globe, the logo, the
// line's track), so the browser's boot splash (public/index.html) turns into the app's splash without a white flash. It has no text (the app's language is not known yet), is not interactive
// and is hidden from screen readers. The real splash (app/index.js) takes over from here.
const BG_COLOR = '#EEF6FD';
const LOGO_RATIO = 2440 / 1405;
// The same size as the splash's logo and the spacer that stands where its tagline goes, so the logo does not move when the splash appears.
const TAGLINE_SPACE = 64;

export function BootScreen() {
  const { width, height } = useWindowDimensions();
  const logoWidth = Math.min(width * 0.62, 320);
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flex: 1, backgroundColor: BG_COLOR }}>
      <Image source={SPLASH_BG} accessible={false} resizeMode="cover" style={{ position: 'absolute', top: 0, left: 0, width, height }} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Image source={LOGO} resizeMode="contain" style={{ width: logoWidth, height: logoWidth / LOGO_RATIO }} />
        <View style={{ height: TAGLINE_SPACE }} />
        <View style={{ width: '50%', maxWidth: 200, height: 3, borderRadius: 3, backgroundColor: '#E4E9F2' }} />
      </View>
    </View>
  );
}
