/* eslint-disable react-hooks/set-state-in-effect -- the fill removes itself when its animation is over, or at once with Reduce motion */
import { useEffect, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { HIGHLIGHT_FROM, HIGHLIGHT_MS } from '../../lib/newItems';
import { useReduceMotion } from './hooks';

// A new item's brief highlight after a pull-to-refresh: put it FIRST inside the card (it fills the card behind the card's content), and
// the card's background starts at #E2E3EF and fades to the card colour over 1.8 s. It removes itself when done. Nothing with "Reduce motion".
export function HighlightFill({ radius = 18, to = '#FFFFFF' }) {
  const reduce = useReduceMotion();
  const [progress] = useState(() => new Animated.Value(0));
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (reduce) { setDone(true); return undefined; }
    const run = Animated.timing(progress, { toValue: 1, duration: HIGHLIGHT_MS, easing: Easing.out(Easing.quad), useNativeDriver: false });
    run.start(({ finished }) => { if (finished) setDone(true); });
    return () => run.stop();
  }, [reduce, progress]);
  if (done) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius, backgroundColor: progress.interpolate({ inputRange: [0, 1], outputRange: [HIGHLIGHT_FROM, to] }) }}
    />
  );
}
