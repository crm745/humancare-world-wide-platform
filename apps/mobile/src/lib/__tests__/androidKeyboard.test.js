/* global describe, test, expect, jest, __dirname */
// Android keyboard: the geometry (pure), the one shared keyboard store, and that the build WITHOUT the native keyboard module still handles the
// keyboard. These are calculations and source checks: they do NOT prove the behaviour on a phone, which has to be seen on the phone.
const fs = require('fs');
const path = require('path');
const {
  FOCUS_GAP, barShift, contentPad, focusDelta, keyboardTopOf, revealDelta,
} = require('../keyboardLayout');
const { createKeyboardStore } = require('../../components/keyboard/keyboardStore');
const { emitInputFocus, onInputFocus } = require('../../components/keyboard/focusBus');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\r\n').join('\n');

// A typical phone: 800 px tall window, a 300 px keyboard, so the keyboard's top edge is at 500.
describe('where the keyboard is', () => {
  test('the system\'s own top edge wins; otherwise the screen height minus the keyboard height; closed is Infinity', () => {
    expect(keyboardTopOf({ screenY: 512, height: 300, screenHeight: 800 })).toBe(512);
    expect(keyboardTopOf({ height: 300, screenHeight: 800 })).toBe(500);
    expect(keyboardTopOf({ screenY: 0, height: 300, screenHeight: 800 })).toBe(500);
    expect(keyboardTopOf({})).toBe(Infinity);
    expect(keyboardTopOf({ height: 0, screenHeight: 800 })).toBe(Infinity);
  });
});

describe('the focused field ends 24 px above the keyboard (and above a bar on it)', () => {
  test('a field already clear of the keyboard is not scrolled', () => {
    expect(focusDelta({ fieldBottom: 400, keyboardTop: 500 })).toBe(0);
    expect(focusDelta({ fieldBottom: 476, keyboardTop: 500 })).toBe(0); // exactly 24 above
  });
  test('a field behind the keyboard is scrolled by exactly what it takes', () => {
    expect(focusDelta({ fieldBottom: 620, keyboardTop: 500 })).toBe(144); // 620 - (500 - 24)
    expect(focusDelta({ fieldBottom: 477, keyboardTop: 500 })).toBe(1);
  });
  test('with a Continue bar riding on the keyboard, the field must clear the bar too', () => {
    expect(focusDelta({ fieldBottom: 400, keyboardTop: 500, footerHeight: 84 })).toBe(8); // 400 - (500 - 84 - 24)
    expect(focusDelta({ fieldBottom: 392, keyboardTop: 500, footerHeight: 84 })).toBe(0);
  });
  test('closed keyboard or an unknown position: nothing to do', () => {
    expect(focusDelta({ fieldBottom: 900, keyboardTop: Infinity })).toBe(0);
    expect(focusDelta({ fieldBottom: NaN, keyboardTop: 500 })).toBe(0);
  });
  test('the 24 px gap is the one the whole app uses', () => {
    expect(FOCUS_GAP).toBe(24);
  });
  test('the suggestion list under a field is brought above the keyboard the same way, using the keyboard\'s real top edge', () => {
    expect(revealDelta({ top: 500, height: 200, keyboardTop: 480, windowHeight: 800, keyboardHeight: 300 })).toBe(244); // 700 - (480 - 24)
    expect(revealDelta({ top: 500, height: 200, windowHeight: 800, keyboardHeight: 300 })).toBe(224); // no top given: window - keyboard
  });
});

describe('room under the content so the LAST field can be scrolled clear of the keyboard (no assumption that the window shrank)', () => {
  test('the scroll area reaches into the keyboard by that much (and the bar on it)', () => {
    expect(contentPad({ scrollBottom: 800, keyboardTop: 500 })).toBe(300);
    expect(contentPad({ scrollBottom: 716, keyboardTop: 500, footerHeight: 84 })).toBe(300); // a scroll area that ends above a 84 px bar
  });
  test('a window that DID shrink (the scroll area already ends above the keyboard): nothing is added, so there is no double gap', () => {
    expect(contentPad({ scrollBottom: 500, keyboardTop: 500 })).toBe(0);
    expect(contentPad({ scrollBottom: 480, keyboardTop: 500 })).toBe(0);
  });
  test('closed keyboard: nothing', () => {
    expect(contentPad({ scrollBottom: 800, keyboardTop: Infinity })).toBe(0);
  });
});

