import { createContext, forwardRef, useCallback, useContext, useRef } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { cssInterop } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  KEYBOARD_CONTROLLER_AVAILABLE, KeyboardAvoidingView, KeyboardAwareScrollView, KeyboardProvider, KeyboardStickyView, useKeyboardState,
} from './controller';
import { useApp } from '../../state/AppContext';
import { listMaxHeight, revealDelta, scrollBottomOffset, stickyOffset } from '../../lib/keyboardLayout';
import { FormFocusProvider } from './formFocus';

// THE one way this app deals with the on-screen keyboard (react-native-keyboard-controller: the same behaviour on iOS, on Android with the
// system's edge-to-edge drawing, and a harmless no-op on the web). Screens never handle the keyboard themselves:
//   KeyboardRoot      once, around the whole app (app/_layout.js)
//   KeyboardScroll    the scroll area of a screen with inputs (layout.js Body uses it, so every Body screen has it): the focused field is
//                     scrolled to 24 px above the keyboard (also when it grows, and when moving to the next field), the whole form stays
//                     scrollable, a tap on an empty area or a drag closes the keyboard, a tap on a button works first time, and the
//                     keyboard's return key says Next / Done (formFocus.js)
//   KeyboardBar       a bar that rides on top of the keyboard (Submit / Continue)
//   KeyboardModalView the content of a modal or bottom sheet, which rises above the keyboard
//   useKeyboard       whether the keyboard is open, and how tall it is (the tab bar and the SOS button hide while it is up)
// (controller.js loads the library safely: a build without its native module falls back to plain React Native components.)
if (KEYBOARD_CONTROLLER_AVAILABLE) cssInterop(KeyboardAwareScrollView, { className: 'style', contentContainerClassName: 'contentContainerStyle' });

// Around the whole app. Android draws edge to edge (Expo SDK 53+ has it always on, and Android 15 forces it), so the status bar and the
// navigation bar are translucent.
export function KeyboardRoot({ children }) {
  return <KeyboardProvider statusBarTranslucent navigationBarTranslucent>{children}</KeyboardProvider>;
}

// A drag closes the keyboard: interactive on iOS, on-drag on Android. Not on the web: there React Native Web treats EVERY scroll (the browser
// bringing a focused field into view, a programmatic scroll) as a drag and would take the focus out of the field being typed in.
export const KEYBOARD_DISMISS_MODE = Platform.OS === 'web' ? 'none' : Platform.OS === 'ios' ? 'interactive' : 'on-drag';

// `reveal(viewRef)`: scroll the form just enough that a view below the focused field (an open suggestion list) is not under the keyboard.
// A no-op outside a KeyboardScroll.
const RevealContext = createContext(() => {});
export const useReveal = () => useContext(RevealContext);

// The scroll area of a form. Takes the props of a ScrollView. `footerHeight`: the height of a KeyboardBar under it (so a focused field
// is never hidden behind the bar).
export const KeyboardScroll = forwardRef(function KeyboardScroll({ footerHeight = 0, children, onScroll, ...props }, ref) {
  const { isRTL } = useApp();
  const { height: windowHeight } = useWindowDimensions();
  const keyboard = useKeyboard();
  const inner = useRef(null);
  const scrollY = useRef(0);
  const setRef = useCallback((node) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  const reveal = useCallback((viewRef) => {
    const node = viewRef && viewRef.current;
    if (!node || !node.measureInWindow) return;
    node.measureInWindow((_x, top, _w, height) => {
      // where the keyboard's top edge really is (the window does not shrink for it on Android), not window height minus keyboard height
      const delta = revealDelta({ top, height, windowHeight, keyboardHeight: keyboard.height, keyboardTop: keyboard.top, footerHeight });
      if (delta > 0 && inner.current && inner.current.scrollTo) inner.current.scrollTo({ y: scrollY.current + delta, animated: true });
    });
  }, [windowHeight, keyboard.height, keyboard.top, footerHeight]);
  return (
    <KeyboardAwareScrollView
      ref={setRef}
      bottomOffset={scrollBottomOffset(footerHeight)}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={KEYBOARD_DISMISS_MODE}
      scrollEventThrottle={16}
      onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; if (onScroll) onScroll(e); }}
      // the JavaScript stand-in (a build without the native module) needs the bar's height to keep a field above it; the library does not take it
      {...(KEYBOARD_CONTROLLER_AVAILABLE ? null : { footerHeight })}
      {...props}
    >
      <RevealContext.Provider value={reveal}>
        <FormFocusProvider rtl={isRTL}>{children}</FormFocusProvider>
      </RevealContext.Provider>
    </KeyboardAwareScrollView>
  );
});

// A bar (Submit / Continue) that sits at the bottom of the screen and rides on top of the keyboard while it is open. `children` is the bar
// itself, which keeps the screen's bottom safe-area inset as its own bottom padding (the offset takes it back off while the keyboard is up).
export function KeyboardBar({ children, onLayout, style }) {
  const insets = useSafeAreaInsets();
  return <KeyboardStickyView offset={stickyOffset(insets.bottom)} onLayout={onLayout} style={style}>{children}</KeyboardStickyView>;
}

// The content of a modal or bottom sheet: it rises above the keyboard. On Android a modal is its own window, which has to be told about
// the keyboard as well (a second provider inside it; edge to edge as in the rest of the app).
export function KeyboardModalView({ children, style, className }) {
  const view = (
    <KeyboardAvoidingView behavior="padding" style={[{ flex: 1 }, style]} className={className}>{children}</KeyboardAvoidingView>
  );
  return Platform.OS === 'android' ? <KeyboardProvider statusBarTranslucent navigationBarTranslucent>{view}</KeyboardProvider> : view;
}

// The props a modal needs under edge-to-edge on Android (spread on <Modal>).
export const MODAL_EDGE_PROPS = { statusBarTranslucent: true, navigationBarTranslucent: true };

// Whether the keyboard is open, how tall it is, and where its top edge is (0 / Infinity when closed). `enabled` false: always closed. Read from the ONE
// shared keyboard store (keyboardStore.js): nothing here listens to the keyboard itself.
const CLOSED = { open: false, height: 0, top: Infinity };
export function useKeyboard(enabled = true) {
  const state = useKeyboardState();
  return enabled ? state : CLOSED;
}
export const useKeyboardOpen = (enabled = true) => useKeyboard(enabled).open;

// The max height for a list in a modal while the keyboard is open (see lib/keyboardLayout.js listMaxHeight).
export function useListMaxHeight({ reserved = 0, min = 120, max = Infinity } = {}) {
  const { height: windowHeight } = useWindowDimensions();
  const { height: keyboardHeight } = useKeyboard();
  return listMaxHeight({ windowHeight, keyboardHeight, reserved, min, max });
}

export { FormFocusProvider, useFormInput } from './formFocus';
