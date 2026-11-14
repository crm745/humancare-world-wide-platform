import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { fabClearance, scrollPadFor, sosFabVisible } from '../../lib/sos';

// Whether the floating SOS button shows on the screen in front (see lib/sos.js): a signed-in patient, on a screen that has it.
export function useSosFabVisible({ ignoreKeyboard = true } = {}) {
  const pathname = usePathname();
  const { authStatus, isCorporate } = useApp();
  const keyboardOpen = useKeyboardOpen(!ignoreKeyboard);
  return sosFabVisible({ pathname, authStatus, isCorporate, keyboardOpen });
}

// The bottom padding of a scrolling screen (see scrollPadFor in lib/sos.js): its own padding, or the room the floating button needs,
// whichever is more. `edge` is how far the bottom of the scroll area is above the bottom of the screen (a tab bar or the screen's
// own bottom bar under it). Spread `scrollProps` on the ScrollView so the content can be measured.
export function useFabScrollPad({ ownPad = 0, edge = 0 } = {}) {
  const visible = useSosFabVisible();
  const insets = useSafeAreaInsets();
  const [viewHeight, setViewHeight] = useState(0);
  const [itemsHeight, setItemsHeight] = useState(0);
  const paddingBottom = scrollPadFor({ ownPad, visible, clearance: fabClearance({ edge, insetBottom: insets.bottom }), itemsHeight, viewHeight });
  // The padding the content was laid out with, so its own height can be told apart from the padding.
  const applied = useRef(paddingBottom);
  useEffect(() => { applied.current = paddingBottom; });
  const onLayout = useCallback((e) => setViewHeight(Math.round(e.nativeEvent.layout.height)), []);
  const onContentSizeChange = useCallback((_w, h) => setItemsHeight(Math.max(0, Math.round(h - applied.current))), []);
  return { paddingBottom, scrollProps: { onLayout, onContentSizeChange } };
}

// True while the on-screen keyboard is open. Off (always false) unless `enabled`.
export function useKeyboardOpen(enabled = true) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setOpen(true));
    const hide = Keyboard.addListener(hideEvent, () => setOpen(false));
    return () => { show.remove(); hide.remove(); };
  }, [enabled]);
  return enabled ? open : false;
}
