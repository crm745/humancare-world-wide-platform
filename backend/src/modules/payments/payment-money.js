// Exact money arithmetic for payments. Amounts are DECIMAL(14,3) in major units (invoices.amount); they are handled here as
// BigInt THOUSANDTHS (1250.500 -> 1250500n), never as JavaScript numbers, and NEVER rounded: a value the currency cannot hold is refused.
//
// Razorpay wants an integer in the currency's smallest unit (paise, cents...). The number of minor-unit digits is the ISO 4217
// exponent: 2 for INR/USD/EUR/GBP, 0 for JPY, 3 for KWD. Three fractional digits is the most the database stores.
//
// ORDER_CURRENCIES is the list HumanCare creates Razorpay orders in. It is deliberately limited to two-decimal currencies: Razorpay's
// rules for zero- and three-decimal currencies have not been verified, so those are refused until they are (the exponent table
// still knows them, so the arithmetic is correct once they are added).
const CURRENCY_EXPONENT = Object.freeze({
  INR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2, SGD: 2, AUD: 2, CAD: 2,
  JPY: 0, KRW: 0, VND: 0,
  BHD: 3, KWD: 3, OMR: 3,
});
const ORDER_CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD']);

const DB_DIGITS = 3;
const exponentOf = (currency) => (Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, currency) ? CURRENCY_EXPONENT[currency] : null);

// A decimal read from the database (a Prisma Decimal, or its string) as BigInt thousandths; null when it is not an exact decimal.
function toThousandths(value) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'object' && typeof value.toFixed === 'function' ? value.toFixed(DB_DIGITS) : String(value);
  const match = /^(-?)(\d{1,14})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) return null;
  const thousandths = BigInt(match[2]) * 1000n + BigInt((match[3] || '').padEnd(DB_DIGITS, '0') || '0');
  return match[1] ? -thousandths : thousandths;
}

// A client-supplied amount: a decimal STRING only (a JSON number is refused, so no float ever gets in), greater than zero, with no more
// fractional digits than the currency has. Returns BigInt thousandths, or null.
function parseRequestAmount(text, currency) {
  const exponent = exponentOf(currency);
  if (exponent === null || typeof text !== 'string') return null;
  const match = /^(0|[1-9]\d{0,10})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] || '';
  if (fraction.length > exponent) return null; // would need rounding: refused
  const thousandths = BigInt(match[1]) * 1000n + BigInt(fraction.padEnd(DB_DIGITS, '0') || '0');
  return thousandths > 0n ? thousandths : null;
}

// BigInt thousandths as the decimal text for a currency (INR: "250.00", JPY: "250", KWD: "1.250"), or null when it would need rounding.
function formatAmount(thousandths, currency) {
  const exponent = exponentOf(currency);
  if (exponent === null || typeof thousandths !== 'bigint' || thousandths < 0n) return null;
  const factor = 10n ** BigInt(DB_DIGITS - exponent);
  if (thousandths % factor !== 0n) return null;
  const minor = (thousandths / factor).toString().padStart(exponent + 1, '0');
  return exponent === 0 ? minor : `${minor.slice(0, -exponent)}.${minor.slice(-exponent)}`;
}

// BigInt thousandths as the integer smallest-unit amount Razorpay expects, or null when the currency is unknown, the amount would need
// rounding, or the number is not a safe integer. Never rounds.
function toMinorUnits(thousandths, currency) {
  const exponent = exponentOf(currency);
  if (exponent === null || typeof thousandths !== 'bigint' || thousandths <= 0n) return null;
  const factor = 10n ** BigInt(DB_DIGITS - exponent);
  if (thousandths % factor !== 0n) return null;
  const minor = thousandths / factor;
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

// Razorpay's integer smallest-unit amount back to BigInt thousandths (for comparing an order it returned), or null.
function fromMinorUnits(minor, currency) {
  const exponent = exponentOf(currency);
  if (exponent === null || !Number.isSafeInteger(minor) || minor < 0) return null;
  return BigInt(minor) * 10n ** BigInt(DB_DIGITS - exponent);
}

module.exports = { CURRENCY_EXPONENT, ORDER_CURRENCIES, exponentOf, toThousandths, parseRequestAmount, formatAmount, toMinorUnits, fromMinorUnits };
