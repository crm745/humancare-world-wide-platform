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

// When both the calling code and the phone country are known they must agree (+971 with "AE").
// `phone` is what normalizeMobile returned for the number.
function phoneCountryMismatch(profile, phone) {
  return !!profile.phoneCountry && phone.countryCode !== dialOf(profile.phoneCountry);
}

module.exports = { GENDERS, readProfileFields, callingCodeFor, phoneCountryMismatch, dialOf };
