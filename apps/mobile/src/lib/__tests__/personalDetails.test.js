/* global describe, test, expect */
const { viewOf, formFrom, validateForm, buildPatch, personalRows, mobileOf, memberSinceOf, flagOf } = require('../personalDetails');

const FLAG_IN = String.fromCodePoint(0x1f1ee, 0x1f1f3);
const FLAG_GB = String.fromCodePoint(0x1f1ec, 0x1f1e7);

const FULL = {
  id: 7, name: 'Asha Verma', firstName: 'Asha', lastName: 'Verma', email: 'asha@example.com', mobile: '+919876543210', countryCode: '+91',
  phoneCountry: 'IN', gender: 'female', nationality: 'IN', isVerified: true, emailVerifiedAt: '2026-11-01T10:00:00.000Z', createdAt: '2026-10-05T08:30:00.000Z', hasPassword: true,
};
const SINGLE = { id: 8, name: 'Ravi Kumar', firstName: null, lastName: null, email: 'ravi@example.com', mobile: null, gender: null, nationality: null, isVerified: true, emailVerifiedAt: null, createdAt: null, hasPassword: false };

describe('flagOf', () => {
  test('a flag from a two-letter country code, nothing for anything else', () => {
    expect(flagOf('IN')).toBe(FLAG_IN);
    expect(flagOf('gb')).toBe(FLAG_GB);
    for (const v of ['', 'X', 'IND', null, undefined, '12']) expect(flagOf(v)).toBe('');
  });
});

describe('mobileOf: the number and its country as ONE value', () => {
  test('flag, calling code and number together, from the stored phone country and E.164 number', () => {
    expect(mobileOf(FULL)).toEqual({ flag: FLAG_IN, number: '+91 98765 43210', text: `${FLAG_IN} +91 98765 43210` });
  });
  test('the flag follows the stored phone country, not a guess: a UK number picked as another +44 country keeps that country', () => {
    expect(mobileOf({ mobile: '+447700900123', phoneCountry: 'GG' }).flag).toBe(flagOf('GG'));
  });
  test('an account with no phone country takes the flag from a number that belongs to one country', () => {
    expect(mobileOf({ mobile: '+919876543210', phoneCountry: null }).flag).toBe(FLAG_IN);
  });
  test('no phone country and a shared calling code: no flag is invented, the number still shows', () => {
    const out = mobileOf({ mobile: '+12125550123', phoneCountry: null });
    expect(out.number).toMatch(/^\+1 /);
    expect(out.text.endsWith(out.number)).toBe(true);
  });
  test('a number that cannot be read is shown as stored; no mobile gives nothing', () => {
    expect(mobileOf({ mobile: 'not-a-number', phoneCountry: 'IN' }).number).toBe('not-a-number');
    expect(mobileOf({ mobile: null })).toEqual({ flag: '', number: '', text: '' });
  });
  test('there is no separate country or calling-code value to show', () => {
    expect(Object.keys(mobileOf(FULL)).sort()).toEqual(['flag', 'number', 'text']);
  });
});

describe('memberSinceOf', () => {
  test('a real date is formatted; a missing or invalid one gives nothing (never today\'s date)', () => {
    expect(memberSinceOf('2026-10-05T08:30:00.000Z')).toBe('05 Oct 2026');
    for (const v of [null, undefined, '', 'garbage']) expect(memberSinceOf(v)).toBe('');
  });
});

describe('viewOf (what the account looks like)', () => {
  test('a full account: name parts, gender, nationality, the mobile as one value, the flags as booleans, member since', () => {
    expect(viewOf(FULL)).toEqual({
      name: 'Asha Verma', firstName: 'Asha', lastName: 'Verma', usesParts: true, gender: 'female', nationality: 'IN',
      email: 'asha@example.com', mobile: { flag: FLAG_IN, number: '+91 98765 43210', text: `${FLAG_IN} +91 98765 43210` },
      emailVerified: true, accountVerified: true, memberSince: '05 Oct 2026',
    });
  });
  test('an older or social account: a single name, nothing invented for what is missing', () => {
    expect(viewOf(SINGLE)).toMatchObject({ name: 'Ravi Kumar', usesParts: false, firstName: '', lastName: '', gender: '', nationality: '', emailVerified: false, memberSince: '' });
    expect(viewOf(SINGLE).mobile.text).toBe('');
  });
  test('it carries no secret or internal field', () => {
    const keys = Object.keys(viewOf({ ...FULL, googleId: 'g', appleId: 'a', pushToken: 't', passwordHash: 'h', tokenVersion: 3 }));
    for (const forbidden of ['googleId', 'appleId', 'pushToken', 'passwordHash', 'tokenVersion', 'id']) expect(keys).not.toContain(forbidden);
  });
  test('a single name is never split into two', () => {
    const view = viewOf({ ...SINGLE, name: 'Ravi Kumar Singh' });
    expect(view.firstName).toBe('');
    expect(view.lastName).toBe('');
  });
  test('an unknown gender value is not shown; odd spacing is tidied', () => {
    expect(viewOf({ ...FULL, gender: 'attack-helicopter' }).gender).toBe('');
    expect(viewOf({ ...FULL, firstName: '  Asha   Rani ' }).firstName).toBe('Asha Rani');
  });
  test('the verification flags come only from the fields the account has', () => {
    expect(viewOf({ ...FULL, emailVerifiedAt: null }).emailVerified).toBe(false);
    expect(viewOf({ ...FULL, isVerified: false }).accountVerified).toBe(false);
    expect(viewOf({ ...FULL, isVerified: undefined }).accountVerified).toBe(false);
  });
});

