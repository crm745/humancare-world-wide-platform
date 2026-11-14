import { parsePhoneNumberFromString } from 'libphonenumber-js';

// The API stores mobiles in E.164 ("+919876543210"); the app's profile keeps the
// calling code and the national number apart, the way the country picker shows them.
// `hasPassword` is false for Google/Apple-only accounts. It no longer matters for changing mobile or email
// (a code to the new value is all that is needed).
export function profileFromUser(user) {
  const parsed = user.mobile ? parsePhoneNumberFromString(user.mobile) : null;
  return {
    name: user.name,
    // Empty for accounts made before the sign-up form asked for first and last name separately.
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    cc: parsed ? `+${parsed.countryCallingCode}` : user.countryCode || '+91',
    phone: parsed ? parsed.nationalNumber : user.mobile || '',
    email: user.email,
    // Empty for accounts made before the sign-up form asked for them.
    gender: user.gender || '',
    nationality: user.nationality || '',
    phoneCountry: user.phoneCountry || '',
    hasPassword: user.hasPassword !== false,
  };
}