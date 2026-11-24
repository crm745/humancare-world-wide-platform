// The rows of the login country-code dropdown (components/CountryCodeDropdown.js): one per dial code of the app's own list (COUNTRY_CODES, CALLING_CODE_COUNTRY in data/mock.js), shown as the ISO
// code and the dial code ("IN +91", "US +1", "GB +44"). Pure: no React, no native modules. The value the screen stores is still the dial code ("+91").

// { code: '+91', iso: 'IN' } for every dial code, in the list's own order (India, UAE, UK, US first). A code with no country keeps an empty iso and shows the dial code alone.
export function codeRows(codes, isoOf) {
  return codes.map((code) => ({ code, iso: isoOf[code] || '' }));
}

// "IN +91" (or "+91" when there is no country).
export const rowText = (row) => `${row.iso} ${row.code}`.trim();
