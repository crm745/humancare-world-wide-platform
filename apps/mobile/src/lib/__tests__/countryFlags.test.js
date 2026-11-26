/* global describe, test, expect, __dirname */
// The country list shows each country's flag and name, and no dial code. The flag is made from the ISO code (no assets, no library).
const fs = require('fs');
const path = require('path');
const { flagEmoji } = require('../countryNames');
const { COUNTRIES } = require('../../data/countryList');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');

describe('flagEmoji', () => {
  test('two letters become the two regional-indicator symbols of that flag', () => {
    expect(flagEmoji('IN')).toBe('\u{1F1EE}\u{1F1F3}');
    expect(flagEmoji('us')).toBe('\u{1F1FA}\u{1F1F8}');
    expect(flagEmoji('GB')).toBe('\u{1F1EC}\u{1F1E7}');
  });
  test('anything that is not a two-letter code gives nothing', () => {
    for (const bad of ['', null, undefined, 'I', 'IND', '12', 'I1', '+91']) expect(flagEmoji(bad)).toBe('');
  });
  test('every country of the list has a flag, made of exactly two symbols', () => {
    for (const c of COUNTRIES) expect({ code: c.code, symbols: [...flagEmoji(c.code)].length }).toEqual({ code: c.code, symbols: 2 });
  });
});

describe('the country list rows', () => {
  const picker = read('components', 'NationalityPhone.js');
  const rows = picker.slice(picker.indexOf('renderItem'), picker.indexOf('// "Nationality" with the phone number'));
  test('each row has the flag and the name; the dial code is not shown, nor read out', () => {
    expect(rows).toContain('{flagEmoji(item.code)}');
    expect(rows).toContain('{displayNameOf(item.code)}');
    expect(rows).not.toMatch(/item\.dial|\.dial\b/);
    expect(rows).toContain('accessibilityLabel={displayNameOf(item.code)}');
  });
  test('the flag sits in a fixed-width slot before the name, so the names line up', () => {
    expect(rows).toContain("width: 30, fontSize: 22, lineHeight: 28, textAlign: 'center'");
    expect(rows.indexOf('flagEmoji(item.code)')).toBeLessThan(rows.indexOf('displayNameOf(item.code)}</Text>'));
  });
  test('selection, the ticked row, the search by name and the ISO value picked are unchanged', () => {
    expect(picker).toContain('onPress={() => pick(item.code)}');
    expect(picker).toContain('const on = item.code === selected;');
    expect(picker).toContain('searchCountriesLocalized(query)');
    expect(picker).toContain('<Check size={16}');
  });
  test('the dial codes are still used where a phone number needs them (the calling-code field and the phone rules)', () => {
    expect(picker).toContain('const dial = dialOf(phoneCountry);');
    expect(read('lib', 'phoneCountry.js')).toContain('dialOf');
    expect(read('components', 'CountryCodeDropdown.js')).toContain('rowText(r)'); // the login code list keeps its "IN +91" rows
  });
});
