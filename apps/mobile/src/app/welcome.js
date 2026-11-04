import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, BackHandler, FlatList, Image, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { ONBOARDING_CARE, ONBOARDING_FAMILY } from '../data/images';
import { useApp } from '../state/AppContext';
import { Text } from '../components/ui';

const BLUE = '#1B6FDB';
const MAX_COLUMN = 480;

const PAGES = [
  { key: 'family', image: ONBOARDING_FAMILY, title: 'onboard_1_title', body: 'onboard_1_body', bodyMaxWidth: 300 },
  { key: 'care', image: ONBOARDING_CARE, title: 'onboard_2_title', body: 'onboard_2_body', bodyMaxWidth: 320 },
];

// "Get Started" and "Skip" always open Create Account (then straight to Home after the SMS
// code). People who already have an account use "Already have an account? Login" there.
const finish = () => router.push('/register');

// Getting Started: two swipeable pages. Only the middle (illustration, heading, text)
// scrolls when it doesn't fit; the dots and the button stay pinned at the bottom. The
// pager is laid out left to right even in Arabic, so page order and offsets stay the
// same on every platform.
export default function Welcome() {
  const { t } = useApp();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const pageW = Math.min(width, MAX_COLUMN);
  const side = width < 360 ? 16 : 24;
  const short = height < 700;

  const listRef = useRef(null);
  const indexRef = useRef(0);
  const [index, setIndex] = useState(0);
  const [listH, setListH] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const last = index === PAGES.length - 1;
  const pageLabel = t('onboard_page').replace('{n}', index + 1).replace('{total}', PAGES.length);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  const goTo = useCallback((i) => {
    indexRef.current = i;
    setIndex(i);
    listRef.current?.scrollToIndex({ index: i, animated: !reduceMotion });
  }, [reduceMotion]);

  // Android back on page 2 goes to page 1. Only while this screen is focused, or it would
  // also catch the back press on the Register screen opened on top of it.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (indexRef.current === 0) return false;
        goTo(0);
        return true;
      });
      return () => sub.remove();
    }, [goTo]),
  );

  // Keep the current page lined up when the window size changes (rotation, split screen).
  useEffect(() => {
    listRef.current?.scrollToIndex({ index: indexRef.current, animated: false });
  }, [pageW]);

  const announced = useRef(false);
  useEffect(() => {
    if (announced.current) AccessibilityInfo.announceForAccessibility(pageLabel);
    announced.current = true;
  }, [pageLabel]);

  const onScroll = (e) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / pageW);
    if (i !== indexRef.current && i >= 0 && i < PAGES.length) {
      indexRef.current = i;
      setIndex(i);
    }
  };

  const illustrationWidth = (() => {
    const fit = Math.min(pageW - side * 2, 360);
    return short ? Math.min(fit, height * 0.3 * 1.2) : fit; // 6:5, so height = width / 1.2
  })();

  return (
    <View style={{ flex: 1, backgroundColor: '#FFFFFF', paddingTop: insets.top, direction: 'ltr' }}>
      <View style={{ flex: 1, width: '100%', maxWidth: MAX_COLUMN, alignSelf: 'center' }}>
        <FlatList
          ref={listRef}
          data={PAGES}
          keyExtractor={(page) => page.key}
          horizontal
          pagingEnabled
          bounces={false}
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
          onLayout={(e) => setListH(e.nativeEvent.layout.height)}
          getItemLayout={(_, i) => ({ length: pageW, offset: pageW * i, index: i })}
          renderItem={({ item, index: i }) => (
            // Pinned to the pager's own height, so the ScrollView inside scrolls instead
            // of running down behind the dots and the button.
            <View style={{ width: pageW, height: listH || undefined }}>
              <View style={{ height: 48, paddingHorizontal: side, flexDirection: 'row', alignItems: 'center', justifyContent: i === 0 ? 'flex-end' : 'flex-start' }}>
                {i === 0 ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={t('onboard_skip')} onPress={finish} hitSlop={8} style={{ minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}>
                    <Text className="font-inter-semibold" style={{ fontSize: 16, color: '#4A5268' }}>{t('onboard_skip')}</Text>
                  </Pressable>
                ) : (
                  <Pressable accessibilityRole="button" accessibilityLabel={t('onboard_back')} onPress={() => goTo(0)} hitSlop={8} style={{ minWidth: 44, minHeight: 44, flexDirection: 'row', alignItems: 'center' }}>
                    <ChevronLeft size={22} color="#4A5268" strokeWidth={2.2} />
                    <Text className="font-inter-semibold" style={{ fontSize: 16, color: '#4A5268' }}>{t('onboard_back')}</Text>
                  </Pressable>
                )}
              </View>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ flexGrow: 1, alignItems: 'center', paddingHorizontal: side, paddingTop: short ? 16 : 62, paddingBottom: 16 }}
                showsVerticalScrollIndicator={false}
              >
                <Image
                  source={item.image}
                  accessible={false}
                  importantForAccessibility="no"
                  resizeMode="contain"
                  style={{ width: illustrationWidth, aspectRatio: 6 / 5 }}
                />
                <Text className="font-inter-black" style={{ fontSize: 28, lineHeight: 34, letterSpacing: -0.3, color: '#0F1630', textAlign: 'center', marginTop: 40 }}>
                  {t(item.title)}
                </Text>
                <Text style={{ fontSize: 18, lineHeight: 26, color: '#2A3042', textAlign: 'center', maxWidth: item.bodyMaxWidth, marginTop: 12 }}>
                  {t(item.body)}
                </Text>
              </ScrollView>
            </View>
          )}
        />

        <View style={{ paddingHorizontal: side, paddingBottom: 24 + insets.bottom }}>
          <View
            accessible
            accessibilityLabel={pageLabel}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 28 }}
          >
            {PAGES.map((page, i) => (
              <View
                key={page.key}
                style={{ width: i === index ? 24 : 8, height: 8, borderRadius: 4, backgroundColor: i === index ? BLUE : '#D3DAE6' }}
              />
            ))}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={last ? t('welcome_btn') : t('onboard_next')}
            onPress={() => (last ? finish() : goTo(index + 1))}
            style={{
              height: 56,
              borderRadius: 16,
              backgroundColor: BLUE,
              alignItems: 'center',
              justifyContent: 'center',
              shadowColor: BLUE,
              shadowOpacity: 0.26,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 8 },
              elevation: 6,
            }}
          >
            <Text className="font-inter-bold" style={{ fontSize: 18, color: '#FFFFFF' }}>
              {last ? t('welcome_btn') : t('onboard_next')}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
