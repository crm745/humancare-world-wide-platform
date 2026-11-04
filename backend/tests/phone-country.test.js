// resolvePhoneCountry (src/common/utils/signup-profile.js): checks the country picked for a phone's
// calling code against the number, and works out the phone country to store. Pure: no database.
const { resolvePhoneCountry } = require('../src/common/utils/signup-profile');

const MISMATCH = { ok: false, error: 'phone_country_mismatch' };
const INVALID = { ok: false, error: 'invalid_phone' };

// Numbers libphonenumber's bundled metadata files under one country each.
const IN = '+918691938888';
const AE = '+971501234567';
const US = '+12125550123';
const CA = '+14165550123';
const PR = '+17875550123';
const BS = '+12425550123';
const RU = '+79123456789';
const KZ = '+77011234567';
const GB = '+442071234567';
const GG_FILED = '+447911123456'; // an ordinary UK mobile range that libphonenumber files under GG

// Every number above is fixed (none is random), and each must really be valid, or the cases below prove nothing.
describe('test numbers', () => {
  it.each([IN, AE, US, CA, PR, BS, RU, KZ, GB, GG_FILED])('%s is a valid number', (number) => {
    const { parsePhoneNumberFromString } = require('libphonenumber-js');
    expect(parsePhoneNumberFromString(number).isValid()).toBe(true);
  });
});

describe('resolvePhoneCountry: a country was picked', () => {
  it.each([
    ['India', IN, 'IN'],
    ['the UAE', AE, 'AE'],
    ['the US', US, 'US'],
    ['Canada', CA, 'CA'],
    ['Puerto Rico', PR, 'PR'],
    ['the Bahamas', BS, 'BS'],
    ['Russia', RU, 'RU'],
    ['Kazakhstan', KZ, 'KZ'],
  ])('keeps %s when the number belongs to it', (_name, number, country) => {
    expect(resolvePhoneCountry(number, country)).toEqual({ ok: true, phoneCountry: country });
  });

  it.each([
    ['US picked, Canadian number', CA, 'US'],
    ['Canada picked, US number', US, 'CA'],
    ['US picked, Puerto Rican number', PR, 'US'],
    ['US picked, Bahamian number', BS, 'US'],
    ['Russia picked, Kazakh number', KZ, 'RU'],
    ['Kazakhstan picked, Russian number', RU, 'KZ'],
  ])('refuses a country that does not own the number: %s', (_name, number, country) => {
    expect(resolvePhoneCountry(number, country)).toEqual(MISMATCH);
  });

  it('refuses a country with a different calling code', () => {
    expect(resolvePhoneCountry(AE, 'IN')).toEqual(MISMATCH);
    expect(resolvePhoneCountry(US, 'RU')).toEqual(MISMATCH);
    expect(resolvePhoneCountry(IN, 'GB')).toEqual(MISMATCH);
  });

  it.each(['GB', 'GG', 'JE', 'IM'])('treats GB, GG, JE and IM as one group for +44: %s', (country) => {
    for (const number of [GB, GG_FILED]) {
      expect(resolvePhoneCountry(number, country)).toEqual({ ok: true, phoneCountry: country });
    }
  });

  it('still refuses a non-+44 country for a +44 number', () => {
    expect(resolvePhoneCountry(GG_FILED, 'IE')).toEqual(MISMATCH);
  });

  it('accepts any country of a shared code that the number cannot decide (+61)', () => {
    expect(resolvePhoneCountry('+61412345678', 'AU')).toEqual({ ok: true, phoneCountry: 'AU' });
    expect(resolvePhoneCountry('+61412345678', 'CX')).toEqual({ ok: true, phoneCountry: 'CX' });
  });
});

