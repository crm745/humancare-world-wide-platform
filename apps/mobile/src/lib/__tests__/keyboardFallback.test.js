/* global describe, test, expect, jest */
// What the phone showed: "The package 'react-native-keyboard-controller' doesn't seem to be linked" (a dev build made before the library was added).
// The app must still open: components/keyboard/controller.js falls back to plain React Native.
jest.mock('react-native', () => ({
  Keyboard: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
  KeyboardAvoidingView: 'RNKeyboardAvoidingView',
  Platform: { OS: 'android' },
  ScrollView: 'RNScrollView',
  View: 'RNView',
}));
// the project's NativeWind babel step adds a styling runtime to every file; it is not what is under test
jest.mock('react-native-css-interop', () => ({}));
jest.mock('react-native-css-interop/jsx-runtime', () => ({}), { virtual: true });
jest.mock('react-native-keyboard-controller', () => { throw new Error("The package 'react-native-keyboard-controller' doesn't seem to be linked."); });

const { Keyboard } = require('react-native');
const controller = require('../../components/keyboard/controller');

describe('without the native module', () => {
  test('loading it does not throw, and it says the library is not there', () => {
    expect(controller.KEYBOARD_CONTROLLER_AVAILABLE).toBe(false);
  });
  test('every piece exists (plain stand-ins), so the screens render as before', () => {
    ['KeyboardProvider', 'KeyboardAwareScrollView', 'KeyboardStickyView', 'KeyboardAvoidingView', 'KeyboardEvents'].forEach((name) => expect(controller[name]).toBeTruthy());
  });
  test('the provider just renders what is inside it', () => {
    expect(controller.KeyboardProvider({ children: 'x' })).toBe('x');
  });
  test('keyboard events come from the phone itself: Android has only the "did" events', () => {
    const seen = [];
    controller.KeyboardEvents.addListener('keyboardWillShow', (e) => seen.push(e.height));
    expect(Keyboard.addListener).toHaveBeenCalledWith('keyboardDidShow', expect.any(Function));
    Keyboard.addListener.mock.calls[0][1]({ endCoordinates: { height: 300 } });
    expect(seen).toEqual([300]);
    controller.KeyboardEvents.addListener('keyboardWillHide', () => {});
    expect(Keyboard.addListener).toHaveBeenCalledWith('keyboardDidHide', expect.any(Function));
  });
});
