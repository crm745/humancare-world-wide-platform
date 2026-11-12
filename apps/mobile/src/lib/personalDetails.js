// What the Personal details screen shows and sends, worked out from the account the API returns (GET /auth/me) and
// the edit form. Pure (no React, no native modules), so it can be unit-tested. Nothing here invents a value: a detail
// the account does not have is simply absent.
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { isValidNamePart, isValidName } from './validators';
import { formatDisplayDate } from './requestShape';

const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];

const clean = (value) => String(value == null ? '' : value).trim().replace(/\s+/g, ' ');

// A country's flag built from its two-letter code ("IN" -> the Indian flag), as on the Login screen.
export const flagOf = (iso) => (/^[A-Za-z]{2}$/.test(iso || '') ? String.fromCodePoint(...[...iso.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : '');

// The mobile number and its country as ONE value: "🇮🇳 +91 98765 43210". The flag comes from the account's stored phone
// country (the country the person picked for the calling code), or else from the number itself when it belongs to a
// single country; the number and its calling code come from the stored E.164 number. Nothing when there is no mobile.
export function mobileOf(user) {
  if (!user.mobile) return { flag: '', number: '', text: '' };
  const parsed = parsePhoneNumberFromString(user.mobile);
  const number = parsed ? parsed.formatInternational() : user.mobile;
  const flag = flagOf(user.phoneCountry) || (parsed && parsed.country ? flagOf(parsed.country) : '');
  return { flag, number, text: flag ? `${flag} ${number}` : number };
}

// "03 Nov 2026", or nothing when the account has no (valid) creation date.
export function memberSinceOf(createdAt) {
  if (!createdAt || !Number.isFinite(new Date(createdAt).getTime())) return '';
  return formatDisplayDate(createdAt);
}

export function viewOf(user) {
  const firstName = clean(user.firstName);
  const lastName = clean(user.lastName);
  return {
    name: clean(user.name),
    firstName,
    lastName,
    // An account made with two name fields edits them as two; one made with a single name (older accounts,
    // Google/Apple) edits it as one. A single name is never split into two: that would be a guess.
    usesParts: !!(firstName || lastName),
    gender: GENDERS.includes(user.gender) ? user.gender : '',
    nationality: user.nationality || '',
    email: user.email || '',
    mobile: mobileOf(user),
    emailVerified: !!user.emailVerifiedAt,
    accountVerified: user.isVerified === true,
    memberSince: memberSinceOf(user.createdAt),
  };
}

export const formFrom = (view) => ({ firstName: view.firstName, lastName: view.lastName, fullName: view.name, gender: view.gender, nationality: view.nationality });

// The messages (as i18n keys) for what is wrong with the form, by field. An empty object means it can be saved.
export function validateForm(view, form) {
  const errors = {};
  if (view.usesParts) {
    if (!isValidNamePart(form.firstName)) errors.firstName = 'pd_err_first';
    if (!isValidNamePart(form.lastName)) errors.lastName = 'pd_err_last';
  } else if (!isValidName(form.fullName)) {
    errors.fullName = 'pd_err_full';
  }
  return errors;
}

// Only what changed, in the shape PATCH /auth/me takes: first and last name together (or the single name), the gender,
// the nationality. Empty when nothing changed. Mobile and email are never in it (they have their own verified flow).
export function buildPatch(view, form) {
  const patch = {};
  if (view.usesParts) {
    if (clean(form.firstName) !== view.firstName || clean(form.lastName) !== view.lastName) {
      patch.firstName = clean(form.firstName);
      patch.lastName = clean(form.lastName);
    }
  } else if (clean(form.fullName) !== view.name) {
    patch.name = clean(form.fullName);
  }
  if (form.gender && form.gender !== view.gender) patch.gender = form.gender;
  if (form.nationality && form.nationality !== view.nationality) patch.nationality = form.nationality;
  return patch;
}

// The rows of the Personal information card that have a value: nothing is shown for a detail that is not there, and
// the name is shown once (as first and last name, or as the full name when the account has no two parts).
export function personalRows(view) {
  const rows = [];
  if (view.usesParts) {
    if (view.firstName) rows.push({ key: 'firstName', labelKey: 'field_first_name', value: view.firstName });
    if (view.lastName) rows.push({ key: 'lastName', labelKey: 'field_last_name', value: view.lastName });
  } else if (view.name) {
    rows.push({ key: 'fullName', labelKey: 'field_full_name', value: view.name });
  }
  if (view.gender) rows.push({ key: 'gender', labelKey: 'field_gender', valueKey: `gender_${view.gender}` });
  if (view.nationality) rows.push({ key: 'nationality', labelKey: 'field_nationality', nationality: view.nationality });
  return rows;
}
