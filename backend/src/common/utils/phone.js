const { parsePhoneNumberFromString } = require('libphonenumber-js');

// Turns what the app sends (national number + calling code from the picker, or a full
// "+91..." string) into { e164, countryCode }, or null if it isn't a valid number for
// that country. libphonenumber drops the trunk prefix ("09876…" -> "9876…") by each
// country's own rules, which a blanket "strip leading zeros" would get wrong (Italy
// keeps its leading 0, for example).
function normalizeMobile(mobile, countryCode) {
  const raw = String(mobile || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const ccDigits = String(countryCode || '').replace(/\D/g, '');
  if (!raw.startsWith('+') && !ccDigits) return null;
  const parsed = parsePhoneNumberFromString(raw.startsWith('+') ? `+${digits}` : `+${ccDigits}${digits}`);
  if (!parsed || !parsed.isValid()) return null;
  return { e164: parsed.number, countryCode: `+${parsed.countryCallingCode}` };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// "+919876543210" -> "+91 •••••3210" for "code sent to" lines.
function maskMobile(e164) {
  const parsed = parsePhoneNumberFromString(e164 || '');
  if (!parsed) return '';
  return `+${parsed.countryCallingCode} •••••${parsed.nationalNumber.slice(-4)}`;
}

// "priya.sharma@gmail.com" -> "pr•••@gmail.com"
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 2)}•••@${domain}`;
}

function maskContact(identifier) {
  return identifier.includes('@') ? maskEmail(identifier) : maskMobile(identifier);
}

module.exports = { normalizeMobile, normalizeEmail, maskMobile, maskEmail, maskContact };