describe('resolvePhoneCountry: no country picked (older apps)', () => {
  it.each([
    ['India', IN, 'IN'],
    ['the UAE', AE, 'AE'],
  ])('infers the one country that uses an unshared calling code: %s', (_name, number, country) => {
    expect(resolvePhoneCountry(number, undefined)).toEqual({ ok: true, phoneCountry: country });
  });

  it.each([
    ['the US', US, 'US'],
    ['Canada', CA, 'CA'],
    ['Puerto Rico', PR, 'PR'],
    ['the Bahamas', BS, 'BS'],
    ['Russia', RU, 'RU'],
    ['Kazakhstan', KZ, 'KZ'],
  ])('infers the owner of a shared code when the number decides it: %s', (_name, number, country) => {
    expect(resolvePhoneCountry(number, undefined)).toEqual({ ok: true, phoneCountry: country });
    expect(resolvePhoneCountry(number, null)).toEqual({ ok: true, phoneCountry: country });
    expect(resolvePhoneCountry(number, '')).toEqual({ ok: true, phoneCountry: country });
  });

  it('does not guess for +44: libphonenumber cannot tell a UK number from a Guernsey one', () => {
    expect(resolvePhoneCountry(GB, undefined)).toEqual({ ok: true, phoneCountry: null });
    expect(resolvePhoneCountry(GG_FILED, undefined)).toEqual({ ok: true, phoneCountry: null });
  });

  it('does not guess for other shared codes the number cannot decide (+61, +358)', () => {
    expect(resolvePhoneCountry('+61412345678', undefined)).toEqual({ ok: true, phoneCountry: null });
    expect(resolvePhoneCountry('+358401234567', undefined)).toEqual({ ok: true, phoneCountry: null });
  });

  it('gives none for a valid number that belongs to no country (non-geographic +800)', () => {
    expect(resolvePhoneCountry('+80012345678', undefined)).toEqual({ ok: true, phoneCountry: null });
    expect(resolvePhoneCountry('+80012345678', 'IN')).toEqual(MISMATCH);
  });
});

describe('resolvePhoneCountry: numbers it cannot use', () => {
  it.each([
    ['too short', '+12125550'],
    ['a +44 number that is too short', '+4479111234'],
    ['not a number', 'not-a-number'],
    ['not E.164', '9876543210'],
    ['empty', ''],
    ['missing', undefined],
  ])('rejects %s', (_label, number) => {
    expect(resolvePhoneCountry(number, 'IN')).toEqual(INVALID);
    expect(resolvePhoneCountry(number, undefined)).toEqual(INVALID);
  });
});

describe('resolvePhoneCountry: a number valid for several countries of a shared code', () => {
  // None exist in libphonenumber's data for +1 and +7 today, so make every country claim the number.
  const withEveryRegionValid = () => {
    let resolver;
    jest.isolateModules(() => {
      jest.doMock('libphonenumber-js', () => ({ ...jest.requireActual('libphonenumber-js'), isValidNumberForRegion: () => true }));
      resolver = require('../src/common/utils/signup-profile').resolvePhoneCountry;
    });
    jest.dontMock('libphonenumber-js');
    return resolver;
  };

  it('keeps the picked country but does not guess one for an older app', () => {
    const resolve = withEveryRegionValid();
    expect(resolve(US, 'CA')).toEqual({ ok: true, phoneCountry: 'CA' });
    expect(resolve(US, undefined)).toEqual({ ok: true, phoneCountry: null });
  });
});

describe('resolvePhoneCountry: the number is valid but no country of the code claims it', () => {
  it('keeps the picked country (it cannot be disproved) and gives none to an older app', () => {
    let resolve;
    jest.isolateModules(() => {
      jest.doMock('libphonenumber-js', () => ({ ...jest.requireActual('libphonenumber-js'), isValidNumberForRegion: () => false }));
      resolve = require('../src/common/utils/signup-profile').resolvePhoneCountry;
    });
    jest.dontMock('libphonenumber-js');
    expect(resolve(US, 'US')).toEqual({ ok: true, phoneCountry: 'US' });
    expect(resolve(US, undefined)).toEqual({ ok: true, phoneCountry: null });
  });
});
