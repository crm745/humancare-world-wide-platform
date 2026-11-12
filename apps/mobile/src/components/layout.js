import { forwardRef, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, BackHandler, Keyboard, Platform, Pressable, ScrollView, View } from 'react-native';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, FileText, House, LayoutGrid, User } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { emitTabReselect, goBack, navReplace, onTabReselect } from '../lib/nav';
import { Text, cx } from './ui';

// Full-height screen with safe-area padding. `bg` is a Tailwind background class.
export function Screen({ children, bg = 'bg-canvas', padded, className = '', style }) {
  const insets = useSafeAreaInsets();
  return (
    <View className={`flex-1 ${bg} ${padded ? 'px-[26px] pb-[26px]' : ''} ${className}`} style={[{ paddingTop: insets.top, paddingBottom: padded ? insets.bottom + 26 : 0 }, style]}>
      {children}
    </View>
  );
}

// Vertically scrolling body with no visible scrollbar (the prototype's .noscroll).
// Bottom padding is set here, not by contentClassName (the style would override any pb-* class):
// room for the tab bar when there is one, the device's safe area, and a gap so the last
// button never sits against the bottom edge or the gesture bar.
const BOTTOM_GAP = 32;
// forwardRef so a parent (e.g. RequestStep, to scroll back to the top offending
// field when validation fails) can call scrollTo on the underlying ScrollView.
export const Body = forwardRef(function Body({ children, className = '', contentClassName = '', withNav, grow = true }, ref) {
  const insets = useSafeAreaInsets();
  const inner = useRef(null);
  // Tapping the active tab again scrolls this screen back to the top.
  useEffect(() => (withNav ? onTabReselect(() => inner.current?.scrollTo({ y: 0, animated: true })) : undefined), [withNav]);
  return (
    <ScrollView
      ref={(node) => { inner.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node; }}
      className={`flex-1 ${className}`}
      contentContainerClassName={`${grow ? 'flex-grow' : ''} ${contentClassName}`}
      contentContainerStyle={{ paddingBottom: (withNav ? 64 : 0) + BOTTOM_GAP + insets.bottom }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
});

export function IconButton({ children, onPress, className = '' }) {
  return (
    <Pressable onPress={onPress} className={cx('h-[34px] w-[34px] items-center justify-center rounded-full bg-soft active:opacity-70', className)}>
      {children}
    </Pressable>
  );
}

export function BackButton({ onPress = goBack, className = '' }) {
  const { isRTL } = useApp();
  return (
    <Pressable onPress={onPress} className={cx('h-9 w-9 items-center justify-center rounded-[10px] bg-soft active:opacity-70', className)}>
      <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}>
        <ChevronLeft size={22} color="#17233D" strokeWidth={2} />
      </View>
    </Pressable>
  );
}

// The one header bar for every screen that has one (All Services, Tracking, Requests, Documents, ...): white, a
// 44 px soft back button, the title next to it, and an optional right-hand element. Keep every screen on this
// component so the header looks the same everywhere.
export function TopBar({ title, onBack, right, left }) {
  const { t, isRTL } = useApp();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E4E9F2' }}>
      {left || (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('home_back')}
          onPress={onBack || goBack}
          style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: '#EEF3FB', alignItems: 'center', justifyContent: 'center' }}
        >
          <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}>
            <ChevronLeft size={20} color="#0D2340" strokeWidth={2.4} />
          </View>
        </Pressable>
      )}
      {title ? <Text className="font-inter-black" accessibilityRole="header" style={{ flex: 1, fontSize: 16, color: '#0D2340' }}>{title}</Text> : <View style={{ flex: 1 }} />}
      {right}
    </View>
  );
}

const TABS = [
  { id: '/home', key: 'nav_home', Icon: House },
  { id: '/all-services', key: 'nav_services', Icon: LayoutGrid },
  { id: '/my-requests', key: 'nav_requests', Icon: FileText },
  { id: '/profile', key: 'nav_profile', Icon: User },
];

// Scrolls a ScrollView back to the top when the tab you are on is tapped again.
export function useScrollToTopOnTabTap(ref) {
  useEffect(() => onTabReselect(() => ref.current?.scrollTo({ y: 0, animated: true })), [ref]);
}

function Tab({ on, label, Icon, reduceMotion, onPress }) {
  // The pill fades in over about 150 ms (no fade when Reduce Motion is on).
  const [fade] = useState(() => new Animated.Value(on ? 1 : 0));
  useEffect(() => {
    if (reduceMotion) fade.setValue(on ? 1 : 0);
    else Animated.timing(fade, { toValue: on ? 1 : 0, duration: 150, useNativeDriver: true }).start();
  }, [on, reduceMotion, fade]);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      aria-selected={on}
      onPress={onPress}
      style={{ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{ width: 56, height: 32, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16, backgroundColor: '#E7F0FE', opacity: fade }} />
        <View style={{ zIndex: 1 }}>
          <Icon size={22} color={on ? '#1A73E8' : '#6B7A90'} strokeWidth={2} />
        </View>
      </View>
      <Text numberOfLines={1} maxFontSizeMultiplier={1.2} className={on ? 'font-inter-black' : 'font-inter-semibold'} style={{ marginTop: 4, fontSize: 12, color: on ? '#0D2340' : '#6B7A90' }}>{label}</Text>
    </Pressable>
  );
}

// Bottom tab bar: Home, Services, Requests, Profile. Corporates see "Cases" (corporate
// dashboard) in place of "Requests". The white bar is full width; the tabs sit centred in
// at most 560. Tapping the tab you are on scrolls it to the top, the Android back button on
// any other tab goes to Home, and the bar hides while the keyboard is up.
export function BottomNav() {
  const { t, isCorporate } = useApp();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const [reduceMotion, setReduceMotion] = useState(false);
  const [keyboard, setKeyboard] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android' || pathname === '/home') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { navReplace('/home'); return true; });
    return () => sub.remove();
  }, [pathname]);

  if (keyboard) return null;
  return (
    <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 64 + insets.bottom, paddingBottom: insets.bottom, backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#E4E9F2' }}>
      <View accessibilityRole="tablist" style={{ flex: 1, flexDirection: 'row', width: '100%', maxWidth: 560, alignSelf: 'center' }}>
        {TABS.map(({ id, key, Icon }) => {
          const corporateCases = id === '/my-requests' && isCorporate;
          const target = corporateCases ? '/corporate-dashboard' : id;
          const on = pathname === target;
          return (
            <Tab
              key={id}
              on={on}
              Icon={Icon}
              label={corporateCases ? t('nav_cases') : t(key)}
              reduceMotion={reduceMotion}
              onPress={() => (on ? emitTabReselect() : navReplace(target))}
            />
          );
        })}
      </View>
    </View>
  );
}
