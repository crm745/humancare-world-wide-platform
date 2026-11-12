// The one language registry. Everything that needs to know which languages the app has, how they read
// (direction), which locale formats their dates, or how to match the phone's language reads it from here:
// the language sheet (via LANGUAGES in data/mock.js), AppContext (isRTL, locale) and the device-language match.
// A language is added by adding an entry here and its block in data/i18n.json; nothing else lists languages.
//
//   name        English name
//   nativeName  the name in the language itself (what the language sheet shows)
//   locale      BCP-47 tag used for dates and numbers (Intl)
//   direction   'ltr' | 'rtl'; drives isRTL (native RTL limits: docs/mobile-localization-phase1.md)
//   fontFamily  font group the language is set in. Every language uses the bundled Inter for now; the scripts Inter
//               has no glyphs for (Devanagari, Gujarati, Telugu, Arabic) fall back to the system font (Phase 7).
//   supported   false hides a language from the sheet and from device matching while its translations are unfinished

export const DEFAULT_LANGUAGE = 'EN';

export const LANGUAGE_REGISTRY = {
  EN: { name: 'English', nativeName: 'English', locale: 'en-GB', direction: 'ltr', fontFamily: 'inter', supported: true },
  HI: { name: 'Hindi', nativeName: 'हिंदी', locale: 'hi-IN', direction: 'ltr', fontFamily: 'inter', supported: true },
  MR: { name: 'Marathi', nativeName: 'मराठी', locale: 'mr-IN', direction: 'ltr', fontFamily: 'inter', supported: true },
  GU: { name: 'Gujarati', nativeName: 'ગુજરાતી', locale: 'gu-IN', direction: 'ltr', fontFamily: 'inter', supported: true },
  TE: { name: 'Telugu', nativeName: 'తెలుగు', locale: 'te-IN', direction: 'ltr', fontFamily: 'inter', supported: true },
  AR: { name: 'Arabic', nativeName: 'العربية', locale: 'ar', direction: 'rtl', fontFamily: 'inter', supported: true },
};

const has = (code) => typeof code === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGE_REGISTRY, code);

// A code the app can use right now (registered and supported). Anything else (null, 'FR', 'constructor') is not.
export const isSupportedLanguage = (code) => has(code) && LANGUAGE_REGISTRY[code].supported === true;

// The language a code names, or English for anything unknown: callers never get undefined.
export const getLanguage = (code) => (isSupportedLanguage(code) ? LANGUAGE_REGISTRY[code] : LANGUAGE_REGISTRY[DEFAULT_LANGUAGE]);
export const normalizeLanguage = (code) => (isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE);

export const directionOf = (code) => getLanguage(code).direction;
export const isRtlLanguage = (code) => directionOf(code) === 'rtl';
export const localeOf = (code) => getLanguage(code).locale;

// What the language sheet lists, in registry order: { code, name, label }. `name` is "native (English)" for every
// language but English, as it has always read; `label` is "native (CODE)".
export const supportedLanguages = () => Object.keys(LANGUAGE_REGISTRY)
  .filter(isSupportedLanguage)
  .map((code) => {
    const { name, nativeName } = LANGUAGE_REGISTRY[code];
    return code === DEFAULT_LANGUAGE ? { code, name: nativeName, label: `${nativeName} (${code})` } : { code, name: `${nativeName} (${name})`, label: `${nativeName} (${code})` };
  });

// The primary language subtag of a locale tag, lower case: 'hi-IN' -> 'hi', 'ar_EG' -> 'ar', 'en' -> 'en'.
function primarySubtag(tag) {
  if (typeof tag !== 'string') return '';
  return tag.trim().toLowerCase().split(/[-_]/)[0];
}

// The supported language for the phone's preferred locales (expo-localization's getLocales(), in the person's order).
// The first preferred locale whose language the app has wins, matched on the language and never on the region
// (en-IN, en-GB -> EN; hi-IN -> HI; ar-AE, ar-EG -> AR). None of them supported (or nothing readable) -> English.
export function matchDeviceLanguage(locales) {
  const list = Array.isArray(locales) ? locales : [];
  for (const entry of list) {
    const wanted = primarySubtag(typeof entry === 'string' ? entry : entry?.languageCode || entry?.languageTag);
    if (!wanted) continue;
    const code = Object.keys(LANGUAGE_REGISTRY).find((c) => isSupportedLanguage(c) && primarySubtag(LANGUAGE_REGISTRY[c].locale) === wanted);
    if (code) return code;
  }
  return DEFAULT_LANGUAGE;
}
