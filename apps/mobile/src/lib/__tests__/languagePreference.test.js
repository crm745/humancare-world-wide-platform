/* global describe, test, expect, jest, __dirname */
const fs = require('fs');
const path = require('path');
const { LANGUAGE_STORAGE_KEY, loadSavedLanguage, saveLanguage, resolveInitialLanguage, deviceLanguage } = require('../languagePreference');

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: jest.fn(async (k) => (k in data ? data[k] : null)),
    setItem: jest.fn(async (k, v) => { data[k] = v; }),
  };
};
const deviceIs = (...tags) => () => tags.map((languageTag) => ({ languageTag, languageCode: languageTag.split('-')[0] }));

describe('saving and restoring', () => {
  test('the chosen language is saved under its own key and restored', async () => {
    const storage = memoryStorage();
    expect(await saveLanguage(storage, 'HI')).toBe(true);
    expect(storage.data[LANGUAGE_STORAGE_KEY]).toBe('HI');
    expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('en-GB') })).toBe('HI');
  });
  test('the key is not one of the sign-in token keys', () => {
    expect(LANGUAGE_STORAGE_KEY).toBe('humancare_language');
    expect(['humancare_token', 'humancare_refresh_token']).not.toContain(LANGUAGE_STORAGE_KEY);
  });
  test('an unsupported code is not saved', async () => {
    const storage = memoryStorage();
    for (const bad of ['FR', '', null, undefined, 'constructor']) expect(await saveLanguage(storage, bad)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  test('a failing write is reported as false, never thrown', async () => {
    const storage = { setItem: jest.fn(async () => { throw new Error('disk full'); }) };
    await expect(saveLanguage(storage, 'AR')).resolves.toBe(false);
  });
});

describe('the language the app starts in', () => {
  test('no saved choice: the phone\'s language', async () => {
    const storage = memoryStorage();
    expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('hi-IN') })).toBe('HI');
    expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('mr-IN') })).toBe('MR');
    expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('gu-IN') })).toBe('GU');
    expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('te-IN') })).toBe('TE');
    expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('ar-AE') })).toBe('AR');
    expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('en-IN') })).toBe('EN');
  });
  test('a saved choice wins over the phone\'s language', async () => {
    const storage = memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'EN' });
    expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('hi-IN') })).toBe('EN');
  });
  test('an unsupported phone language is English', async () => {
    expect(await resolveInitialLanguage({ storage: memoryStorage(), getLocales: deviceIs('fr-FR') })).toBe('EN');
  });
  test('starting never writes: neither a guess nor a saved choice is touched', async () => {
    const empty = memoryStorage();
    await resolveInitialLanguage({ storage: empty, getLocales: deviceIs('hi-IN') });
    expect(empty.setItem).not.toHaveBeenCalled();
    const saved = memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'TE' });
    await resolveInitialLanguage({ storage: saved, getLocales: deviceIs('hi-IN') });
    expect(saved.setItem).not.toHaveBeenCalled();
    expect(saved.data[LANGUAGE_STORAGE_KEY]).toBe('TE');
  });
  test('a corrupted or retired saved value falls back to the phone\'s language, and is left as it is', async () => {
    for (const bad of ['FR', '', 'hi', '{"a":1}', 'constructor', '\u0000']) {
      const storage = memoryStorage({ [LANGUAGE_STORAGE_KEY]: bad });
      expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('hi-IN') })).toBe('HI');
      expect(await loadSavedLanguage(storage)).toBeNull();
      expect(storage.setItem).not.toHaveBeenCalled();
    }
    const notText = memoryStorage({ [LANGUAGE_STORAGE_KEY]: 7 });
    expect(await loadSavedLanguage(notText)).toBeNull();
  });
  test('storage that throws does not crash the start: the phone\'s language is used', async () => {
    const storage = { getItem: jest.fn(async () => { throw new Error('storage unavailable'); }), setItem: jest.fn() };
    expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('ar-SA') })).toBe('AR');
    const syncThrow = { getItem: () => { throw new Error('boom'); } };
    expect(await resolveInitialLanguage({ storage: syncThrow, getLocales: deviceIs('hi-IN') })).toBe('HI');
  });
  test('storage that never answers does not hold the app on a blank screen', async () => {
    const storage = { getItem: () => new Promise(() => {}) };
    expect(await resolveInitialLanguage({ storage, getLocales: deviceIs('hi-IN'), timeoutMs: 20 })).toBe('HI');
  });
  test('a missing or throwing device locale is English', async () => {
    const storage = memoryStorage();
    expect(await resolveInitialLanguage({ storage, getLocales: () => { throw new Error('no locale module'); } })).toBe('EN');
    expect(await resolveInitialLanguage({ storage, getLocales: () => [] })).toBe('EN');
    expect(await resolveInitialLanguage({ storage, getLocales: () => undefined })).toBe('EN');
    expect(deviceLanguage(() => null)).toBe('EN');
  });
});