describe('personalRows (only what exists, the name once)', () => {
  test('a full account: first, last, gender, nationality (no full name as well)', () => {
    expect(personalRows(viewOf(FULL)).map((r) => r.key)).toEqual(['firstName', 'lastName', 'gender', 'nationality']);
  });
  test('a single-name account with nothing else: only the full name', () => {
    expect(personalRows(viewOf(SINGLE)).map((r) => r.key)).toEqual(['fullName']);
  });
  test('first, last and full name are never all shown', () => {
    for (const user of [FULL, SINGLE, { ...FULL, lastName: null }]) {
      const keys = personalRows(viewOf(user)).map((r) => r.key);
      expect(keys.includes('fullName') && (keys.includes('firstName') || keys.includes('lastName'))).toBe(false);
    }
  });
  test('no empty rows', () => {
    expect(personalRows(viewOf({ ...FULL, gender: null, nationality: null })).map((r) => r.key)).toEqual(['firstName', 'lastName']);
  });
});

describe('validateForm', () => {
  const view = viewOf(FULL);
  test('first and last name must each be a real name of at most 50 characters', () => {
    const form = formFrom(view);
    expect(validateForm(view, form)).toEqual({});
    expect(validateForm(view, { ...form, firstName: '' })).toEqual({ firstName: 'pd_err_first' });
    expect(validateForm(view, { ...form, lastName: '12' })).toEqual({ lastName: 'pd_err_last' });
    expect(validateForm(view, { ...form, firstName: 'A'.repeat(51), lastName: '' })).toEqual({ firstName: 'pd_err_first', lastName: 'pd_err_last' });
  });
  test('a single-name account needs a valid full name', () => {
    const single = viewOf(SINGLE);
    const form = formFrom(single);
    expect(validateForm(single, form)).toEqual({});
    expect(validateForm(single, { ...form, fullName: 'A' })).toEqual({ fullName: 'pd_err_full' });
    expect(validateForm(single, { ...form, fullName: '   ' })).toEqual({ fullName: 'pd_err_full' });
  });
});

describe('buildPatch (only what changed, and never mobile, email or a flag)', () => {
  test('nothing changed: nothing to send', () => {
    expect(buildPatch(viewOf(FULL), formFrom(viewOf(FULL)))).toEqual({});
    expect(buildPatch(viewOf(SINGLE), formFrom(viewOf(SINGLE)))).toEqual({});
  });
  test('a changed first or last name sends both parts', () => {
    const view = viewOf(FULL);
    expect(buildPatch(view, { ...formFrom(view), firstName: ' Asha  Rani ' })).toEqual({ firstName: 'Asha Rani', lastName: 'Verma' });
    expect(buildPatch(view, { ...formFrom(view), lastName: 'Sharma' })).toEqual({ firstName: 'Asha', lastName: 'Sharma' });
  });
  test('a changed single name sends name', () => {
    const view = viewOf(SINGLE);
    expect(buildPatch(view, { ...formFrom(view), fullName: 'Ravi K Kumar' })).toEqual({ name: 'Ravi K Kumar' });
  });
  test('gender and nationality go only when they changed to something', () => {
    const view = viewOf(FULL);
    expect(buildPatch(view, { ...formFrom(view), gender: 'other', nationality: 'GB' })).toEqual({ gender: 'other', nationality: 'GB' });
    expect(buildPatch(view, { ...formFrom(view), gender: '', nationality: '' })).toEqual({});
    const blank = viewOf({ ...FULL, gender: null, nationality: null });
    expect(buildPatch(blank, { ...formFrom(blank), gender: 'male' })).toEqual({ gender: 'male' });
  });
  test('the patch can only ever hold name, firstName, lastName, gender and nationality', () => {
    const view = viewOf(FULL);
    const form = { ...formFrom(view), firstName: 'X', lastName: 'Y', gender: 'other', nationality: 'GB', email: 'evil@x.com', mobile: '+1', isVerified: false, emailVerifiedAt: null };
    const keys = Object.keys(buildPatch(view, form));
    expect(keys.every((k) => ['name', 'firstName', 'lastName', 'gender', 'nationality'].includes(k))).toBe(true);
  });
});
