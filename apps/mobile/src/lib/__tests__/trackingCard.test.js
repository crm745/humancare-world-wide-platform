/* global describe, test, expect, __dirname */
// The Tracking tab's own card: no status pill, no full-width button, the stage line with its fallbacks, and the Home / My Requests card left as it was. Dummy data only.
const fs = require('fs');
const path = require('path');
const { trackingCardView, matchesTrackingQuery, activeRequestsOf } = require('../activeRequests');

const SRC = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8').split('\r\n').join('\n');
const dict = { mr_step_of: 'Step {{n}} of {{total}}', mr_a11y_step: 'step {{n}} of {{total}}', rd_updated: 'Updated {{when}}', tb_min_ago: '{{n}} min ago', tb_say_min_other: '{{n}} minutes ago', tb_say_min_one: '{{n}} minute ago' };
const t = (key, vars) => String(dict[key] || key).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
const NOW = Date.parse('2026-11-26T10:00:00.000Z');
const item = (over = {}) => ({
  id: 'REQ-1194', rawId: 11, status: 'submitted', serviceType: 'medical_escort', createdAt: '2026-11-26T08:00:00.000Z',
  raw: { id: 11, referenceNumber: 'REQ-1194', serviceType: 'medical_escort', status: 'submitted', updatedAt: '2026-11-26T09:58:00.000Z', ...over },
});

describe('trackingCardView', () => {
  test('stage, step and updated line', () => {
    const v = trackingCardView(item(), t, NOW);
    expect(v.reference).toBe('REQ-1194');
    expect(v.stage).toBeTruthy();
    if (v.progress) expect(v.stepText).toBe(`Step ${v.progress.step} of ${v.progress.total}`);
    expect(v.updated).toBe('2 min ago');
    expect(v.subline).toContain('Updated 2 min ago');
    expect(v.label).toContain('REQ-1194');
    expect(v.label).toContain('Updated 2 minutes ago');
  });
  test('"Updated" is left out when there is no last-updated time', () => {
    const v = trackingCardView({ ...item(), raw: { ...item().raw, updatedAt: undefined } }, t, NOW);
    if (!v.updated) expect(v.subline).not.toContain('Updated');
    const bare = trackingCardView({ id: 'REQ-1', rawId: 1, status: 'submitted', serviceType: 'x', raw: { id: 1, serviceType: 'x', status: 'submitted' } }, t, NOW);
    expect(bare.updated).toBe('');
    expect(bare.subline).not.toContain('Updated');
  });
  test('the stage line falls back to the status label when the stage is missing, and "Step x of n" is left out with no steps', () => {
    const bare = trackingCardView({ id: 'REQ-1', rawId: 1, status: 'submitted', serviceType: 'x', raw: { id: 1, serviceType: 'x', status: 'submitted' } }, t, NOW);
    if (!bare.progress) { expect(bare.stage).toBeTruthy(); expect(bare.stepText).toBe(''); expect(bare.subline).not.toContain('Step'); }
  });
});

describe('the Tracking card component', () => {
  const card = read('components/tracking/TrackingRequestCard.js');
  test('no status pill and no full-width Track Request button', () => {
    expect(card).not.toContain('badge');
    expect(card).not.toContain('statusLabel');
    expect(card).not.toContain('home_track_request');
  });
  test('the card and the Track button both call onTrack; the button label carries the request number', () => {
    expect(card.match(/onPress=\{onTrack\}/g).length).toBe(3);
    expect(card).toContain("accessibilityLabel={`${t('tr_track')}, ${v.reference}`}");
    expect(card).toContain('accessibilityLabel={v.label}');
  });
  test('sizes of the design', () => {
    expect(card).toContain('borderRadius: 16, padding: 14, gap: 10');
    expect(card).toContain('height: 36, paddingStart: 12, paddingEnd: 4, borderRadius: 10');
    expect(card).toContain('height: 5');
    expect(card).toContain('scaleX: -1');
  });
  test('the variant shows only when the view has one (nameAndVariant drops it when it is in the name)', () => {
    expect(card).toContain('{v.variant ?');
  });
});

