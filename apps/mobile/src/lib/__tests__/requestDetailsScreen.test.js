/* global describe, test, expect, __dirname */
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const screen = read('../../app/request-details.js');
const parts = read('../../components/request/DetailsParts.js');

describe('Request Details is drawn to the design (source checks)', () => {
  test('the header: white, 76 tall, a 1px #E4E9F2 bottom line, a 48x48 back button (radius 14, #EEF3FB), an 18/24/800 title', () => {
    expect(screen).toContain("height: 76, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: C.line");
    expect(screen).toContain('width: 48, height: 48, borderRadius: 14, backgroundColor: C.soft');
    expect(screen).toContain('<ChevronLeft size={22} color={C.navy}');
    expect(screen).toContain('fontFamily: FONT[800], fontSize: 18, lineHeight: 24, color: C.navy');
  });
  test('the page is #F2F6FC, padded 16 16 24 with 14 between the blocks', () => {
    expect(screen).toContain("backgroundColor: '#F2F6FC'");
    expect(screen).toContain('paddingTop: 16, paddingHorizontal: 16, paddingBottom: 24, gap: 14');
  });
  test('a section label is 12/16/800 uppercase, 0.08em, #5B6B84, 4 from the left, and a heading; a card is radius 18 / padding 16 (20 / 18 for the big ones)', () => {
    expect(parts).toContain("paddingLeft: 4, fontFamily: FONT[800], fontSize: 12, lineHeight: 16, letterSpacing: 0.96, textTransform: 'uppercase', color: C.muted");
    expect(parts).toContain('accessibilityRole="header"');
    expect(parts).toContain("borderWidth: 1, borderColor: C.line, borderRadius: big ? 20 : 18, padding: padding === undefined ? (big ? 18 : 16) : padding");
    expect(parts).toContain('gap: 8');
  });
  test('a field is a 12.5/16/600 label over a 15/21/700 value with a 2 gap, and every value wraps', () => {
    expect(parts).toContain('fontFamily: FONT[600], fontSize: 12.5, lineHeight: 16, color: C.muted');
    expect(parts).toContain('fontFamily: FONT[700], fontSize: 15, lineHeight: 21, color: C.ink, flexShrink: 1');
    expect(parts).toContain("overflowWrap: 'anywhere', wordBreak: 'break-word'");
    expect(parts).toContain('minWidth: 0, gap: 2');
  });
  test('the summary: a 52 tile (radius 16) with the ServiceIcon at 24, the 19/25/800 name, an 11.5/14/800 badge, three 66-tall actions with an 8 gap', () => {
    expect(screen).toContain('width: 52, height: 52, borderRadius: 16');
    expect(screen).toContain('<ServiceIcon serviceKey={h.serviceKey} size={24} color={C.navy} fill={C.navy} fillOpacity={0.12} />');
    expect(screen).toContain('fontFamily: FONT[800], fontSize: 19, lineHeight: 25');
    expect(screen).toContain("fontFamily: FONT[800], fontSize: 11.5, lineHeight: 14, textTransform: 'uppercase'");
    expect(screen).toContain('minHeight: 66, borderRadius: 14, backgroundColor: \'#F5F8FC\'');
    expect(screen).toContain('<Icon size={20} color={C.blueText} />');
    expect(screen).toContain("marginTop: 16, flexDirection: 'row', gap: 8");
  });
  test('the three actions are the same as before: the summary PDF, the share text, a phone call', () => {
    expect(screen).toContain("downloadAndShare(`/requests/me/${request.id}/summary`, `${request.referenceNumber}-summary.pdf`)");
    expect(screen).toContain('Share.share(');
    expect(screen).toContain("Linking.openURL('tel:+919699999065')");
    expect(screen).toContain("toast('Downloading request summary…')");
  });
  test('live tracking: a 16/22/800 title, the Case active chip, five 6-tall segments with a 4 gap, the step line and the update time', () => {
    expect(screen).toContain('fontFamily: FONT[800], fontSize: 16, lineHeight: 22');
    expect(screen).toContain("width: 7, height: 7, borderRadius: 4, backgroundColor: C.blue");
    expect(screen).toContain("backgroundColor: '#E7F0FE'");
    expect(screen).toContain("flexDirection: 'row', gap: 4");
    expect(screen).toContain('height: 6, borderRadius: 3, backgroundColor: i < s.step ? C.blue : C.line');
    expect(screen).toContain("t('mr_step_of', { n: s.step, total: s.total })");
    expect(screen).toContain("t('rd_updated', { when: s.updated })");
  });
  test('every other state is the 40x40 tile card, and exactly one status card is drawn', () => {
    const layout = parts.slice(parts.indexOf('export function StatusLayout'));
    expect(layout).toContain('width: 40, height: 40, borderRadius: 12');
    expect(layout).toContain('fontFamily: FONT[800], fontSize: 15.5, lineHeight: 21');
    expect(layout).toContain('fontFamily: FONT[400], fontSize: 13.5, lineHeight: 19');
    expect(screen.match(/<StatusCard /g)).toHaveLength(1);
    expect(screen).toContain("if (s.kind === 'review') return <ReviewBanner request={request} />;");
    expect(screen).toContain('bg="#E0F5F4" fg="#0B6564" Icon={CircleCheck} title={t(\'rd_approved_title\')}');
    expect(screen).toContain('bg="#FDF0DA" fg="#8F4C08" Icon={Clock} title={t(\'rd_review_title\')}');
    expect(screen).toContain('bg="#EEF1F6" fg="#5B6B84" Icon={Ban} title={t(\'rd_cancelled_title\')}');
  });
  test('the patient grid is two columns with a 14 row gap and a 12 column gap', () => {
    expect(screen).toContain("<View style={{ gap: 14 }}>");
    expect(screen).toContain("flexDirection: 'row', gap: 12");
  });
  test('the trip: a 14px ring dot (3px #1A73E8), a dashed 2px #C9D3E1 line, a filled dot, a #EEF1F6 divider with 16 above and below', () => {
    expect(screen).toContain('width: 14, height: 14, borderRadius: 7, borderWidth: 3, borderColor: C.blue');
    expect(screen).toContain('width: 14, height: 14, borderRadius: 7, backgroundColor: C.blue');
    expect(parts).toContain("color = '#C9D3E1'");
    expect(parts).toContain('strokeWidth={2} strokeDasharray="4 4"');
    expect(screen).toContain('marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: C.divider');
  });
  test('the medical card: padding 4 16, rows with 12 above and below and a 1px #EEF1F6 line; the chips are the design\'s', () => {
    expect(screen).toContain('paddingVertical: 4, paddingHorizontal: 16');
    expect(screen).toContain('paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: C.divider');
    expect(screen).toContain('padV = 5, padH = 10, size = 13, line = 18');
    expect(screen).toContain('padV={6} padH={12} size={13.5}');
  });
  test('the condition keeps its line breaks, is clamped to four lines, and its button reports expanded', () => {
    expect(screen).toContain('numberOfLines={open ? undefined : 4}');
    expect(screen).toContain('accessibilityState={{ expanded: open }}');
    expect(screen).toContain("fontFamily: FONT[700], fontSize: 14, color: C.blueText");
    expect(screen).toContain('minHeight: 44');
  });
  test('a document row is at least 66 tall, with a 40 tile, a one-line name with an ellipsis, a meta line and a chevron', () => {
    expect(screen).toContain('minHeight: 66, flexDirection: \'row\'');
    expect(screen).toContain('width: 40, height: 40, borderRadius: 12, backgroundColor: doc.isImage ? \'#E0F5F4\' : C.soft');
    expect(screen).toContain('numberOfLines={1} ellipsizeMode="tail"');
    expect(screen).toContain('fontFamily: FONT[600], fontSize: 14.5, lineHeight: 20');
    expect(screen).toContain('<ChevronRight size={20}');
  });
  test('the bottom bar is only drawn for a live case; the always-visible Track Details button is gone', () => {
    expect(screen).toContain('{view.showTrackingBar ? (');
    expect(screen).toContain("paddingTop: 12, paddingHorizontal: 16, paddingBottom: 20 + insets.bottom");
    expect(screen).toContain('minHeight: 52, borderRadius: 16, backgroundColor: C.blue');
    expect(screen).toContain("pathname: '/request-tracking', params: { id: request.id }");
    expect(screen).not.toContain('btn_track_details');
    expect(screen).not.toContain('Track Details');
  });
  test('what was there is kept: the load error, the reload after an upload, Document history and Additional documents', () => {
    expect(screen).toContain('<LoadError');
    expect(screen).toContain('<DocumentHistory request={request} styled />');
    expect(screen).toContain('<AdditionalDocuments request={request} onUploaded={reload} />');
    expect(screen).toContain("apiGet(`/requests/me/${id}`)");
  });
  test('no other screen was changed to make this one: TopBar is not used, and the form is not imported', () => {
    expect(screen).not.toContain('TopBar');
    expect(screen).not.toMatch(/request\/step|request\/review/);
  });
});
