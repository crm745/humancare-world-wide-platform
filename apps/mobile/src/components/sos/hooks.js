import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Keyboard, Platform } from 'react-native';
import { useFocusEffect, usePathname } from 'expo-router';
import { useApp } from '../../state/AppContext';
import { fabContentPad, getFixedBar, setFixedBar, sosFabVisible, subscribeFixedBar } from '../../lib/sos';

// Whether the floating SOS button shows on the screen in front (see lib/sos.js): a signed-in patient, on a screen that has it.
export function useSosFabVisible({ ignoreKeyboard = true } = {}) {
  const pathname = usePathname();
  const { authStatus, isCorporate } = useApp();
  const keyboardOpen = useKeyboardOpen(!ignoreKeyboard);
  return sosFabVisible({ pathname, authStatus, isCorporate, keyboardOpen });
}

// The extra room a scrolling screen leaves at its end while the button shows (0 when it does not).
export const useSosFabPad = () => fabContentPad(useSosFabVisible());

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

// The height of the fixed bar on the screen in front (0 when there is none), for the button to sit above.
export const useFixedBarHeight = () => useSyncExternalStore(subscribeFixedBar, getFixedBar, getFixedBar);

// A screen with its own fixed bottom bar calls this with the bar's whole height (0 while the bar is not drawn). It only
// counts while the screen is in front: a screen left behind in the stack takes its bar away.
export function useReportFixedBar(height) {
  useFocusEffect(
    useCallback(() => {
      setFixedBar(height);
      return () => setFixedBar(0);
    }, [height]),
  );
}
