import { COUNTRIES } from '../data/countryList';

// Pure rules of the Create Account form's Nationality + phone fields (no React, no native
// modules), kept apart so they can be unit-tested.

export const DEFAULT_PHONE_COUNTRY = 'IN';
export const COUNTRY_BY_CODE = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));

export const dialOf = (isoCode) => COUNTRY_BY_CODE[isoCode]?.dial || '';
export const nameOf = (isoCode) => COUNTRY_BY_CODE[isoCode]?.name || '';

// Lower case, no accents: "Côte d’Ivoire" is found by typing "cote".
const plain = (text) => String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

// The countries that match what was typed, best first. Typing digits or a "+" searches the dial
// codes ("91", "+971"); anything else searches the names (starting with it first, then
// containing it) or an exact two-letter code ("us"). Empty gives the whole list: India first,
// then A-Z.
export function searchCountries(query) {
  const q = plain(query);
  if (!q) return COUNTRIES;
  if (/^\+?\d+$/.test(q)) {
    const digits = q.replace('+', '');
    return COUNTRIES.filter((c) => c.dial.slice(1).startsWith(digits));
  }
  const starts = [];
  const contains = [];
  for (const c of COUNTRIES) {
    const name = plain(c.name);
    if (name.startsWith(q) || c.code.toLowerCase() === q) starts.push(c);
    else if (name.includes(q)) contains.push(c);
  }
  return [...starts, ...contains];
}

// The form's nationality + phone country. The phone country (and so its calling code) follows
// the nationality until the person changes the code by hand; after that it is theirs.
export const INITIAL_PHONE_STATE = { nationality: '', phoneCountry: DEFAULT_PHONE_COUNTRY, codeEdited: false };

export function pickNationality(state, isoCode) {
  return {
    ...state,
    nationality: isoCode,
    phoneCountry: state.codeEdited ? state.phoneCountry : isoCode,
  };
}

export function pickPhoneCountry(state, isoCode) {
  return { ...state, phoneCountry: isoCode, codeEdited: true };
}
