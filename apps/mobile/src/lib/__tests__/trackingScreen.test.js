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
  const parts = read('../../components/request/DetailsParts.js');
  test('the header is the shared one: white, 76 tall, a 48x48 back button, the title and nothing else', () => {
    expect(screen).toContain("import { ScreenHeader } from '../components/request/DetailsParts';");
    expect(screen).toContain("<ScreenHeader title={t('tracking_details_title')}");
    expect(parts).toContain("height: 76, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, backgroundColor: '#FFFFFF', borderBottomWidth: 1");
    expect(parts).toContain('width: 48, height: 48, borderRadius: 14, backgroundColor: C.soft');
    expect(parts).toContain('fontFamily: FONT[800], fontSize: 18, lineHeight: 24, color: C.navy');
    expect(screen).toContain("backgroundColor: '#F2F6FC'");
  });
  test('the route banner is the application\'s logo blue #303A8F (the palette\'s brand), radius 20, padding 18, 16 between its parts', () => {
    expect(card).toContain("backgroundColor: BANNER, borderRadius: 20, padding: 18, gap: 16");
    expect(card).toContain('const BANNER = P.brand;');
    expect(P.brand).toBe('#303A8F');
    expect(card).toContain('const SOFT_TEXT = P.brandOnDark;');
    expect(card).not.toContain('#0D2340'); // the old dark navy is gone from the banner
    expect(screen).toContain("backgroundColor: '#F2F6FC'"); // the page keeps its light background
  });
  test('the reference, the badge and the service name are drawn from the design\'s sizes', () => {
    expect(card).toContain("fontFamily: FONT[600], fontSize: 12.5, lineHeight: 17, letterSpacing: 0.25, color: SOFT_TEXT");
    expect(card).toContain("paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.16)'");
    expect(card).toContain("fontFamily: FONT[800], fontSize: 11.5, lineHeight: 14, letterSpacing: 0.4, textTransform: 'uppercase'");
    expect(card).toContain("fontFamily: FONT[800], fontSize: 16, lineHeight: 22, color: '#FFFFFF' }, WRAP]}>{d.serviceName}");
  });
  test('the route: the cities at 18/24/800 up to 120 wide, a 32 white chip with the request\'s own icon at 16 in the banner blue, the dashed and solid lines, the dot and the ring', () => {
    expect(card).toContain("maxWidth: 120, flexShrink: 1");
    expect(card).toContain("fontFamily: FONT[800], fontSize: 18, lineHeight: 24, color: '#FFFFFF'");
    expect(card).toContain('const CHIP = 32;');
    expect(card).toContain('<ServiceIcon serviceKey={serviceKey} size={16} color={BANNER}');
    expect(card).toContain('stroke="rgba(255,255,255,0.45)" strokeWidth={2} strokeDasharray="4 4"');
    expect(card).toContain("backgroundColor: 'rgba(255,255,255,0.28)'"); // the 5px halo
    expect(card).toContain('width: 8, height: 8, borderRadius: 4, backgroundColor: \'#FFFFFF\'');
    expect(card).toContain('width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: \'#FFFFFF\'');
    expect(card).not.toMatch(/rotate/); // the chip is not turned
  });
  test('the footer: a 14 top padding and a faint line, 6-tall segments with a 4 gap, the current title and "Step X of N", "Updated ..."', () => {
    expect(card).toContain("paddingTop: 14, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.18)', gap: 8");
    expect(card).toContain("flexDirection: 'row', gap: 4");
    expect(card).toContain("height: 6, borderRadius: 3, backgroundColor: s === 'on' ? '#FFFFFF' : s === 'dim' ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.22)'");
    expect(card).toContain("fontFamily: FONT[800], fontSize: 15, lineHeight: 21, color: '#FFFFFF' }, WRAP]}>{d.currentTitle}");
    expect(card).toContain("t('mr_step_of', { n: d.index + 1, total: d.total })");
    expect(card).toContain("t('rd_updated', { when: d.updated })");
    expect(card).toContain('{d.updated ?'); // hidden when there is no event
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
  test('the list is a list, its current step is marked, and the route card has its own label', () => {
    expect(card).toContain('role="list" accessibilityRole="list"');
    expect(card).toContain('role="listitem"');
    expect(card).toContain("aria-current={current ? 'step' : undefined}");
    expect(card).toContain('accessibilityLabel={d.accessibilityLabel}');
  });
  test('it draws the steps it is given: no step name, step count or text is written into the screen', () => {
    for (const source of [card, screen]) {
      expect(source).not.toMatch(/trk_received|trk_medical|trk_quote|trk_progress|trk_completed|tcp_m_|Request received|Mission in progress|Flight scheduled/);
      expect(source).not.toMatch(/length === 4|length === 5|\[0, 1, 2, 3|Array\.from\(\{ length: [0-9]/);
    }
    expect(card).toContain('d.steps.map(');
    expect(card).toContain('d.segments.map(');
  });
  test('no stage notes, no share, no invented operational information, no gradient or monospace', () => {
    const code = (src) => src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//') && !l.includes('{/*')).join(String.fromCharCode(10));
    expect(code(card)).not.toMatch(/\.note\b|Share|ETA|coordinator|distance|LinearGradient|Menlo|monospace/);
    expect(code(read('../trackingDetailsView.js'))).not.toMatch(/\.note\b/);
  });
  test('the admin\'s "changes required" message (above Progress) and the "Open request" button (below it) are kept', () => {
    expect(card.indexOf('<Message ')).toBeLessThan(card.indexOf("<Section title={t('td_progress')}>"));
    expect(card.indexOf("<Section title={t('td_progress')}>")).toBeLessThan(card.indexOf("t('tcp_open_request')"));
    expect(card).toContain('d.openRequest && onOpenRequest');
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
