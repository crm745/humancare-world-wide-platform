import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function isValidName(value) {
  const v = (value || '').trim();
  return v.length >= 2 && /\p{L}/u.test(v);
}

// One of the two name fields (first name, last name): at least a letter, at most 50 characters,
// the same limits as the server.
export function isValidNamePart(value) {
  const v = (value || '').trim();
  return v.length >= 1 && v.length <= 50 && /\p{L}/u.test(v);
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || '').trim());
}

// Fallback for countries isValidPhoneForCountry doesn't have an exact length for — a
// loose sanity range covering real numbers worldwide, not any one country's exact length.
export function isValidPhone(value) {
  const len = (value || '').replace(/\D/g, '').length;
  return len >= 7 && len <= 15;
}

// Mobile number length (national significant number, i.e. not counting the country
// code) for each country this app's country-code selectors offer. Digit counts
// genuinely differ by country — confirmed against HumanCare's own real regional
// numbers (see REGIONAL_NUMBERS in data/mock.js) for the 5 countries we actually
// operate in, not just assumed from general convention.
const PHONE_LENGTH_BY_CC = {
  '+91': 10, // India
  '+971': 9, // UAE
  '+968': 8, // Oman
  '+880': 10, // Bangladesh
  '+44': 10, // UK
  '+1': 10, // US/Canada
};

export function isValidPhoneForCountry(value, countryCode) {
  const len = (value || '').replace(/\D/g, '').length;
  const expected = PHONE_LENGTH_BY_CC[countryCode];
  return expected ? len === expected : isValidPhone(value);
}

export function isValidDateString(value) {
  const v = (value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
}

// Age is optional everywhere it's used, so empty is valid — only checked if filled in.
export function isValidAge(value) {
  if (!value) return true;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 130;
}

// Account mobile numbers (register, login, edit profile): checked with libphonenumber's
// per-country rules, exactly like the backend does before storing them in E.164.
// `value` is the national number as typed; a leading trunk 0 is allowed.
export function isValidMobileNumber(value, countryCode) {
  const digits = (value || '').replace(/\D/g, '');
  const cc = (countryCode || '').replace(/\D/g, '');
  if (!digits || !cc) return false;
  const parsed = parsePhoneNumberFromString(`+${cc}${digits}`);
  return !!parsed && parsed.isValid();
}

export const PASSWORD_HINT = 'At least 8 characters, with a letter and a number.';

// Same rule as the backend's passwordProblem(): a message, or null when it's fine.
export function passwordProblem(value) {
  const v = value || '';
  if (v.length < 8) return 'Password must be at least 8 characters.';
  if (v.length > 72) return 'Password must be at most 72 characters.';
  if (!/\p{L}/u.test(v) || !/\d/.test(v)) return 'Password must include at least one letter and one number.';
  return null;
}
