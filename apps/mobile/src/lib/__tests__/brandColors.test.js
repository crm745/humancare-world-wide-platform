/* global describe, test, expect, __dirname */
// #303A8F, the logo's royal blue, is the one brand blue of the app, defined once in src/theme/colors.js.
const fs = require('fs');
const path = require('path');
const { COLORS, primaryAlpha } = require('../../theme/colors');
const palette = require('../tracking/palette');

const SRC = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { if (name !== '__tests__') walk(full, out); } else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// relative luminance and contrast, as WCAG defines them
const lum = ([r, g, b]) => { const c = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

describe('the tokens', () => {
  test('the brand blue and its tints', () => {
    expect(COLORS).toEqual({
      primary: '#303A8F', primaryPressed: '#252D6F', primarySoft: '#EAEBF4', primaryMuted: '#ACB0D2', onPrimaryMuted: 'rgba(255,255,255,0.72)',
    });
    expect(primaryAlpha(0.72)).toBe('rgba(48,58,143,0.72)');
    expect(primaryAlpha(0)).toBe('rgba(48,58,143,0)');
  });
  test('white text, and white at 0.72, are readable on the brand blue (WCAG AA, 4.5)', () => {
    expect(contrast(rgb('#FFFFFF'), rgb(COLORS.primary))).toBeGreaterThanOrEqual(4.5);
    // white at 0.72 over #303A8F
    const mixed = rgb(COLORS.primary).map((v) => Math.round(255 * 0.72 + v * 0.28));
    expect(contrast(mixed, rgb(COLORS.primary))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb('#FFFFFF'), rgb(COLORS.primaryPressed))).toBeGreaterThan(contrast(rgb('#FFFFFF'), rgb(COLORS.primary)));
  });
  test('the brand blue is readable as text on white and on its own soft tint', () => {
    expect(contrast(rgb(COLORS.primary), rgb('#FFFFFF'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(COLORS.primary), rgb(COLORS.primarySoft))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('one source for every blue', () => {
  test('the Tailwind classes use the tokens, so bg-primary and COLORS.primary are the same colour', () => {
    const source = fs.readFileSync(path.join(SRC, '../tailwind.config.js'), 'utf8');
    expect(source).toContain("require('./src/theme/colors')");
    expect(source).toContain('primary: { DEFAULT: COLORS.primary, soft: COLORS.primarySoft, dark: COLORS.primary, pressed: COLORS.primaryPressed, muted: COLORS.primaryMuted }');
    expect(source).not.toMatch(/#1A73E8|#1A5FC4|#E7F0FE/i);
  });
  test('the Android notification colour in app.json is the brand blue', () => {
    const config = JSON.parse(fs.readFileSync(path.join(SRC, '../app.json'), 'utf8'));
    const text = JSON.stringify(config);
    expect(text).toContain(`"color":"${COLORS.primary}"`);
    expect(text).not.toMatch(/#1A73E8/i);
  });
  test('the tracking palette and the Private Charter colours take their blue from the tokens', () => {
    expect(palette.TRACKING_PALETTE.brand).toBe(COLORS.primary);
    expect(palette.TRACKING_PALETTE.brandSoft).toBe(COLORS.primarySoft);
    expect(palette.TRACKING_PALETTE.brandOnDark).toBe(COLORS.onPrimaryMuted);
    expect(palette.BLUE).toBe(COLORS.primary);
    const view = require('../tracking/privateCharterTrackingView');
    expect(view.COLORS.PRIMARY).toBe(COLORS.primary);
    expect(view.COLORS.PRIMARY_SOFT).toBe(COLORS.primarySoft);
  });
  test('no screen or component writes one of the old blues, or the new one, by hand: they all use the tokens', () => {
    const old = /#1A73E8|#1A5FC4|#E7F0FE|#0F4FB0|#D6E6FD|#3E8EF7|#1B6FDB|#2F3A8D|#2457A7|#CFE0FB|#C9D8F2|#A9B3F0|#A9BAD3|#E9EAF4|#E9EBF6|#303A8F|rgba\(\s*26\s*,\s*115\s*,\s*232|rgba\(\s*13\s*,\s*35\s*,\s*64|rgba\(\s*169\s*,\s*179\s*,\s*240/i;
    const hits = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(path.join('theme', 'colors.js'))) continue;
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => { if (old.test(line)) hits.push(`${path.relative(SRC, file)}:${i + 1}`); });
    }
    expect(hits).toEqual([]);
  });
  test('dark navy is still the text and icon colour: only fills became the brand blue', () => {
    expect(read('components/layout.js')).toContain("color=\"#0D2340\"");
    expect(read('components/requests/RequestsHeader.js')).toContain('backgroundColor: on ? COLORS.primary');
    expect(read('components/home/BannerCarousel.js')).toContain('colors={[COLORS.primary, primaryAlpha(0.72), primaryAlpha(0)]}');
    expect(read('components/request/RequestFrame.js')).toContain("'bg-primary'");
    expect(read('components/request/fields.js')).toContain('true: COLORS.primary');
  });
  test('the things that are not brand blue were left alone: the SOS red, the neutrals, the Google mark', () => {
    expect(read('components/sos/SosFab.js')).toContain("const RED = '#C53030';");
    expect(read('components/layout.js')).toContain("'#6B7A90'");
    expect(read('components/SocialMarks.js')).toContain('#4285F4');
    expect(read('../tailwind.config.js')).toContain("canvas: '#F2F6FC'");
  });
});
