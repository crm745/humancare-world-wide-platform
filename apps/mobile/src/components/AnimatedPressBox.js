import { useEffect, useRef, useState } from 'react';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { buttonFadeMs } from '../lib/bannerMotion';
import { PressBox } from './PressBox';

// A PressBox whose opacity FADES (150 ms) when it goes pale or comes back, instead of switching at once: a button that is switched off offline, or comes back when the connection returns.
// reanimated runs the fade on the UI thread; nothing sets state on a frame. The pressed feedback (a slight dim) is part of the same opacity, so a class like active:opacity-85 must not be added.
// With Reduce Motion the change is immediate.
export const FADED_OPACITY = 0.45;
export const PRESSED_OPACITY = 0.85;
const AnimatedBox = Animated.createAnimatedComponent(PressBox);

// `faded`: the pale look. `feedback`: whether a press dims it (a pale or primary button has its own look).
export function AnimatedPressBox({ faded, feedback = true, style, onPressIn, onPressOut, ...props }) {
  const reduceMotion = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const opacity = useSharedValue(faded ? FADED_OPACITY : 1);
  const lastFaded = useRef(faded);
  const target = faded ? FADED_OPACITY : (pressed && feedback ? PRESSED_OPACITY : 1);
  useEffect(() => {
    const fading = lastFaded.current !== faded; // a pale <-> on change fades over 150 ms; a press is quick
    lastFaded.current = faded;
    opacity.value = withTiming(target, { duration: fading ? buttonFadeMs(reduceMotion) : (reduceMotion ? 0 : 80) });
  }, [target, faded, reduceMotion, opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <AnimatedBox
      {...props}
      style={[style, animated]}
      onPressIn={(e) => { setPressed(true); if (onPressIn) onPressIn(e); }}
      onPressOut={(e) => { setPressed(false); if (onPressOut) onPressOut(e); }}
    />
  );
}
