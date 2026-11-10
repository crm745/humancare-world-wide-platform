/* global describe, it, expect */
const {
  isValidName,
  isValidEmail,
  isValidPhone,
  isValidPhoneForCountry,
  isValidDateString,
  isValidAge,
} = require('../validators');

describe('isValidName', () => {
  it('accepts a real name', () => expect(isValidName('Rakesh Sharma')).toBe(true));
  it('rejects a name that is just digits', () => expect(isValidName('12345')).toBe(false));
  it('rejects an empty/whitespace name', () => expect(isValidName('   ')).toBe(false));
  it('rejects a single character', () => expect(isValidName('R')).toBe(false));
});

describe('isValidEmail', () => {
  it('accepts a normal email', () => expect(isValidEmail('a@b.com')).toBe(true));
  it('rejects a missing @', () => expect(isValidEmail('a-b.com')).toBe(false));
  it('rejects a missing domain', () => expect(isValidEmail('a@b')).toBe(false));
});

describe('isValidPhone (loose, no country context)', () => {
  it('accepts a 10-digit number', () => expect(isValidPhone('9876543210')).toBe(true));
  it('rejects a too-short number', () => expect(isValidPhone('12345')).toBe(false));
  it('rejects a too-long number', () => expect(isValidPhone('1'.repeat(20))).toBe(false));
});

describe('isValidPhoneForCountry', () => {
  it('requires exactly 10 digits for India (+91)', () => {
    expect(isValidPhoneForCountry('9876543210', '+91')).toBe(true);
    expect(isValidPhoneForCountry('98765432', '+91')).toBe(false);
  });
  it('requires exactly 9 digits for UAE (+971)', () => {
    expect(isValidPhoneForCountry('501234567', '+971')).toBe(true);
    expect(isValidPhoneForCountry('5012345678', '+971')).toBe(false);
  });
  it('requires exactly 8 digits for Oman (+968)', () => {
    expect(isValidPhoneForCountry('92402959', '+968')).toBe(true);
    expect(isValidPhoneForCountry('555555555555555', '+968')).toBe(false);
  });
  it('requires exactly 10 digits for Bangladesh (+880)', () => {
    expect(isValidPhoneForCountry('1314968067', '+880')).toBe(true);
    expect(isValidPhoneForCountry('13149680', '+880')).toBe(false);
  });
  it('falls back to the loose 7-15 digit range for a country with no exact rule', () => {
    expect(isValidPhoneForCountry('123456789012', '+998')).toBe(true);
    expect(isValidPhoneForCountry('12345', '+998')).toBe(false);
  });
});

describe('isValidDateString', () => {
  it('accepts YYYY-MM-DD', () => expect(isValidDateString('2026-09-25')).toBe(true));
  it('rejects a different format', () => expect(isValidDateString('25-09-2026')).toBe(false));
  it('rejects an invalid calendar date', () => expect(isValidDateString('2026-13-45')).toBe(false));
});

describe('isValidAge', () => {
  it('treats empty as valid (age is optional)', () => expect(isValidAge('')).toBe(true));
  it('accepts a normal age', () => expect(isValidAge('45')).toBe(true));
  it('rejects zero or negative', () => {
    expect(isValidAge('0')).toBe(false);
    expect(isValidAge('-5')).toBe(false);
  });
  it('rejects an unrealistic age', () => expect(isValidAge('200')).toBe(false));
  it('rejects a non-integer', () => expect(isValidAge('45.5')).toBe(false));
});

describe('isValidMobileNumber (libphonenumber, same as the backend)', () => {
  const { isValidMobileNumber } = require('../validators');
  it('accepts real numbers for each country', () => {
    expect(isValidMobileNumber('9876543210', '+91')).toBe(true);
    expect(isValidMobileNumber('501234567', '+971')).toBe(true);
    expect(isValidMobileNumber('92402959', '+968')).toBe(true);
  });
  it('allows a leading trunk 0', () => expect(isValidMobileNumber('09876543210', '+91')).toBe(true));
  it('rejects wrong lengths', () => {
    expect(isValidMobileNumber('98765432', '+91')).toBe(false);
    expect(isValidMobileNumber('5012345678', '+971')).toBe(false);
  });
  it('rejects empty input or a missing country code', () => {
    expect(isValidMobileNumber('', '+91')).toBe(false);
    expect(isValidMobileNumber('9876543210', '')).toBe(false);
  });
});

describe('passwordProblem', () => {
  const { passwordProblem } = require('../validators');
  it('accepts 8+ characters with a letter and a number', () => expect(passwordProblem('abcdefg1')).toBeNull());
  it('rejects fewer than 8 characters', () => expect(passwordProblem('abc123')).toMatch(/8 characters/));
  it('rejects a password with no number', () => expect(passwordProblem('abcdefghij')).toMatch(/letter and one number/));
  it('rejects a password with no letter', () => expect(passwordProblem('1234567890')).toMatch(/letter and one number/));
});

describe('isValidNamePart (first name, last name)', () => {
  const { isValidNamePart } = require('../validators');
  it.each(['Asha', 'Rao', 'Mary Ann', "O'Brien", 'Müller', 'आशा', 'K'])('accepts %s', (value) => expect(isValidNamePart(value)).toBe(true));
  it.each(['', '   ', '1234', '---', undefined])('refuses %p', (value) => expect(isValidNamePart(value)).toBe(false));
  it('refuses more than 50 characters, the same limit as the server', () => {
    expect(isValidNamePart('x'.repeat(50))).toBe(true);
    expect(isValidNamePart('x'.repeat(51))).toBe(false);
  });
});
