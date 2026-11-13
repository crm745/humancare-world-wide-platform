/* global describe, test, expect, __dirname */
// The My Requests screen: what a card shows (from the list API's own fields), that its step agrees with the Tracking
// screen, the header and chips, the states, and that the backend calls and the other screens are as they were.
const fs = require('fs');
const path = require('path');
const { toListItem, serviceKeyFromTitle, toUiStatus: toUiStatusOf } = require('../requestShape');
const { TRACKING_STEPS, trackingPosition, trackingView } = require('../requestTracking');
const { STEP_COUNT, SEGMENT_DONE, SEGMENT_COMPLETED, SEGMENT_TODO, BADGE_BESIDE_MIN_WIDTH, badgeBelowFor, serviceKeyOf, serviceTitleKey, shortPlace, progressOf, cardView, statusCounts } = require('../myRequestsView');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const NL = String.fromCharCode(10);
const codeOf = (source) => source.split(NL).filter((l) => !l.trim().startsWith('//')).join(NL);
const screen = codeOf(read('../../app/my-requests.js'));
const card = codeOf(read('../../components/requests/RequestCard.js'));
const header = codeOf(read('../../components/requests/RequestsHeader.js'));

// t as the app has it: the language's text, then English, then the key; {{values}} filled
const tIn = (lang) => (key, values) => {
  const text = (i18n[lang] && i18n[lang][key]) ?? i18n.EN[key] ?? key;
  return values ? text.replace(/[{][{]\s*([A-Za-z0-9_.]+)\s*[}][}]/g, (m, name) => (values[name] == null ? '' : String(values[name]))) : text;
};
const t = tIn('EN');

const ROW = (over = {}) => ({
  id: 7, referenceNumber: 'REQ-1064', serviceType: 'Ground Ambulance', serviceKey: 'ground', status: 'submitted', createdAt: '2026-11-13T09:00:00.000Z',
  origin: 'Thane, Maharashtra, India', destination: 'Mumbai, Maharashtra, India', ...over,
});
const item = (over) => toListItem(ROW(over));

describe('toListItem only adds fields', () => {
  test('the six fields the list always had keep their values', () => {
    expect(item()).toMatchObject({ id: 'REQ-1064', rawId: 7, service: 'ground', status: 'submitted', date: '2026-11-13' });
    expect(item().display).toBe('13 Nov 2026');
    expect(item({ status: 'in_progress' }).status).toBe('progress');
    expect(item({ serviceType: 'Not A Real Service', serviceKey: undefined }).service).toBe(serviceKeyFromTitle('Not A Real Service'));
  });
  test('the new fields are the backend\'s own values', () => {
    expect(item({ status: 'in_progress' })).toMatchObject({
      rawStatus: 'in_progress', serviceKey: 'ground', serviceType: 'Ground Ambulance', origin: 'Thane, Maharashtra, India', destination: 'Mumbai, Maharashtra, India', createdAt: '2026-11-13T09:00:00.000Z',
    });
  });
  test('a row with nothing optional still shapes (no undefined)', () => {
    const bare = toListItem({ id: 1, referenceNumber: 'REQ-1001', serviceType: 'x', status: 'submitted', createdAt: null });
    expect(bare).toMatchObject({ serviceKey: null, origin: '', destination: '', createdAt: null, date: '' });
  });
  test('the only other user of the old keys, the filters, still finds service, date and status', () => {
    const { applyFilters, DEFAULT_FILTERS } = require('../filters');
    const list = [item(), item({ referenceNumber: 'REQ-1065', createdAt: '2026-11-10T00:00:00.000Z', serviceType: 'Home Healthcare Services', serviceKey: 'homecare' })];
    expect(applyFilters(list, { ...DEFAULT_FILTERS, service: 'ground' }, '2026-11-13').map((r) => r.id)).toEqual(['REQ-1064']);
    expect(applyFilters(list, DEFAULT_FILTERS, '2026-11-13').map((r) => r.id)).toEqual(['REQ-1064', 'REQ-1065']);
  });
  test('the only screen that uses toListItem is My Requests; the others use other helpers of requestShape, which are unchanged', () => {
    const appDir = path.join(__dirname, '../../app');
    const users = fs.readdirSync(appDir).filter((f) => f.endsWith('.js') && /import \{[^}]*\btoListItem\b[^}]*\} from '..\/lib\/requestShape'/.test(fs.readFileSync(path.join(appDir, f), 'utf8')));
    expect(users).toEqual(['my-requests.js']);
    expect(read('../../app/corporate-dashboard.js')).toContain("import { toUiStatus, serviceKeyFromTitle } from '../lib/requestShape';");
    expect(toUiStatusOf('in_progress')).toBe('progress');
  });
});

