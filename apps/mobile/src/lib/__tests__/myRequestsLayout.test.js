/* global describe, test, expect */
// The sizes of My Requests: at the design's width (470 and wider) every value is the design's own, exactly; on a narrower
// screen everything shrinks in proportion, never below 80%, and a tappable thing is never smaller than 44.
const { DESIGN_WIDTH, MIN_SCALE, TOUCH_TARGET, scaleFor, scaled, headerSpec, cardSpec, badgeBelowFor } = require('../myRequestsLayout');

describe('the scale follows the screen width', () => {
  test('1 at the design width and wider; proportional below it', () => {
    expect(DESIGN_WIDTH).toBe(470);
    for (const w of [470, 500, 600, 720, 1200]) expect(scaleFor(w)).toBe(1);
    expect(scaleFor(423)).toBeCloseTo(0.9, 5);
    expect(scaleFor(412)).toBeCloseTo(412 / 470, 5);
    expect(scaleFor(390)).toBeCloseTo(390 / 470, 5);
    expect(scaleFor(378)).toBeCloseTo(378 / 470, 5);
  });
  test('never below 80%, so nothing becomes unreadably small (320 and 360 are 0.8)', () => {
    expect(MIN_SCALE).toBe(0.8);
    for (const w of [100, 280, 320, 360, 376]) expect(scaleFor(w)).toBe(0.8);
  });
  test('it never grows as the screen narrows', () => {
    let last = Infinity;
    for (let w = 1000; w >= 200; w -= 5) { const s = scaleFor(w); expect(s).toBeLessThanOrEqual(last); last = s; }
  });
  test('an odd width is the design\'s own size', () => {
    for (const w of [undefined, null, NaN, 0, -3]) expect(scaleFor(w)).toBe(1);
  });
  test('a value is scaled to the nearest half point', () => {
    expect(scaled(16, 0.8)).toBe(13);
    expect(scaled(13, 0.8)).toBe(10.5);
    expect(scaled(11.5, 0.8)).toBe(9);
    expect(scaled(14.5, 1)).toBe(14.5);
    expect(scaled(22, 0.8)).toBe(17.5);
  });
});

describe('at the design width every value is the design\'s own', () => {
  const H = headerSpec(1);
  const C = cardSpec(1);
  test('header: padding 20 / 23 / 14, a 16 gap between rows', () => {
    expect([H.padTop, H.padSide, H.padBottom, H.gap]).toEqual([20, 23, 14, 16]);
  });
  test('back button 52 square, radius 14, chevron 22, a 14 gap, title 20 / 26', () => {
    expect([H.back, H.backRadius, H.chevron, H.titleGap, H.titleSize, H.titleLine]).toEqual([52, 14, 22, 14, 20, 26]);
  });
  test('search: height 50, radius 14, padding 0 14, a 10 gap, icon 20, text 15; filter button 50 square with a 20 icon; a 10 gap between them', () => {
    expect([H.searchHeight, H.searchRadius, H.searchPadX, H.searchGap, H.searchIcon, H.searchFont]).toEqual([50, 14, 14, 10, 20, 15]);
    expect([H.filter, H.filterIcon, H.rowGap]).toEqual([50, 20, 10]);
  });
  test('chips: height 38, padding 0 8 0 14, text 14, an 8 gap inside and between, a bubble of min width 22, padding 2 6, text 12', () => {
    expect([H.chipHeight, H.chipPadLeft, H.chipPadRight, H.chipFont, H.chipGap, H.chipsGap]).toEqual([38, 14, 8, 14, 8, 8]);
    expect([H.bubbleMin, H.bubblePadY, H.bubblePadX, H.bubbleFont]).toEqual([22, 2, 6, 12]);
  });
  test('list: padding 16 top / 23 sides / 24 bottom, a 12 gap between cards', () => {
    expect([C.listPadTop, C.listPadSide, C.listPadBottom, C.listGap]).toEqual([16, 23, 24, 12]);
  });
  test('card: radius 18, padding 16 16 4, a 12 gap; icon tile 46 with radius 14 and a 22 icon', () => {
    expect([C.radius, C.padTop, C.padSide, C.padBottom, C.gap]).toEqual([18, 16, 16, 4, 12]);
    expect([C.tile, C.tileRadius, C.icon]).toEqual([46, 14, 22]);
  });
  test('name 16 / 22, date 13 / 18', () => {
    expect([C.nameSize, C.nameLine, C.subSize, C.subLine]).toEqual([16, 22, 13, 18]);
  });
  test('badge: padding 5 10, text 11.5 / 14, letter spacing 0.05em', () => {
    expect([C.badgePadY, C.badgePadX, C.badgeSize, C.badgeLine]).toEqual([5, 10, 11.5, 14]);
    expect(C.badgeSpacing).toBeCloseTo(0.575, 5);
  });
  test('route: an 8 gap, text 14 / 20, pin 16, arrow 14', () => {
    expect([C.routeGap, C.routeSize, C.routeLine, C.pin, C.arrow]).toEqual([8, 14, 20, 16, 14]);
  });
  test('progress: 12 top padding, a 6 gap, five segments 6 tall with a 4 gap and radius 3; step text 13 / 18', () => {
    expect([C.progressPad, C.progressGap, C.segHeight, C.segGap, C.segRadius]).toEqual([12, 6, 6, 4, 3]);
    expect([C.stepSize, C.stepLine]).toEqual([13, 18]);
  });
  test('"View details": 14.5, a 16 chevron, 44 tall', () => {
    expect([C.detailsSize, C.detailsChevron, C.detailsMinHeight]).toEqual([14.5, 16, 44]);
  });
  test('"No requests match": 15', () => {
    expect(C.noMatch).toBe(15);
  });
});

