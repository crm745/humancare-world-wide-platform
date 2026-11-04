import { useEffect, useState } from 'react';
import { Animated, Easing, View } from 'react-native';

// A grey block that pulses gently while real content loads.
export function SkeletonBlock({ pulse, style }) {
  return <Animated.View style={[{ backgroundColor: '#E4E9F2', opacity: pulse }, style]} />;
}

// Stands in for the active-request card while the requests load. Only shown if loading
// takes a moment (the screen decides), so a quick load never flashes it.
export function ActiveRequestSkeleton() {
  const [pulse] = useState(() => new Animated.Value(0.55));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.55, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View
      accessible
      accessibilityLabel="Loading"
      style={{ marginBottom: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2', borderRadius: 18, padding: 14, gap: 12 }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <SkeletonBlock pulse={pulse} style={{ width: 120, height: 14, borderRadius: 7 }} />
        <SkeletonBlock pulse={pulse} style={{ width: 76, height: 22, borderRadius: 11 }} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <SkeletonBlock pulse={pulse} style={{ width: 44, height: 44, borderRadius: 13 }} />
        <View style={{ gap: 8 }}>
          <SkeletonBlock pulse={pulse} style={{ width: 150, height: 14, borderRadius: 7 }} />
          <SkeletonBlock pulse={pulse} style={{ width: 90, height: 12, borderRadius: 6 }} />
        </View>
      </View>
      <SkeletonBlock pulse={pulse} style={{ height: 5, borderRadius: 3 }} />
      <SkeletonBlock pulse={pulse} style={{ height: 44, borderRadius: 12 }} />
    </View>
  );
}
