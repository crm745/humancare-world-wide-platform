// Pure: the Quotation's Final Amount and Currency as Bitrix24 holds them (UF_CRM_6A3399F56ECFF, UF_CRM_6A23F4E86AA45) -> what
// case_quotations may store. Nothing here reads a database or the network.
//
// The rules come from the table's own CHECKs: amount and currency are BOTH set or BOTH NULL; amount > 0, at most 11 integer digits and
// 3 decimals (DECIMAL(14,3)); currency three uppercase letters. On top of that an amount is NEVER ROUNDED: it must not have more
// decimals than its currency has (ISO 4217 exponent), except trailing zeros. Anything that does not meet all of this leaves
// amount and currency NULL, records a short validation code, and keeps the raw Bitrix text, so the quotation stays unconfirmed
// (the database refuses to confirm a row with a validation error or without a money pair) until Operations fix it in Bitrix.
const { exponentOf } = require('../payments/payment-money');

const AMOUNT_RAW_MAX = 64; // case_quotations.bitrix_amount_raw
const CURRENCY_RAW_MAX = 32; // case_quotations.bitrix_currency_raw
const AMOUNT_TEXT = /^(\d{1,11})(?:\.(\d{1,20}))?$/;
const CURRENCY_TEXT = /^[A-Z]{3}$/;

// A raw Bitrix value as trimmed text, or null when the field is empty / not provided.
function rawText(value, max) {
  if (value === undefined || value === null || value === false) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return `invalid:${typeof value}`.slice(0, max);
  const text = String(value).trim();
  return text === '' ? null : text.slice(0, max);
}

/** -> { amount: '1500.00' | null, currency: 'INR' | null, error: code | null, amountRaw, currencyRaw }
 * `amount` is exact decimal text with the currency's own number of decimals (e.g. "1500.00", JPY "1500", KWD "1500.000"). */
function parseQuotationMoney(rawAmount, rawCurrency) {
  const amountRaw = rawText(rawAmount, AMOUNT_RAW_MAX);
  const currencyRaw = rawText(rawCurrency, CURRENCY_RAW_MAX);
  const none = (error) => ({ amount: null, currency: null, error, amountRaw, currencyRaw });

  if (amountRaw === null && currencyRaw === null) return none('amount_missing');
  if (amountRaw === null) return none('amount_missing');
  if (currencyRaw === null) return none('currency_missing');

  const amountMatch = AMOUNT_TEXT.exec(amountRaw);
  if (!amountMatch) return none('amount_invalid');
  if (!CURRENCY_TEXT.test(currencyRaw)) return none('currency_invalid');
  const exponent = exponentOf(currencyRaw);
  if (exponent === null) return none('currency_unsupported');

  const whole = amountMatch[1].replace(/^0+(?=\d)/, '');
  const fraction = amountMatch[2] || '';
  const significant = fraction.replace(/0+$/, '');
  if (significant.length > exponent) return none('amount_precision');
  if (/^0+$/.test(whole) && significant === '') return none('amount_not_positive');
  const text = exponent === 0 ? whole : `${whole}.${significant.padEnd(exponent, '0')}`;
  return { amount: text, currency: currencyRaw, error: null, amountRaw, currencyRaw };
}

module.exports = { parseQuotationMoney, rawText, AMOUNT_RAW_MAX, CURRENCY_RAW_MAX };
