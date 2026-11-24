/* global describe, test, expect, __dirname */
// The redesigned Request Submitted screen: no "Thank you" / handshake, the one-shot success animation (its timeline as numbers, Reduce Motion, no loop), the request card, Next Steps, the helpline card and the
// bottom bar (same navigation and tel: action as before), in all six languages. The screen is checked from its source and its pure parts (no device); the picture itself needs a phone.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const A = require('../submittedAnimation');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const screen = read('app', 'request', 'submitted.js');
const mark = read('components', 'request', 'SubmittedMark.js');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];

describe('nothing of the old celebration is left', () => {
  test('no "Thank you" wording and no handshake emoji on the screen, and its translation keys are gone', () => {
    expect(screen).not.toMatch(/thank/i);
    expect(screen).not.toContain('🤝');
    expect(mark).not.toContain('🤝');
    for (const lang of LANGS) expect(Object.prototype.hasOwnProperty.call(I18N[lang], 'thank_you_title')).toBe(false);
    expect(read('data', 'i18n.json')).not.toMatch(/thank_you_title/);
  });
  test('the title is "Request Submitted" (a header), in every language', () => {
    expect(screen).toContain("t('sub_title_submitted')");
    expect(screen).toMatch(/accessibilityRole="header"/);
    expect(I18N.EN.sub_title_submitted).toBe('Request Submitted');
    for (const lang of LANGS) expect({ lang, text: typeof I18N[lang].sub_title_submitted === 'string' && I18N[lang].sub_title_submitted.trim() !== '' }).toEqual({ lang, text: true });
  });
  test('the subtitle keeps the sentence the screen already had (same key)', () => {
    expect(screen).toContain("t('request_received_sub')");
  });
});