describe('on a narrower screen everything shrinks together', () => {
  test('at 378 (a typical small window) every size is about 80% of the design\'s', () => {
    const s = scaleFor(378);
    const H = headerSpec(s);
    const C = cardSpec(s);
    expect(H.titleSize).toBe(scaled(20, s));
    expect(H.titleSize).toBeLessThan(20);
    expect(H.padSide).toBeLessThan(23);
    expect(C.nameSize).toBe(scaled(16, s));
    expect(C.nameSize).toBeLessThan(16);
    expect(C.tile).toBeLessThan(46);
    for (const [key, value] of Object.entries(C)) {
      if (['detailsMinHeight', 'badgeSpacing'].includes(key)) continue;
      expect(value).toBeLessThanOrEqual(cardSpec(1)[key]);
      expect(value).toBeGreaterThan(cardSpec(1)[key] * 0.7);
    }
  });
  test('the proportions of the design are kept: the ratio of the name to the title is the design\'s', () => {
    for (const w of [320, 378, 412]) {
      const s = scaleFor(w);
      expect(cardSpec(s).nameSize / headerSpec(s).titleSize).toBeGreaterThan(0.75);
      expect(cardSpec(s).nameSize / headerSpec(s).titleSize).toBeLessThan(0.85);
    }
  });
  test('text stays readable: the smallest text, the badge, is never under 9, the date never under 10.5', () => {
    for (let w = 200; w <= 1000; w += 7) {
      const C = cardSpec(scaleFor(w));
      expect(C.badgeSize).toBeGreaterThanOrEqual(9);
      expect(C.subSize).toBeGreaterThanOrEqual(10.5);
      expect(C.nameSize).toBeGreaterThanOrEqual(13);
      expect(C.routeSize).toBeGreaterThanOrEqual(11);
    }
  });
});

describe('a tappable thing is never smaller than 44', () => {
  test('the buttons and the search field stay 44 or more, however small the screen', () => {
    for (let w = 200; w <= 700; w += 5) {
      const H = headerSpec(scaleFor(w));
      expect(H.back).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(H.filter).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(H.searchHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(cardSpec(scaleFor(w)).detailsMinHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
  });
  test('a chip looks as the design does but its touch area reaches 44', () => {
    for (let w = 200; w <= 700; w += 5) {
      const H = headerSpec(scaleFor(w));
      expect(H.chipHeight + 2 * H.chipHitSlop).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
    expect(headerSpec(1).chipHitSlop).toBe(3);
  });
});

describe('the badge goes under the name only when there is no room', () => {
  test('beside it from 320 up at normal text size', () => {
    for (const w of [320, 360, 378, 390, 412, 470, 600]) expect(badgeBelowFor(w)).toBe(false);
  });
});
