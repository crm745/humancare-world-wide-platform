import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, FlatList, Image, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ArrowRight } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { Text } from '../ui';

// There is no banners/promotions API, so these three fixed slides are used. "Request
// now" opens the All Services screen, the same as "View all services".
// `size` is the photo's pixel size and `focus` the part of it to keep in view ([x, y] as
// fractions), as set in the design.
const SLIDES = [
  { key: 'global', image: require('../../../assets/images/banner-global.jpg'), size: [1080, 617], focus: [0.7, 0.5], service: 'privatecharter', title: 'home_banner_1_title', body: 'home_banner_1_body', alt: 'home_banner_1_alt' },
  { key: 'hospital', image: require('../../../assets/images/banner-hospital.jpg'), size: [1199, 800], focus: [0.35, 0.2], service: 'hospital', title: 'home_banner_2_title', body: 'home_banner_2_body', alt: 'home_banner_2_alt' },
  { key: 'homecare', image: require('../../../assets/images/banner-homecare.jpg'), size: [1000, 667], focus: [0.85, 0.2], service: 'homecare', title: 'home_banner_3_title', body: 'home_banner_3_body', alt: 'home_banner_3_alt' },
];
const ADVANCE_MS = 3500;

// The photo on the right 66% of the slide, filling it ("cover") but lined up on the part
// that matters. React Native's Image can't do that on its own, so the size is worked out here.
function BannerPhoto({ source, size, focus, label }) {
  const [box, setBox] = useState(null);
  const scale = box ? Math.max(box.w / size[0], box.h / size[1]) : 1;
  const w = size[0] * scale;
  const h = size[1] * scale;
  return (
    <View
      onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '66%', overflow: 'hidden' }}
    >
      {box && (
        <Image
          source={source}
          accessibilityLabel={label}
          resizeMode="stretch"
          style={{ position: 'absolute', width: w, height: h, left: (box.w - w) * focus[0], top: (box.h - h) * focus[1] }}
        />
      )}
    </View>
  );
}

// Swipeable; moves on by itself every 3.5s, but not while a finger is on it or when the
// system's Reduce Motion is on. The pager runs left to right even in Arabic, so slide
// order and offsets stay the same on every platform.
export function BannerCarousel({ width, tablet, onRequest }) {
  const { t } = useApp();
  const listRef = useRef(null);
  const indexRef = useRef(0);
  const [index, setIndex] = useState(0);
  const [touching, setTouching] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  const goTo = useCallback((i) => {
    indexRef.current = i;
    setIndex(i);
    listRef.current?.scrollToIndex({ index: i, animated: true });
  }, []);

  useEffect(() => {
    if (reduceMotion || touching) return undefined;
    const timer = setInterval(() => goTo((indexRef.current + 1) % SLIDES.length), ADVANCE_MS);
    return () => clearInterval(timer);
  }, [reduceMotion, touching, goTo]);

  // "Request now" opens the list of all services on every slide (a slide's own `service`
  // is kept in the data but not used here). A second tap within a second is ignored.
  const lastTap = useRef(0);
  const handleRequest = () => {
    const now = Date.now();
    if (now - lastTap.current < 1000) return;
    lastTap.current = now;
    onRequest();
  };

  const onScroll = (e) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== indexRef.current && i >= 0 && i < SLIDES.length) {
      indexRef.current = i;
      setIndex(i);
    }
  };

  return (
    <View style={{ marginBottom: 14, gap: 8, direction: 'ltr' }}>
      <View style={{ width, borderRadius: 18, overflow: 'hidden', backgroundColor: '#0D2340' }}>
        <FlatList
          ref={listRef}
          data={SLIDES}
          keyExtractor={(s) => s.key}
          horizontal
          pagingEnabled
          bounces={false}
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
          onScrollBeginDrag={() => setTouching(true)}
          onScrollEndDrag={() => setTouching(false)}
          onTouchStart={() => setTouching(true)}
          onTouchEnd={() => setTouching(false)}
          onTouchCancel={() => setTouching(false)}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          renderItem={({ item }) => (
            <View style={{ width, minHeight: tablet ? 240 : 176, backgroundColor: '#0D2340' }}>
              <BannerPhoto source={item.image} size={item.size} focus={item.focus} label={t(item.alt)} />
              <LinearGradient
                pointerEvents="none"
                colors={['#0D2340', 'rgba(13,35,64,0.72)', 'rgba(13,35,64,0)']}
                locations={[0.4, 0.58, 0.84]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
              />
              <View style={{ width: '66%', flex: 1, paddingHorizontal: 14, paddingVertical: 12, justifyContent: 'center', alignItems: 'flex-start', gap: 5 }}>
                <Text className="font-inter-black" style={{ fontSize: 16, lineHeight: 20, letterSpacing: -0.16, color: '#FFFFFF' }}>{t(item.title)}</Text>
                <Text style={{ fontSize: 12, lineHeight: 16, color: '#E3EAF5' }}>{t(item.body)}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('home_request_now_label')}
                  onPress={handleRequest}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  style={{ marginTop: 4, minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#FFFFFF' }}
                >
                  <Text className="font-inter-black" style={{ fontSize: 12.5, color: '#0D2340' }}>{t('home_request_now')}</Text>
                  <ArrowRight size={14} color="#0D2340" strokeWidth={2.4} />
                </Pressable>
              </View>
            </View>
          )}
        />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 5 }} accessible={false} importantForAccessibility="no-hide-descendants">
        {SLIDES.map((s, i) => (
          <View key={s.key} style={{ height: 6, borderRadius: 3, width: i === index ? 16 : 6, backgroundColor: i === index ? '#1A73E8' : '#C9D3E1' }} />
        ))}
      </View>
    </View>
  );
}
