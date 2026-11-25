import { useEffect, useRef } from 'react';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { buttonFadeMs } from '../lib/bannerMotion';
import { PressBox } from './PressBox';

// A PressBox whose opacity FADES (150 ms) when it goes pale or comes back, instead of switching at once: a button that is switched off offline, or comes back when the connection returns.
// reanimated runs the fade on the UI thread; nothing sets state on a frame. The pressed feedback (a slight dim) is part of the same opacity, so a class like active:opacity-85 must not be added.
// A press is written straight to the shared value from the press events: it sets no React state, so the button and its children are not re-rendered by a touch.
// With Reduce Motion the change is immediate.
export const FADED_OPACITY = 0.45;
export const PRESSED_OPACITY = 0.85;
const AnimatedBox = Animated.createAnimatedComponent(PressBox);

// `faded`: the pale look. `feedback`: whether a press dims it (a pale or primary button has its own look).
export function AnimatedPressBox({ faded, feedback = true, style, onPressIn, onPressOut, ...props }) {
  const reduceMotion = useReducedMotion();
  const pressedRef = useRef(false);
  const opacity = useSharedValue(faded ? FADED_OPACITY : 1);
  const lastFaded = useRef(faded);
  const targetFor = (isPressed) => (faded ? FADED_OPACITY : (isPressed && feedback ? PRESSED_OPACITY : 1));
  useEffect(() => {
    const fading = lastFaded.current !== faded; // a pale <-> on change fades over 150 ms; a press is quick
    lastFaded.current = faded;
    const target = targetFor(pressedRef.current);
    opacity.value = withTiming(target, { duration: fading ? buttonFadeMs(reduceMotion) : (reduceMotion ? 0 : 80) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetFor only reads faded and feedback, which are listed
  }, [faded, feedback, reduceMotion, opacity]);
  const press = (isPressed) => {
    pressedRef.current = isPressed;
    const target = targetFor(isPressed);
    opacity.set(withTiming(target, { duration: reduceMotion ? 0 : 80 })); // .set(): the shared value is written from an event handler
  };
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <AnimatedBox
      {...props}
      style={[style, animated]}
      onPressIn={(e) => { press(true); if (onPressIn) onPressIn(e); }}
      onPressOut={(e) => { press(false); if (onPressOut) onPressOut(e); }}
    />
  );
}
