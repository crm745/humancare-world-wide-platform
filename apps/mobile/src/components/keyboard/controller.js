import { forwardRef, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dimensions, Keyboard, KeyboardAvoidingView as RNKeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { barShift, contentPad, focusDelta } from '../../lib/keyboardLayout';
import { createKeyboardStore } from './keyboardStore';
import { onInputFocus } from './focusBus';

// react-native-keyboard-controller is a NATIVE module: it exists only in a build made after it was added (a new dev build / EAS build). In Expo
// Go, or in a dev build made before, importing it throws "doesn't seem to be linked", so it is loaded inside a try.
//
// WHEN IT IS THERE the app uses it (index.js): the native, smooth behaviour.
//
// WHEN IT IS NOT, the app uses the stand-ins below. They are NOT empty: they do the same job in JavaScript, which is what an Android phone needs
// because the app draws edge to edge (Expo SDK 53+, Android 15), so the window does NOT shrink for the keyboard: the keyboard is only drawn on top of
// the screen. (An earlier version of these stand-ins was a plain ScrollView / View that ignored the keyboard, and the keyboard covered the field.)
//   KeyboardAwareScrollView  pads the end of the content by how far the keyboard reaches into the scroll area, and scrolls the focused field to
//                            `gap` above the keyboard (when the keyboard opens, when another field is focused, when a multiline field grows)
//   KeyboardStickyView       moves the bar that rides on the keyboard up to sit on it
//   KeyboardAvoidingView     React Native's own, with padding on both platforms (it measures the overlap, so it adds nothing if the window shrank)
// What they cannot match is the library's per-frame animation: the screen moves when the keyboard has finished opening (Android reports it then).
// They are written with JSX (not createElement) so that NativeWind's className still works on them.
let real = null;
try {
  real = require('react-native-keyboard-controller');
} catch {
  real = null;
}
export const KEYBOARD_CONTROLLER_AVAILABLE = real !== null;
if (!KEYBOARD_CONTROLLER_AVAILABLE && typeof __DEV__ !== 'undefined' && __DEV__) {
  console.warn('react-native-keyboard-controller is not in this build: using the JavaScript keyboard handling. A new dev build gives the native one.');
}

// The library's "will" events on both platforms; React Native has the "did" ones only on Android. `screenY` is the keyboard's top edge.
const FallbackEvents = {
  addListener: (name, callback) => Keyboard.addListener(
    Platform.OS === 'ios' ? name : name.replace('Will', 'Did'),
    (e) => callback({ height: (e && e.endCoordinates && e.endCoordinates.height) || 0, screenY: e && e.endCoordinates ? e.endCoordinates.screenY : undefined }),
  ),
};
export const KeyboardEvents = real ? real.KeyboardEvents : FallbackEvents;

// The ONE keyboard listener of the app (see keyboardStore.js).
export const keyboardStore = createKeyboardStore(KeyboardEvents, () => Dimensions.get('screen').height);
export const useKeyboardState = () => useSyncExternalStore(keyboardStore.subscribe, keyboardStore.get, keyboardStore.get);

const PassThrough = ({ children }) => children;

const FallbackScroll = forwardRef(function FallbackScroll({
  bottomOffset = 24, footerHeight = 0, onScroll, children, extraKeyboardSpace, enabled, mode, ScrollViewComponent, ...props
}, ref) {
  const inner = useRef(null);
  const scrollY = useRef(0);
  const [pad, setPad] = useState(0);
  const gap = Math.max(0, bottomOffset - footerHeight);
  const latest = useRef({ footerHeight, gap });
  useEffect(() => { latest.current = { footerHeight, gap }; });
  const setRef = useCallback((node) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  useEffect(() => {
    let timer = null;
    // Scrolls just enough that the focused field ends `gap` above the keyboard (and above a bar on it). Does nothing when it already does.
    const revealFocused = () => {
      const keyboard = keyboardStore.get();
      const input = TextInput.State && TextInput.State.currentlyFocusedInput ? TextInput.State.currentlyFocusedInput() : null;
      if (!keyboard.open || !input || !input.measureInWindow) return;
      input.measureInWindow((_x, y, _w, h) => {
        const delta = focusDelta({ fieldBottom: y + h, keyboardTop: keyboard.top, footerHeight: latest.current.footerHeight, gap: latest.current.gap });
        if (delta > 0 && inner.current && inner.current.scrollTo) inner.current.scrollTo({ y: scrollY.current + delta, animated: true });
      });
    };
    const settle = (delay) => { clearTimeout(timer); timer = setTimeout(revealFocused, delay); }; // one scroll, after layout: no repeated calls
    const apply = () => {
      const keyboard = keyboardStore.get();
      if (!keyboard.open) { setPad(0); clearTimeout(timer); return; }
      const node = inner.current;
      if (!node || !node.measureInWindow) return;
      node.measureInWindow((_x, y, _w, h) => {
        setPad(contentPad({ scrollBottom: y + h, keyboardTop: keyboard.top, footerHeight: latest.current.footerHeight }));
        settle(90);
      });
    };
    const offKeyboard = keyboardStore.subscribe(apply);
    const offFocus = onInputFocus(() => settle(60)); // another field, or a field that grew
    apply();
    return () => { offKeyboard(); offFocus(); clearTimeout(timer); };
  }, []);

  return (
    <ScrollView
      ref={setRef}
      {...props}
      scrollEventThrottle={16}
      onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; if (onScroll) onScroll(e); }}
    >
      {children}
      {pad > 0 ? <View style={{ height: pad }} /> : null}
    </ScrollView>
  );
});

const FallbackSticky = ({ offset, enabled, onLayout, style, children, ...props }) => {
  const ref = useRef(null);
  const [base, setBase] = useState(null); // the bar's bottom edge with the keyboard closed
  const keyboard = useKeyboardState();
  const insetBottom = (offset && offset.opened) || 0;
  // derived, not stored: the bar rides up while the keyboard is open, and is back in place when it closes
  const shift = keyboard.open && base !== null ? barShift({ baseBottom: base, keyboardTop: keyboard.top, insetBottom }) : 0;
  const handleLayout = (e) => {
    if (onLayout) onLayout(e);
    if (!keyboardStore.get().open && ref.current && ref.current.measureInWindow) ref.current.measureInWindow((_x, y, _w, h) => { setBase(y + h); });
  };
  return (
    <View ref={ref} {...props} onLayout={handleLayout} style={[style, shift > 0 ? { transform: [{ translateY: -shift }] } : null]}>
      {children}
    </View>
  );
};

const FallbackAvoiding = ({ behavior, ...props }) => <RNKeyboardAvoidingView behavior={behavior} {...props} />;

export const KeyboardProvider = real ? real.KeyboardProvider : PassThrough;
export const KeyboardAwareScrollView = real ? real.KeyboardAwareScrollView : FallbackScroll;
export const KeyboardStickyView = real ? real.KeyboardStickyView : FallbackSticky;
export const KeyboardAvoidingView = real ? real.KeyboardAvoidingView : FallbackAvoiding;
