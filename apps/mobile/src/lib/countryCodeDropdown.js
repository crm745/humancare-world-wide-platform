// The rows of the login country-code dropdown (components/CountryCodeDropdown.js): one per dial code of the app's own list (COUNTRY_CODES, CALLING_CODE_COUNTRY in data/mock.js), shown as the ISO
// code and the dial code ("IN +91", "US +1", "GB +44"). Pure: no React, no native modules. The value the screen stores is still the dial code ("+91").

// { code: '+91', iso: 'IN' } for every dial code, in the list's own order (India, UAE, UK, US first). A code with no country keeps an empty iso and shows the dial code alone.
export function codeRows(codes, isoOf) {
  return codes.map((code) => ({ code, iso: isoOf[code] || '' }));
}

// "IN +91" (or "+91" when there is no country).
export const rowText = (row) => `${row.iso} ${row.code}`.trim();

// Where the list opens and how tall it may be, from the room on screen. `below` and `above` are the free pixels under and over the field (the keyboard, the screen edge and a margin already taken off),
// `max` is the tallest the list ever gets, `min` the height under which a side is "not enough" (about four rows). Opens DOWN when there is enough room below; otherwise UP when that side has more.
// The height is the room of the side it opens on (never more than `max`, never less than `floor`), and the list scrolls inside it when every code does not fit.
export function listPlacement({ below, above, max = 360, min = 176, floor = 88 }) {
  const room = (v) => (Number.isFinite(v) ? Math.max(0, v) : 0);
  const b = room(below);
  const a = room(above);
  const up = b < min && a > b;
  const side = up ? a : b;
  return { up, maxHeight: Math.max(floor, Math.min(max, Math.floor(side))) };
}

// Whether two measurements of the field row (and the page's host point) are the same place, to the pixel: the layout has stopped moving (the keyboard has finished closing, the page has finished scrolling).
export const sameSpot = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.h === b.h && a.winY === b.winY;

// The most frames the list waits for the layout to settle after the keyboard hides. A bound, not a delay: it is normally left after one or two frames, as soon as two measurements in a row agree.
export const MAX_SETTLE_FRAMES = 40;
