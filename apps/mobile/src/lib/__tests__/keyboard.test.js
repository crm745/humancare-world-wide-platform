/* global describe, test, expect, __dirname */
// The keyboard handling: the rules (pure) and that every screen with an input goes through the ONE shared solution (components/keyboard).
const fs = require('fs');
const path = require('path');
const {
  FOCUS_GAP, ROW_TOLERANCE, scrollBottomOffset, stickyOffset, listMaxHeight, orderFields, nextFieldId, returnKeyFor,
} = require('../keyboardLayout');

const SRC = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const walk = (dir) => fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
const code = [...walk('app'), ...walk('components')];

describe('the focused field keeps 24 px above the keyboard', () => {
  test('24 px, plus the height of a bar that rides on the keyboard', () => {
    expect(FOCUS_GAP).toBe(24);
    expect(scrollBottomOffset()).toBe(24);
    expect(scrollBottomOffset(0)).toBe(24);
    expect(scrollBottomOffset(84)).toBe(108);
    expect(scrollBottomOffset(83.6)).toBe(108);
    expect(scrollBottomOffset(-5)).toBe(24);
    expect(scrollBottomOffset(undefined)).toBe(24);
  });
});

describe('no double gap: the safe-area inset is not counted on top of the keyboard', () => {
  test('a bar that rides the keyboard gives back the bottom inset it keeps as padding', () => {
    expect(stickyOffset(34)).toEqual({ closed: 0, opened: 34 }); // iPhone with a home indicator
    expect(stickyOffset(0)).toEqual({ closed: 0, opened: 0 }); // no inset
    expect(stickyOffset(48)).toEqual({ closed: 0, opened: 48 }); // Android 3-button bar under edge-to-edge
    expect(stickyOffset(undefined)).toEqual({ closed: 0, opened: 0 });
    expect(stickyOffset(-3)).toEqual({ closed: 0, opened: 0 });
  });
});

describe('a list in a modal gets what is left above the keyboard', () => {
  test('window minus keyboard minus what is above the list, between min and max', () => {
    expect(listMaxHeight({ windowHeight: 800, keyboardHeight: 0, reserved: 100, max: 280 })).toBe(280);
    expect(listMaxHeight({ windowHeight: 667, keyboardHeight: 300, reserved: 224, min: 90, max: 280 })).toBe(143); // small phone
    expect(listMaxHeight({ windowHeight: 600, keyboardHeight: 400, reserved: 300, min: 90, max: 280 })).toBe(90); // never below min
    expect(listMaxHeight({ windowHeight: 900, keyboardHeight: 300, reserved: 100 })).toBe(500); // no max
  });
});

describe('Next / Done', () => {
  const f = (id, x, y, seq) => ({ id, x, y, seq });
  test('top to bottom', () => {
    expect(orderFields([f('b', 0, 200, 2), f('a', 0, 100, 1), f('c', 0, 300, 3)])).toEqual(['a', 'b', 'c']);
  });
  test('fields on one row read left to right (right to left in Arabic), within a few px of each other', () => {
    const row = [f('to', 190, 203, 2), f('from', 18, 200, 1), f('below', 18, 300, 3)];
    expect(ROW_TOLERANCE).toBe(8);
    expect(orderFields(row)).toEqual(['from', 'to', 'below']);
    expect(orderFields(row, true)).toEqual(['to', 'from', 'below']);
  });
  test('the same place: the order they appeared in', () => {
    expect(orderFields([f('b', 0, 100, 2), f('a', 0, 100, 1)])).toEqual(['a', 'b']);
  });
  test('the field after this one; the last has none', () => {
    expect(nextFieldId(['a', 'b', 'c'], 'a')).toBe('b');
    expect(nextFieldId(['a', 'b', 'c'], 'c')).toBe(null);
    expect(nextFieldId(['a', 'b', 'c'], 'zzz')).toBe(null);
    expect(nextFieldId([], 'a')).toBe(null);
  });
  test('the return key: Next, Done on the last, the default on a multiline field, the caller\'s own choice wins', () => {
    expect(returnKeyFor({ isLast: false })).toBe('next');
    expect(returnKeyFor({ isLast: true })).toBe('done');
    expect(returnKeyFor({ multiline: true, isLast: false })).toBeUndefined();
    expect(returnKeyFor({ multiline: true, isLast: true })).toBeUndefined();
    expect(returnKeyFor({ explicit: 'search', isLast: false })).toBe('search');
  });
});

