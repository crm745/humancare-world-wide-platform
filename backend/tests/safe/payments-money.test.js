/* global describe, test, expect */
// Exact money handling for payments: BigInt thousandths, ISO 4217 exponents, never a float, never a silent rounding.
const m = require('../../src/modules/payments/payment-money');

describe('toThousandths (database decimals)', () => {
  test('reads a database decimal exactly', () => {
    expect(m.toThousandths('1500.000')).toBe(1500000n);
    expect(m.toThousandths('0.001')).toBe(1n);
    expect(m.toThousandths('99999999999.999')).toBe(99999999999999n);
    expect(m.toThousandths('12')).toBe(12000n);
    expect(m.toThousandths({ toFixed: (d) => (1250.5).toFixed(d) })).toBe(1250500n); // a Prisma Decimal-like value
  });
  test('refuses anything that is not an exact decimal', () => {
    for (const bad of [null, undefined, '', 'abc', '1e3', '1.2345', '--1', '1,5']) expect(m.toThousandths(bad)).toBeNull();
  });
});

describe('parseRequestAmount (what a client may send)', () => {
  test('accepts a plain decimal string within the currency precision', () => {
    expect(m.parseRequestAmount('250.00', 'INR')).toBe(250000n);
    expect(m.parseRequestAmount('250', 'INR')).toBe(250000n);
    expect(m.parseRequestAmount('0.01', 'USD')).toBe(10n);
    expect(m.parseRequestAmount('250.5', 'EUR')).toBe(250500n);
  });
  test('refuses a JavaScript number: no floating-point amount ever gets in', () => {
    expect(m.parseRequestAmount(250, 'INR')).toBeNull();
    expect(m.parseRequestAmount(250.5, 'INR')).toBeNull();
  });
  test('refuses more fractional digits than the currency has (it would need rounding)', () => {
    expect(m.parseRequestAmount('250.005', 'INR')).toBeNull();
    expect(m.parseRequestAmount('250.001', 'USD')).toBeNull();
    expect(m.parseRequestAmount('250.5', 'JPY')).toBeNull();
    expect(m.parseRequestAmount('1.2345', 'KWD')).toBeNull();
    expect(m.parseRequestAmount('1.234', 'KWD')).toBe(1234n); // three decimals are fine for a three-decimal currency
  });
  test('refuses zero, negatives, exponents, signs, spaces, leading zeros and unknown currencies', () => {
    for (const bad of ['0', '0.00', '-5', '+5', '1e2', ' 5', '5 ', '05', '5.', '.5', '', 'abc', '1,000.00', '999999999999.00']) expect(m.parseRequestAmount(bad, 'INR')).toBeNull();
    expect(m.parseRequestAmount('5.00', 'XXX')).toBeNull();
  });
});

describe('toMinorUnits (the integer Razorpay expects)', () => {
  test('uses the ISO 4217 exponent of the currency', () => {
    expect(m.toMinorUnits(1500000n, 'INR')).toBe(150000); // paise
    expect(m.toMinorUnits(250500n, 'USD')).toBe(25050); // cents
    expect(m.toMinorUnits(1500000n, 'JPY')).toBe(1500); // no minor unit
    expect(m.toMinorUnits(1234n, 'KWD')).toBe(1234); // three digits
  });
  test('never rounds: an amount the currency cannot hold is refused', () => {
    expect(m.toMinorUnits(1500001n, 'INR')).toBeNull();
    expect(m.toMinorUnits(1500500n, 'JPY')).toBeNull();
  });
  test('refuses zero, negatives, unknown currencies and numbers beyond the safe integer range', () => {
    expect(m.toMinorUnits(0n, 'INR')).toBeNull();
    expect(m.toMinorUnits(-10n, 'INR')).toBeNull();
    expect(m.toMinorUnits(1000n, 'XXX')).toBeNull();
    expect(m.toMinorUnits(10n ** 20n, 'KWD')).toBeNull();
    expect(m.toMinorUnits('1500', 'INR')).toBeNull(); // only BigInt
  });
  test('exact where a float would not be (0.1 + 0.2 style)', () => {
    expect(m.toMinorUnits(m.toThousandths('19.990'), 'INR')).toBe(1999);
    expect(m.toMinorUnits(m.toThousandths('1.150'), 'USD')).toBe(115); // 1.15 * 100 is 114.99999999999999 as a float
  });
});

describe('formatAmount', () => {
  test('writes the amount with the currency digits and refuses to round', () => {
    expect(m.formatAmount(250000n, 'INR')).toBe('250.00');
    expect(m.formatAmount(250500n, 'USD')).toBe('250.50');
    expect(m.formatAmount(1500000n, 'JPY')).toBe('1500');
    expect(m.formatAmount(1234n, 'KWD')).toBe('1.234');
    expect(m.formatAmount(5n, 'INR')).toBeNull();
    expect(m.formatAmount(10n, 'INR')).toBe('0.01');
  });
});

describe('fromMinorUnits', () => {
  test('is the exact inverse for the currency', () => {
    expect(m.fromMinorUnits(150000, 'INR')).toBe(1500000n);
    expect(m.fromMinorUnits(1500, 'JPY')).toBe(1500000n);
    expect(m.fromMinorUnits(1.5, 'INR')).toBeNull();
    expect(m.fromMinorUnits(-1, 'INR')).toBeNull();
  });
});

describe('order currencies', () => {
  test('are limited to the two-decimal currencies whose Razorpay rules are known', () => {
    for (const c of ['INR', 'USD', 'EUR', 'GBP']) expect(m.ORDER_CURRENCIES.has(c)).toBe(true);
    for (const c of ['JPY', 'KWD', 'BHD', 'XXX']) expect(m.ORDER_CURRENCIES.has(c)).toBe(false);
  });
});
