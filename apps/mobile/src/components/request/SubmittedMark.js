import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedProps, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { CHECK, COLORS, DOTS, DURATION_MS, FILL_R, RING, SIZE, frameAt } from '../../lib/submittedAnimation';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedG = Animated.createAnimatedComponent(G);

// The success mark at the top of Request Submitted (108 x 108): a ring that draws itself, three dots that fade, a pale teal fill that grows, a check that draws. The timeline is lib/submittedAnimation.js
// (one clock, 0 to 1450 ms). It plays ONCE when the screen opens: the effect runs once and there is no repeat, so a re-render or coming back from the background never restarts it. With Reduce Motion on, the
// clock starts at its end, so the finished picture is there at once. The picture is decoration: it is hidden from screen readers (the screen announces "Request submitted" itself).
export function SubmittedMark() {
  const reduceMotion = useReducedMotion();
  const clock = useSharedValue(reduceMotion ? DURATION_MS : 0);

  useEffect(() => {
    if (!reduceMotion) clock.value = withTiming(DURATION_MS, { duration: DURATION_MS, easing: Easing.linear });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the screen opens
  }, []);

  const arc = useAnimatedProps(() => ({ strokeDashoffset: frameAt(clock.value).arcOffset }));
  const tealArc = useAnimatedProps(() => { const f = frameAt(clock.value); return { strokeDashoffset: f.arcOffset, strokeOpacity: f.arcTeal }; });
  const dots = useAnimatedProps(() => ({ opacity: frameAt(clock.value).dotsOpacity }));
  const fill = useAnimatedProps(() => ({ r: frameAt(clock.value).fillRadius }));
  const check = useAnimatedProps(() => { const f = frameAt(clock.value); return { strokeDashoffset: f.checkOffset, strokeOpacity: f.checkVisible }; });

  return (
    <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: SIZE, height: SIZE }} testID="submitted-mark">
      <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <Circle cx={RING.cx} cy={RING.cy} r={RING.r} fill="none" stroke={COLORS.track} strokeWidth={RING.stroke} />
        <AnimatedCircle cx={RING.cx} cy={RING.cy} fill={COLORS.fill} r={reduceMotion ? FILL_R : 0} animatedProps={fill} />
        <AnimatedCircle
          cx={RING.cx} cy={RING.cy} r={RING.r} fill="none" strokeWidth={RING.stroke} strokeLinecap="round" strokeDasharray={RING.dash}
          stroke={COLORS.blue} transform={`rotate(-90 ${RING.cx} ${RING.cy})`} animatedProps={arc}
        />
        <AnimatedCircle
          cx={RING.cx} cy={RING.cy} r={RING.r} fill="none" strokeWidth={RING.stroke} strokeLinecap="round" strokeDasharray={RING.dash}
          stroke={COLORS.teal} strokeOpacity={reduceMotion ? 1 : 0} transform={`rotate(-90 ${RING.cx} ${RING.cy})`} animatedProps={tealArc}
        />
        <AnimatedG animatedProps={dots}>
          {DOTS.map((d) => <Circle key={d.cx} cx={d.cx} cy={RING.cy} r={3.5} fill={COLORS.blue} fillOpacity={d.opacity} />)}
        </AnimatedG>
        <AnimatedPath d={CHECK.d} fill="none" stroke={COLORS.teal} strokeWidth={CHECK.stroke} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={CHECK.dash} animatedProps={check} />
      </Svg>
    </View>
  );
}
