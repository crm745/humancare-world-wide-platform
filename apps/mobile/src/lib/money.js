// Display-only money formatting. The backend (payments/payment-money.js) is the only place that does money
// ARITHMETIC, and it always sends amounts as exact decimal strings (e.g. "1500.00", "250", never a number) —
// this never reparses them as a float, it only adds a currency symbol and groups the integer part with commas.

const CURRENCY_SYMBOLS = {
  INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'AED\u00A0', SGD: 'S$', AUD: 'A$', CAD: 'C$',
  JPY: '¥', KRW: '₩', VND: '₫', BHD: 'BHD\u00A0', KWD: 'KWD\u00A0', OMR: 'OMR\u00A0',
};

// "1500" -> "1,500" (never touches the fractional part).
const grouped = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * `amountText` is the backend's exact decimal string for `currency`. Returns e.g. "₹1,500.00"; a currency with no
 * known symbol falls back to its ISO code ("AED 100.00"). An amount that isn't a plain decimal string (missing,
 * not text, not digits) is returned as-is, so nothing is ever silently hidden from the screen.
 */
export function formatMoney(amountText, currency) {
  if (typeof amountText !== 'string') return '';
  const match = /^(-?)(\d+)(\.(\d+))?$/.exec(amountText.trim());
  if (!match) return amountText;
  const [, sign, intPart, , fraction] = match;
  const symbol = CURRENCY_SYMBOLS[currency] || (currency ? `${currency}\u00A0` : '');
  return `${sign}${symbol}${grouped(intPart)}${fraction ? `.${fraction}` : ''}`;
}