describe('the screen and the other cards', () => {
  test('Tracking uses the new card; Home and My Requests keep the ActiveRequestCard', () => {
    expect(read('app/(tabs)/active-tracking.js')).toContain('<TrackingRequestCard');
    expect(read('app/(tabs)/active-tracking.js')).not.toContain('ActiveRequestCard');
    expect(read('app/(tabs)/my-requests.js')).toContain('<ActiveRequestCard');
    expect(read('components/home/ActiveRequestCard.js')).toContain('home_track_request');
    // the compact My Requests button says just "Track" (tr_track); the full Home card keeps "Track Request" (home_track_request)
    const cardSrc = read('components/home/ActiveRequestCard.js');
    expect(cardSrc.slice(cardSrc.indexOf(') : ('))).not.toContain('tr_track');
    expect(cardSrc.slice(cardSrc.indexOf('{S.inline ? ('), cardSrc.indexOf(') : ('))).toContain("{t('tr_track')}");
  });
  test('the new "Track" label exists in all six languages', () => {
    const json = JSON.parse(read('data/i18n.json'));
    const blocks = JSON.stringify(json).match(/"tr_track":/g);
    expect(blocks.length).toBe(6);
  });
});

describe('the Tracking search (matchesTrackingQuery)', () => {
  const charter = { ...item({ serviceType: 'Air Ambulance', serviceKey: 'privatecharter', origin: 'Mumbai', destination: 'Delhi' }), serviceType: 'Air Ambulance', serviceKey: 'privatecharter', origin: 'Mumbai', destination: 'Delhi' };
  const nothing = { id: 'REQ-9', rawId: 9, status: 'submitted', raw: { id: 9, status: 'submitted' } };
  test('reference, service name, raw service type, variant, origin and destination all match', () => {
    expect(matchesTrackingQuery(charter, 'req-1194', t)).toBe(true);
    expect(matchesTrackingQuery(charter, 'svc_air', t)).toBe(true); // the displayed name (t returns the key in this test)
    expect(matchesTrackingQuery(charter, 'air ambulance', t)).toBe(true); // raw service type
    expect(matchesTrackingQuery(charter, 'tb_short_charter', t)).toBe(true); // variant
    expect(matchesTrackingQuery(charter, 'mumbai', t)).toBe(true);
    expect(matchesTrackingQuery(charter, 'delhi', t)).toBe(true);
    expect(matchesTrackingQuery(charter, 'london', t)).toBe(false);
  });
  test('case-insensitive, trimmed; an empty search matches everything', () => {
    expect(matchesTrackingQuery(charter, '  MuMbAi  ', t)).toBe(true);
    expect(matchesTrackingQuery(charter, '   ', t)).toBe(true);
    expect(matchesTrackingQuery(charter, '', t)).toBe(true);
    expect(matchesTrackingQuery(charter, null, t)).toBe(true);
    expect(matchesTrackingQuery(charter, undefined, t)).toBe(true);
  });
  test('missing or null fields never throw', () => {
    expect(matchesTrackingQuery(nothing, 'x', t)).toBe(false);
    expect(matchesTrackingQuery({ ...nothing, origin: null, destination: undefined, serviceType: null }, 'req-9', t)).toBe(true);
    expect(matchesTrackingQuery(null, 'x', t)).toBe(false);
  });
  test('searching keeps the active filter and the priority order', () => {
    const a = { ...item(), id: 'REQ-A', rawId: 1, raw: { ...item().raw, id: 1, updatedAt: '2026-11-20T00:00:00Z' } };
    const b = { ...item(), id: 'REQ-B', rawId: 2, raw: { ...item().raw, id: 2, updatedAt: '2026-11-25T00:00:00Z' } };
    const c = { ...item(), id: 'REQ-C', rawId: 3, raw: { ...item().raw, id: 3, reviewStatus: 'awaiting_documents', updatedAt: '2026-11-01T00:00:00Z' } };
    const done = { ...item(), id: 'REQ-D', rawId: 4, status: 'completed', raw: { ...item().raw, id: 4, status: 'completed' } };
    const shown = activeRequestsOf([a, b, c, done]).filter((r) => matchesTrackingQuery(r, 'req-', t));
    expect(shown.map((r) => r.id)).toEqual(['REQ-C', 'REQ-B', 'REQ-A']);
  });
});

