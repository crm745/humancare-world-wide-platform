// Country names in the person's language. The names the app stores and sends stay English (data/countryList.js, data/countries.js: the API holds the same list); these are only what is SHOWN.
// data/countryNames.json is generated once from CLDR (Node's Intl.DisplayNames), never at run time: Hermes on phones does not reliably support Intl.DisplayNames. A code it has no name for falls back to English.
import NAMES from '../data/countryNames.json';
import { COUNTRIES } from '../data/countryList';
import { COUNTRY_NAME_BY_ISO } from '../data/countries';
import { LANGUAGE_REGISTRY } from '../data/languages';
import { nameOf, searchCountries } from './phoneCountry';

let active = 'EN';
// AppContext tells this the language whenever it changes (the same way lib/dateFormat.js is told the locale).
export const setCountryLanguage = (code) => { if (typeof code === 'string' && code) active = code; };

const own = (object, key) => (object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

// The name of an ISO country in a language ('' for English or when there is none).
export function countryName(iso, lang = active) {
  if (lang === 'EN') return '';
  return own(own(NAMES, lang), iso) || '';
}

// What to show for a country: its name in the person's language, else the English name.
export const displayNameOf = (iso, lang = active) => countryName(iso, lang) || nameOf(iso);
export const countryDisplay = (iso, englishName, lang = active) => countryName(iso, lang) || englishName || '';

const plain = (text) => String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

// The countries for what was typed: the English search (names, dial codes, codes) plus the names in the person's own language ("भारत", "الهند"). With nothing typed, the whole list: India first,
// then in the order of the person's language.
export function searchCountriesLocalized(query, lang = active) {
  const base = searchCountries(query);
  if (lang === 'EN') return base;
  const q = plain(query);
  if (!q) {
    const locale = (LANGUAGE_REGISTRY[lang] && LANGUAGE_REGISTRY[lang].locale) || lang;
    const rest = base.filter((c) => c.code !== 'IN').sort((a, b) => countryDisplay(a.code, a.name, lang).localeCompare(countryDisplay(b.code, b.name, lang), locale));
    return [...base.filter((c) => c.code === 'IN'), ...rest];
  }
  if (/^\+?\d+$/.test(q)) return base;
  const seen = new Set(base.map((c) => c.code));
  const starts = [];
  const contains = [];
  for (const c of COUNTRIES) {
    if (seen.has(c.code)) continue;
    const name = plain(countryName(c.code, lang));
    if (!name) continue;
    if (name.startsWith(q)) starts.push(c); else if (name.includes(q)) contains.push(c);
  }
  return [...starts, ...contains, ...base];
}

// { 'Germany': 'जर्मनी', ... }: the labels for a list whose values are the English names that are stored and sent (the corporate case form's country).
export function countryLabelsByEnglishName(lang = active) {
  const labels = {};
  for (const [iso, name] of Object.entries(COUNTRY_NAME_BY_ISO)) { const shown = countryName(iso, lang); if (shown) labels[name] = shown; }
  return labels;
}

// The flag of an ISO 3166-1 country ("IN" -> the Indian flag), made from the two letters of its code: each letter becomes its "regional indicator" symbol, and a phone shows the pair as the flag. No picture files and
// no library: the flag comes with the phone's own emoji font. '' for anything that is not two letters.
export function flagEmoji(iso) {
  const code = String(iso || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