describe('how AppContext uses it (source checks; the screens are not rendered in this test environment)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../state/AppContext.js'), 'utf8');
  test('nothing is drawn until the language is known, and the auth start is not behind it', () => {
    expect(source).toContain('if (!langReady) return null;');
    expect(source.indexOf('Promise.resolve().then(authStore.validate)')).toBeLessThan(source.indexOf('if (!langReady) return null;'));
  });
  test('choosing the language already showing, or an unknown one, does nothing and writes nothing', () => {
    expect(source).toContain('if (!isSupportedLanguage(code) || code === langRef.current) return;');
    expect(source.split('saveLanguage(AsyncStorage, code)').length - 1).toBe(1);
  });
  test('the start reads and never writes', () => {
    const start = source.slice(source.indexOf('resolveInitialLanguage({'), source.indexOf('// Chooses a language'));
    expect(start).not.toContain('saveLanguage');
  });
  test('the context still offers lang, setLang, isRTL and t, plus the locale', () => {
    for (const piece of ['      lang,', '      setLang,', 'isRTL: isRtlLanguage(lang)', '      t,', 'locale: localeOf(lang)']) expect(source).toContain(piece);
    expect(source).not.toContain("lang === 'AR'");
  });
  test('the preference is not kept in the sign-in secure store', () => {
    expect(fs.readFileSync(path.join(__dirname, '../languagePreference.js'), 'utf8')).not.toMatch(/SecureStore|session/);
  });
});

describe('regression: Profile, the language sheet and the other screens still read the same context', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  test('the language sheet still lists LANGUAGES, marks the current one and calls setLang', () => {
    const profile = read('../../app/profile.js');
    expect(profile).toContain("import { LANGUAGES } from '../data/mock';");
    expect(profile).toContain('setLang(l.code);');
    expect(profile).toContain('const on = l.code === lang;');
    expect(profile).toContain("t('choose_language')");
  });
  test('every RTL consumer still reads isRTL from the context', () => {
    for (const file of ['../../app/_layout.js', '../../components/layout.js', '../../components/widgets.js', '../../components/NationalityPhone.js', '../../app/profile.js']) {
      expect(read(file)).toMatch(/isRTL/);
    }
  });
  test('Home and the other screens only call t(key)', () => {
    expect(read('../../app/home.js')).toContain('const { t, toast, isCorporate, profile } = useApp();');
  });
  test('the session start is untouched by the language work', () => {
    const source = read('../../state/AppContext.js');
    // the same two calls as before; the only addition is that what the screens had loaded is forgotten first (lib/screenCache.js)
    expect(source).toContain('const unsubscribe = onSessionChange((signedIn) => { clearCache(); return signedIn ? authStore.signedIn() : authStore.signedOut(); });');
    expect(source).toContain('fetchMe: (signal) => apiGet(\'/auth/me\', { signal, validation: true }),');
  });
});
