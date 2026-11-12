/* global describe, test, expect, __dirname */
const fs = require('fs');
const path = require('path');
const registry = require('../../data/languages');
const i18n = require('../../data/i18n.json');

const { LANGUAGE_REGISTRY, DEFAULT_LANGUAGE, isSupportedLanguage, getLanguage, normalizeLanguage, directionOf, isRtlLanguage, localeOf, supportedLanguages, matchDeviceLanguage } = registry;

describe('the language registry', () => {
  test('all six existing languages are registered, and each has a translation block', () => {
    expect(Object.keys(LANGUAGE_REGISTRY)).toEqual(['EN', 'HI', 'MR', 'GU', 'TE', 'AR']);
    for (const code of Object.keys(LANGUAGE_REGISTRY)) expect(i18n[code]).toBeDefined();
    expect(Object.keys(i18n).sort()).toEqual(Object.keys(LANGUAGE_REGISTRY).sort());
  });
  test('every language has names, a valid locale, a direction and a font group', () => {
    for (const [code, lang] of Object.entries(LANGUAGE_REGISTRY)) {
      expect(lang.name).toBeTruthy();
      expect(lang.nativeName).toBeTruthy();
      expect(['ltr', 'rtl']).toContain(lang.direction);
      expect(lang.fontFamily).toBeTruthy();
      expect(lang.supported).toBe(true);
      expect(() => new Intl.DateTimeFormat(lang.locale)).not.toThrow();
      expect(Intl.DateTimeFormat.supportedLocalesOf([lang.locale]).length).toBe(1);
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });
  test('Arabic is right-to-left; the other five stay left-to-right', () => {
    expect(directionOf('AR')).toBe('rtl');
    expect(isRtlLanguage('AR')).toBe(true);
    for (const code of ['EN', 'HI', 'MR', 'GU', 'TE']) {
      expect(directionOf(code)).toBe('ltr');
      expect(isRtlLanguage(code)).toBe(false);
    }
  });
  test('English keeps en-GB, so dates read as before', () => {
    expect(localeOf('EN')).toBe('en-GB');
    expect(DEFAULT_LANGUAGE).toBe('EN');
  });
  test('an unknown, empty or hostile code is handled safely, as English', () => {
    for (const bad of ['FR', '', null, undefined, 42, 'constructor', '__proto__', 'toString', 'en']) {
      expect(isSupportedLanguage(bad)).toBe(false);
      expect(normalizeLanguage(bad)).toBe('EN');
      expect(getLanguage(bad)).toBe(LANGUAGE_REGISTRY.EN);
      expect(directionOf(bad)).toBe('ltr');
      expect(isRtlLanguage(bad)).toBe(false);
      expect(localeOf(bad)).toBe('en-GB');
    }
  });
  test('an unsupported entry is not offered, nor chosen from the device language', () => {
    LANGUAGE_REGISTRY.UR = { name: 'Urdu', nativeName: 'اردو', locale: 'ur', direction: 'rtl', fontFamily: 'inter', supported: false };
    try {
      expect(supportedLanguages().map((l) => l.code)).not.toContain('UR');
      expect(matchDeviceLanguage([{ languageCode: 'ur' }])).toBe('EN');
      LANGUAGE_REGISTRY.UR.supported = true;
      expect(isRtlLanguage('UR')).toBe(true); // a new right-to-left language needs only its registry entry
      expect(matchDeviceLanguage([{ languageCode: 'ur' }])).toBe('UR');
    } finally {
      delete LANGUAGE_REGISTRY.UR;
    }
  });
});

describe('the language list the sheet shows (LANGUAGES) comes from the registry', () => {
  test('same shape and same visible names as before', () => {
    expect(supportedLanguages()).toEqual([
      { code: 'EN', name: 'English', label: 'English (EN)' },
      { code: 'HI', name: 'हिंदी (Hindi)', label: 'हिंदी (HI)' },
      { code: 'MR', name: 'मराठी (Marathi)', label: 'मराठी (MR)' },
      { code: 'GU', name: 'ગુજરાતી (Gujarati)', label: 'ગુજરાતી (GU)' },
      { code: 'TE', name: 'తెలుగు (Telugu)', label: 'తెలుగు (TE)' },
      { code: 'AR', name: 'العربية (Arabic)', label: 'العربية (AR)' },
    ]);
  });
  test('mock.js no longer holds its own list', () => {
    const mock = fs.readFileSync(path.join(__dirname, '../../data/mock.js'), 'utf8');
    expect(mock).toContain('export const LANGUAGES = supportedLanguages();');
    expect(mock).not.toMatch(/code: 'HI'/);
  });
});

describe('matchDeviceLanguage (the phone\'s preferred locales)', () => {
  const tags = (...list) => list.map((languageTag) => ({ languageTag, languageCode: languageTag.split('-')[0] }));
  test('the five regional-language examples', () => {
    expect(matchDeviceLanguage(tags('hi-IN'))).toBe('HI');
    expect(matchDeviceLanguage(tags('mr-IN'))).toBe('MR');
    expect(matchDeviceLanguage(tags('gu-IN'))).toBe('GU');
    expect(matchDeviceLanguage(tags('te-IN'))).toBe('TE');
    expect(matchDeviceLanguage(tags('ar-AE'))).toBe('AR');
    expect(matchDeviceLanguage(tags('ar'))).toBe('AR');
  });
  test('English in any region is English', () => {
    for (const tag of ['en-IN', 'en-GB', 'en-US', 'en']) expect(matchDeviceLanguage(tags(tag))).toBe('EN');
  });
  test('matches on the language, not the region, and not on a lookalike', () => {
    expect(matchDeviceLanguage(tags('hi-US'))).toBe('HI');
    expect(matchDeviceLanguage(tags('ar-EG'))).toBe('AR');
    expect(matchDeviceLanguage(tags('hu-HU'))).toBe('EN'); // not HI
    expect(matchDeviceLanguage(['HI_in'])).toBe('HI'); // plain tags, any case, underscore
  });
  test('an unsupported language is English; the first supported preference wins', () => {
    expect(matchDeviceLanguage(tags('fr-FR'))).toBe('EN');
    expect(matchDeviceLanguage(tags('fr-FR', 'ar-SA', 'hi-IN'))).toBe('AR');
    expect(matchDeviceLanguage(tags('en-GB', 'hi-IN'))).toBe('EN');
  });
  test('nothing usable is English', () => {
    for (const bad of [undefined, null, [], {}, 'hi', [null], [{}], [42], [{ languageCode: '' }]]) expect(matchDeviceLanguage(bad)).toBe('EN');
  });
});