describe('the step agrees with the Tracking screen, for every status', () => {
  test.each(['submitted', 'in_progress', 'completed'])('%s', (status) => {
    const { index } = trackingPosition({ status });
    const p = progressOf(status);
    const view = trackingView({ status });
    if (status === 'completed') {
      expect(p.kind).toBe('completed');
      expect(p.filled).toBe(STEP_COUNT);
      expect(view.index).toBe(STEP_COUNT - 1);
    } else {
      expect(p.kind).toBe('step');
      expect(p.step).toBe(index + 1);
      expect(p.filled).toBe(view.steps.filter((s) => s.state === 'done' || s.state === 'now').length);
      expect(p.stageKey).toBe(TRACKING_STEPS[index].title);
    }
  });
  test('submitted is step 1 "Request received", in progress is step 4 "In Progress", completed is step 5', () => {
    expect(progressOf('submitted')).toMatchObject({ kind: 'step', step: 1, filled: 1, color: SEGMENT_DONE });
    expect(t(progressOf('submitted').stageKey)).toBe('Request received');
    expect(progressOf('in_progress')).toMatchObject({ kind: 'step', step: 4, filled: 4, color: SEGMENT_DONE });
    expect(t(progressOf('in_progress').stageKey)).toBe('In Progress');
    expect(progressOf('completed')).toMatchObject({ kind: 'completed', filled: 5, color: SEGMENT_COMPLETED });
  });
  test('cancelled: no step, every segment grey', () => {
    expect(progressOf('cancelled')).toMatchObject({ kind: 'cancelled', filled: 0, color: SEGMENT_TODO });
  });
  test('the stage names are the Tracking screen\'s own keys, nowhere else', () => {
    expect(TRACKING_STEPS.map((s) => t(s.title))).toEqual(['Request received', 'Medical review cleared', 'Quote approved', 'In Progress', 'Completed']);
    expect(card).not.toMatch(/Team on the mission|Request received|Medical review/);
    expect(codeOf(read('../myRequestsView.js'))).toContain('TRACKING_STEPS[index].title');
  });
  test('an unknown status never breaks a card: it reads as the first step', () => {
    expect(progressOf('something_new')).toMatchObject({ kind: 'step', step: 1 });
    expect(progressOf(undefined)).toMatchObject({ kind: 'step', step: 1 });
  });
  test('the colours', () => {
    expect([SEGMENT_DONE, SEGMENT_COMPLETED, SEGMENT_TODO]).toEqual(['#1A73E8', '#0B6564', '#E4E9F2']);
    expect(STEP_COUNT).toBe(5);
  });
});

describe('the badge', () => {
  test.each([
    ['submitted', '#FDF0DA', '#8F4C08', 'Submitted'], ['in_progress', '#E7F0FE', '#1A5FC4', 'In Progress'], ['completed', '#E0F5F4', '#0B6564', 'Completed'],
    ['cancelled', '#EEF1F6', '#5B6B84', 'Cancelled'],
  ])('%s', (status, bg, fg, label) => {
    const v = cardView(item({ status }), t);
    expect(v.badge).toEqual({ bg, fg });
    expect(v.statusLabel).toBe(label);
  });
  test('any other status: grey, shown as it is', () => {
    const v = cardView(item({ status: 'on_hold' }), t);
    expect(v.badge).toEqual({ bg: '#EEF1F6', fg: '#5B6B84' });
    expect(v.statusLabel).toBe('on_hold');
  });
  test('the card draws it uppercase with the design\'s padding, size and letter spacing', () => {
    expect(card).toContain("paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999");
    expect(card).toContain("fontSize: 11.5, lineHeight: 14, letterSpacing: 0.575, textTransform: 'uppercase'");
    expect(card).toContain('flexShrink: 0');
  });
});

