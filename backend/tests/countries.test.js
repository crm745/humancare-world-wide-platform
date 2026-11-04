// The sign-up country list lives in two generated copies, one for the API and one for the app
// (see scripts/generate-countries.js). This fails when they differ, when the list stops matching
// the dial codes libphonenumber-js knows, or when its shape is wrong.
const fs = require('fs');
const path = require('path');
const { getCountries, getCountryCallingCode } = require('libphonenumber-js');
const { COUNTRIES } = require('../src/common/constants/countries');

const MOBILE_FILE = path.join(__dirname, '..', '..', 'apps', 'mobile', 'src', 'data', 'countryList.js');

function mobileCopy() {
  const text = fs.readFileSync(MOBILE_FILE, 'utf8');
  const match = text.match(/export const COUNTRIES = (\[[\s\S]*?\n\]);/);
  if (!match) throw new Error('countryList.js has no COUNTRIES array');
  // One JSON object per line with a trailing comma; make it a JSON array.
  return JSON.parse(match[1].replace(/,\s*\]$/, ']'));
}

describe('sign-up country list', () => {
  it('is identical in the API and the mobile app: run node scripts/generate-countries.js if this fails', () => {
    expect(mobileCopy()).toEqual(COUNTRIES);
  });

  it('has India first, then every other country A to Z by name', () => {
    expect(COUNTRIES[0]).toEqual({ code: 'IN', name: 'India', dial: '+91' });
    const rest = COUNTRIES.slice(1).map((c) => c.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('has a unique two-letter code, a name and a dial code for every entry', () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of COUNTRIES) {
      expect(c.code).toMatch(/^[A-Z]{2}$/);
      expect(c.name.length).toBeGreaterThan(1);
      expect(c.dial).toMatch(/^\+\d{1,4}$/);
    }
  });

  it('takes its dial codes from libphonenumber-js, not from memory', () => {
    const known = new Set(getCountries());
    for (const c of COUNTRIES) {
      expect(known.has(c.code)).toBe(true);
      expect(c.dial).toBe(`+${getCountryCallingCode(c.code)}`);
    }
    // Nearly every country libphonenumber knows is there (a few have no English name).
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(known.size - 6);
  });

  it('lists the countries that share a dial code separately', () => {
    const by = (code) => COUNTRIES.find((c) => c.code === code);
    expect([by('US').dial, by('CA').dial]).toEqual(['+1', '+1']);
    expect([by('RU').dial, by('KZ').dial]).toEqual(['+7', '+7']);
    expect(by('AE').dial).toBe('+971');
  });
});
