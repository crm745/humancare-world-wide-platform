// "An input just got focus, or its text grew": the form's scroll area listens and keeps that input above the keyboard. A single shared emitter
// (the inputs do not know which scroll area they are in). Used by the build without the native keyboard module; the library does this itself.
const listeners = new Set();

export function onInputFocus(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitInputFocus() {
  listeners.forEach((listener) => listener());
}
