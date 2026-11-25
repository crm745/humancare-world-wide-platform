/* global describe, test, expect, __dirname */
// The six languages (English, Hindi, Marathi, Gujarati, Telugu, Arabic) are complete and stay complete: the same keys everywhere, every value really translated, the same placeholders,
// every key the code asks for exists, no English sentence is hard-coded in a screen, and the language machinery (registry, fallback, saved choice, switching, RTL) holds.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { translate, interpolate } = require('../translate');
const L = require('../../data/languages');
const { resolveInitialLanguage, loadSavedLanguage, saveLanguage, LANGUAGE_STORAGE_KEY } = require('../languagePreference');
const { errorText, KNOWN_MESSAGES } = require('../errorText');
const { genderLabels } = require('../genderLabels');
const { passwordProblemKey } = require('../validators');

const CODES = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const OTHERS = CODES.filter((c) => c !== 'EN');
const EN_KEYS = Object.keys(I18N.EN);
const SRC = path.join(__dirname, '..', '..');

// The script each language is written in: every value of it holds at least one letter of that script (the brand-neutral "SOS" is the one international sign).
const SCRIPT = { HI: /[ऀ-ॿ]/, MR: /[ऀ-ॿ]/, GU: /[઀-૿]/, TE: /[ఀ-౿]/, AR: /[؀-ۿ]/ };
const INTERNATIONAL = new Set(['sos_btn']);
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w.]+)\s*\}\}|\{(\w+)\}/g)].map((m) => m[1] || m[2]).sort().join('|');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(full, out); } else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}
// The source without its comment lines (a comment may quote an example).
const code = (text) => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
const sources = walk(SRC).map((file) => [path.relative(SRC, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8').split('\r\n').join('\n')]);

describe('every language has every key', () => {
  test('exactly the six languages', () => {
    expect(Object.keys(I18N)).toEqual(CODES);
  });
  test.each(OTHERS)('%s holds exactly the keys English holds (none missing, none extra)', (lang) => {
    const keys = Object.keys(I18N[lang]);
    expect(EN_KEYS.filter((k) => !(k in I18N[lang]))).toEqual([]);
    expect(keys.filter((k) => !(k in I18N.EN))).toEqual([]);
    expect(keys).toHaveLength(EN_KEYS.length);
  });
  test('English has a sensible size (it only grows)', () => {
    expect(EN_KEYS.length).toBeGreaterThanOrEqual(867);
  });
});

describe('every value is real text, translated, in the right script', () => {
  test.each(CODES)('%s: no empty value, no non-text value', (lang) => {
    for (const key of EN_KEYS) {
      const value = I18N[lang][key];
      expect({ lang, key, text: typeof value === 'string' && value.trim() !== '' }).toEqual({ lang, key, text: true });
    }
  });
  test.each(OTHERS)('%s: no value is the English text left in place', (lang) => {
    const same = EN_KEYS.filter((k) => I18N[lang][k] === I18N.EN[k] && /[A-Za-z]{4,}/.test(I18N.EN[k]));
    expect(same).toEqual([]);
  });
  test.each(OTHERS)('%s: every value is written in the language\'s own script', (lang) => {
    const missing = EN_KEYS.filter((k) => !INTERNATIONAL.has(k) && !SCRIPT[lang].test(I18N[lang][k]));
    expect(missing).toEqual([]);
  });
  test('no value keeps a stray, unfilled or broken {{ }} / { } mark', () => {
    for (const lang of CODES) {
      for (const key of EN_KEYS) {
        const stripped = I18N[lang][key].replace(/\{\{\s*[\w.]+\s*\}\}|\{\w+\}/g, '');
        expect({ lang, key, broken: /[{}]/.test(stripped) }).toEqual({ lang, key, broken: false });
      }
    }
  });
});

describe('placeholders agree in every language', () => {
  test.each(OTHERS)('%s: the same {{names}} / {names} as English, for every key', (lang) => {
    const bad = EN_KEYS.filter((k) => placeholders(I18N[lang][k]) !== placeholders(I18N.EN[k]));
    expect(bad).toEqual([]);
  });
  test('a value with placeholders fills in, in every language, with no leftover', () => {
    for (const lang of CODES) {
      const filled = translate(I18N, lang, 'lang_set_toast', { name: 'X' });
      expect(filled).toContain('X');
      expect(filled).not.toMatch(/\{\{|\}\}/);
      expect(translate(I18N, lang, 'tb_min_ago', { n: 5 })).toContain('5');
    }
  });
  test('a missing value fills with nothing, never "undefined"', () => {
    expect(interpolate('A {{name}} B', {})).toBe('A  B');
    expect(interpolate('A {{name}} B', { name: null })).toBe('A  B');
    expect(interpolate('A {{name}} B', { name: 0 })).toBe('A 0 B');
  });
});

describe('fallback and missing keys', () => {
  const dictionary = { EN: { a: 'English A', b: 'English B {{x}}' }, HI: { a: 'हिंदी A' } };
  test('a key a language lacks falls back to English, with its placeholders filled', () => {
    expect(translate(dictionary, 'HI', 'a')).toBe('हिंदी A');
    expect(translate(dictionary, 'HI', 'b', { x: '1' })).toBe('English B 1');
  });
  test('an unknown language falls back to English; an unknown key reads as the key itself', () => {
    expect(translate(dictionary, 'XX', 'a')).toBe('English A');
    expect(translate(dictionary, 'EN', 'nope')).toBe('nope');
    expect(translate(dictionary, 'HI', 'constructor')).toBe('constructor');
  });
  test('every key the code asks for with t(\'key\') exists in the dictionary', () => {
    const missing = [];
    for (const [file, text] of sources) {
      if (/^data\//.test(file) || file === 'lib/translate.js') continue;
      for (const m of code(text).matchAll(/\bt\(\s*'([a-z][a-z0-9_]*)'\s*[,)]/g)) if (!(m[1] in I18N.EN) && !m[1].endsWith('_')) missing.push(`${file}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('no English sentence is hard-coded in a screen', () => {
  // Text a screen shows must come from t(). Formats and examples that are the same in every language (an e-mail example, a date pattern) are the only exceptions, and the Google sign-in popup
  // page, which has no language provider by design (components/GoogleCallbackScreen.js).
  const ALLOWED = new Set(['you@example.com', 'corporate@company.com', 'YYYY-MM-DD', 'Signing you in…', 'You can close this window.']);
  const TEXT = />\s*([A-Z][A-Za-z0-9,.'&/ -]{3,}[a-z.!?])\s*<\//g;
  const PROP = /\b(?:placeholder|label|title|accessibilityLabel|accessibilityHint|subtitle|hint)=(?:"([^"{}]*[A-Za-z]{3,}[^"{}]*)"|\{'([^'{}]*[A-Za-z]{3,}[^'{}]*)'\})/g;
  const TOAST = /\b(?:toast|Alert\.alert)\(\s*['"`]([^'"`]{4,})['"`]/g;
  test('no JSX text, text prop or toast in app/ or components/ is an English literal', () => {
    const found = [];
    for (const [file, text] of sources) {
      if (!/^(app|components)\//.test(file) || file === 'components/GoogleCallbackScreen.js') continue;
      for (const re of [TEXT, PROP, TOAST]) {
        re.lastIndex = 0;
        for (const m of code(text).matchAll(re)) {
          const value = m[1] || m[2];
          if (!value || ALLOWED.has(value) || /^[A-Z_]+$/.test(value) || /^[a-z_]+$/.test(value)) continue;
          found.push(`${file}: ${value}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
  test('the gender choices are shown in the person\'s language (the stored values stay Male / Female / Other)', () => {
    for (const lang of CODES) {
      const t = (k) => translate(I18N, lang, k);
      const labels = genderLabels(t);
      expect(Object.keys(labels)).toEqual(['Male', 'Female', 'Other']);
      expect(labels.Male).toBe(t('gender_male'));
      if (lang !== 'EN') expect(labels.Male).not.toBe('Male');
    }
    for (const file of ['app/request/step1.js', 'components/request/HomeStep1.js', 'components/request/MarineStep1.js', 'components/request/MvtStep1.js', 'components/request/TeleStep1.js', 'components/request/CorporateStep1.js', 'components/request/MortalStep1.js']) {
      expect(sources.find(([f]) => f === file)[1]).toContain('labels={genderLabels(t)} keepSize placeholder={t(\'gender_placeholder\')}');
    }
  });
  test('the app\'s own error messages are shown in the person\'s language; a message the server sent is shown as it came', () => {
    for (const [message, key] of Object.entries(KNOWN_MESSAGES)) {
      expect(typeof I18N.EN[key]).toBe('string');
      for (const lang of CODES) {
        const t = (k) => translate(I18N, lang, k);
        expect(errorText({ message }, t)).toBe(t(key));
      }
    }
    const t = (k) => translate(I18N, 'HI', k);
    expect(errorText({ message: 'Invalid mobile or password' }, t)).toBe('Invalid mobile or password'); // from the server: unchanged
    expect(errorText({ code: 'network', message: 'anything' }, t)).toBe(t('err_network_short'));
    expect(errorText({}, t, 'otp_verify_failed')).toBe(t('otp_verify_failed'));
    expect(errorText(null, t)).toBe('');
  });
  test('the password rules are worded in every language', () => {
    expect(passwordProblemKey('short1')).toBe('pwd_err_min');
    expect(passwordProblemKey('a'.repeat(73) + '1')).toBe('pwd_err_max');
    expect(passwordProblemKey('onlyletters')).toBe('pwd_err_mix');
    expect(passwordProblemKey('Abcdefg1')).toBeNull();
    for (const key of ['pwd_err_min', 'pwd_err_max', 'pwd_err_mix', 'pwd_hint']) for (const lang of OTHERS) expect(I18N[lang][key]).not.toBe(I18N.EN[key]);
  });
});

describe('the registry, the saved choice and switching', () => {
  test('the six languages are registered and supported; the others are not', () => {
    for (const code of CODES) expect(L.isSupportedLanguage(code)).toBe(true);
    for (const code of ['FR', 'ES', '', null, undefined, 'constructor']) expect(L.isSupportedLanguage(code)).toBe(false);
    expect(Object.keys(L.LANGUAGE_REGISTRY)).toEqual(CODES);
    expect(L.supportedLanguages().map((l) => l.code)).toEqual(CODES);
  });
  test('Arabic is right to left and the others left to right', () => {
    expect(L.isRtlLanguage('AR')).toBe(true);
    for (const code of CODES.filter((c) => c !== 'AR')) expect(L.isRtlLanguage(code)).toBe(false);
    expect(L.isRtlLanguage('XX')).toBe(false);
  });
  test('English is the fallback for anything unknown', () => {
    expect(L.normalizeLanguage('XX')).toBe('EN');
    expect(L.getLanguage('nope')).toBe(L.LANGUAGE_REGISTRY.EN);
    expect(L.DEFAULT_LANGUAGE).toBe('EN');
  });
  test('the phone\'s language picks the matching one of the six, English otherwise', () => {
    expect(L.matchDeviceLanguage([{ languageCode: 'hi' }])).toBe('HI');
    expect(L.matchDeviceLanguage([{ languageCode: 'mr' }])).toBe('MR');
    expect(L.matchDeviceLanguage([{ languageCode: 'gu' }])).toBe('GU');
    expect(L.matchDeviceLanguage([{ languageCode: 'te' }])).toBe('TE');
    expect(L.matchDeviceLanguage([{ languageCode: 'ar', languageTag: 'ar-AE' }])).toBe('AR');
    expect(L.matchDeviceLanguage([{ languageCode: 'fr' }, { languageCode: 'te' }])).toBe('TE');
    expect(L.matchDeviceLanguage([{ languageCode: 'fr' }])).toBe('EN');
  });
  test('a saved choice survives a restart, beats the phone\'s language, and an invalid one is ignored', async () => {
    const store = {};
    const storage = { getItem: async (k) => (k in store ? store[k] : null), setItem: async (k, v) => { store[k] = v; } };
    for (const code of CODES) {
      await saveLanguage(storage, code);
      expect(store[LANGUAGE_STORAGE_KEY]).toBe(code);
      expect(await loadSavedLanguage(storage)).toBe(code);
      expect(await resolveInitialLanguage({ storage, getLocales: () => [{ languageCode: 'fr' }] })).toBe(code);
    }
    store[LANGUAGE_STORAGE_KEY] = 'FR';
    expect(await loadSavedLanguage(storage)).toBeNull();
    expect(await resolveInitialLanguage({ storage, getLocales: () => [{ languageCode: 'hi' }] })).toBe('HI');
  });
  test('switching language changes the text of the same key, in every language, and back', () => {
    const key = 'login_btn';
    const texts = CODES.map((c) => translate(I18N, c, key));
    expect(new Set(texts).size).toBe(CODES.length);
    expect(translate(I18N, 'EN', key)).toBe(texts[0]);
  });
});

describe('long text and offline', () => {
  test('no translation is wildly longer than its English (long text still fits: cut with an ellipsis, wrapped)', () => {
    const tooLong = [];
    for (const lang of OTHERS) {
      for (const key of EN_KEYS) {
        const en = I18N.EN[key];
        const text = I18N[lang][key];
        if (en.length >= 12 && text.length > en.length * 3 + 10) tooLong.push(`${lang}.${key}`);
      }
    }
    expect(tooLong).toEqual([]);
  });
  test('the offline texts exist in every language (the app is readable with no connection: the dictionary is bundled, nothing is fetched)', () => {
    const offlineKeys = EN_KEYS.filter((k) => /^(net_|cc_)/.test(k));
    expect(offlineKeys.length).toBeGreaterThan(20);
    for (const lang of CODES) for (const key of offlineKeys) expect(I18N[lang][key]).toBeTruthy();
    for (const [file, text] of sources) if (/^(lib|app|components|state)\//.test(file)) expect({ file, fetchesTranslations: /fetch\([^)]*(i18n|translat|locale)/i.test(text) }).toEqual({ file, fetchesTranslations: false });
  });
  test('Arabic keeps its right-to-left layout rules (the root view\'s direction, the chevron flips)', () => {
    const layout = sources.find(([f]) => f === 'app/_layout.js')[1];
    expect(layout).toContain("direction: isRTL ? 'rtl' : 'ltr'");
  });
});
