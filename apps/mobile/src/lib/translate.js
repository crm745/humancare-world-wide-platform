// The translation lookup behind t(): the selected language, then English, then the key itself, with optional
// {{placeholder}} values:  translate(I18N, 'HI', 'welcome_message', { name: 'Asha' })  ->  "स्वागत है, Asha"
// Without values the text comes back exactly as stored, so every existing t('key') call is unchanged.

import { DEFAULT_LANGUAGE } from '../data/languages';

const own = (object, key) => (object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

// A string from the dictionary, or undefined when it has none (a missing key, or a value that is not text).
const lookup = (dictionary, lang, key) => {
  const value = own(own(dictionary, lang), key);
  return typeof value === 'string' ? value : undefined;
};

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

// Fills {{name}} from values. A value that is missing, null or undefined becomes empty text (a sentence with a gap
// reads better than the literal "{{name}}", and nothing throws); numbers and other values are shown as text.
export function interpolate(text, values) {
  if (!values || typeof values !== 'object') return text;
  return text.replace(PLACEHOLDER, (_match, name) => {
    const value = own(values, name);
    return value === undefined || value === null ? '' : String(value);
  });
}

export function translate(dictionary, lang, key, values) {
  const text = lookup(dictionary, lang, key) ?? lookup(dictionary, DEFAULT_LANGUAGE, key);
  if (text === undefined) return key;
  return interpolate(text, values);
}
