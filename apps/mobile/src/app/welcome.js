import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, BackHandler, FlatList, Image, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ONBOARDING_CARE } from '../data/images';
import { useApp } from '../state/AppContext';
import { GettingStartedIntro } from '../components/GettingStartedIntro';
import { Text } from '../components/ui';

const BLUE = '#1B6FDB';
const MAX_COLUMN = 480;

const PAGES = [
  { key: 'care', image: ONBOARDING_CARE, title: 'onboard_2_title', body: 'onboard_2_body', bodyMaxWidth: 320 },
  { key: 'intro' }, // page 2: its own design, see GettingStartedIntro.js
];

// "Get Started" and "Skip" open Login. New people use "Sign up" on the Login screen to reach
// Create Account.
const finish = () => router.push('/login');

// Getting Started: two swipeable pages. The middle (illustration, heading, text)
// is sized to fit and only scrolls if it truly cannot; the dots and the button stay pinned at the bottom. The
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
  const [overflows, setOverflows] = useState(false);
  const [textH, setTextH] = useState(110); // heading + text, measured, because they wrap differently on every width
  const layoutH = useRef(0);
  const contentH = useRef(0);
  const [reduceMotion, setReduceMotion] = useState(false);
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
  // also catch the back press on the Login screen opened on top of it.
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

  // The page is sized to fit, so it does not scroll: what is not the illustration (Skip row, dots, button and gaps)
  // take 180 + the bottom inset, the heading and text are measured, and the illustration gets what is left (6:5, so
  // height = width / 1.2). Only when even that does not fit (very large system text) does it scroll.
  const topPad = short ? 16 : 40;
  const roomForImage = listH ? listH - (48 + 116 + 16) - textH - insets.bottom - topPad : Infinity;
  const illustrationWidth = Math.max(96, Math.min(pageW - side * 2, 360, roomForImage * 1.2));

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
              {i === 1 ? (
                // Page 2 has no Skip and no dots: its own Get Started button finishes Getting Started.
                <GettingStartedIntro width={pageW} height={listH} onNext={finish} />
              ) : (
                <>
                  <View style={{ height: 48, paddingHorizontal: side, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('onboard_skip')} onPress={finish} hitSlop={8} style={{ minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}>
                      <Text className="font-inter-semibold" style={{ fontSize: 16, color: '#4A5268' }}>{t('onboard_skip')}</Text>
                    </Pressable>
                  </View>
                  <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={{ flexGrow: 1, alignItems: 'center', paddingHorizontal: side, paddingTop: topPad, paddingBottom: 16 }}
                    showsVerticalScrollIndicator={false}
                    bounces={false}
                    scrollEnabled={overflows}
                    onLayout={(e) => { layoutH.current = e.nativeEvent.layout.height; setOverflows(contentH.current > layoutH.current + 1); }}
                    onContentSizeChange={(_, h) => { contentH.current = h; setOverflows(h > layoutH.current + 1); }}
                  >
                    <Image
                      source={item.image}
                      accessible={false}
                      importantForAccessibility="no"
                      resizeMode="contain"
                      style={{ width: illustrationWidth, height: illustrationWidth / 1.2 }}
                    />
                    <View onLayout={(e) => setTextH(Math.round(e.nativeEvent.layout.height))} style={{ alignItems: 'center' }}>
                    <Text className="font-inter-black" style={{ fontSize: 28, lineHeight: 34, letterSpacing: -0.3, color: '#0F1630', textAlign: 'center', marginTop: 40 }}>
                      {t(item.title)}
                    </Text>
                    <Text style={{ fontSize: 18, lineHeight: 26, color: '#2A3042', textAlign: 'center', maxWidth: item.bodyMaxWidth, marginTop: 12 }}>
                      {t(item.body)}
                    </Text>
                    </View>
                  </ScrollView>

                  <View style={{ paddingHorizontal: side, paddingBottom: 24 + insets.bottom }}>
                    <View
                      accessible
                      accessibilityLabel={t('onboard_page').replace('{n}', 1).replace('{total}', PAGES.length)}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 28 }}
                    >
                      {PAGES.map((page, dot) => (
                        <View
                          key={page.key}
                          style={{ width: dot === 0 ? 24 : 8, height: 8, borderRadius: 4, backgroundColor: dot === 0 ? BLUE : '#D3DAE6' }}
                        />
                      ))}
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('onboard_next')}
                      onPress={() => goTo(1)}
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
                        {t('onboard_next')}
                      </Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          )}
        />
      </View>
    </View>
  );
}
