// The sizes of My Requests, in one place. Pure (no React, no native modules), so they can be unit-tested.
//
// The design (docs/my-requests-design.png) is drawn 470 wide. At 470 and wider every value below is the design's own.
// On a narrower screen everything, the text included, shrinks in proportion to the width (so the screen looks like
// the design, only smaller) down to 80%, and no further: below about 376 wide it stops shrinking and the content
// reflows instead. The sizes follow the screen width, not the system text size: large system text still enlarges the
// text on top of this, as it should.
export const DESIGN_WIDTH = 470;
export const MIN_SCALE = 0.8;
export const TOUCH_TARGET = 44;

export const scaleFor = (screenWidth) => {
  const width = Number.isFinite(screenWidth) && screenWidth > 0 ? screenWidth : DESIGN_WIDTH;
  return Math.min(1, Math.max(MIN_SCALE, width / DESIGN_WIDTH));
};

// A design value at this scale, to the nearest half point (so lines stay crisp).
export const scaled = (value, scale) => Math.round(value * scale * 2) / 2;

// A tappable thing is never smaller than 44.
const touch = (value, scale) => Math.max(TOUCH_TARGET, scaled(value, scale));

// The header: its rows, back button, search, filter button and chips.
export function headerSpec(scale) {
  const px = (v) => scaled(v, scale);
  return {
    padTop: px(20), padSide: px(23), padBottom: px(14), gap: px(16),
    back: touch(52, scale), backRadius: px(14), chevron: px(22), titleGap: px(14), titleSize: px(20), titleLine: px(26),
    rowGap: px(10),
    searchHeight: touch(50, scale), searchRadius: px(14), searchPadX: px(14), searchGap: px(10), searchIcon: px(20), searchFont: px(15),
    filter: touch(50, scale), filterIcon: px(20),
    chipsGap: px(8), chipHeight: px(38), chipPadLeft: px(14), chipPadRight: px(8), chipFont: px(14), chipGap: px(8),
    bubbleMin: px(22), bubblePadY: px(2), bubblePadX: px(6), bubbleFont: px(12),
    // the chip is 38 tall in the design; a smaller chip gets a bigger touch area instead of a bigger look
    chipHitSlop: Math.max(0, Math.ceil((TOUCH_TARGET - px(38)) / 2)),
  };
}

// The list and its cards.
export function cardSpec(scale) {
  const px = (v) => scaled(v, scale);
  return {
    listPadTop: px(16), listPadSide: px(23), listPadBottom: px(24), listGap: px(12),
    radius: px(18), padTop: px(16), padSide: px(16), padBottom: px(4), gap: px(12),
    tile: px(46), tileRadius: px(14), icon: px(22),
    nameSize: px(16), nameLine: px(22), subSize: px(13), subLine: px(18),
    badgePadY: px(5), badgePadX: px(10), badgeSize: px(11.5), badgeLine: px(14), badgeSpacing: px(11.5) * 0.05,
    routeGap: px(8), routeSize: px(14), routeLine: px(20), pin: px(16), arrow: px(14),
    progressPad: px(12), progressGap: px(6), segGap: px(4), segHeight: px(6), segRadius: px(3),
    stepSize: px(13), stepLine: px(18), detailsSize: px(14.5), detailsChevron: px(16), detailsGap: px(2),
    detailsMinHeight: TOUCH_TARGET, // the "View details" row stays 44 tall
    emptyTitle: px(14), emptySub: px(12.5), noMatch: px(15),
  };
}

// On a narrow screen, or with large system text, the column beside the badge gets too narrow for a word like
// "Ambulance" and the name would break in the middle. Then the badge goes under the date instead of beside the name.
// The room needed is the part of the row that does not depend on the text size (the tile, the gaps, the padding) plus
// the badge and the longest word, which grow with the system text size.
export function badgeBelowFor(screenWidth, fontScale = 1) {
  const scale = scaleFor(screenWidth);
  const text = Math.max(1, Number.isFinite(fontScale) && fontScale ? fontScale : 1);
  const width = Number.isFinite(screenWidth) && screenWidth > 0 ? screenWidth : DESIGN_WIDTH;
  const fixed = 148 * scale + 2; // tile 46, gaps 24, padding 32, side margins 46, borders
  const textual = 190 * scale * text; // the badge (about 105) and the longest word (about 85)
  return width < fixed + textual;
}
