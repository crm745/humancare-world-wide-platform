/* global describe, test, expect */
const { translate, interpolate } = require('../translate');
const real = require('../../data/i18n.json');

const DICT = {
  EN: { greet: 'Welcome, {{name}}', plain: 'Plain', only_en: 'Only English', count: '{{n}} files for {{ who }}', twice: '{{name}} and {{name}}', dollar: 'Cost {{x}}' },
  HI: { greet: 'स्वागत है, {{name}}', plain: 'सादा' },
};

describe('existing t(key) behaviour is unchanged', () => {
  test('the selected language, then English, then the key itself', () => {
    expect(translate(DICT, 'HI', 'plain')).toBe('सादा');
    expect(translate(DICT, 'HI', 'only_en')).toBe('Only English');
    expect(translate(DICT, 'HI', 'no_such_key')).toBe('no_such_key');
    expect(translate(DICT, 'XX', 'plain')).toBe('Plain'); // an unknown language reads as English
  });
  test('every real key in every language comes back exactly as stored when no values are given', () => {
    for (const lang of Object.keys(real)) for (const key of Object.keys(real[lang])) expect(translate(real, lang, key)).toBe(real[lang][key]);
  });
  test('a key missing in a language falls back to English exactly as before', () => {
    const missing = Object.keys(real.EN).find((k) => !(k in real.HI));
    expect(translate(real, 'HI', missing)).toBe(real.EN[missing]);
  });
  test('keys that are not own entries (constructor, __proto__) are missing keys, not functions', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(translate(DICT, 'HI', key)).toBe(key);
  });
  test('a value that is not text counts as missing', () => {
    expect(translate({ EN: { a: 'A' }, HI: { a: null } }, 'HI', 'a')).toBe('A');
    expect(translate({ EN: { a: 5 } }, 'EN', 'a')).toBe('a');
  });
  test('no dictionary at all is safe', () => {
    expect(translate(undefined, 'EN', 'k')).toBe('k');
    expect(translate({}, 'EN', 'k')).toBe('k');
  });
});

describe('interpolation', () => {
  test('fills {{name}} in the selected language', () => {
    expect(translate(DICT, 'EN', 'greet', { name: 'Asha' })).toBe('Welcome, Asha');
    expect(translate(DICT, 'HI', 'greet', { name: 'आशा' })).toBe('स्वागत है, आशा');
  });
  test('several placeholders, spaces inside the braces, and a repeated one', () => {
    expect(translate(DICT, 'EN', 'count', { n: 3, who: 'Ravi' })).toBe('3 files for Ravi');
    expect(translate(DICT, 'EN', 'twice', { name: 'A' })).toBe('A and A');
  });
  test('English fallback text is interpolated too', () => {
    expect(translate({ EN: { k: 'Hi {{name}}' }, HI: {} }, 'HI', 'k', { name: 'Z' })).toBe('Hi Z');
  });
  test('a missing, null or undefined value gives empty text and never throws', () => {
    expect(translate(DICT, 'EN', 'greet', {})).toBe('Welcome, ');
    expect(translate(DICT, 'EN', 'greet', { name: null })).toBe('Welcome, ');
    expect(translate(DICT, 'EN', 'greet', { name: undefined })).toBe('Welcome, ');
    expect(translate(DICT, 'EN', 'greet', { other: 'x' })).toBe('Welcome, ');
  });
  test('values of any type are shown as text; zero is not "missing"', () => {
    expect(translate(DICT, 'EN', 'greet', { name: 0 })).toBe('Welcome, 0');
    expect(translate(DICT, 'EN', 'greet', { name: false })).toBe('Welcome, false');
  });
  test('values with $ patterns or braces are inserted literally and never re-interpreted', () => {
    expect(translate(DICT, 'EN', 'dollar', { x: "$& $1 $$ {{name}}" })).toBe('Cost $& $1 $$ {{name}}');
  });
  test('inherited properties are not values', () => {
    expect(translate(DICT, 'EN', 'greet', {}).includes('function')).toBe(false);
    expect(translate({ EN: { k: '{{constructor}}' } }, 'EN', 'k', {})).toBe('');
  });
  test('text without placeholders, or with non-object values, is returned as is', () => {
    expect(translate(DICT, 'EN', 'plain', { name: 'x' })).toBe('Plain');
    expect(translate(DICT, 'EN', 'greet', 'oops')).toBe('Welcome, {{name}}');
    expect(translate(DICT, 'EN', 'greet', null)).toBe('Welcome, {{name}}');
    expect(interpolate('a {{ b }} c', { b: 1 })).toBe('a 1 c');
  });
  test('no real translation uses a placeholder yet, so nothing existing changes', () => {
    for (const lang of Object.keys(real)) for (const text of Object.values(real[lang])) expect(text).not.toContain('{{');
  });
});
