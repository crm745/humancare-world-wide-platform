import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { collapseTimings, EASE_IN, EASE_OUT } from '../../lib/bannerMotion';

// A line that appears and disappears with the network ("Connect to the internet to submit.", "Internet connection is required to sign in with Google."): it fades in while its height
// expands, 180 ms, and the reverse when the connection returns, so what is below it moves smoothly instead of jumping. reanimated runs it on the UI thread.
//   - A line that is already there when the screen opens is simply drawn (no animation): it animates only when `show` CHANGES.
//   - Reduce Motion: no height animation, a fade of at most 100 ms.
// The children are always passed in; this component decides whether they are mounted (they stay while the line is closing).
const bezier = (p) => Easing.bezier(p[0], p[1], p[2], p[3]);

export function Collapse({ show, children, style }) {
  const reduceMotion = useReducedMotion();
  const { fadeMs, heightMs } = collapseTimings(reduceMotion);
  const [v, setV] = useState(() => ({ seen: show, mounted: show, id: 0, mode: 'settled' }));
  const natural = useRef(0); // the content's own height, once measured
  const started = useRef(-1);
  const height = useSharedValue(0);
  const opacity = useSharedValue(show ? 1 : 0);
  const animating = useSharedValue(0); // 1 while the height is being driven; otherwise the line has its natural height

  if (show !== v.seen) setV({ seen: show, mounted: true, id: v.id + 1, mode: show ? 'enter' : 'exit' });

  const unmount = (id) => setV((s) => (s.id === id ? { ...s, mounted: false, mode: 'settled' } : s));
  // A safety net: the animation callbacks are not called when an animation is interrupted (the connection flapping), which can leave the line clipped to a sliver (an icon, no words). Whatever
  // happens, the line is released to its natural size / removed shortly after its animation should have ended.
  const guard = useRef(null);
  const settleLater = (fn) => { if (guard.current) clearTimeout(guard.current); guard.current = setTimeout(() => { guard.current = null; fn(); }, Math.max(heightMs, fadeMs) + 120); };
  useEffect(() => () => { if (guard.current) clearTimeout(guard.current); }, []);
  const open = (h) => {
    settleLater(() => { animating.value = 0; opacity.value = 1; });
    animating.value = heightMs ? 1 : 0;
    if (heightMs) height.value = withTiming(h, { duration: heightMs, easing: bezier(EASE_OUT) }, (finished) => { if (finished) animating.value = 0; });
    opacity.value = withTiming(1, { duration: fadeMs, easing: bezier(EASE_OUT) });
  };

  useEffect(() => {
    if (started.current === v.id) return;
    if (v.mode === 'enter' && natural.current > 0) { started.current = v.id; open(natural.current); }
    if (v.mode === 'exit') {
      started.current = v.id;
      const id = v.id;
      settleLater(() => unmount(id));
      if (heightMs) { animating.value = 1; height.value = withTiming(0, { duration: heightMs, easing: bezier(EASE_IN) }); }
      opacity.value = withTiming(0, { duration: fadeMs, easing: bezier(EASE_IN) }, (finished) => { if (finished) { animating.value = 0; runOnJS(unmount)(id); } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per change of `show`
  }, [v.mode, v.id]);

  const onLayout = (e) => {
    const h = Math.round(e.nativeEvent.layout.height);
    natural.current = h;
    // eslint-disable-next-line react-hooks/immutability -- shared values are written from animation callbacks, as reanimated intends
    if (v.mode === 'enter' && started.current !== v.id) { started.current = v.id; if (heightMs) height.value = 0; open(h); } else if (v.mode === 'enter' && started.current === v.id && h > 0) open(h); // the size changed while opening (the words were laid out after the icon)
  };

  const animatedStyle = useAnimatedStyle(() => (animating.value ? { opacity: opacity.value, height: height.value, overflow: 'hidden' } : { opacity: opacity.value }));
  if (!v.mounted) return null;
  return (
    <Animated.View style={[animatedStyle, style]}>
      <View onLayout={onLayout}>{children}</View>
    </Animated.View>
  );
}