describe('the badge beside the name, or under it when there is no room', () => {
  test('beside the name from 350 up at normal text size; under it on a narrower screen (320, 330, 345)', () => {
    for (const w of [350, 360, 375, 390, 412, 470, 600]) expect(badgeBelowFor(w, 1)).toBe(false);
    for (const w of [280, 320, 330, 345, 349]) expect(badgeBelowFor(w, 1)).toBe(true);
    expect(BADGE_BESIDE_MIN_WIDTH).toBe(350);
  });
  test('large system text needs more room: the badge goes under the name sooner', () => {
    expect(badgeBelowFor(390, 1.3)).toBe(true);
    expect(badgeBelowFor(470, 1.3)).toBe(false);
    expect(badgeBelowFor(412, 1.15)).toBe(false);
    expect(badgeBelowFor(412, 1.2)).toBe(true);
  });
  test('a text size under 1 or a missing one counts as 1', () => {
    expect(badgeBelowFor(350, 0.8)).toBe(false);
    expect(badgeBelowFor(320, undefined)).toBe(true);
    expect(badgeBelowFor(350, 0)).toBe(false);
    expect(badgeBelowFor(350, NaN)).toBe(false);
  });
  test('the card draws the one badge in either place, and it never shrinks', () => {
    expect(card).toContain('const badgeBelow = badgeBelowFor(width, fontScale);');
    expect(card).toContain('{badgeBelow ? <View style={{ marginTop: 6 }}>{badge}</View> : null}');
    expect(card).toContain('{badgeBelow ? null : badge}');
    expect(card.split('{v.statusLabel}').length - 1).toBe(2); // the badge, and "Completed" / "Cancelled" in the progress line
    expect(card).toContain('flexShrink: 0');
  });
});

describe('the route row', () => {
  test('shows only the part before the first comma', () => {
    expect(shortPlace('Mumbai, Maharashtra, India')).toBe('Mumbai');
    expect(shortPlace('  Thane  ')).toBe('Thane');
    expect(cardView(item(), t).route).toEqual({ from: 'Thane', to: 'Mumbai' });
  });
  test('only an origin, or only a destination, shows just that one', () => {
    expect(cardView(item({ destination: '' }), t).route).toEqual({ from: 'Thane', to: '' });
    expect(cardView(item({ origin: '' }), t).route).toEqual({ from: '', to: 'Mumbai' });
  });
  test('neither hides the row', () => {
    expect(cardView(item({ origin: '', destination: '' }), t).route).toBeNull();
    expect(cardView(item({ origin: '  ', destination: null }), t).route).toBeNull();
    expect(card).toContain('{v.route ? (');
  });
  test('free text without a comma stays whole', () => {
    expect(cardView(item({ origin: 'Kokilaben Hospital', destination: 'Airport' }), t).route).toEqual({ from: 'Kokilaben Hospital', to: 'Airport' });
  });
  test('the card draws the pin, the cities and the arrow with the design\'s sizes', () => {
    expect(card).toContain('<MapPin size={16} color={MUTED} />');
    expect(card).toContain('<ArrowRight size={14} color="#8A97AB" />');
    expect(card).toContain("fontFamily: FONT[600], fontSize: 14, lineHeight: 20, color: INK");
    expect(card).toContain("flexWrap: 'wrap', gap: 8");
  });
});

