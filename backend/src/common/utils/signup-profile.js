const { parsePhoneNumberFromString, isValidNumberForRegion } = require('libphonenumber-js');
const { COUNTRIES } = require('../constants/countries');

// The extra answers on the Create Account form (and the Google/Apple sign-up step): gender,
// nationality and the country picked for the phone's calling code. They are optional on the
// server so that older app versions, which do not send them, can still sign up; when a value IS
// sent it must be exactly right. They are personal data: never put them in a log line.

const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];
const COUNTRY_BY_CODE = new Map(COUNTRIES.map((country) => [country.code, country]));

const present = (value) => value !== undefined && value !== null && value !== '';
const dialOf = (isoCode) => COUNTRY_BY_CODE.get(isoCode)?.dial || null;

// Checks the three values and returns them (null for any that was not sent), or { error }.
// "male" etc. and ISO codes must match exactly: "Male" or "in" is refused rather than fixed up.
function readProfileFields(body) {
  const { gender, nationality, phoneCountry } = body;
  if (present(gender) && !GENDERS.includes(gender)) {
    return { error: `Invalid gender. Use one of: ${GENDERS.join(', ')}` };
  }
  if (present(nationality) && !COUNTRY_BY_CODE.has(nationality)) {
    return { error: 'Invalid nationality. Use a two-letter country code such as "IN".' };
  }
  if (present(phoneCountry) && !COUNTRY_BY_CODE.has(phoneCountry)) {
    return { error: 'Invalid phoneCountry. Use a two-letter country code such as "IN".' };
  }
  return {
    gender: present(gender) ? gender : null,
    nationality: present(nationality) ? nationality : null,
    phoneCountry: present(phoneCountry) ? phoneCountry : null,
  };
}

// The calling code to read the number with: the one sent, or else the picked country's own.
function callingCodeFor(body, profile) {
  return present(body.countryCode) ? body.countryCode : profile.phoneCountry ? dialOf(profile.phoneCountry) : undefined;
}

const COUNTRIES_BY_DIAL = new Map();
for (const country of COUNTRIES) {
  COUNTRIES_BY_DIAL.set(country.dial, [...(COUNTRIES_BY_DIAL.get(country.dial) || []), country.code]);
}

// The calling codes where the number itself says which country it belongs to: the North American
// plan (+1: US, CA, PR, BS ...) and +7 (RU, KZ). libphonenumber's bundled metadata tells those
// apart reliably, so the country picked must really own the number. Every other code that several
// countries share (+44 GB/GG/JE/IM, +358, +61, +590 ...) is one group: libphonenumber files many
// ordinary UK mobiles under GG, JE or IM, so a person who picked GB cannot be told apart from one
// who picked GG. Any country of the code is accepted there, and none is guessed.
const NUMBER_DECIDES_COUNTRY = new Set(['+1', '+7']);

// Checks the country picked for a phone's calling code against the number, and works out the
// phone country to store. `e164` is the normalized number; `selectedPhoneCountry` is the ISO code
// the person picked, or absent for older app versions.
//   { ok: true, phoneCountry }   the picked country, or for an older app the country the number
//                                reliably belongs to, else null (never a guess)
//   { ok: false, error }         'invalid_phone' or 'phone_country_mismatch'
function resolvePhoneCountry(e164, selectedPhoneCountry) {
  const parsed = parsePhoneNumberFromString(String(e164 || ''));
  if (!parsed || !parsed.isValid()) return { ok: false, error: 'invalid_phone' };

  const dial = `+${parsed.countryCallingCode}`;
  const sharing = COUNTRIES_BY_DIAL.get(dial) || [];
  const selected = present(selectedPhoneCountry) ? selectedPhoneCountry : null;
  const mismatch = { ok: false, error: 'phone_country_mismatch' };

  if (selected && !sharing.includes(selected)) return mismatch;
  if (sharing.length === 1) return { ok: true, phoneCountry: sharing[0] };
  if (!NUMBER_DECIDES_COUNTRY.has(dial)) return { ok: true, phoneCountry: selected };

  const owners = sharing.filter((code) => isValidNumberForRegion(parsed.number, code));
  if (selected) return owners.length && !owners.includes(selected) ? mismatch : { ok: true, phoneCountry: selected };
  return { ok: true, phoneCountry: owners.length === 1 ? owners[0] : null };
}

module.exports = { GENDERS, readProfileFields, callingCodeFor, resolvePhoneCountry, dialOf };
