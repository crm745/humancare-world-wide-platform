/* global describe, test, expect */
const { formatMoney } = require('../money');

describe('formatMoney', () => {
  test('known currencies get their symbol and thousands grouping', () => {
    expect(formatMoney('1500.00', 'INR')).toBe('₹1,500.00');
    expect(formatMoney('250', 'JPY')).toBe('¥250');
    expect(formatMoney('1234567.89', 'USD')).toBe('$1,234,567.89');
  });
  test('a currency with no known symbol falls back to its ISO code', () => {
    expect(formatMoney('100.00', 'XYZ')).toBe('XYZ\u00A0100.00');
  });
  test('a zero amount is still shown, not treated as missing', () => {
    expect(formatMoney('0.00', 'INR')).toBe('₹0.00');
  });
  test('never reparses the exact decimal text as a float (no rounding)', () => {
    expect(formatMoney('1250.001', 'INR')).toBe('₹1,250.001');
  });
  test('a value that is not a plain decimal string is returned as-is', () => {
    expect(formatMoney('', 'INR')).toBe('');
    expect(formatMoney(undefined, 'INR')).toBe('');
    expect(formatMoney('not-a-number', 'INR')).toBe('not-a-number');
  });
  test('a negative amount keeps its sign before the symbol', () => {
    expect(formatMoney('-50.00', 'INR')).toBe('-₹50.00');
  });
});