describe('the service: its icon and its name, as on Home', () => {
  test('the service key first, with a suffix such as _stretcher or _domestic ignored', () => {
    expect(serviceKeyOf({ serviceKey: 'commercialair_stretcher', serviceType: 'Anything' })).toBe('commercialair');
    expect(serviceKeyOf({ serviceKey: 'mortal_domestic', serviceType: 'Anything' })).toBe('mortal');
    expect(serviceKeyOf({ serviceKey: 'privatecharter', serviceType: 'Anything' })).toBe('privatecharter');
    expect(serviceKeyOf({ serviceKey: 'tele' })).toBe('tele');
  });
  test('then the title it was saved with, then the generic Air Ambulance', () => {
    expect(serviceKeyOf({ serviceKey: null, serviceType: 'Ground Ambulance' })).toBe('ground');
    expect(serviceKeyOf({ serviceKey: 'unknown_key', serviceType: 'Home Healthcare Services' })).toBe('homecare');
    expect(serviceKeyOf({ serviceType: 'A service nobody has heard of' })).toBe('air');
    expect(serviceKeyOf({})).toBe('air');
    expect(serviceKeyOf(null)).toBe('air');
  });
  test('prototype names are not service keys', () => {
    expect(serviceKeyOf({ serviceKey: 'constructor', serviceType: 'Ground Ambulance' })).toBe('ground');
    expect(serviceKeyOf({ serviceKey: '__proto__' })).toBe('air');
  });
  test('the name is the same text Home shows, in the language of the app; unknown services show their own text', () => {
    expect(cardView(item(), t).name).toBe('Ground Ambulance');
    expect(cardView(item({ serviceKey: 'commercialair_stretcher' }), t).name).toBe('Commercial Airlines');
    expect(cardView(item({ serviceKey: 'privatecharter' }), t).name).toBe('Private Charter Air Ambulance Service');
    expect(cardView(item({ serviceKey: 'tele' }), tIn('HI')).name).toBe(i18n.HI.svc_tele);
    expect(serviceTitleKey('nothing')).toBeNull();
  });
  test('every service a request can have has a name in all six languages', () => {
    for (const key of ['air', 'privatecharter', 'commercialair', 'ground', 'hospital', 'mortal', 'homecare', 'tele', 'corporate']) {
      const titleKey = serviceTitleKey(key);
      expect(titleKey).toBeTruthy();
      for (const lang of Object.keys(i18n)) expect(i18n[lang][titleKey]).toBeTruthy();
    }
  });
  test('the card uses Home\'s own ServiceIcon, unchanged, at 22 in the 46 tile, with Home\'s colours', () => {
    expect(card).toContain("import { ServiceIcon } from '../home/ServiceIcon';");
    expect(card).toContain('<ServiceIcon serviceKey={v.key} size={22} color={NAVY} fill={NAVY} fillOpacity={0.12} />');
    expect(card).toContain("width: 46, height: 46, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2'");
    expect(card).not.toMatch(/lucide-react-native'.*(Plane|Truck|Ambulance)/);
  });
});

describe('the card text', () => {
  test('"REQ-1064 · 13 Nov 2026" in the existing date format; just the number without a date', () => {
    expect(cardView(item(), t).sub).toBe('REQ-1064 · 13 Nov 2026');
    expect(cardView(item({ createdAt: null }), t).sub).toBe('REQ-1064');
  });
  test('the name, date, step and button use the design\'s sizes and weights', () => {
    expect(card).toContain('fontFamily: FONT[800], fontSize: 16, lineHeight: 22, color: NAVY');
    expect(card).toContain('fontFamily: FONT[400], fontSize: 13, lineHeight: 18, color: MUTED');
    expect(card).toContain('fontFamily: FONT[700], color: INK');
    expect(card).toContain('fontFamily: FONT[500], color: MUTED');
    expect(card).toContain("fontFamily: FONT[700], fontSize: 14.5, color: '#1A5FC4'");
    expect(card).toContain('minHeight: 44');
    expect(card).toContain('<ChevronRight size={16} color="#1A5FC4" strokeWidth={2.2} />');
  });
  test('the card is white with a 1px #E9EEF6 border, radius 18, padding 16 16 4, a 12 gap and a faint shadow', () => {
    expect(card).toContain("backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E9EEF6', borderRadius: 18, paddingTop: 16, paddingHorizontal: 16, paddingBottom: 4, gap: 12");
    expect(card).toContain("shadowColor: '#0D2340', shadowOpacity: 0.04, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }");
  });
  test('the progress block: a 1px #EEF1F6 top border, 12 padding, 6 gap, five 6-tall segments with a 4 gap and radius 3', () => {
    expect(card).toContain("borderTopWidth: 1, borderTopColor: '#EEF1F6', paddingTop: 12, gap: 6");
    expect(card).toContain("flexDirection: 'row', gap: 4");
    expect(card).toContain('height: 6, borderRadius: 3');
    expect(card).toContain('Array.from({ length: STEP_COUNT }');
  });
  test('Step n of 5, then the Tracking stage name; "Completed" or "Cancelled" alone for those two', () => {
    expect(t('mr_step_of', { n: 4, total: 5 })).toBe('Step 4 of 5');
    expect(card).toContain("t('mr_step_of', { n: progress.step, total: STEP_COUNT })");
    expect(card).toContain('` · ${t(progress.stageKey)}`');
    expect(card).toContain("progress.kind === 'cancelled' ? MUTED : INK");
    expect(card).not.toContain('updatedAt');
  });
});

describe('the accessibility label of a card', () => {
  test('service, reference, status and step', () => {
    const v = cardView(item({ origin: '', destination: '' }), t);
    expect(v.label).toBe('Ground Ambulance, REQ-1064, Submitted, step 1 of 5');
  });
  test('in progress is step 4; completed says step 5; cancelled has no step', () => {
    expect(cardView(item({ status: 'in_progress', origin: '', destination: '' }), t).label).toBe('Ground Ambulance, REQ-1064, In Progress, step 4 of 5');
    expect(cardView(item({ status: 'completed', origin: '', destination: '' }), t).label).toBe('Ground Ambulance, REQ-1064, Completed, step 5 of 5');
    expect(cardView(item({ status: 'cancelled', origin: '', destination: '' }), t).label).toBe('Ground Ambulance, REQ-1064, Cancelled');
  });
  test('the full place names go into the label, even though the card shows only the cities', () => {
    expect(cardView(item(), t).label).toBe('Ground Ambulance, REQ-1064, Submitted, step 1 of 5, Thane, Maharashtra, India to Mumbai, Maharashtra, India');
    expect(cardView(item({ destination: '' }), t).label).toContain('Thane, Maharashtra, India');
    expect(cardView(item({ destination: '' }), t).label).not.toContain(' to ');
  });
  test('it is said in the language of the app', () => {
    const hi = cardView(item(), tIn('HI')).label;
    expect(hi).toContain(i18n.HI.svc_ground);
    expect(hi).toContain('चरण 1 / 5');
    expect(hi).toContain('से Mumbai, Maharashtra, India');
  });
  test('the card is one button with that label and the "View details" hint; the button text is not a second button', () => {
    expect(card).toContain('accessibilityRole="button"');
    expect(card).toContain("accessibilityLabel={`${v.label}. ${t('mr_view_details')}`}");
    expect(card.split('accessibilityRole="button"').length - 1).toBe(1);
    expect(card.split('<Pressable').length - 1).toBe(1);
  });
});

describe('the status chips', () => {
  const LIST = [item(), item({ status: 'in_progress' }), item({ status: 'in_progress' }), item({ status: 'completed' }), item({ status: 'cancelled' }), item({ status: 'on_hold' })];
  test('counts come from the whole loaded list', () => {
    expect(statusCounts(LIST)).toEqual({ all: 6, submitted: 1, progress: 2, completed: 1, cancelled: 1 });
    expect(statusCounts([])).toEqual({ all: 0, submitted: 0, progress: 0, completed: 0, cancelled: 0 });
  });
  test('All, Submitted, In progress, Completed and, last, Cancelled', () => {
    expect(screen).toContain("const STATUSES = ['all', 'submitted', 'progress', 'completed', 'cancelled'];");
    expect(screen).toContain("t(s === 'all' ? 'chip_all' : s === 'progress' ? 'mr_chip_progress' : 'status_' + s)");
    expect([t('chip_all'), t('status_submitted'), t('mr_chip_progress'), t('status_completed'), t('status_cancelled')]).toEqual(['All', 'Submitted', 'In progress', 'Completed', 'Cancelled']);
  });
  test('the counts do not follow the search or the filter', () => {
    expect(screen).toContain('const counts = statusCounts(requests);');
  });
  test('each chip: height 38, radius 999, padding 0 8 0 14, 14 / 700, 8 gap, with a count bubble', () => {
    expect(header).toContain('height: 38, borderRadius: 999, paddingLeft: 14, paddingRight: 8');
    expect(header).toContain("flexDirection: 'row', alignItems: 'center', gap: 8");
    expect(header).toContain("fontFamily: FONT[700], fontSize: 14");
    expect(header).toContain('minWidth: 22, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 999');
    expect(header).toContain("fontFamily: FONT[800], fontSize: 12");
  });
  test('selected: #0D2340 with white text and a rgba(255,255,255,0.18) bubble; not selected: white, a 1px #E4E9F2 border, #17233D text, a #EEF1F6 bubble with #5B6B84 text', () => {
    expect(header).toContain("backgroundColor: on ? NAVY : '#FFFFFF', borderWidth: on ? 0 : 1, borderColor: LINE");
    expect(header).toContain("color: on ? '#FFFFFF' : INK");
    expect(header).toContain("backgroundColor: on ? 'rgba(255,255,255,0.18)' : '#EEF1F6'");
    expect(header).toContain("color: on ? '#FFFFFF' : MUTED");
  });
  test('they scroll sideways with an 8 gap; a chip is a button with a selected state and a 44-point touch area', () => {
    expect(header).toContain('<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>');
    expect(header).toContain('accessibilityState={{ selected: on }}');
    expect(header).toContain('hitSlop={{ top: 3, bottom: 3 }}');
  });
});

describe('the header', () => {
  test('white, a 1px #E4E9F2 bottom border, padding 20 top / 23 sides / 14 bottom, a 16 gap between rows', () => {
    expect(header).toContain("backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: LINE, paddingTop: 20, paddingHorizontal: 23, paddingBottom: 14, gap: 16");
  });
  test('back button 52x52, radius 14, #EEF3FB, chevron 22 stroke 2.2; title 20 / 26 / 800 #0D2340 after a 14 gap', () => {
    expect(header).toContain('width: 52, height: 52, borderRadius: 14, backgroundColor: SOFT');
    expect(header).toContain('<ChevronLeft size={22} strokeWidth={2.2} color={NAVY} />');
    expect(header).toContain("flexDirection: 'row', alignItems: 'center', gap: 14");
    expect(header).toContain('fontFamily: FONT[800], fontSize: 20, lineHeight: 26, color: NAVY');
  });
  test('search field: height 50, #F5F8FC, a 1px #E4E9F2 border, radius 14, padding 0 14, 10 gap, a 20 icon, 15 text', () => {
    expect(header).toContain("height: 50, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderRadius: 14, backgroundColor: '#F5F8FC', borderWidth: 1, borderColor: LINE");
    expect(header).toContain('<Search size={20} color={MUTED} />');
    expect(header).toContain("fontFamily: 'Inter_400Regular', fontSize: 15");
  });
  test('filter button 50x50, radius 14, #EEF3FB, a 20 sliders icon, with a 10 gap before it', () => {
    expect(header).toContain('width: 50, height: 50, borderRadius: 14, backgroundColor: SOFT');
    expect(header).toContain('<SlidersHorizontal size={20} color={NAVY} />');
  });
  test('built inside My Requests: the shared TopBar and SearchHeader are not used, and not changed', () => {
    expect(screen).not.toMatch(/TopBar|SearchHeader/);
    expect(read('../../components/SearchHeader.js')).toContain('export function SearchHeader(');
    expect(read('../../app/corporate-dashboard.js')).toContain('<SearchHeader');
  });
  test('the back button keeps its behaviour (goBack), and flips in right-to-left', () => {
    expect(screen).toContain('onBack={goBack}');
    expect(header).toContain('transform: [{ scaleX: -1 }]');
  });
  test('the placeholder, the filter and back labels come from i18n', () => {
    expect(screen).toContain("searchPlaceholder={t('mr_search_ph')}");
    expect(screen).toContain("filterLabel={t('filter_requests_title')}");
    expect(screen).toContain("backLabel={t('home_back')}");
    expect(t('mr_search_ph')).toBe('Search by request ID or service');
  });
});

describe('the list and its states', () => {
  test('the list: padding 16 top, 23 sides, 24 bottom (plus the tab bar), a 12 gap; newest first (the filters sort)', () => {
    expect(screen).toContain('paddingTop: 16, paddingHorizontal: 23, paddingBottom: 24 + TAB_BAR + insets.bottom, gap: 12');
    expect(screen).toContain('applyFilters(requests, filters, today)');
  });
  test('the same request, and a card opens the same details screen as before', () => {
    expect(screen).toContain("apiGet('/requests/me')");
    expect(screen.split('apiGet(').length - 1).toBe(1);
    expect(screen).toContain("router.push({ pathname: '/request-details', params: { id: r.rawId } })");
    expect(screen).not.toMatch(/apiPost|apiPatch|apiUpload|fetch\(/);
  });
  test('pull to refresh: the system spinner, the same request, a failed refresh keeps the list', () => {
    expect(screen).toContain('refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}');
    expect(screen).toContain('const onRefresh = async () => {');
    expect(screen).toContain('.catch((err) => toast(err.message))');
    expect(screen).toContain("load().finally(() => setLoading(false));");
  });
  test('the first load shows the loading state', () => {
    expect(screen).toContain('{loading && <LoadingState />}');
    expect(screen).toContain('useState(true)');
  });
  test('a search or filter with no match says "No requests match"; no requests at all keeps the old empty state', () => {
    expect(screen).toContain('{!loading && requests.length > 0 && items.length === 0 && (');
    expect(screen).toContain("{t('mr_no_match')}");
    expect(screen).toContain('{!loading && requests.length === 0 && (');
    expect(screen).toContain("{t('mr_empty_title')}");
    expect(screen).toContain("{t('mr_empty_sub')}");
    expect(screen).toContain("fontFamily: 'Inter_400Regular', fontSize: 15, color: '#5B6B84', textAlign: 'center'");
  });
  test('search finds a request by number, by the service name shown, or by the service type it was saved with', () => {
    expect(screen).toContain('r.id.toLowerCase().includes(q)');
    expect(screen).toContain('cardView(r, t).name.toLowerCase().includes(q)');
    expect(screen).toContain('r.serviceType.toLowerCase().includes(q)');
  });
  test('the status param from the Profile overview still works', () => {
    expect(screen).toContain("useState(params.status || 'all')");
    expect(screen).toContain("(status === 'active' ? ['submitted', 'progress'].includes(r.status) : r.status === status)");
  });
  test('the bottom navigation and the filter sheet are as they were', () => {
    expect(screen).toContain('<BottomNav />');
    expect(screen).toContain('<FilterSheet visible={sheet} onClose={() => setSheet(false)} title={t(\'filter_requests_title\')} services={FILTER_SERVICES} value={filters} onApply={setFilters} />');
  });
});

describe('translations of the new labels', () => {
  const KEYS = ['mr_search_ph', 'mr_chip_progress', 'mr_no_match', 'mr_step_of', 'mr_a11y_step', 'mr_a11y_route', 'mr_view_details'];
  test('every key exists in all six languages, and the other five are translated', () => {
    expect(Object.keys(i18n)).toHaveLength(6);
    for (const lang of Object.keys(i18n)) for (const key of KEYS) expect(i18n[lang][key]).toBeTruthy();
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) for (const key of KEYS) expect(i18n[lang][key]).not.toBe(i18n.EN[key]);
  });
  test('the {{placeholders}} are the same in every language', () => {
    const names = (s) => (s.match(/[{][{][a-z]+[}][}]/g) || []).sort().join();
    for (const key of ['mr_step_of', 'mr_a11y_step', 'mr_a11y_route']) for (const lang of Object.keys(i18n)) expect(names(i18n[lang][key])).toBe(names(i18n.EN[key]));
  });
});

describe('what was not touched', () => {
  test('Home\'s ServiceIcon is used as it is: this change adds no prop to it', () => {
    expect(codeOf(read('../../components/home/ServiceIcon.js'))).toContain('export function ServiceIcon({ serviceKey, size = 24, color, fill, fillOpacity = 0.3 })');
  });
  test('no other screen was edited for this: Request details, tracking and the shared Card/Pill still exist as they were', () => {
    expect(read('../../components/ui.js')).toContain('export function Pill(');
    expect(read('../../app/request-details.js')).toContain("apiGet(`/requests/me/${id}`)");
    expect(read('../../app/request-tracking.js')).toContain('/requests/me/${id}');
  });
});