describe('the Continue bar on the keyboard', () => {
  test('it moves up to the keyboard without counting the safe-area inset twice', () => {
    expect(barShift({ baseBottom: 800, keyboardTop: 500, insetBottom: 0 })).toBe(300);
    expect(barShift({ baseBottom: 800, keyboardTop: 500, insetBottom: 34 })).toBe(266); // its padding sits behind the keyboard
  });
  test('closed, or a window that shrank (the bar already above the keyboard): it does not move', () => {
    expect(barShift({ baseBottom: 800, keyboardTop: Infinity })).toBe(0);
    expect(barShift({ baseBottom: 500, keyboardTop: 500, insetBottom: 34 })).toBe(0);
  });
});

describe('ONE shared keyboard store (no competing listeners)', () => {
  function fakeEvents() {
    const handlers = {};
    return { addListener: jest.fn((name, cb) => { handlers[name] = cb; return { remove() {} }; }), handlers };
  }
  test('it attaches once, however many things read it, and not before the first read', () => {
    const events = fakeEvents();
    const store = createKeyboardStore(events, () => 800);
    expect(events.addListener).not.toHaveBeenCalled();
    store.get(); store.subscribe(() => {}); store.subscribe(() => {}); store.get();
    expect(events.addListener).toHaveBeenCalledTimes(2); // show and hide, once
  });
  test('open: the height and the keyboard\'s top edge; closed: back to nothing; subscribers hear of each change once', () => {
    const events = fakeEvents();
    const store = createKeyboardStore(events, () => 800);
    const seen = [];
    store.subscribe(() => seen.push({ ...store.get() }));
    events.handlers.keyboardWillShow({ height: 300, screenY: 500 });
    expect(store.get()).toEqual({ open: true, height: 300, top: 500 });
    events.handlers.keyboardWillShow({ height: 300, screenY: 500 }); // the same again: no new notice
    events.handlers.keyboardWillHide();
    expect(store.get()).toEqual({ open: false, height: 0, top: Infinity });
    expect(seen).toHaveLength(2);
  });
  test('no screenY from the system: the top is the screen height minus the keyboard\'s', () => {
    const events = fakeEvents();
    const store = createKeyboardStore(events, () => 800);
    store.get();
    events.handlers.keyboardWillShow({ height: 320 });
    expect(store.get().top).toBe(480);
  });
  test('a keyboard that changes height while open (a suggestion bar, another keyboard) follows', () => {
    const events = fakeEvents();
    const store = createKeyboardStore(events, () => 800);
    store.get();
    events.handlers.keyboardWillShow({ height: 300, screenY: 500 });
    events.handlers.keyboardWillShow({ height: 360, screenY: 440 });
    expect(store.get()).toEqual({ open: true, height: 360, top: 440 });
  });
  test('unsubscribing stops the notices', () => {
    const events = fakeEvents();
    const store = createKeyboardStore(events, () => 800);
    const spy = jest.fn();
    const off = store.subscribe(spy);
    off();
    events.handlers.keyboardWillShow({ height: 300, screenY: 500 });
    expect(spy).not.toHaveBeenCalled();
  });
  test('the app has no other keyboard listener: only the store (and the stand-in\'s event shim) call Keyboard.addListener', () => {
    const walk = (dir) => fs.readdirSync(path.join(__dirname, '../..', dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
    const users = [...walk('app'), ...walk('components'), ...walk('lib'), ...walk('state')].filter((f) => !f.includes('__tests__') && /Keyboard\.addListener|KeyboardEvents\.addListener/.test(read(f)));
    expect(users.sort()).toEqual(['components/keyboard/controller.js']);
  });
});

describe('the focus signal', () => {
  test('an input that gets focus (or whose text grows) tells the scroll area; unsubscribing stops it', () => {
    const spy = jest.fn();
    const off = onInputFocus(spy);
    emitInputFocus();
    expect(spy).toHaveBeenCalledTimes(1);
    off();
    emitInputFocus();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  test('every shared input sends it, a multiline one also when it grows, and the caller\'s own handlers still run', () => {
    const form = read('components/keyboard/formFocus.js');
    expect(form).toContain('onFocus: (e) => { if (onFocus) onFocus(e); emitInputFocus(); },');
    expect(form).toContain('onContentSizeChange: (e) => { if (onContentSizeChange) onContentSizeChange(e); emitInputFocus(); }');
    expect(read('components/ui.js')).toContain('onLayout, onFocus, onContentSizeChange, ...props }) {');
  });
});

describe('THE BUG: the build without the native keyboard module (what the phone runs) must still handle the keyboard on Android', () => {
  const controller = read('components/keyboard/controller.js');
  const code = controller.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  test('the stand-in scroll pads the content by how far the keyboard reaches in, and scrolls the focused field above the keyboard', () => {
    expect(code).toContain('contentPad({ scrollBottom: y + h, keyboardTop: keyboard.top, footerHeight: latest.current.footerHeight })');
    expect(code).toContain('focusDelta({ fieldBottom: y + h, keyboardTop: keyboard.top, footerHeight: latest.current.footerHeight, gap: latest.current.gap })');
    expect(code).toContain('TextInput.State.currentlyFocusedInput()');
    expect(code).toContain('inner.current.scrollTo({ y: scrollY.current + delta, animated: true })');
    expect(code).toContain('{pad > 0 ? <View style={{ height: pad }} /> : null}');
  });
  test('it keeps the form scrollable and does not scroll over and over: one scroll per event, after layout', () => {
    expect(code).toContain('const settle = (delay) => { clearTimeout(timer); timer = setTimeout(revealFocused, delay); };');
    expect(code).toContain('scrollEventThrottle={16}');
  });
  test('it follows another field and a growing field (the focus signal), and the keyboard changing', () => {
    expect(code).toContain('const offFocus = onInputFocus(() => settle(60));');
    expect(code).toContain('const offKeyboard = keyboardStore.subscribe(apply);');
  });
  test('when the keyboard closes the padding goes and the screen is back to normal', () => {
    expect(code).toContain('if (!keyboard.open) { setPad(0); clearTimeout(timer); return; }');
  });
  test('the bar rides up on the keyboard and is back in place when it closes (derived, no stored shift)', () => {
    expect(code).toContain('const shift = keyboard.open && base !== null ? barShift({ baseBottom: base, keyboardTop: keyboard.top, insetBottom }) : 0;');
    expect(code).toContain('transform: [{ translateY: -shift }]');
  });
  test('the avoiding view has behaviour on Android too (it was undefined there)', () => {
    expect(code).toContain('const FallbackAvoiding = ({ behavior, ...props }) => <RNKeyboardAvoidingView behavior={behavior} {...props} />;');
    expect(code).not.toContain("Platform.OS === 'ios' ? behavior : undefined");
  });
  test('the stand-ins are written with JSX, so className (NativeWind) still reaches the ScrollView; createElement would drop it', () => {
    expect(code).not.toContain('createElement');
    expect(code).toContain('<ScrollView\n      ref={setRef}\n      {...props}');
  });
  test('the scroll area hands the bar\'s height to the stand-in only (the library does not take it)', () => {
    expect(read('components/keyboard/index.js')).toContain('{...(KEYBOARD_CONTROLLER_AVAILABLE ? null : { footerHeight })}');
  });
  test('the real library is still preferred when the build has it', () => {
    expect(code).toContain('export const KeyboardAwareScrollView = real ? real.KeyboardAwareScrollView : FallbackScroll;');
    expect(code).toContain('export const KeyboardStickyView = real ? real.KeyboardStickyView : FallbackSticky;');
  });
});

describe('Android configuration', () => {
  test('the soft keyboard layout mode is set explicitly (resize: the library\'s requirement, and the default); it needs a new native build to be applied', () => {
    const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../app.json'), 'utf8'));
    expect(app.expo.android.softwareKeyboardLayoutMode).toBe('resize');
  });
  test('the native keyboard library is a dependency, and the app is edge to edge on Android (so the window does not resize for the keyboard)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
    expect(pkg.dependencies['react-native-keyboard-controller']).toBeTruthy();
    expect(read('components/keyboard/index.js')).toContain('<KeyboardProvider statusBarTranslucent navigationBarTranslucent>');
  });
});

describe('the suggestion dropdown (Current Location, Destination)', () => {
  test('it scrolls on its own (nested scrolling on Android), keeps taps, and is brought above the keyboard when it opens or changes', () => {
    const field = read('components/request/CityField.js');
    expect(field).toContain('nestedScrollEnabled');
    expect(field).toContain('keyboardShouldPersistTaps="handled"');
    expect(field).toContain('reveal(box)');
  });
  test('the height it may take shrinks with the keyboard (it never reaches under it)', () => {
    expect(read('components/request/CityField.js')).toContain('useListMaxHeight({ reserved: 300, min: 110, max: 220 })');
  });
});