describe('the one shared solution (components/keyboard)', () => {
  const kb = read('components/keyboard/index.js');
  const focus = read('components/keyboard/formFocus.js');
  test('react-native-keyboard-controller, installed', () => {
    expect(JSON.parse(fs.readFileSync(path.join(SRC, '../package.json'), 'utf8')).dependencies['react-native-keyboard-controller']).toBeTruthy();
    expect(read('components/keyboard/controller.js')).toContain("require('react-native-keyboard-controller')");
    expect(kb).toContain("from './controller'");
  });
  test('the provider is around the whole app, edge to edge', () => {
    expect(kb).toContain('<KeyboardProvider statusBarTranslucent navigationBarTranslucent>{children}</KeyboardProvider>');
    const layout = read('app/_layout.js');
    expect(layout).toContain('<KeyboardRoot>');
    expect(layout.indexOf('<KeyboardRoot>')).toBeLessThan(layout.indexOf('<AppProvider>'));
  });
  test('the scroll area: 24 px above the keyboard, bar height counted, first-tap buttons, dismiss on tap and drag', () => {
    expect(kb).toContain('bottomOffset={scrollBottomOffset(footerHeight)}');
    expect(kb).toContain('keyboardShouldPersistTaps="handled"');
    expect(kb).toContain("export const KEYBOARD_DISMISS_MODE = Platform.OS === 'web' ? 'none' : Platform.OS === 'ios' ? 'interactive' : 'on-drag';");
    expect(kb).toContain('keyboardDismissMode={KEYBOARD_DISMISS_MODE}');
    expect(kb).toContain('<FormFocusProvider rtl={isRTL}>{children}</FormFocusProvider>');
  });
  test('the bar rides the keyboard and takes the bottom inset back off (no double gap)', () => {
    expect(kb).toContain('<KeyboardStickyView offset={stickyOffset(insets.bottom)}');
  });
  test('a modal rises above the keyboard; on Android it is told about the keyboard too', () => {
    expect(kb).toContain('<KeyboardAvoidingView behavior="padding"');
    expect(kb).toContain("Platform.OS === 'android' ? <KeyboardProvider statusBarTranslucent navigationBarTranslucent>");
    expect(kb).toContain('export const MODAL_EDGE_PROPS = { statusBarTranslucent: true, navigationBarTranslucent: true };');
  });
  test('the keyboard follows the system as it starts to move (open and height)', () => {
    // ONE listener, in the shared store (keyboardStore.js); everything else reads it
    const store = read('components/keyboard/keyboardStore.js');
    expect(store).toContain("events.addListener('keyboardWillShow'");
    expect(store).toContain("events.addListener('keyboardWillHide'");
    expect(kb).toContain('const state = useKeyboardState();');
    expect(kb).not.toMatch(/addListener\(/);
  });
  test('Next / Done never submits: the last field only closes the keyboard', () => {
    expect(focus).toContain("submitBehavior: isLast ? 'blurAndSubmit' : 'submit'");
    expect(focus).toContain('else Keyboard.dismiss();');
    expect(focus).not.toMatch(/onSubmit\b|handleSubmit|\.submit\(\)/);
  });
  test('a multiline field keeps Return for a new line', () => {
    expect(focus).toContain('const chained = !multiline && !explicit;');
  });
});

describe('every screen with inputs uses it', () => {
  test('Body (every form screen\'s scroll area) is the shared KeyboardScroll', () => {
    const layout = read('components/layout.js');
    expect(layout).toContain('<KeyboardScroll');
    expect(layout).not.toMatch(/<ScrollView/);
    expect(layout).toContain('footerHeight={footerHeight}');
  });
  test('every shared input takes part in Next / Done', () => {
    const ui = read('components/ui.js');
    expect(ui).toContain('const form = useFormInput({ multiline, returnKeyType, onSubmitEditing, onLayout, onFocus, onContentSizeChange });');
    expect(ui).toContain('{...form}');
  });
  test('the request form: Continue bar on the keyboard, scroll area aware of it, no KeyboardAvoidingView of its own', () => {
    const frame = read('components/request/RequestFrame.js');
    expect(frame).toContain('<KeyboardScroll');
    expect(frame).toContain('footerHeight={barHeight}');
    expect(frame).toContain('<KeyboardBar onLayout=');
    expect(frame).not.toContain('KeyboardAvoidingView');
  });
  test('the description field (multiline) is registered with the form, so the cursor line stays above the keyboard', () => {
    const step2 = read('app/request/step2.js');
    expect(step2).toContain('useFormInput({ multiline: true })');
    expect(step2).toContain('<DescriptionInput');
  });
  test('the tab bar hides while the keyboard is open, on both platforms', () => {
    const layout = read('components/layout.js');
    expect(layout).toContain('const keyboard = useKeyboardOpen();');
    expect(layout).toContain('if (keyboard) return null;');
    expect(layout).not.toContain('Keyboard.addListener');
  });
  test('the SOS button hides while the keyboard is open (it uses the same hook)', () => {
    expect(read('components/sos/hooks.js')).toContain("import { useKeyboardOpen } from '../keyboard';");
    expect(read('components/sos/SosFab.js')).toContain('const show = visible && !keyboardOpen;');
  });
  test('modals and sheets with inputs rise above the keyboard and are edge to edge', () => {
    ['components/widgets.js', 'components/NationalityPhone.js'].forEach((file) => {
      const src = read(file);
      expect(src).toContain('<KeyboardModalView');
      expect(src).toContain('{...MODAL_EDGE_PROPS}');
      expect(src).not.toMatch(/<Modal[^>]*statusBarTranslucent>/);
    });
    expect(read('components/widgets.js').match(/<KeyboardModalView/g)).toHaveLength(2); // the sheet and the picker
    expect(read('components/request/CityField.js')).not.toContain('Modal'); // the city suggestions are inline, under the field
  });
  test('ONE way: nothing else handles the keyboard (no own KeyboardAvoidingView, no Keyboard listeners)', () => {
    code.filter((f) => !f.startsWith('components/keyboard/')).forEach((file) => {
      const src = read(file);
      expect({ file, avoiding: /import[^;]*KeyboardAvoidingView[^;]*from 'react-native'/.test(src) }).toEqual({ file, avoiding: false });
      expect({ file, listener: /Keyboard\.addListener/.test(src) }).toEqual({ file, listener: false });
    });
  });
  test('the only raw TextInputs: the shared Input, the registered description, the code boxes and the search boxes', () => {
    const raw = code.filter((f) => /<TextInput/.test(read(f))).sort();
    expect(raw).toEqual(['app/request/step2.js', 'components/NationalityPhone.js', 'components/requests/RequestsHeader.js', 'components/ui.js', 'components/widgets.js']);
  });
});

describe('a build without the keyboard library still opens (Expo Go, or a dev build made before it was added)', () => {
  const controller = read('components/keyboard/controller.js');
  test('the library is loaded inside a try, so a missing native module cannot stop the app starting', () => {
    expect(controller).toMatch(/try \{\s*real = require\('react-native-keyboard-controller'\);\s*\} catch \{\s*real = null;\s*\}/);
    // nothing else imports the library directly (a direct import is what crashed with "doesn't seem to be linked")
    code.forEach((file) => expect({ file, direct: /from 'react-native-keyboard-controller'/.test(read(file)) }).toEqual({ file, direct: false }));
  });
  test('every piece has a plain React Native stand-in, and the app uses the real one only when it exists', () => {
    ['KeyboardProvider', 'KeyboardAwareScrollView', 'KeyboardStickyView', 'KeyboardAvoidingView', 'KeyboardEvents'].forEach((name) => {
      expect(controller).toContain(`export const ${name} = real ? real.${name} :`);
    });
    expect(read('components/keyboard/index.js')).toContain('if (KEYBOARD_CONTROLLER_AVAILABLE) cssInterop(KeyboardAwareScrollView');
  });
  test('the fallback keyboard events use the phone\'s own events (will on iOS, did on Android)', () => {
    expect(controller).toContain("Platform.OS === 'ios' ? name : name.replace('Will', 'Did')");
  });
});
