import { createContext, useContext, useEffect, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SKELETON } from '../../theme/colors';
import { useReduceMotion } from './hooks';

// The loading skeleton kit. A screen wraps its placeholder in <SkeletonArea label="Loading ...">; inside it, <Skeleton>, <SkeletonText>
// and <SkeletonCircle> are rounded blocks. The cards and the page behind them are the screen's own (white, same border, radius and
// padding): only what is INSIDE a card becomes blocks.
//
// The shimmer: a highlight sweeps left to right across every block, 1.3 s, linear, looping. All blocks share ONE animation value
// (made by the area), driven on the native thread. With "Reduce motion" on the blocks are still. The area is one accessible element
// ("Loading your requests"); the blocks themselves are hidden from screen readers.
export const SHIMMER_MS = 1300;
export const SHIMMER_RADIUS = 6; // a text line's block

const ShimmerContext = createContext({ clock: null, reduce: true });

export function SkeletonArea({ label, children, style }) {
  const reduce = useReduceMotion();
  const [clock] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) return undefined;
    clock.setValue(0);
    const loop = Animated.loop(Animated.timing(clock, { toValue: 1, duration: SHIMMER_MS, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [clock, reduce]);
  return (
    <ShimmerContext.Provider value={{ clock, reduce }}>
      <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }} style={style}>
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>{children}</View>
      </View>
    </ShimmerContext.Provider>
  );
}

// One rounded block. `width` may be a number or a percentage string; a missing width fills the row.
export function Skeleton({ width, height = 14, radius = SHIMMER_RADIUS, style }) {
  const { clock, reduce } = useContext(ShimmerContext);
  const [w, setW] = useState(0);
  const shimmer = !reduce && clock && w > 0;
  return (
    <View
      onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))}
      style={[{ width, height, borderRadius: radius, backgroundColor: SKELETON.block, overflow: 'hidden' }, style]}
    >
      {shimmer ? (
        <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: w, transform: [{ translateX: clock.interpolate({ inputRange: [0, 1], outputRange: [-w, w] }) }] }}>
          <LinearGradient colors={[SKELETON.block, SKELETON.highlight, SKELETON.block]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1 }} />
        </Animated.View>
      ) : null}
    </View>
  );
}

// `lines` rounded lines, each as tall as the real text line, the last one shorter.
export function SkeletonText({ lines = 1, lineHeight = 14, gap = 8, lastLineWidth = '60%', width = '100%', radius = SHIMMER_RADIUS, style }) {
  return (
    <View style={[{ width, gap }, style]}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={lineHeight} radius={radius} width={i === lines - 1 && lines > 1 ? lastLineWidth : '100%'} />
      ))}
    </View>
  );
}

// An avatar or an icon tile keeps its shape: a circle (radius left out) or a rounded square (radius given).
export function SkeletonCircle({ size = 40, radius, style }) {
  return <Skeleton width={size} height={size} radius={radius === undefined ? size / 2 : radius} style={[{ flexShrink: 0 }, style]} />;
}
