/* global describe, test, expect, __dirname */
// The login country-code dropdown: a plain, compact select showing only "IN +91" style entries (no modal, no search, no country names), built from the app's own data, with the same stored value.
// Pure parts and source checks; the look on iOS and Android needs a phone.
const fs = require('fs');
const path = require('path');
const D = require('../countryCodeDropdown');
const { COUNTRY_CODES, CALLING_CODE_COUNTRY } = require('../../data/mock');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const rows = D.codeRows(COUNTRY_CODES, CALLING_CODE_COUNTRY);

describe('the rows: the app\'s own list, shown as the country code and the dial code', () => {
  test('one row per dial code, in the list\'s own order', () => {
    expect(rows.map((r) => r.code)).toEqual(COUNTRY_CODES);
  });
  test('the examples: IN +91, US +1, GB +44 (plain ISO codes, no "UK"/"UAE" renaming, no names, no flags)', () => {
    const text = (code) => D.rowText(rows.find((r) => r.code === code));
    expect(text('+91')).toBe('IN +91');
    expect(text('+1')).toBe('US +1');
    expect(text('+44')).toBe('GB +44');
    expect(text('+679')).toBe('FJ +679');
    for (const r of rows) expect(D.rowText(r)).toMatch(/^([A-Z]{2} )?\+\d+$/);
  });
  test('a code with no country shows the dial code alone', () => {
    expect(D.rowText({ code: '+999', iso: '' })).toBe('+999');
  });
  test('the value is still the dial code', () => {
    expect(rows.every((r) => /^\+\d+$/.test(r.code))).toBe(true);
  });
});

describe('the login screen and the component', () => {
  const login = read('app', 'login.js');
  const comp = read('components', 'CountryCodeDropdown.js');
  test('login uses it with the same value, setter and number field; the old modal Select is gone from it', () => {
    expect(login).toContain("<CountryCodeField value={cc} onChange={setCc} open={codesOpen} onOpenChange={setCodesOpen} title={t('field_mobile_number')} anchorRef={codeAnchor}>");
    expect(login).toContain('keyboardType="phone-pad"');
    expect(login).not.toMatch(/<Select/);
  });
  test('no modal, no search box, no country names', () => {
    expect(comp).not.toMatch(/<Modal|from 'react-native'.*Modal|TextInput|Search|country_picker_search|displayNameOf|countryNames/);
    expect(comp).not.toMatch(/\.name/);
  });
  test('the list is a floating overlay: absolutely placed, above its neighbours, scrollable, and it takes no room in the form', () => {
    expect(comp).toContain('export function CountryCodeOverlay');
    expect(comp).toContain("position: 'absolute', zIndex: 20, left: spot.x, width: buttonWidth, height,");
    expect(comp).toContain('elevation: 10');
    expect(comp).toContain('nestedScrollEnabled');
    expect(comp).toContain('keyboardShouldPersistTaps="handled"');
  });
  test('no layout tricks: no reserved space, padding or negative margin for the list, and nothing in the flow under the button', () => {
    expect(comp).not.toMatch(/marginTop: -|paddingTop: placement|marginTop: up|marginTop: 2/);
    const field = comp.slice(comp.indexOf('export function CountryCodeField'), comp.indexOf('function useOverlaySpot'));
    expect(field).not.toMatch(/ScrollView|ROWS\.map|open &&/); // the field is the button row only
  });
  test('closes on a pick, on the button, and on a touch anywhere else on the page; no second back-button handler (the app has one, at the root)', () => {
    expect(comp).toContain('const pick = (code) => { onChange(code); onClose(); };');
    expect(comp).toContain('onOpenChange(!open); }}'); // the button toggles
    expect(comp).not.toMatch(/BackHandler/);
    expect(login).toContain("onTouchStart={() => { if (codesOpen) setCodesOpen(false); }}");
    expect(login).toContain("{codesOpen && mode === 'phone' ? <CountryCodeOverlay anchorRef={codeAnchor} value={cc} onChange={setCc} onClose={() => setCodesOpen(false)} /> : null}");
    expect(login).toMatch(/setMode\(next\);\s+setCodesOpen\(false\);/); // switching to e-mail login starts with the list closed
  });
  test('the page only HEARS the touch (a tap on Password still reaches Password and focuses it): no full-page layer in front of the form', () => {
    expect(comp).not.toMatch(/CountryCodeBackdrop|top: 0, left: 0, right: 0, bottom: 0/);
    expect(login).not.toMatch(/CountryCodeBackdrop/);
    expect(read('components', 'layout.js')).toContain('onTouchStart={onTouchStart}');
  });
  test('the button and the list do not announce their own touch, so the button toggles and a row can be picked', () => {
    expect(comp).toContain('const keepTouch = (e) => { if (e && e.stopPropagation) e.stopPropagation(); };');
    expect(comp.match(/onTouchStart=\{keepTouch\}/g).length).toBe(2);
  });
  test('the selected code stays visible in the field, and is ticked in the list', () => {
    expect(comp).toContain('{selected ? rowText(selected) : value}');
    expect(comp).toContain('<Check size={16}');
  });
  test('only the shown value changes: nothing about authentication or the API is touched', () => {
    expect(comp).not.toMatch(/apiPost|apiGet|session|token|otp/i);
    expect(read('components', 'widgets.js')).toContain('export function Select(');
  });
});

