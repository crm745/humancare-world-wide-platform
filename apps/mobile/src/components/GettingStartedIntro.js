import { useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ShieldCheck } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { GETTING_STARTED_SCENE, LOGO } from '../data/images';
import { Button, Card, Heading, Text } from './ui';
import { COLORS } from '../theme/colors';

// The Getting Started page. Only the logo and the scene are pictures; the heading, tagline,
// trust card, button and footer line are real text. Type, colours and the button are the app's
// own (Heading, Card, Button, text-muted, text-primary), so this page sizes like every other screen.
const LOGO_RATIO = 2440 / 1405;
const SCENE_RATIO = 900 / 586;
const MIN_SCENE_H = 150; // the scene shrinks to this before the page starts to scroll
const SIDE = 22;
// The page background runs white (top) to this blue (bottom). The scene's edges fade into the
// page's own colour at that height (pageColorAt), so there is no visible box around it.
const PAGE_TOP = '#FFFFFF';
const PAGE_BOTTOM = '#E9F2FD';
const RGB_TOP = [255, 255, 255];
const RGB_BOTTOM = [233, 242, 253];
const pageColorAt = (fraction, alpha) => {
  const f = Math.min(1, Math.max(0, fraction));
  return `rgba(${RGB_TOP.map((c, i) => Math.round(c + (RGB_BOTTOM[i] - c) * f)).join(',')},${alpha})`;
};

// `width` and `height` are the page's own size (the pager measures it). Everything is centred.
// If the page is too short for everything, the scene shrinks first (down to 150); after that
// the page scrolls, and the button is still reachable.
export function GettingStartedIntro({ width, height, onNext }) {
  const { t } = useApp();
  const insets = useSafeAreaInsets();
  const [topH, setTopH] = useState(0);
  const [bottomH, setBottomH] = useState(0);

  // Sized explicitly: the browser preview ignores aspectRatio on an image.
  const logoW = Math.min(width * 0.42, 190);
  const maxSceneH = width / SCENE_RATIO;
  const sceneH = topH && bottomH ? Math.min(maxSceneH, Math.max(MIN_SCENE_H, height - topH - bottomH)) : maxSceneH;
  // The scene keeps its proportions, so a shorter scene is also narrower than the screen.
  const sceneW = Math.min(width, sceneH * SCENE_RATIO);
  const narrower = sceneW < width - 1;
  // Where the scene sits on the page (0 = top, 1 = bottom): the spare height is shared equally
  // above and below it. Used to pick the page colour the scene's edges fade into.
  const spare = Math.max(0, height - topH - sceneH - bottomH);
  const sceneTop = height ? (topH + spare / 2) / height : 0.4;
  const sceneBottom = height ? (topH + spare / 2 + sceneH) / height : 0.7;
  const sceneMid = (sceneTop + sceneBottom) / 2;

  return (
    <View style={{ width, height: height || undefined }}>
      <LinearGradient colors={[PAGE_TOP, PAGE_BOTTOM]} style={StyleSheet.absoluteFill} />
      <ScrollView
        contentContainerStyle={{ minHeight: height, justifyContent: 'space-between' }}
        showsVerticalScrollIndicator={false}
      >
        <View onLayout={(e) => setTopH(e.nativeEvent.layout.height)} style={{ alignItems: 'center', paddingTop: 20, paddingHorizontal: SIDE }}>
          <Image
            source={LOGO} accessible accessibilityLabel={t('gs_logo_label')} resizeMode="contain"
            style={{ width: logoW, height: logoW / LOGO_RATIO }}
          />
          <Heading accessibilityRole="header" maxFontSizeMultiplier={1.4} className="mt-4 text-center text-[22px]" style={{ lineHeight: 28 }}>
            {t('gs_heading')}
          </Heading>
          <Text maxFontSizeMultiplier={1.4} className="mt-1.5 text-center text-[15px] text-muted" style={{ lineHeight: 21 }}>
            {t('gs_tagline')}
          </Text>
        </View>

        <View style={{ width: '100%', height: sceneH, alignItems: 'center' }}>
          <View style={{ width: sceneW, height: sceneH, overflow: 'hidden' }}>
            <Image
              source={GETTING_STARTED_SCENE} accessible={false} importantForAccessibility="no" resizeMode="cover"
              style={{ width: '100%', height: '100%' }}
            />
            <LinearGradient pointerEvents="none" colors={[pageColorAt(sceneTop, 1), pageColorAt(sceneTop, 0)]} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '24%' }} />
            <LinearGradient pointerEvents="none" colors={[pageColorAt(sceneBottom, 0), pageColorAt(sceneBottom, 1)]} style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '28%' }} />
            {narrower && (
              <>
                <LinearGradient pointerEvents="none" start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} colors={[pageColorAt(sceneMid, 1), pageColorAt(sceneMid, 0)]} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '14%' }} />
                <LinearGradient pointerEvents="none" start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} colors={[pageColorAt(sceneMid, 0), pageColorAt(sceneMid, 1)]} style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: '14%' }} />
              </>
            )}
          </View>
        </View>

        <View onLayout={(e) => setBottomH(e.nativeEvent.layout.height)} style={{ paddingHorizontal: SIDE, paddingBottom: insets.bottom + 16 }}>
          <Card accessible className="flex-row items-center gap-3" style={{ shadowColor: '#0D2340', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 }}>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center' }}>
              <ShieldCheck size={22} color="#0D2340" strokeWidth={2} />
            </View>
            <Text maxFontSizeMultiplier={1.4} className="flex-1 text-[13.5px]" style={{ lineHeight: 19 }}>{t('gs_trust')}</Text>
          </Card>

          <Button title={`${t('gs_button')} →`} onPress={onNext} className="mt-4" />

          <View className="mt-3 flex-row items-center justify-center gap-1.5">
            <ShieldCheck size={14} color={COLORS.primary} strokeWidth={2} />
            <Text maxFontSizeMultiplier={1.4} className="shrink text-center font-inter-medium text-[12px] text-primary">{t('gs_footer')}</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
