import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { AccessibilityInfo, Platform, View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useApp } from '../../state/AppContext';
import { BANNER } from '../../lib/networkUi';
import { bannerPresenter } from '../../lib/bannerPresenter';
import { bannerHeightFor, bannerTimings, planBannerTransition, rememberBannerHeight } from '../../lib/bannerMotion';
import { NOTICE } from '../../theme/colors';
import { Text } from '../ui';
import { NETWORK_ICONS } from './icons';

// The ONE network message of the app: a banner directly UNDER the screen's top area (the header, and the step bar on the request form). It pushes the content down and never floats over it, takes no
// touch, and has no buttons. WHAT it shows is decided once for the whole app (lib/bannerPresenter.js: the 1 s / 3 s delays, "Back online" only after a visible problem), fed by
// components/network/BannerDriver.js; every header that mounts a banner reads that one fact.
//
// HOW it moves (lib/bannerMotion.js has the numbers; react-native-reanimated runs it on the UI thread, nothing sets React state on a frame):
//   appear      the height grows 0 -> full while the content fades in and slides down 8 px (220 ms, ease-out); the page below moves with the growing height
//   disappear   the reverse (180 ms, ease-in)
//   change      while it is showing, the new state cross-fades in place (200 ms) over the old one, and the height animates if it differs; it never closes and reopens
//   a new screen the banner is drawn in place with NO animation when a screen opens while it is already showing: it animates only when the state CHANGES
//   Reduce Motion no sliding and no height animation: a fade of at most 100 ms
const SLOW_ICON = '#5B6B84';
const FONT = { 400: 'Inter_400Regular', 800: 'Inter_800ExtraBold' };

// What each state looks like (the colours are the theme's: theme/colors.js NOTICE).
export const bannerLook = (tone) => {
  const n = NOTICE[tone];
  return { bg: n.bg, border: n.border, title: n.title || n.text, text: n.text, icon: tone === 'slow' ? SLOW_ICON : (n.title || n.text) };
};

// The banner to show now ('offline' | 'serverDown' | 'slow' | 'restored' | null): the app-wide fact of lib/bannerPresenter.js.
export function useBannerKind() {
  return useSyncExternalStore(bannerPresenter.subscribe, bannerPresenter.get, bannerPresenter.get);
}

// The bar itself (no state, no animation): what each banner looks like.
export function BannerBar({ kind, onLayout, absolute = false }) {
  const { t } = useApp();
  const spec = BANNER[kind];
  const look = bannerLook(spec.tone);
  const Icon = NETWORK_ICONS[spec.icon];
  return (
    <View
      onLayout={onLayout}
      style={[absolute ? { position: 'absolute', top: 0, start: 0, end: 0 } : null, { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: look.bg, borderBottomWidth: 1, borderBottomColor: look.border }]}
    >
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={18} color={look.icon} strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontFamily: FONT[800], fontSize: 14, lineHeight: 19, color: look.title }}>{t(spec.titleKey)}</Text>
        {spec.textKey ? <Text style={{ fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: look.text }}>{t(spec.textKey)}</Text> : null}
      </View>
    </View>
  );
}

const bezier = (points) => Easing.bezier(points[0], points[1], points[2], points[3]);

// One drawn banner (a "layer"): it owns its own opacity and slide, so two layers can cross-fade. mode:
//   settled   drawn as it is, no animation        enter / swap-in   fades in (enter also slides down)        leaving   fades out (exit also slides up), then reports it is gone
function BannerLayer({ kind, mode, plan, reduceMotion, onMeasure, onGone }) {
  const timings = bannerTimings(plan, reduceMotion);
  const opacity = useSharedValue(mode === 'settled' || mode === 'leaving' ? 1 : 0);
  const shift = useSharedValue(mode === 'enter' ? -timings.slidePx : 0);
  useEffect(() => {
    const easing = timings.easing ? bezier(timings.easing) : Easing.linear;
    if (mode === 'enter' || mode === 'swap-in') {
      opacity.value = withTiming(1, { duration: timings.fadeMs, easing });
      shift.value = withTiming(0, { duration: timings.heightMs, easing });
    } else if (mode === 'leaving') {
      shift.value = withTiming(plan === 'exit' ? -timings.slidePx : 0, { duration: timings.heightMs, easing });
      opacity.value = withTiming(0, { duration: timings.fadeMs, easing }, (finished) => { if (finished) runOnJS(onGone)(); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- starts once per mode change
  }, [mode]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: shift.value }] }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, start: 0, end: 0 }, style]}>
      <BannerBar kind={kind} onLayout={(e) => onMeasure(kind, Math.round(e.nativeEvent.layout.height))} />
    </Animated.View>
  );
}

