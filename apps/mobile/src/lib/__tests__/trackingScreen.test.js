/* global describe, test, expect, __dirname */
// The Tracking screen follows the app's design system: official colours, shared components, Inter only.
const fs = require('fs');
const path = require('path');
const { TRACKING_PALETTE: P, toneFor } = require('../tracking/palette');
const { trackingView } = require('../requestTracking');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const screen = read('../../app/request-tracking.js');
const req = (status, events = []) => ({ status, createdAt: '2026-11-03T04:42:00.000Z', case: events.length ? { stageEvents: events } : null });

describe('palette', () => {
  test('the official logo blue and secondary navy', () => {
    expect(P.brand).toBe('#303A8F');
    expect(P.navy).toBe('#2F2A62');
  });
  test('the neutral and state colours are the app\'s own (cancel red, success green, line, text)', () => {
    const tailwind = read('../../../tailwind.config.js');
    expect(tailwind).toContain(`'${P.cancelled}'`);
    expect(tailwind).toContain(`'${P.done}'`);
    expect(tailwind).toContain(`'${P.line}'`);
    expect(tailwind).toContain(`'${P.faint}'`);
    expect(tailwind).toContain(`'${P.muted}'`);
    expect(tailwind).toContain(`'${P.heading}'`);
  });
  test('toneFor: brand blue in progress, green when completed, the muted red when cancelled', () => {
    expect(toneFor(trackingView(req('payment'))).solid).toBe('#303A8F');
    expect(toneFor(trackingView(req('submitted'))).solid).toBe('#303A8F');
    expect(toneFor(trackingView(req('completed'))).solid).toBe(P.done);
    expect(toneFor(trackingView(req('cancelled'))).solid).toBe(P.cancelled);
    // the route card is blue, so each tone also has a light version for it
    expect(toneFor(trackingView(req('payment'))).onDark).toBe(P.brandOnDark);
    expect(toneFor(trackingView(req('completed'))).onDark).toBe(P.doneOnDark);
    expect(toneFor(trackingView(req('cancelled'))).onDark).toBe(P.cancelledOnDark);
  });
});

