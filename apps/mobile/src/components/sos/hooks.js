import { usePathname } from 'expo-router';
import { useApp } from '../../state/AppContext';
import { sosFabVisible } from '../../lib/sos';
import { useKeyboardOpen } from '../keyboard';

export { useKeyboardOpen };

// Whether the floating SOS button shows on the screen in front (see lib/sos.js): a signed-in patient, on a screen that has it.
export function useSosFabVisible({ ignoreKeyboard = true } = {}) {
  const pathname = usePathname();
  const { authStatus, isCorporate } = useApp();
  const keyboardOpen = useKeyboardOpen(!ignoreKeyboard);
  return sosFabVisible({ pathname, authStatus, isCorporate, keyboardOpen });
}

// The bottom padding of a scrolling screen: its own padding, and nothing more. The floating SOS button used to add extra room at the end of
// every scrolling screen so the last item could scroll above it; that left an empty band after the content, so it is gone and the
// last item may sit behind the button (the button is small and the person can scroll it clear). `edge` and `scrollProps` stay in the
// signature so screens need no change.
export function useFabScrollPad({ ownPad = 0 } = {}) {
  return { paddingBottom: ownPad > 0 ? ownPad : 0, scrollProps: {} };
}
