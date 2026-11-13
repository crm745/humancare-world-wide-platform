// Locale-aware dates. The value shown is always the same moment in the phone's own time zone (no timeZone option,
// exactly as before); only the way it is written follows the language. English stays "05 Oct 2026" and "14:05".
//
// The locale is passed explicitly, or defaults to the one the app is showing: AppContext calls setDateLocale when
// the language is chosen, so the pure helpers in lib/ do not need the React context.

import { DEFAULT_LANGUAGE, localeOf } from '../data/languages';

let activeLocale = localeOf(DEFAULT_LANGUAGE);
export const setDateLocale = (locale) => { if (typeof locale === 'string' && locale) activeLocale = locale; };
export const getDateLocale = () => activeLocale;

const FALLBACK_LOCALE = localeOf(DEFAULT_LANGUAGE);

const toDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

// Formats with the locale; a locale the runtime cannot handle falls back to English rather than throwing.
function format(date, locale, options) {
  try {
    return new Intl.DateTimeFormat(locale || activeLocale, options).format(date);
  } catch {
    return new Intl.DateTimeFormat(FALLBACK_LOCALE, options).format(date);
  }
}

// "05 Oct 2026". '' for a missing or invalid value.
export function formatDate(value, locale) {
  const date = toDate(value);
  return date ? format(date, locale, { day: '2-digit', month: 'short', year: 'numeric' }) : '';
}

// "05 Oct" (no year), for the tracking timeline.
export function formatDayMonth(value, locale) {
  const date = toDate(value);
  return date ? format(date, locale, { day: '2-digit', month: 'short' }) : '';
}

// "14:05", 24-hour in every language (as the English one has always read).
export function formatTime(value, locale) {
  const date = toDate(value);
  return date ? format(date, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
}