export function ConnectionBanner() {
  const { t } = useApp();
  const kind = useBannerKind();
  const reduceMotion = useReducedMotion();
  // While this screen is the one in front, it HAS a banner: a toast that only repeats it may then be left out (lib/bannerPresenter.js registerHost). A screen with no header never registers.
  useFocusEffect(useCallback(() => bannerPresenter.registerHost(), []));
  // What is drawn: `current` (and, during a change, `previous` fading out). First render: whatever is showing, in place, with no animation ('settle').
  const [view, setView] = useState(() => ({ seen: kind, current: kind, previous: null, id: 0, plan: 'settle', layer: 0 }));
  const height = useSharedValue(kind ? bannerHeightFor(kind) : 0);
  const measuredFor = useRef(-1); // the transition whose height has been started

  if (kind !== view.seen) {
    const plan = planBannerTransition(view.current, kind, { mounted: true }); // against what is drawn, so a banner that is still closing is swapped, not reopened
    setView({
      seen: kind,
      current: plan === 'exit' ? view.current : kind,
      previous: plan === 'swap' ? view.current : null,
      id: view.id + 1,
      plan,
      layer: plan === 'enter' || plan === 'swap' ? view.layer + 1 : view.layer,
    });
  }

  const timings = bannerTimings(view.plan, reduceMotion);
  // The measured height of a layer arrives once, after it is drawn: set it at once when nothing is moving, or animate to it.
  const onMeasure = (measuredKind, h) => {
    rememberBannerHeight(measuredKind, h);
    if (measuredKind !== view.current) return;
    if ((view.plan === 'enter' || view.plan === 'swap') && measuredFor.current !== view.id) {
      measuredFor.current = view.id;
      height.value = timings.heightMs ? withTiming(h, { duration: timings.heightMs, easing: bezier(timings.easing) }) : h;
    } else if (view.plan === 'settle' || view.plan === 'none') {
      height.value = h;
    }
  };
  // Closing: the height goes back to 0 as the content fades and slides away.
  const closingId = useRef(-1);
  useEffect(() => {
    if (view.plan !== 'exit' || closingId.current === view.id) return;
    closingId.current = view.id;
    if (timings.heightMs) height.value = withTiming(0, { duration: timings.heightMs, easing: bezier(timings.easing) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per transition
  }, [view.plan, view.id]);

  const currentGone = () => {
    // eslint-disable-next-line react-hooks/immutability -- a shared value is written from an event handler, as reanimated intends
    if (view.plan === 'exit') height.value = 0;
    setView((v) => (v.id === view.id ? { ...v, current: v.plan === 'exit' ? null : v.current, plan: v.plan === 'exit' ? 'none' : v.plan } : v));
  };
  const previousGone = () => setView((v) => (v.id === view.id ? { ...v, previous: null } : v));

  // Each change is announced once (iOS speaks it here; Android reads the live region below).
  const announced = useRef(null);
  useEffect(() => {
    if (!kind) { announced.current = null; return; }
    if (announced.current === kind) return;
    announced.current = kind;
    if (Platform.OS === 'ios') {
      const spec = BANNER[kind];
      AccessibilityInfo.announceForAccessibility([t(spec.titleKey), spec.textKey ? t(spec.textKey) : null].filter(Boolean).join('. '));
    }
  }, [kind, t]);

  const wrapperStyle = useAnimatedStyle(() => ({ height: height.value }));
  if (!view.current && !view.previous) return null;
  const currentMode = view.plan === 'exit' ? 'leaving' : view.plan === 'enter' ? 'enter' : view.plan === 'swap' ? 'swap-in' : 'settled';
  return (
    <Animated.View pointerEvents="none" accessibilityLiveRegion="polite" style={[{ overflow: 'hidden' }, wrapperStyle]}>
      {view.previous ? <BannerLayer key={`l${view.layer - 1}`} kind={view.previous} mode="leaving" plan="swap" reduceMotion={reduceMotion} onMeasure={onMeasure} onGone={previousGone} /> : null}
      {view.current ? <BannerLayer key={`l${view.layer}`} kind={view.current} mode={currentMode} plan={view.plan} reduceMotion={reduceMotion} onMeasure={onMeasure} onGone={currentGone} /> : null}
    </Animated.View>
  );
}