describe('the success animation timeline', () => {
  test('geometry: 108 box, ring r 44 / width 6 / dash 277 centred at 54, fill r 38, three dots, the check path', () => {
    expect(A.SIZE).toBe(108);
    expect(A.RING).toMatchObject({ cx: 54, cy: 54, r: 44, stroke: 6, dash: 277 });
    expect(A.FILL_R).toBe(38);
    expect(A.DOTS.map((d) => [d.cx, d.opacity])).toEqual([[42, 1], [54, 0.7], [66, 0.4]]);
    expect(A.CHECK).toMatchObject({ d: 'M34 55 L48 69 L75 40', dash: 64, stroke: 7 });
    expect(A.COLORS).toMatchObject({ track: '#E4E9F2', fill: '#E0F5F4', blue: '#303A8F', teal: '#0B6564' });
  });
  test('it starts blank: arc undrawn and blue, three dots, no fill, check hidden', () => {
    const f = A.frameAt(0);
    expect(f.arcOffset).toBeCloseTo(277, 5);
    expect(f.arcColor).toBe('rgb(48, 58, 143)');
    expect(f.dotsOpacity).toBe(1);
    expect(f.fillRadius).toBe(0);
    expect(f.checkOffset).toBe(64);
    expect(f.checkVisible).toBe(0);
  });
  test('0-900 ms the arc draws (monotonic, with the cubic-bezier(0.4, 0, 0.2, 1) ease) and is complete at 900', () => {
    let previous = 277;
    for (let ms = 0; ms <= 900; ms += 50) { const o = A.frameAt(ms).arcOffset; expect(o).toBeLessThanOrEqual(previous + 1e-9); previous = o; }
    expect(A.frameAt(900).arcOffset).toBeCloseTo(0, 3);
    expect(A.frameAt(450).arcOffset).toBeLessThan(277 / 2 + 5); // eased: at half the time it is at least half drawn
    expect(A.bezier(0.4, 0, 0.2, 1, 0)).toBeCloseTo(0, 5);
    expect(A.bezier(0.4, 0, 0.2, 1, 1)).toBeCloseTo(1, 5);
  });
  test('800-1000 ms the dots fade 1 -> 0', () => {
    expect(A.frameAt(799).dotsOpacity).toBe(1);
    expect(A.frameAt(900).dotsOpacity).toBeCloseTo(0.5, 5);
    expect(A.frameAt(1000).dotsOpacity).toBe(0);
  });
  test('900-1100 ms the arc turns from brand blue to teal', () => {
    expect(A.frameAt(900).arcColor).toBe('rgb(48, 58, 143)');
    expect(A.frameAt(1100).arcColor).toBe('rgb(11, 101, 100)');
    expect(A.frameAt(1000).arcColor).toBe('rgb(30, 80, 122)'); // halfway
    // the same turn, drawn as a teal ring fading in over the blue one
    expect(A.frameAt(900).arcTeal).toBe(0);
    expect(A.frameAt(1000).arcTeal).toBeCloseTo(0.5, 5);
    expect(A.frameAt(1100).arcTeal).toBe(1);
    expect(A.FINAL_FRAME.arcTeal).toBe(1);
  });
  test('1000-1300 ms the fill grows 0 -> 1.06 -> 1 (it overshoots by 6 %, then settles at r 38)', () => {
    expect(A.frameAt(1000).fillRadius).toBe(0);
    const peak = Math.max(...Array.from({ length: 31 }, (_, i) => A.frameAt(1000 + i * 10).fillRadius));
    expect(peak).toBeGreaterThan(38 * 1.05);
    expect(peak).toBeLessThanOrEqual(38 * 1.06 + 1e-9);
    expect(A.frameAt(1300).fillRadius).toBeCloseTo(38, 5);
  });
  test('1150-1450 ms the check draws 64 -> 0 and is hidden before it starts', () => {
    expect(A.frameAt(1149).checkVisible).toBe(0);
    expect(A.frameAt(1150).checkVisible).toBe(1);
    expect(A.frameAt(1150).checkOffset).toBeCloseTo(64, 5);
    expect(A.frameAt(1450).checkOffset).toBeCloseTo(0, 5);
  });
  test('the final frame is the finished picture, and it stays so (also what Reduce Motion shows at once)', () => {
    expect(A.DURATION_MS).toBe(1450);
    const f = A.FINAL_FRAME;
    expect(f).toMatchObject({ arcColor: 'rgb(11, 101, 100)', dotsOpacity: 0, checkVisible: 1 });
    expect(f.arcOffset).toBeCloseTo(0, 3);
    expect(f.checkOffset).toBeCloseTo(0, 5);
    expect(f.fillRadius).toBeCloseTo(38, 5);
    expect(A.frameAt(5000)).toEqual(A.frameAt(1450));
  });
});

describe('it plays once, honours Reduce Motion, and is decoration for screen readers', () => {
  test('one timing, no repeat, started from an effect that runs once', () => {
    expect((mark.match(/withTiming\(/g) || []).length).toBe(1);
    expect(mark).not.toMatch(/withRepeat|withSequence|setInterval|AppState/);
    const effect = /useEffect\(\(\) => \{([\s\S]*?)\}, \[\]\);/.exec(mark); // empty dependency list: it runs once
    expect(effect).toBeTruthy();
    expect(effect[1]).toContain('clock.value = withTiming(DURATION_MS');
  });
  test('Reduce Motion: the clock starts at its end, so the finished picture is there at once, and no timing runs', () => {
    expect(mark).toContain('useReducedMotion()');
    expect(mark).toContain('useSharedValue(reduceMotion ? DURATION_MS : 0)');
    expect(mark).toContain('if (!reduceMotion) clock.value = withTiming');
    expect(mark).toContain('r={reduceMotion ? FILL_R : 0}');
  });
  test('hidden from screen readers; the screen announces "Request submitted" once instead', () => {
    expect(mark).toMatch(/accessibilityElementsHidden importantForAccessibility="no-hide-descendants"/);
    expect(screen).toContain("AccessibilityInfo.announceForAccessibility(t('sub_title_submitted'))");
    expect((screen.match(/announceForAccessibility/g) || []).length).toBe(1);
    expect(screen).toMatch(/announced\.current/);
  });
  test('the check mark is never mirrored (RTL does not flip it); the button arrow is', () => {
    expect(mark).not.toMatch(/isRTL|scaleX/);
    expect(screen).toContain('isRTL ? { transform: [{ scaleX: -1 }] } : null');
  });
  test('no new package: only react-native-svg and react-native-reanimated, both already installed; no haptics package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies['react-native-svg']).toBeTruthy();
    expect(pkg.dependencies['react-native-reanimated']).toBeTruthy();
    expect(pkg.dependencies['expo-haptics']).toBeUndefined();
    expect(mark + screen).not.toMatch(/expo-haptics/);
  });
});