describe('tapping the number field closes the code list', () => {
  test('the number field closes it on focus and on a tap even when it already has focus', () => {
    const login = read('app', 'login.js');
    expect(login).toContain('onFocus={() => setCodesOpen(false)} onPressIn={() => setCodesOpen(false)}');
  });
});

describe('how tall the list is and which way it opens (listPlacement), instead of a fixed 240', () => {
  test('plenty of room below: opens down, as tall as the room, never over the maximum', () => {
    expect(D.listPlacement({ below: 500, above: 100 })).toEqual({ up: false, maxHeight: 360 });
    expect(D.listPlacement({ below: 300, above: 100 })).toEqual({ up: false, maxHeight: 300 });
  });
  test('enough room below (about four rows) keeps it down even when there is more above', () => {
    expect(D.listPlacement({ below: 180, above: 600 })).toEqual({ up: false, maxHeight: 180 });
  });
  test('not enough below and more above: opens up, with the room above', () => {
    expect(D.listPlacement({ below: 120, above: 250 })).toEqual({ up: true, maxHeight: 250 });
    expect(D.listPlacement({ below: 40, above: 900 })).toEqual({ up: true, maxHeight: 360 });
  });
  test('little room on both sides: the bigger side, never under the floor; bad numbers are safe', () => {
    expect(D.listPlacement({ below: 100, above: 60 })).toEqual({ up: false, maxHeight: 100 });
    expect(D.listPlacement({ below: 10, above: 20 })).toEqual({ up: true, maxHeight: 88 });
    expect(D.listPlacement({ below: NaN, above: undefined })).toEqual({ up: false, maxHeight: 88 });
    expect(D.listPlacement({ below: -50, above: -10 }).maxHeight).toBe(88);
  });
});


describe('where the floating list is measured and placed', () => {
  const comp = read('components', 'CountryCodeDropdown.js');
  test('the button row and a host point in the page are measured in the window, less the keyboard from the shared store', () => {
    expect(comp).toContain('measureInWindow');
    expect(comp).toContain('windowHeight - keyboard - (spot.winY + spot.h) - EDGE_GAP');
    expect(comp).toContain('useKeyboard()'); // the app's one keyboard store: no listener of its own
    expect(comp).not.toMatch(/Keyboard\.addListener/);
  });
  test('opens under the button, or over it when placement says up; the cap is 360, never a fixed 240', () => {
    expect(comp).toContain('top: placement.up ? spot.y - GAP - height : spot.y + spot.h + GAP,');
    expect(comp).toContain('export const CODE_LIST_MAX = 360;');
    expect(comp).not.toMatch(/CODE_LIST_MAX = 240/);
  });
  test('every code is a row of the scrolling list, in the list\'s own order', () => {
    expect(comp).toContain('ROWS.map((r, i) =>');
    expect(rows.length).toBe(COUNTRY_CODES.length);
  });
});

