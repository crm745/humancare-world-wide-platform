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
    expect(login).toContain("<CountryCodeField value={cc} onChange={setCc} open={codesOpen} onOpenChange={setCodesOpen} title={t('field_mobile_number')}>");
    expect(login).toContain('keyboardType="phone-pad"');
    expect(login).not.toMatch(/<Select\b/);
  });
  test('no modal, no search box, no country names', () => {
    expect(comp).not.toMatch(/<Modal|from 'react-native'.*\bModal\b|TextInput|Search|country_picker_search|displayNameOf|countryNames/);
    expect(comp).not.toMatch(/\.name\b/);
  });
  test('a compact scrollable list attached under the button, above its neighbours, never clipped by the row', () => {
    expect(comp).toContain('<ScrollView style={{ maxHeight: CODE_LIST_MAX }}');
    expect(comp).toContain('marginTop: 2, width: buttonWidth');
    expect(comp).not.toMatch(/position: 'absolute', top: rowHeight/); // in the page flow, inside its parent's bounds: touchable and scrollable everywhere
    expect(comp).toMatch(/zIndex: 2/);
    expect(comp).toContain('nestedScrollEnabled');
    expect(comp).toContain('keyboardShouldPersistTaps="handled"');
  });
  test('closes on a pick, on the button, and on an outside tap (a page-wide backdrop); no second back-button handler (the app has one, at the root)', () => {
    expect(comp).toContain("const pick = (code) => { onChange(code); onOpenChange(false); };");
    expect(comp).toContain('onPress={() => onOpenChange(!open)}');
    expect(comp).not.toMatch(/BackHandler/);
    expect(login).toContain("{codesOpen && mode === 'phone' ? <CountryCodeBackdrop onPress={() => setCodesOpen(false)} /> : null}");
    expect(login).toMatch(/setMode\(next\);\s+setCodesOpen\(false\);/); // switching to e-mail login starts with the list closed
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
