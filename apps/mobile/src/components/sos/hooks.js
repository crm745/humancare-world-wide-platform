import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { usePathname } from 'expo-router';
import { useApp } from '../../state/AppContext';
import { fabContentPad, sosFabVisible } from '../../lib/sos';

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