describe('opening with the keyboard up: dismiss it, then place the list from a fresh, settled measurement', () => {
  const comp = read('components', 'CountryCodeDropdown.js');
  test('sameSpot: equal to the pixel, and false for a missing or moved measurement', () => {
    const a = { x: 26, y: 300, h: 52, winY: 420 };
    expect(D.sameSpot(a, { ...a })).toBe(true);
    expect(D.sameSpot(a, { ...a, winY: 380 })).toBe(false);
    expect(D.sameSpot(a, { ...a, h: 50 })).toBe(false);
    expect(D.sameSpot(null, a)).toBe(false);
    expect(D.sameSpot(a, undefined)).toBe(false);
  });
  test('the settle wait is a frame bound, not a timer', () => {
    expect(D.MAX_SETTLE_FRAMES).toBeGreaterThan(5);
    expect(D.MAX_SETTLE_FRAMES).toBeLessThanOrEqual(60); // about a second of frames at the very most, normally one or two
    expect(comp).not.toMatch(/setTimeout|setInterval/);
    expect(comp).toContain('requestAnimationFrame(sample)');
  });
  test('tapping the selector while an input is focused dismisses the keyboard (which also blurs the input) before opening; tapping it while open only closes', () => {
    expect(comp).toContain('onPress={() => { if (!open) Keyboard.dismiss(); onOpenChange(!open); }}');
    expect(comp).toContain("import { Keyboard, Pressable");
  });
  test('nothing is measured or drawn while the shared store says the keyboard is open, and a measurement after it is used only once two in a row agree', () => {
    expect(comp).toContain('const { open: keyboardOpen, height: keyboard } = useKeyboard();');
    expect(comp).toContain('if (keyboardOpen) return undefined;');
    expect(comp).toContain('setSpot(null); }; // a spot never outlives the layout it was measured in');
    expect(comp).toContain('const stable = sameSpot(last, m);');
    expect(comp).toContain('if (frame === 0 ? startedClosed.current : stable) setSpot(');
    expect(comp).not.toMatch(/Keyboard\.addListener/);
  });
  test('with the keyboard already closed the first measurement is used at once', () => {
    expect(comp).toContain('const startedClosed = useRef(!keyboardOpen);');
  });
  test('it still opens below the selector when there is room, and the page does not move', () => {
    expect(comp).toContain('top: placement.up ? spot.y - GAP - height : spot.y + spot.h + GAP,');
    expect(comp).toContain("position: 'absolute', zIndex: 20");
  });
});

describe('login.js imports every React hook it calls (a missing import was a runtime ReferenceError)', () => {
  const login = read('app', 'login.js');
  test('useRef and useState are imported from react, and every hook used is in that import', () => {
    const imported = /import \{([^}]*)\} from 'react';/.exec(login)[1].split(',').map((x) => x.trim());
    for (const hook of ['useRef', 'useState', 'useEffect', 'useMemo', 'useCallback']) {
      if (login.includes(`${hook}(`)) expect({ hook, imported: imported.includes(hook) }).toEqual({ hook, imported: true });
    }
  });
  test('the components login draws are exported by the files it imports them from', () => {
    expect(read('components', 'CountryCodeDropdown.js')).toMatch(/export function CountryCodeField/);
    expect(read('components', 'CountryCodeDropdown.js')).toMatch(/export function CountryCodeOverlay/);
    expect(read('components', 'layout.js')).toMatch(/export function Screen/);
    expect(read('components', 'layout.js')).toMatch(/export const Body/);
  });
});