describe('Tracking screen: search, states and navigation', () => {
  const screen = read('app/(tabs)/active-tracking.js');
  test('the search narrows the already-loaded list, with its own no-match state apart from the no-active state', () => {
    expect(screen).toContain('const shown = active.filter((r) => matchesTrackingQuery(r, query, t));');
    expect(screen).toContain('{shown.map((r) => (');
    expect(screen).toContain('active.length > 0 && shown.length === 0');
    expect(screen).toContain("t('tr_no_match_title')");
    expect(screen).toContain("t('tr_empty_title')");
    expect(screen).toContain('active.length === 0 &&');
    expect(screen).not.toMatch(/apiGet|fetch\(/); // search makes no call of its own
  });
  test('clear button empties the search; placeholder and clear label are translated', () => {
    const search = read('components/tracking/TrackingSearch.js');
    expect(search).toContain("onPress={() => onChange('')}");
    expect(search).toContain("t('docs_clear_search')");
    expect(search).toContain("t('tr_search_ph')");
  });
  test('every card target opens /request-tracking with that request id; the Tracking list never opens Request Details', () => {
    expect(screen).toContain("onTrack={() => router.push({ pathname: '/request-tracking', params: { id: r.rawId } })}");
    expect(screen).not.toContain('request-details');
    const card = read('components/tracking/TrackingRequestCard.js');
    expect(card.match(/onPress=\{onTrack\}/g).length).toBe(3);
    expect(card).not.toContain('onOpen');
  });
  test('the three new texts exist in all six languages', () => {
    const json = JSON.parse(read('data/i18n.json'));
    for (const key of ['tr_search_ph', 'tr_no_match_title', 'tr_no_match_sub']) expect(JSON.stringify(json).match(new RegExp(`"${key}":`, 'g')).length).toBe(6);
  });
});

describe('Tracking Details has no Open Request button, and the other screens are as they were', () => {
  test('no button, no handler, no flag', () => {
    expect(read('components/tracking/TrackingDetails.js')).not.toMatch(/tcp_open_request|openRequest|onOpenRequest/);
    expect(read('lib/trackingDetailsView.js')).not.toMatch(/openRequest|showOpenRequest/);
    expect(read('app/request-tracking.js')).not.toMatch(/request-details|onOpenRequest|router\.push/);
  });
  test('Home, My Requests, Request Details and the corporate Case screen keep their navigation', () => {
    expect(read('app/(tabs)/home.js')).toContain("pathname: '/request-details'");
    expect(read('app/(tabs)/home.js')).toContain("pathname: '/request-tracking'");
    expect(read('app/(tabs)/my-requests.js')).toContain("pathname: '/request-details'");
    expect(read('app/request-details.js')).toContain("pathname: '/request-tracking'");
    expect(read('app/(tabs)/corporate-dashboard.js')).toContain("pathname: '/tracking'");
    expect(read('app/tracking.js')).toContain('PrivateCharterTimelineSection');
  });
});

describe('the compact variant of ActiveRequestCard (My Requests); Home keeps the full card', () => {
  const card = read('components/home/ActiveRequestCard.js');
  test('one component with a variant prop, full by default', () => {
    expect(card).toContain("variant = 'full' })");
    expect(card).toContain('const S = SIZES[variant] || SIZES.full;');
    expect(card.match(/export function ActiveRequestCard/g).length).toBe(1);
  });
  test('the compact sizes are the design\'s, and the full sizes are the original ones', () => {
    const { SIZES } = { SIZES: card.slice(card.indexOf('const SIZES'), card.indexOf('function Route')) };
    expect(SIZES).toContain('pad: 14, radius: 16, gap: 10');
    expect(SIZES).toContain('tile: 40, tileRadius: 11');
    expect(SIZES).toContain('name: [15, 20], sub: [12.5, 17]');
    expect(SIZES).toContain("pill: { py: 3, px: 9, radius: 11, size: 12, line: 16, max: '42%' }");
    expect(SIZES).toContain('route: [13.5, 18], dot: 6, hollow: 7, seg: 5, segGap: 4, bar: 6');
    expect(SIZES).toContain('track: { minHeight: 36, radius: 10, size: 14, arrow: 15 }');
    expect(SIZES).toContain('pad: 16, radius: 18, gap: 14');
    expect(SIZES).toContain('track: { minHeight: 46, radius: 12, size: 15, arrow: 18 }');
  });
  test('the Track Request button stays full width with the same key and action; touch area at least 48', () => {
    expect(card).toContain("t('home_track_request')");
    expect(card).toContain('onPress={onTrack}');
    expect(card).toContain('Math.ceil((48 - S.track.minHeight) / 2)');
  });
  test('My Requests uses the compact variant for active requests; Home passes no variant; completed cards keep RequestCard', () => {
    const mine = read('app/(tabs)/my-requests.js');
    expect(mine).toContain('<ActiveRequestCard key={r.id} variant="compact"');
    expect(mine).toContain("onTrack={() => router.push({ pathname: '/request-tracking', params: { id: r.rawId } })}");
    expect(mine).toContain('<RequestCard key={r.id}');
    expect(read('components/home/ActiveRequestCard.js').match(/variant=/g)).toBeNull();
    expect(read('app/(tabs)/home.js')).not.toContain('variant="compact"');
  });
});

describe('My Requests compact card and the Tracking card share their measurements', () => {
  const mine = read('components/home/ActiveRequestCard.js');
  const tracking = read('components/tracking/TrackingRequestCard.js');
  const compact = mine.slice(mine.indexOf('  compact: {'), mine.indexOf('};', mine.indexOf('  compact: {')));
  test('card, tile, name, reference, route and bar sizes are the same numbers', () => {
    expect(compact).toContain('pad: 14, radius: 16, gap: 10');
    expect(tracking).toContain('borderRadius: 16, padding: 14, gap: 10');
    expect(compact).toContain('tile: 40, tileRadius: 11');
    expect(tracking).toContain('size={40}');
    expect(tracking).toContain('radius={11}');
    expect(compact).toContain('name: [15, 20], sub: [12.5, 17]');
    expect(tracking).toContain('fontSize: 15, lineHeight: 20');
    expect(tracking).toContain('fontSize: 12.5, lineHeight: 17');
    expect(compact).toContain('route: [13.5, 18]');
    expect(tracking).toContain('fontSize: 13.5, lineHeight: 18');
    expect(compact).toContain('seg: 5, segGap: 4');
    expect(tracking).toContain('height: 5');
    expect(tracking).toContain('gap: 4');
  });
  test('the My Requests Track Request button is as tall as the Tracking Track button (36), with a 48 touch area', () => {
    expect(compact).toContain('track: { minHeight: 36');
    expect(tracking).toContain('height: 36');
    expect(mine).toContain('Math.ceil((48 - S.track.minHeight) / 2)');
  });
});

describe('the compact My Requests card: step line and Track Request share one row, like Tracking', () => {
  const card = read('components/home/ActiveRequestCard.js');
  test('only the compact variant is inline; the full Home card keeps the button under the step line', () => {
    const full = card.slice(card.indexOf('  full: {'), card.indexOf('  compact: {'));
    const compact = card.slice(card.indexOf('  compact: {'), card.indexOf('};', card.indexOf('  compact: {')));
    expect(compact).toContain('inline: true');
    expect(full).not.toContain('inline');
    expect(card).toContain('if (S.inline) return segments;');
  });
  test('the row: the step text on the left (opens the details), the Track Request button on the right (opens tracking)', () => {
    const row = card.slice(card.indexOf('{S.inline ? ('), card.indexOf(') : ('));
    expect(row).toContain('<PressBox accessible={false} importantForAccessibility="no" onPress={onOpen}');
    expect(row).toContain('<StepLine progress={v.progress} stage={v.stage} t={t} S={S} />');
    expect(row).toContain('onPress={onTrack}');
    expect(row.indexOf('StepLine')).toBeLessThan(row.indexOf('onPress={onTrack}'));
  });
  test('the button: same label and key, request number in its accessibility label, 36 high, 48 touch area, wraps in long languages, arrow mirrored', () => {
    const row = card.slice(card.indexOf('{S.inline ? ('), card.indexOf(') : ('));
    expect(row).toContain("accessibilityLabel={`${t('tr_track')}, ${v.reference}`}");
    expect(row).toContain('Math.ceil((48 - S.track.minHeight) / 2)');
    expect(row).toContain("maxWidth: '55%'");
    expect(row).toContain('flexShrink: 1, fontFamily: FONT[800]'); // the label wraps instead of clipping
    expect(row).toContain('scaleX: -1');
  });
  test('a card with no steps still has the button, on the right', () => {
    const row = card.slice(card.indexOf('{S.inline ? ('), card.indexOf(') : ('));
    expect(row).toContain('{v.progress ? <StepLine');
    expect(row).toContain('flex: 1, minWidth: 0');
  });
});