describe('the request card, Next Steps, the helpline card and the bottom bar', () => {
  test('a very long service name is written whole: no line limit, no ellipsis', () => {
    const line = screen.split('\n').find((l) => l.includes('{service}</Text>'));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/numberOfLines|ellipsizeMode|adjustsFontSizeToFit/);
    expect(screen).not.toMatch(/numberOfLines=\{1\}>\{service\}/);
  });
  test('the card shows the Request ID, the SUBMITTED pill (the app\'s own Pill), the service and "Submitted <date, time>"', () => {
    expect(screen).toContain("t('lbl_request_id')");
    expect(screen).toContain('<Pill status="submitted" />');
    expect(screen).toContain("t('sub_submitted_on', { date: `${formatDate(submittedAt)}, ${formatTime(submittedAt)}` })");
    for (const lang of LANGS) expect(I18N[lang].sub_submitted_on).toContain('{{date}}');
  });
  test('Next Steps keeps its three steps and texts', () => {
    expect(screen).toContain("['next_step_call', PhoneCall]");
    expect(screen).toContain("['next_step_arrange', ClipboardCheck]");
    expect(screen).toContain("['next_step_updates', BellRing]");
    expect(screen).toContain("t('next_steps_label')");
    expect(screen).toMatch(/\{!incomplete && \(\s*<Card/); // no "Next Steps" while documents are missing (unchanged rule)
  });
  test('the helpline card opens tel: with the number the screen already had; no new number', () => {
    expect(screen).toContain('onPress={() => open(`tel:${EMERGENCY_TEL}`)}');
    expect(screen).not.toContain('EMERGENCY_DISPLAY'); // the number itself is no longer written on the card (the Call pill dials it)
    const mock = read('data', 'mock.js');
    expect(mock).toContain("export const EMERGENCY_TEL = '+919699999065';");
    expect(mock).toContain("export const EMERGENCY_DISPLAY = '+91 96999 99065';");
    expect(screen).not.toMatch(/\+91\s?9\d{4}\s?\d{5}|tel:\+/);
    for (const key of ['sub_urgent_help', 'sub_call_btn']) for (const lang of LANGS) expect({ key, lang, ok: !!I18N[lang][key] }).toEqual({ key, lang, ok: true });
  });
  test('"View My Request" and "Return to Home" go exactly where they went before', () => {
    expect(screen).toContain("onPress={() => navReplace({ pathname: '/request-details', params: { id: requestId } })}");
    expect(screen).toContain("t('view_my_request_btn')");
    expect(screen).toContain("onPress={() => navReplace('/home')}");
    expect(screen).toContain("t('btn_return_home')");
    expect(screen).toContain("<TopBar title={t('request_submitted_title')} onBack={() => navReplace('/home')} />"); // the header and back button are unchanged
  });
  test('the missing-documents screen and the draft state are untouched', () => {
    expect(screen).toContain("t('sub_docs_missing_title')");
    expect(screen).toContain("t('sk_try_again')");
    expect(screen).toContain('<UploadStatusList');
    expect(screen).toContain("submissionState(draft) === 'draft'");
  });
  test('brand colours come from the tokens (COLORS), not written by hand', () => {
    expect(screen).toContain('COLORS.primaryPressed');
    expect(screen).toContain('COLORS.primarySoft');
    expect(screen).not.toMatch(/#303A8F|#252D6F|#EAEBF4/i);
  });
});
