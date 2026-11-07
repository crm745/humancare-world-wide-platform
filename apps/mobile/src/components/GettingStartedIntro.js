import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ArrowRight, ShieldCheck } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { GETTING_STARTED_SCENE, LOGO } from '../data/images';
import { Text } from './ui';

// Page 1 of Getting Started. Only the logo and the scene are pictures; the heading, tagline,
// trust card, button and footer line are real text.
const LOGO_RATIO = 2440 / 1405;
const SCENE_RATIO = 900 / 586;
const MIN_SCENE_H = 150; // the scene shrinks to this before the page starts to scroll
const SIDE = 24;
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
  const logoW = Math.min(width * 0.48, 220);
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
  // Fits the heading on one line when the screen is wide enough, never below 22 or above 28.
  const headingSize = Math.max(22, Math.min(28, Math.floor((width - SIDE * 2) / 12.9)));

  return (
    <View style={{ width, height: height || undefined }}>
      <LinearGradient colors={[PAGE_TOP, PAGE_BOTTOM]} style={StyleSheet.absoluteFill} />
      <ScrollView
        contentContainerStyle={{ minHeight: height, justifyContent: 'space-between' }}
        showsVerticalScrollIndicator={false}
      >
        <View onLayout={(e) => setTopH(e.nativeEvent.layout.height)} style={{ alignItems: 'center', paddingTop: 24, paddingHorizontal: SIDE }}>
          <Image
            source={LOGO} accessible accessibilityLabel={t('gs_logo_label')} resizeMode="contain"
            style={{ width: logoW, height: logoW / LOGO_RATIO }}
          />
          <Text
            className="font-inter-bold" accessibilityRole="header" maxFontSizeMultiplier={1.4}
            style={{ fontSize: headingSize, lineHeight: Math.round((headingSize * 34) / 28), color: '#0D2340', textAlign: 'center', marginTop: 20 }}
          >
            {t('gs_heading')}
          </Text>
          <Text maxFontSizeMultiplier={1.4} style={{ fontSize: 18, lineHeight: 24, color: '#4A5268', textAlign: 'center', marginTop: 8 }}>
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
          <View
            accessible
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E3ECF7',
              borderRadius: 20, padding: 16, shadowColor: '#0D2340', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 3,
            }}
          >
            <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: '#C9D8F2', alignItems: 'center', justifyContent: 'center' }}>
              <ShieldCheck size={26} color="#0D2340" strokeWidth={2} />
            </View>
            <Text maxFontSizeMultiplier={1.4} style={{ flex: 1, fontSize: 16, lineHeight: 22, color: '#17233D' }}>{t('gs_trust')}</Text>
          </View>

          <Pressable
            onPress={onNext} accessibilityRole="button" accessibilityLabel={t('gs_button')}
            style={{ marginTop: 16, minHeight: 56, borderRadius: 28, backgroundColor: '#1D4ED8', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 8 }}
          >
            <Text className="font-inter-semibold" maxFontSizeMultiplier={1.3} style={{ fontSize: 18, color: '#FFFFFF' }}>{t('gs_button')}</Text>
            <ArrowRight size={22} color="#FFFFFF" strokeWidth={2.4} />
          </Pressable>

          <View style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <ShieldCheck size={16} color="#1D4ED8" strokeWidth={2} />
            <Text className="font-inter-medium" maxFontSizeMultiplier={1.4} style={{ fontSize: 13, color: '#1D4ED8', textAlign: 'center', flexShrink: 1 }}>{t('gs_footer')}</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
