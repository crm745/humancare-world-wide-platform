import { useEffect, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { useReduceMotion } from './hooks';

// Content that arrives after a skeleton fades in and rises 6 px (opacity 0 to 1, translateY 6 to 0, 320 ms ease). Without a skeleton
// (`animate` false: the screen had its data at once) or with "Reduce motion" on, it simply appears.
export const REVEAL_MS = 320;
export const REVEAL_RISE = 6;

export function Reveal({ animate, children, style }) {
  const reduce = useReduceMotion();
  const [progress] = useState(() => new Animated.Value(animate ? 0 : 1));
  useEffect(() => {
    if (!animate || reduce) { progress.setValue(1); return; }
    Animated.timing(progress, { toValue: 1, duration: REVEAL_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [animate, reduce, progress]);
  return (
    <Animated.View style={[{ opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [REVEAL_RISE, 0] }) }] }, style]}>
      {children}
    </Animated.View>
  );
}
