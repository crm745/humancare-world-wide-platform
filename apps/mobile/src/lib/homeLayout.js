// How Home lays out its service tiles. Pure (no React, no native modules), so it can be unit-tested.
//
// ALWAYS three columns, whatever the screen width: the eight services and the "More" tile make three full rows of three.
// Three columns leave every tile wide enough at any phone width, so the padding (Home's own 18) and the gap (8) are the
// same everywhere, and a name that is too long for one line wraps onto the next (up to three lines). The name's size is
// the largest of 10.5, 10 and 9.5 at which the longest single word ("Teleconsultation") still fits the tile: it is never
// scaled down further than 9.5.
export const COLUMNS = 3;
export const HOME_SIDE_PADDING = 18; // Home's own horizontal padding (header, banner, cards)
export const HOME_MAX_WIDTH = 720; // Home's content column
export const LABEL_SIZES = [10.5, 10, 9.5];
// The width of "Teleconsultation", the longest word among the names, in ems (Inter Medium, the font the names use on
// every platform), and the room left beyond it.
export const LONGEST_WORD_EM = 7.9;
export const WORD_MARGIN = 1.5;

// The grid for a screen of this width.
//   pad    the space left and right of the tiles (Home's own 18)
//   gap    the space between two tiles
//   bleed  how far the grid reaches into Home's own padding (18 - pad), as a negative margin
//   cell   the width of one tile
export function gridFor(screenWidth) {
  const width = Number.isFinite(screenWidth) && screenWidth > 0 ? screenWidth : 390;
  const content = Math.min(width, HOME_MAX_WIDTH);
  const pad = HOME_SIDE_PADDING;
  const gap = 8;
  const cell = (content - 2 * pad - gap * (COLUMNS - 1)) / COLUMNS;
  const labelSize = LABEL_SIZES.find((size) => LONGEST_WORD_EM * size + WORD_MARGIN <= cell) || LABEL_SIZES[LABEL_SIZES.length - 1];
  return { columns: COLUMNS, pad, gap, bleed: HOME_SIDE_PADDING - pad, cell, labelSize, lineHeight: Math.round(labelSize * 1.35) };
}
