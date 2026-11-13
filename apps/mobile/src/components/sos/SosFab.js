import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, View } from 'react-native';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Phone } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { FAB_CORE, FAB_RIGHT, FAB_RING, PULSE, fabBottom } from '../../lib/sos';
import { useKeyboardOpen, useSosFabVisible } from './hooks';
import { SosModal } from './SosModal';

const RED = '#C53030';
const STATIC_RING = 68;
const RING_INSET = (FAB_RING - FAB_CORE) / 2; // the 80px pulse ring is centred on the 56px core

// The floating SOS button (the "pulse ring" design): a red 56px core, an always-visible 68px ring, and an 80px ring that
// pulses three times each time a screen with the button comes in front, then stays still. Tapping the core opens the same
// confirmation as the red SOS banner on Home (SosModal). It is mounted once, in the root layout, and decides from the route
// whether to show (lib/sos.js). Only the core is tappable; both rings ignore touches.
export function SosFab() {
  const { t } = useApp();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const visible = useSosFabVisible();
  const keyboardOpen = useKeyboardOpen(true);
  const [open, setOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  // 0 = the pulse has just started, 1 = it is over (scale at its biggest, fully see-through). It rests at 1. It is created at 0
  // on purpose: Animated.loop puts it back to its creation value before each run, and each run must start from 0.
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  const show = visible && !keyboardOpen;

  // Pulses three times every time the route changes to a screen that shows the button (not when the app comes back from the
  // background, and not at all with Reduce Motion on). Stops on leaving the screen and on unmount.
  useEffect(() => {
    progress.setValue(1);
    if (!show || reduceMotion) return undefined;
    progress.setValue(0);
    const run = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, { toValue: 1, duration: PULSE.duration, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(PULSE.rest),
      ]),
      { iterations: PULSE.runs },
    );
    run.start();
    return () => { run.stop(); progress.setValue(1); };
    // `show` is deliberately not a dependency of the restart on its own: the route is what re-runs it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, visible, reduceMotion]);

  if (!show) return open ? <SosModal visible onClose={() => setOpen(false)} /> : null;

  const bottom = fabBottom({ insetBottom: insets.bottom });
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [PULSE.scaleFrom, PULSE.scaleTo] });
  const opacity = progress.interpolate({ inputRange: [0, 1], outputRange: [PULSE.opacityFrom, PULSE.opacityTo] });

  return (
    <>
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', right: FAB_RIGHT - RING_INSET, bottom: bottom - RING_INSET, width: FAB_RING, height: FAB_RING, alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      >
        <Animated.View
          pointerEvents="none"
          style={{ position: 'absolute', width: FAB_RING, height: FAB_RING, borderRadius: FAB_RING / 2, backgroundColor: 'rgba(197,48,48,0.24)', opacity, transform: [{ scale }] }}
        />
        <View
          pointerEvents="none"
          style={{ position: 'absolute', width: STATIC_RING, height: STATIC_RING, borderRadius: STATIC_RING / 2, borderWidth: 2, borderColor: 'rgba(197,48,48,0.22)' }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('sos_fab_a11y')}
          onPress={() => setOpen(true)}
          style={({ pressed }) => ({
            width: FAB_CORE, height: FAB_CORE, borderRadius: FAB_CORE / 2, backgroundColor: RED, alignItems: 'center', justifyContent: 'center',
            shadowColor: RED, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 6 }, elevation: 6, opacity: pressed ? 0.9 : 1,
          })}
        >
          <Phone size={24} color="#FFFFFF" strokeWidth={2.1} />
        </Pressable>
      </View>
      <SosModal visible={open} onClose={() => setOpen(false)} />
    </>
  );
}
