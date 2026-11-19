/* global describe, test, expect */
// Pure rules: the quotation's money, the deterministic fingerprint and the versioning decision. No database, no network.
const { parseQuotationMoney, rawText } = require('../../src/modules/bitrix/quotation-money');
const { contentFingerprint, decideVersion } = require('../../src/modules/bitrix/quotation-versioning');

const PDF = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('parseQuotationMoney', () => {
  test.each([
    ['1500', 'INR', '1500.00'], ['1500.00', 'INR', '1500.00'], ['1500.5', 'USD', '1500.50'], ['0001500.250', 'EUR', '1500.25'],
    ['1500', 'JPY', '1500'], ['1500.000', 'JPY', '1500'], ['2.125', 'KWD', '2.125'], ['1500.0000', 'INR', '1500.00'], [1500.5, 'GBP', '1500.50'],
  ])('%s %s is stored exactly as %s', (amount, currency, expected) => {
    expect(parseQuotationMoney(amount, currency)).toMatchObject({ amount: expected, currency, error: null });
  });

  test('missing amount and/or currency leaves BOTH null with a code, and keeps the raw text (never one without the other)', () => {
    expect(parseQuotationMoney(undefined, '')).toMatchObject({ amount: null, currency: null, error: 'amount_missing', amountRaw: null, currencyRaw: null });
    expect(parseQuotationMoney('', 'INR')).toMatchObject({ amount: null, currency: null, error: 'amount_missing', currencyRaw: 'INR' });
    expect(parseQuotationMoney('1500', '')).toMatchObject({ amount: null, currency: null, error: 'currency_missing', amountRaw: '1500' });
    expect(parseQuotationMoney('1500', null)).toMatchObject({ amount: null, currency: null, error: 'currency_missing' });
  });

  test.each([
    ['abc', 'INR', 'amount_invalid'], ['-5', 'INR', 'amount_invalid'], ['1,500', 'INR', 'amount_invalid'], ['1e3', 'INR', 'amount_invalid'], ['123456789012', 'INR', 'amount_invalid'],
    ['0', 'INR', 'amount_not_positive'], ['0.00', 'INR', 'amount_not_positive'],
    ['10.001', 'INR', 'amount_precision'], ['10.5', 'JPY', 'amount_precision'], ['1.0001', 'KWD', 'amount_precision'],
    ['100', 'inr', 'currency_invalid'], ['100', 'RS', 'currency_invalid'], ['100', '5830', 'currency_invalid'], ['100', 'XYZ', 'currency_unsupported'],
  ])('%s %s is refused as %s and is never rounded', (amount, currency, error) => {
    expect(parseQuotationMoney(amount, currency)).toMatchObject({ amount: null, currency: null, error });
  });

  test('raw values are trimmed and capped to the column widths', () => {
    expect(rawText('  12  ', 64)).toBe('12');
    expect(rawText('x'.repeat(200), 64)).toHaveLength(64);
    expect(rawText({}, 64)).toBe('invalid:object');
    expect(parseQuotationMoney('9'.repeat(100), 'INR').amountRaw).toHaveLength(64);
  });
});

describe('contentFingerprint', () => {
  const money = { amount: '1500.00', currency: 'INR' };
  test('is deterministic, 64 lowercase hex', () => {
    const a = contentFingerprint({ pdfSha256: PDF, ...money });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(contentFingerprint({ pdfSha256: PDF, ...money })).toBe(a);
  });
  test('any change to the PDF, the amount or the currency changes it', () => {
    const a = contentFingerprint({ pdfSha256: PDF, ...money });
    expect(contentFingerprint({ pdfSha256: OTHER, ...money })).not.toBe(a);
    expect(contentFingerprint({ pdfSha256: PDF, amount: '1500.01', currency: 'INR' })).not.toBe(a);
    expect(contentFingerprint({ pdfSha256: PDF, amount: '1500.00', currency: 'USD' })).not.toBe(a);
  });
  test('an invalid or missing money pair hashes the RAW text, so editing it is still a change', () => {
    const none = contentFingerprint({ pdfSha256: PDF, amount: null, currency: null, amountRaw: null, currencyRaw: null });
    const a = contentFingerprint({ pdfSha256: PDF, amount: null, currency: null, amountRaw: '10.001', currencyRaw: 'INR' });
    const b = contentFingerprint({ pdfSha256: PDF, amount: null, currency: null, amountRaw: '10.002', currencyRaw: 'INR' });
    expect(a).not.toBe(none);
    expect(a).not.toBe(b);
    expect(none).not.toBe(contentFingerprint({ pdfSha256: PDF, ...money }));
  });
  test('refuses anything that is not a 64-hex PDF hash', () => {
    expect(() => contentFingerprint({ pdfSha256: 'abc', ...money })).toThrow();
    expect(() => contentFingerprint({ pdfSha256: PDF.toUpperCase(), ...money })).toThrow();
  });
});

describe('decideVersion (the approved versioning rules)', () => {
  const fp = 'f'.repeat(64);
  const other = 'e'.repeat(64);
  const head = (status, over = {}) => ({ status, versionNumber: 3, contentFingerprint: fp, ...over });

  test('first upload creates draft version 1', () => expect(decideVersion(null, fp)).toEqual({ action: 'create', versionNumber: 1 }));
  test.each(['draft', 'confirmed', 'published', 'accepted', 'rejected', 'withdrawn', 'superseded'])('identical content on a %s head creates nothing', (status) => {
    expect(decideVersion(head(status), fp)).toEqual({ action: 'unchanged' });
  });
  test.each(['draft', 'confirmed'])('changed content on an unpublished %s head updates that same version', (status) => {
    expect(decideVersion(head(status), other)).toEqual({ action: 'update_working', versionNumber: 3 });
  });
  test.each(['published', 'accepted', 'rejected', 'withdrawn', 'superseded'])('changed content on a %s head creates version 4 and never edits the head', (status) => {
    expect(decideVersion(head(status), other)).toEqual({ action: 'create', versionNumber: 4 });
  });
});
