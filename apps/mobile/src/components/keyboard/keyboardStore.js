import { keyboardTopOf } from '../../lib/keyboardLayout';

// ONE place that listens to the keyboard for the whole app. Everything that needs to know whether it is open, how tall it is and WHERE ITS TOP
// IS (the scroll area, the bar that rides on it, the tab bar and the SOS button that hide) reads this, so there are never several listeners that
// could disagree. `events` is the library's KeyboardEvents, or (in a build without the native module) the stand-in over React Native's own.
//
// state: { open, height, top }  top = the keyboard's top edge in window coordinates (Infinity while it is closed)
export function createKeyboardStore(events, screenHeight = () => 0) {
  let state = { open: false, height: 0, top: Infinity };
  const listeners = new Set();
  let attached = false;

  const set = (next) => {
    if (state.open === next.open && state.height === next.height && state.top === next.top) return;
    state = next;
    listeners.forEach((listener) => listener());
  };

  // Attached on first use, once.
  const attach = () => {
    if (attached) return;
    attached = true;
    events.addListener('keyboardWillShow', (e) => {
      const height = Math.round((e && e.height) || 0);
      set({ open: true, height, top: keyboardTopOf({ screenY: e && e.screenY, height, screenHeight: screenHeight() }) });
    });
    events.addListener('keyboardWillHide', () => set({ open: false, height: 0, top: Infinity }));
  };

  return {
    get() { attach(); return state; },
    subscribe(listener) { attach(); listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
