/* global describe, it, expect */
const {
  INITIAL_PHONE_STATE, dialOf, nameOf, pickNationality, pickPhoneCountry, searchCountries,
} = require('../phoneCountry');
const { isValidMobileNumber } = require('../validators');

const codes = (list) => list.map((c) => c.code);

describe('searchCountries', () => {
  it('gives the whole list, India first, when nothing is typed', () => {
    const all = searchCountries('');
    expect(all[0].code).toBe('IN');
    expect(all.length).toBeGreaterThan(240);
    expect(searchCountries('   ')).toEqual(all);
  });

  it('finds a country by name, ignoring case and accents, names that start with it first', () => {
    expect(codes(searchCountries('india'))[0]).toBe('IN');
    expect(codes(searchCountries('ARAB'))).toContain('AE');
    expect(codes(searchCountries('cote'))).toContain('CI');
    const un = searchCountries('un');
    expect(un.findIndex((c) => c.name.startsWith('United'))).toBeLessThan(un.findIndex((c) => !c.name.toLowerCase().startsWith('un')));
  });

  it('finds a country by its two-letter code', () => {
    expect(codes(searchCountries('us'))[0]).toBe('US');
    expect(codes(searchCountries('AE'))[0]).toBe('AE');
  });

  it('finds countries by dial code, with or without the plus', () => {
    expect(codes(searchCountries('+971'))).toEqual(['AE']);
    expect(codes(searchCountries('971'))).toEqual(['AE']);
    expect(codes(searchCountries('91'))).toContain('IN');
  });

  it('returns every country that shares a dial code', () => {
    const plusOne = codes(searchCountries('+1'));
    expect(plusOne).toEqual(expect.arrayContaining(['US', 'CA']));
    expect(codes(searchCountries('+7'))).toEqual(expect.arrayContaining(['RU', 'KZ']));
  });

  it('gives nothing for something that is not a country', () => {
    expect(searchCountries('zzzzzz')).toEqual([]);
  });
});

describe('dialOf and nameOf', () => {
  it('look a country up by its code', () => {
    expect(dialOf('IN')).toBe('+91');
    expect(dialOf('AE')).toBe('+971');
    expect(dialOf('CA')).toBe('+1');
    expect(nameOf('US')).toBe('United States');
    expect(dialOf('ZZ')).toBe('');
  });
});

describe('phone code follows nationality', () => {
  it('starts on India with the code not yet edited', () => {
    expect(INITIAL_PHONE_STATE).toEqual({ nationality: '', phoneCountry: 'IN', codeEdited: false });
  });

  it('sets the phone country to the nationality: India -> +91, UAE -> +971', () => {
    let state = pickNationality(INITIAL_PHONE_STATE, 'AE');
    expect(state).toEqual({ nationality: 'AE', phoneCountry: 'AE', codeEdited: false });
    expect(dialOf(state.phoneCountry)).toBe('+971');
    state = pickNationality(state, 'IN');
    expect(dialOf(state.phoneCountry)).toBe('+91');
  });

  it('does not overwrite a code the person changed by hand', () => {
    let state = pickPhoneCountry(INITIAL_PHONE_STATE, 'AE'); // an Indian living in the UAE
    state = pickNationality(state, 'IN');
    expect(state).toEqual({ nationality: 'IN', phoneCountry: 'AE', codeEdited: true });
    state = pickNationality(state, 'GB');
    expect(state.phoneCountry).toBe('AE');
  });

  it('remembers which country shares a code, not just the code', () => {
    const canada = pickNationality(INITIAL_PHONE_STATE, 'CA');
    const us = pickNationality(INITIAL_PHONE_STATE, 'US');
    expect(dialOf(canada.phoneCountry)).toBe('+1');
    expect(dialOf(us.phoneCountry)).toBe('+1');
    expect([canada.phoneCountry, us.phoneCountry]).toEqual(['CA', 'US']);
  });

  it('only changes the code: the digits typed stay valid for the new country', () => {
    // 9876543210 is an Indian number; switching the code to +971 makes it invalid, and the form
    // says so instead of dropping the digits.
    expect(isValidMobileNumber('9876543210', dialOf('IN'))).toBe(true);
    expect(isValidMobileNumber('9876543210', dialOf('AE'))).toBe(false);
    expect(isValidMobileNumber('501234567', dialOf('AE'))).toBe(true);
    expect(isValidMobileNumber('2025550123', dialOf('US'))).toBe(true);
    expect(isValidMobileNumber('4165550123', dialOf('CA'))).toBe(true);
  });
});