describe('the Tracking Details screen is drawn to the design', () => {
  const card = read('../../components/tracking/TrackingDetails.js');
  const banner = read('../../components/tracking/TrackingBanner.js');
  const lib = read('../trackingBanner.js');
  const parts = read('../../components/request/DetailsParts.js');
  test('the header is the shared one: white, 76 tall, a 48x48 back button, the title and nothing else', () => {
    expect(screen).toContain("import { ScreenHeader } from '../components/request/DetailsParts';");
    expect(screen).toContain("<ScreenHeader title={t('tracking_details_title')}");
    expect(parts).toContain("height: 76, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, backgroundColor: '#FFFFFF', borderBottomWidth: 1");
    expect(parts).toContain('width: 48, height: 48, borderRadius: 14, backgroundColor: C.soft');
    expect(parts).toContain('fontFamily: FONT[800], fontSize: 18, lineHeight: 24, color: C.navy');
    expect(screen).toContain("backgroundColor: '#F2F6FC'");
  });
  test('the top card is the new banner (components/tracking/TrackingBanner.js); the old route card is gone', () => {
    expect(card).toContain("import TrackingBanner from './TrackingBanner';");
    expect(card).toContain('<TrackingBanner d={d} />');
    expect(card).not.toMatch(/RouteCard|RouteLine|function City|react-native-svg|SOFT_TEXT|const BANNER/);
    expect(screen).toContain("backgroundColor: '#F2F6FC'"); // the page keeps its light background
  });
  test('the banner card: white, radius 20, a 1px #E4E9F2 border, overflow hidden, the 0 10 24 shadow', () => {
    expect(banner).toContain("backgroundColor: '#FFFFFF', borderRadius: 20, borderWidth: 1, borderColor: LINE, overflow: 'hidden'");
    expect(banner).toContain("const LINE = '#E4E9F2';");
    expect(banner).toContain("shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.1, shadowRadius: 24");
  });
  test('the top part: min height 158, padding 16, a 135-degree gradient #4450B8 / #303A8F 48% / #222A6E, and nothing else behind the text', () => {
    expect(banner).toContain('minHeight: 158, padding: 16, backgroundColor: GRADIENT.colors[1]');
    expect(lib).toContain("colors: Object.freeze(['#4450B8', COLORS.primary, '#222A6E'])");
    expect(lib).toContain('locations: Object.freeze([0, 0.48, 1])');
    expect(lib).toContain('start: Object.freeze({ x: 0, y: 0 })');
    expect(lib).toContain('end: Object.freeze({ x: 1, y: 1 })');
    expect(banner).toContain('colors={GRADIENT.colors} locations={GRADIENT.locations} start={GRADIENT.start} end={GRADIENT.end}');
    expect(banner.match(/<LinearGradient /g)).toHaveLength(1); // no photo fade, no vertical shade
  });
  test('the corner glow is a true radial fade (white 18% to nothing), never a solid circle', () => {
    expect(lib).toContain('export const GLOW = Object.freeze({ size: 240, opacity: 0.18 });');
    expect(banner).toContain('<RadialGradient id="tbGlow"');
    expect(banner).toContain('stopColor="#FFFFFF" stopOpacity={GLOW.opacity}');
    expect(banner).toContain('stopColor="#FFFFFF" stopOpacity={0}');
    expect(banner).toContain('fill="url(#tbGlow)"');
    expect(banner).not.toMatch(/backgroundColor: 'rgba\(255,255,255,0\.1[0-9]*\)', *borderRadius|borderRadius: 120|borderRadius: GLOW/); // no View drawn as a circle
  });
  test('row 1: the white 28 chip (icon 15, 12.5/800 in the brand blue), a 1x16 divider and the request number that never wraps', () => {
    expect(banner).toContain("height: 28, borderRadius: 14, paddingHorizontal: 11, backgroundColor: '#FFFFFF'");
    expect(banner).toContain('<ServiceIcon serviceKey={d.chipIcon} size={15} color={NAVY}');
    expect(banner).toContain('fontFamily: FONT[800], fontSize: 12.5, color: BRAND');
    expect(banner).toContain("width: 1, height: 16, backgroundColor: 'rgba(255,255,255,0.35)'");
    expect(banner).toContain("numberOfLines={1} style={{ flexShrink: 0, fontFamily: FONT[700], fontSize: 12.5, letterSpacing: 0.375, color: 'rgba(255,255,255,0.85)' }}>{d.reference}");
  });
  test('the title block: 14 below the row, 22/28/800 and 13.5/18, two lines each, as wide as the service\'s share (55% / 64%) allows and never reaching the picture', () => {
    expect(banner).toContain('marginTop: 14,');
    expect(banner).toContain("numberOfLines={2} ellipsizeMode=\"tail\" style={{ maxWidth: widths.title, fontFamily: FONT[800], fontSize: 22, lineHeight: 28, color: '#FFFFFF'");
    expect(banner).toContain("fontFamily: FONT[400], fontSize: 13.5, lineHeight: 18, color: 'rgba(255,255,255,0.82)'");
    expect(banner).toContain('textWidths({ image, cardWidth, screenWidth, title: texts.title })');
    expect(banner).toContain('{texts.title}');
    expect(banner).toContain('{texts.subtitle}');
  });
  test('the drawn picture: bundled, anchored bottom-right by the config, hidden from screen readers; no photo, no placeholder, no icon', () => {
    expect(banner).toContain("require('../../../assets/images/banner/banner-private-charter.png')");
    expect(banner).toContain("position: 'absolute', bottom: place.bottom, [side]: place.right, width: place.width, height: place.height");
    expect(banner).toContain('accessible={false} importantForAccessibility="no"');
    expect(banner).toContain('const image = d.bannerImage && PICTURES[d.bannerImage.image] ? d.bannerImage : null;');
    expect(banner).toContain('{image ? (');
    expect(banner).not.toMatch(/uri:|https?:\/\//); // nothing from the network
    expect(banner).not.toMatch(/data\/images|IMAGES\[|services\.json|tracking-jet|photo/i); // no Service Details photo, no jet
    expect(banner).not.toMatch(/width: 84|borderRadius: 42/); // no icon-in-a-circle placeholder
    expect(banner.match(/<ServiceIcon /g)).toHaveLength(1); // the service icon is only the chip's (size 15)
    expect(banner).toContain('<ServiceIcon serviceKey={d.chipIcon} size={15}');
    expect(fs.existsSync(path.join(__dirname, '../../../assets/images/tracking-jet.png'))).toBe(false);
  });
  test('the bottom part: two equal cells with a 1px divider, a 38 rounded tile and a round 38 tile, 12/16/600 labels and 15/20/800 values, all cut with an ellipsis', () => {
    expect(banner).toContain("gap: 14, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: '#FFFFFF'");
    expect(banner).toContain("width: 1, alignSelf: 'stretch', backgroundColor: LINE");
    expect(banner).toContain('width: 38, height: 38, borderRadius: round ? 19 : 11, backgroundColor: TILE');
    expect(banner).toContain('const TILE = COLORS.primarySoft;');
    expect(banner).toContain('fontFamily: FONT[600], fontSize: 12, lineHeight: 16, color: MUTED');
    expect(banner).toContain('fontFamily: FONT[800], fontSize: 15, lineHeight: 20, color: valueColor');
    expect(banner).toContain('<CalendarCheck size={20} color={BRAND}');
    expect(banner).toContain('<Clock size={20} color={BRAND}');
    expect(banner.match(/numberOfLines=\{1\} ellipsizeMode="tail"/g)).toHaveLength(2);
    expect(banner).toContain("t('tb_status_label')");
    expect(banner).toContain("t('tb_updated_label')");
    expect(banner).toContain('statusColorOf(d.status)');
  });
  test('right to left: the screen\'s direction runs the rows the other way; the text aligns right and the picture sits at the bottom-left with the same offsets', () => {
    expect(banner).not.toContain('row-reverse'); // the screen's direction (rtl) already runs a row the other way
    expect(banner).toContain("const align = isRTL ? 'right' : 'left';");
    expect(banner).toContain("const side = isRTL ? 'left' : 'right';");
  });
  test('the card is one spoken element and the time moves on once a minute', () => {
    expect(banner).toContain('accessible accessibilityRole="summary" accessibilityLabel={label}');
    expect(banner).toContain('startMinuteTicker(() => setNow(Date.now()))');
    expect(banner).toContain('bannerAccessibilityLabel(');
  });
  test('the timeline: a "Progress" label over a card, 26px markers (check, ring and dot, grey ring), connectors, and the step text', () => {
    expect(card).toContain("t('td_progress')");
    expect(card).toContain('const MARKER = 26;');
    expect(card).toContain('width: MARKER, height: MARKER, borderRadius: MARKER / 2');
    expect(card).toContain('top: MARKER + 2, bottom: -2, width: 2');
    expect(card).toContain("pending: { weight: 600, color: C.muted }"); // a pending step is readable, not faded
    expect(card).toContain('paddingTop: 18, paddingHorizontal: 16, paddingBottom: 4');
    expect(card).toContain('<Check size={13} color="#FFFFFF" strokeWidth={3.2} />');
    expect(card).toContain("borderWidth: 3, borderColor: BLUE");
    expect(card).toContain("borderWidth: 2, borderColor: '#D5DCE7'");
    expect(card).toContain("width: 2, backgroundColor: step.state === 'done' ? BLUE : C.line");
    expect(card).toContain('paddingTop: 1, paddingBottom: 16, gap: 2');
    expect(card).toContain('fontSize: 14.5, lineHeight: 20');
    expect(card).toContain("t('timeline_pending')");
    expect(card).toContain("step.state === 'pending' && !step.stopped"); // a cancelled stop step shows its time, not "Pending"
  });
  test('the list is a list and its current step is marked', () => {
    expect(card).toContain('role="list" accessibilityRole="list"');
    expect(card).toContain('role="listitem"');
    expect(card).toContain("aria-current={current ? 'step' : undefined}");
  });
  test('it draws the steps it is given: no step name, step count or text is written into the screen', () => {
    for (const source of [card, screen]) {
      expect(source).not.toMatch(/trk_received|trk_medical|trk_quote|trk_progress|trk_completed|tcp_m_|Request received|Mission in progress|Flight scheduled/);
      expect(source).not.toMatch(/length === 4|length === 5|\[0, 1, 2, 3|Array\.from\(\{ length: [0-9]/);
    }
    expect(card).toContain('d.steps.map(');
  });
  test('no stage notes, no share, no invented operational information, no gradient or monospace', () => {
    const code = (src) => src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//') && !l.includes('{/*')).join(String.fromCharCode(10));
    expect(code(card)).not.toMatch(/\.note\b|Share|ETA|coordinator|distance|LinearGradient|Menlo|monospace/);
    expect(code(read('../trackingDetailsView.js'))).not.toMatch(/\.note\b/);
  });
  test('the admin\'s "changes required" message (above Progress) is kept, and there is no "Open request" button or link to Request Details', () => {
    expect(card.indexOf('<Message ')).toBeLessThan(card.indexOf("<Section title={t('td_progress')}>"));
    expect(card).not.toMatch(/tcp_open_request|openRequest|onOpenRequest/);
    expect(read('../../app/request-tracking.js')).not.toMatch(/request-details|onOpenRequest/);
    expect(card).toContain("t('tcp_changes_label')");
  });
  test('the tracking logic and the API call are unchanged', () => {
    expect(screen).toContain('apiGet(`/requests/me/${id}`)');
    expect(screen).toContain('buildTrackingDetails(request, t)');
    const adapter = read('../trackingDetailsView.js');
    expect(adapter).toContain('trackingView(request)');
    expect(adapter).toContain('buildPrivateCharterTracking(request)');
    const logic = read('../requestTracking.js');
    expect(logic).toContain("{ key: 'submitted', title: 'trk_received'");
    expect(logic).toContain("{ key: 'payment', title: 'trk_quote'");
  });
});
