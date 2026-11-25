/* global describe, test, expect, __dirname */
// Home's "Active Requests" section and the active-request card (lib/activeRequests.js, components/home/ActiveRequestCard.js): 0 / 1 / 2 / 3+ active requests, the order, one definition of "active"
// shared with My Requests, the name shown once, the variant and stage rules, no bar without steps, navigation per card, six languages and RTL. Mock requests with dummy values only; no device.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { translate } = require('../translate');
const { toListItem } = require('../requestShape');
const { isActiveRequest, statusCounts, ACTIVE_STATUSES } = require('../myRequestsView');
const A = require('../activeRequests');

const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const tFor = (lang) => (key, values) => translate(I18N, lang, key, values);
const t = tFor('EN');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');

let n = 0;
const req = (extra = {}) => {
  n += 1;
  return {
    id: 100 + n, referenceNumber: `REQ-${1000 + n}`, serviceType: 'Ground Ambulance', serviceKey: 'ground', status: 'submitted', reviewStatus: null,
    origin: 'Pune, Maharashtra, India', destination: 'Mumbai, Maharashtra, India', createdAt: `2026-11-${String(10 + n).padStart(2, '0')}T09:00:00.000Z`, updatedAt: `2026-11-${String(10 + n).padStart(2, '0')}T09:00:00.000Z`, ...extra,
  };
};
const items = (list) => list.map(toListItem);

describe('which requests are active (the ONE definition, shared with My Requests)', () => {
  test('submitted and in progress are active; completed and cancelled are not', () => {
    expect(ACTIVE_STATUSES).toEqual(['submitted', 'progress']);
    const list = items([req({ status: 'submitted' }), req({ status: 'in_progress' }), req({ status: 'completed' }), req({ status: 'cancelled' })]);
    expect(list.map(isActiveRequest)).toEqual([true, true, false, false]);
  });
  test('the count on Home equals the Active count of My Requests, always', () => {
    const list = items([req(), req({ status: 'in_progress' }), req({ status: 'completed' }), req(), req({ status: 'cancelled' }), req({ status: 'in_progress' })]);
    expect(A.homeActiveSection(list).count).toBe(statusCounts(list).active);
    expect(statusCounts(list).active).toBe(4);
    expect(A.homeActiveSection([]).count).toBe(statusCounts([]).active);
  });
  test('My Requests filters with the same function (there is no second copy of the rule)', () => {
    expect(read('app', '(tabs)', 'my-requests.js')).toContain("status === 'active' ? isActiveRequest(r)");
    expect(read('app', '(tabs)', 'my-requests.js')).not.toMatch(/\['submitted', 'progress'\]\.includes/);
  });
});

describe('how many cards Home shows', () => {
  const sec = (count) => A.homeActiveSection(items(Array.from({ length: count }, () => req())));
  test('0 active: the section is hidden (nothing is drawn)', () => {
    const s = A.homeActiveSection(items([req({ status: 'completed' })]));
    expect(s).toMatchObject({ count: 0, shown: [], visible: false });
    const component = read('components', 'home', 'ActiveRequestCard.js');
    expect(component).toContain('if (!section || !section.visible) return null;');
    expect(read('app', '(tabs)', 'home.js')).toContain('{activeSection.visible && (');
  });
  test('1 active: the one card', () => { expect(sec(1)).toMatchObject({ count: 1, visible: true }); expect(sec(1).shown).toHaveLength(1); });
  test('2 or more: the whole section is hidden (the Tracking tab lists them), but the count stays the real one', () => {
    expect(A.HOME_ACTIVE_MAX).toBe(1);
    for (const count of [2, 3, 4, 9]) { const s = sec(count); expect(s.shown).toHaveLength(0); expect(s).toMatchObject({ count, visible: false }); expect(s.active).toHaveLength(count); }
  });
  test('the ordering Home and Tracking share: patient action required first, then most recently updated; Home draws the one request there is', () => {
    const older = req({ updatedAt: '2026-11-01T10:00:00.000Z' });
    const newer = req({ updatedAt: '2026-11-22T10:00:00.000Z' });
    const needs = req({ updatedAt: '2026-11-02T10:00:00.000Z', reviewStatus: 'changes_requested' });
    expect(A.activeRequestsOf(items([older, newer])).map((i) => i.rawId)).toEqual([newer.id, older.id]);
    expect(A.activeRequestsOf(items([older, newer, needs])).map((i) => i.rawId)).toEqual([needs.id, newer.id, older.id]);
    expect(A.homeActiveSection(items([older, newer, needs])).count).toBe(3); // the count is every active request
  });
  test('My Requests is unchanged: it still lists every active request (Home\'s limit is not applied there)', () => {
    const mr = read('app', '(tabs)', 'my-requests.js');
    expect(mr).not.toMatch(/HOME_ACTIVE_MAX|homeActiveSection|slice\(0, 1\)/);
    expect(mr).toContain('isActiveRequest(r)');
  });
  test('the one card is built from the request itself, keyed by its id', () => {
    const s = sec(1);
    expect(s.shown).toHaveLength(1);
    expect(s.active).toHaveLength(1);
    expect(read('components', 'home', 'ActiveRequestCard.js')).toContain('section.shown.map((item) => <ActiveRequestCard key={item.rawId} item={item}');
  });
});

describe('the order', () => {
  test('a request that needs something from the person comes first; then the most recently updated', () => {
    const a = req({ updatedAt: '2026-11-20T10:00:00.000Z' });
    const b = req({ updatedAt: '2026-11-22T10:00:00.000Z' });
    const c = req({ updatedAt: '2026-11-01T10:00:00.000Z', reviewStatus: 'awaiting_documents' });
    const d = req({ updatedAt: '2026-11-02T10:00:00.000Z', reviewStatus: 'changes_requested' });
    const order = A.activeRequestsOf(items([a, b, c, d])).map((i) => i.rawId);
    expect(order).toEqual([d.id, c.id, b.id, a.id]);
  });
  test('with no such flag, newest update first; the list order breaks a tie', () => {
    const x = req({ updatedAt: '2026-11-20T10:00:00.000Z' });
    const y = req({ updatedAt: '2026-11-20T10:00:00.000Z' });
    expect(A.activeRequestsOf(items([x, y])).map((i) => i.rawId)).toEqual([x.id, y.id]);
    expect(A.needsAction(toListItem(req({ reviewStatus: 'approved' })))).toBe(false);
  });
});

describe('what one card shows', () => {
  const view = (extra, lang = 'EN') => A.activeCardView(toListItem(req(extra)), tFor(lang));
  test('the service name once; the variant only where the data has one and the name does not contain it', () => {
    const charter = view({ serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter' });
    expect(charter).toMatchObject({ name: 'Air Ambulance', variant: 'Private Charter' });
    const commercial = view({ serviceType: 'Medical Escort (Commercial Airlines) — Wheelchair (CAW)', serviceKey: 'commercialair_wheelchair' });
    expect(commercial).toMatchObject({ name: 'Medical Escort', variant: 'Commercial Airlines' });
    const ground = view({});
    expect(ground).toMatchObject({ name: 'Ground Ambulance', variant: '' });
    const mortal = view({ serviceType: 'Mortal Remains Transportation — Within India', serviceKey: 'mortal_domestic' });
    expect(mortal.variant).toBe('Within India');
    for (const v of [charter, commercial, ground, mortal]) expect(v.variant === '' || v.name.toLowerCase().indexOf(v.variant.toLowerCase()) < 0).toBe(true);
    expect(A.nameAndVariant(toListItem(req({ serviceKey: 'privatecharter' })), (k) => (k === 'svc_air' ? 'Private Charter Air' : k === 'tb_short_charter' ? 'Private Charter' : k)).variant).toBe(''); // a variant inside the name is dropped
  });
  test('the label a screen reader gets names the service once', () => {
    const v = view({ serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', status: 'in_progress' });
    expect(v.label.startsWith('Air Ambulance, Private Charter, REQ-')).toBe(true);
    expect(v.label.match(/Air Ambulance/g)).toHaveLength(1);
    expect(v.label).toMatch(/In Progress/);
  });
  test('status pill colours: submitted soft blue, in progress amber, completed green, cancelled grey: ONE mapping for Home and My Requests', () => {
    const { cardView, STATUS_BADGE } = require('../myRequestsView');
    expect(view({ status: 'submitted' }).badge).toEqual({ bg: '#EAEBF4', fg: '#303A8F' });
    expect(view({ status: 'in_progress' }).badge).toEqual({ bg: '#FDF0DA', fg: '#8F4C08' });
    expect(STATUS_BADGE.completed).toEqual({ bg: '#E0F5F4', fg: '#0B6564' });
    expect(STATUS_BADGE.cancelled).toEqual({ bg: '#EEF1F6', fg: '#5B6B84' });
    for (const status of ['submitted', 'in_progress', 'completed', 'cancelled']) {
      const item = toListItem(req({ status }));
      expect(A.activeCardView(item, t).badge).toEqual(cardView(item, t).badge); // Home's card and My Requests' other cards agree
    }
    expect(read('lib', 'activeRequests.js')).not.toMatch(/#FDF0DA|#8F4C08/); // no second copy of the colours
  });
  test('the route is shown only when the request has a pickup and a drop (cities only)', () => {
    expect(view({}).route).toEqual({ from: 'Pune', to: 'Mumbai' });
    expect(view({ destination: '' }).route).toBeNull();
    expect(view({ serviceType: 'Home Healthcare Services', serviceKey: 'homecare', destination: '' }).route).toBeNull();
  });
  test('progress comes from THIS request\'s own workflow steps: generic five, Private Charter its own; the stage is hidden when it equals the status', () => {
    const received = view({ status: 'submitted' });
    expect(received.progress).toEqual({ total: 5, step: 1, stage: 'Request received' });
    expect(received.stage).toBe('Request received'); // differs from the status "Submitted"
    const going = view({ status: 'in_progress' });
    expect(going.progress).toMatchObject({ total: 5, step: 4, stage: 'In Progress' });
    expect(going.stage).toBe(''); // "In Progress" is also the status: only "Step 4 of 5" is shown
    // Private Charter has its own milestones (4 to 6). In the review workflow the list knows the step (reviewStatus): "Documents review" is under way.
    const charter = view({ serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', status: 'submitted', reviewStatus: 'in_review' });
    expect(charter.progress.total).toBeGreaterThanOrEqual(4);
    expect(charter.progress.total).toBeLessThanOrEqual(6);
    expect(charter.progress.step).toBe(2);
    // Without the Case (the list does not carry its stage events) a legacy Private Charter request has no step under way that the data can prove: no bar and no step text, never a guess.
    const legacy = view({ serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', status: 'in_progress' });
    expect(legacy.progress).toBeNull();
  });
  test('a request without workflow steps has no bar and no step text', () => {
    const item = toListItem(req());
    delete item.raw;
    const v = A.activeCardView(item, t);
    expect(v.progress).toBeNull();
    expect(v.stage).toBe('');
    expect(v.label).not.toMatch(/step/);
    expect(read('components', 'home', 'ActiveRequestCard.js')).toContain('{v.progress ? <Progress progress={v.progress} stage={v.stage} t={t} /> : null}');
  });
  test.each(LANGS)('%s: every text of the card comes from the dictionary (no English leaks into the label)', (lang) => {
    const v = view({ status: 'in_progress', serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter' }, lang);
    expect(v.name).toBe(I18N[lang].svc_air);
    expect(v.variant).toBe(I18N[lang].tb_short_charter);
    expect(v.statusLabel).toBe(I18N[lang].status_progress);
    expect(I18N[lang].home_active_requests.trim()).not.toBe('');
    if (lang !== 'EN') expect(I18N[lang].home_active_requests).not.toBe(I18N.EN.home_active_requests);
  });
});

describe('the screens', () => {
  const component = read('components', 'home', 'ActiveRequestCard.js');
  test('Track Request on a card opens THAT card own request, and Home has no "All Active Requests" link', () => {
    const home = read('app', '(tabs)', 'home.js');
    expect(home).toContain("onTrack={(item) => router.push({ pathname: '/request-tracking', params: { id: item.rawId } })}");
    expect(component).toContain('onTrack={() => onTrack(item)}');
    expect(component).toContain('onOpen={() => onOpen(item)}');
    const mr = read('app', '(tabs)', 'my-requests.js');
    expect(mr).toContain("useState(params.status || 'all')");
    expect(mr).toContain("const STATUSES = ['all', 'active', 'submitted', 'progress', 'completed', 'cancelled'];");
    expect(mr).toContain("s === 'active' ? 'lbl_active'");
  });
  test('My Requests draws active requests with the new card (All and Active) and the others with their own card; no new bottom tab', () => {
    const mr = read('app', '(tabs)', 'my-requests.js');
    expect(mr).toContain('isActiveRequest(r)');
    expect(mr).toContain('<ActiveRequestCard key={r.id} item={r}');
    expect(mr).toContain('<RequestCard key={r.id} item={r}');
    expect(read('components', 'layout.js')).toMatch(/TABS = \[/);
    const tabs = /TABS = \[([\s\S]*?)\];/.exec(read('components', 'layout.js'))[1];
    expect((tabs.match(/id:/g) || []).length).toBe(4);
  });
  test('the card follows the design: sizes, colours, the Track button, mirrored arrows, accessibility', () => {
    expect(component).toContain("borderColor: '#E4E9F2', borderRadius: 18, padding: 16, gap: 14");
    expect(component).toContain('shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }');
    expect(component).toContain('size={44}');
    expect(component).toContain("fontFamily: FONT[800], fontSize: 16, lineHeight: 21");
    expect(component).toContain("maxWidth: '44%'");
    expect(component).toContain('minHeight: 46, borderRadius: 12');
    expect(component).toContain('hitSlop={{ top: 1, bottom: 1 }}'); // 46 + 2 = 48 dp touch target
    expect((component.match(/scaleX: -1/g) || []).length).toBe(1); // only the Track Request arrow remains, and it mirrors in RTL
    expect(component).toContain('accessibilityLabel={`${t(\'home_track_request\')}, ${v.reference}`}');
    expect(component).toContain("accessibilityLabel={`${v.label}. ${t('mr_view_details')}`}");
    expect(component).toContain("accessibilityRole=\"header\"");
  });
  test('progress segments are one per step of the request and fill from the start side (the row mirrors in Arabic)', () => {
    expect(component).toContain('Array.from({ length: progress.total }');
    expect(component).toContain('i < progress.step ? COLORS.primary');
    expect(component).not.toMatch(/\d+\s*%.*progress|progress.*percent/i); // no invented percentages
  });
  test('Home has no Active Request skeleton (the card appears only once the list confirms exactly one), and keeps its error and pull-to-refresh', () => {
    const home = read('app', '(tabs)', 'home.js');
    expect(home).not.toContain('ActiveRequestSkeleton');
    expect(home).toContain('<Reveal animate={arrivesLater}>'); // fades in after a cold start, simply appears when the list was already known
    expect(home).toContain('const [arrivesLater] = useState(() => loading && !isCorporate);');
    expect(home).toContain('<LoadFailure titleKey="lf_title_home"');
    expect(home).toContain('refreshControl={isCorporate ? undefined : <AppRefreshControl');
  });
});

describe('card navigation: the body opens Request Details, Track Request opens Tracking Details', () => {
  const component = read('components', 'home', 'ActiveRequestCard.js');
  const card = component.slice(component.indexOf('export function ActiveRequestCard'), component.indexOf('export function ActiveRequestsSection'));
  test('the card body is one button that opens the details of its own request, with a summary label and "View details"', () => {
    expect(card).toContain("accessibilityLabel={`${v.label}. ${t('mr_view_details')}`} onPress={onOpen}");
    expect(card).toContain('accessibilityRole="button"');
  });
  test('Track Request is a SIBLING of the body button, not inside it, so one tap is one action (it cannot also open the details)', () => {
    const bodyOpen = card.indexOf('onPress={onOpen}');
    const bodyClose = card.indexOf('</PressBox>', bodyOpen);
    const trackOpen = card.indexOf('onPress={onTrack}');
    expect(bodyOpen).toBeGreaterThan(0);
    expect(trackOpen).toBeGreaterThan(bodyClose); // the Track button starts after the body button has closed
    expect(card).toContain("accessibilityLabel={`${t('home_track_request')}, ${v.reference}`}");
    expect(card).toContain('hitSlop={{ top: 1, bottom: 1 }}');
    expect(card).toContain('minHeight: 46');
  });
  test('Home: the body opens /request-details and Track opens /request-tracking, each with THAT card\'s own id', () => {
    const home = read('app', '(tabs)', 'home.js');
    expect(home).toContain("onOpen={(item) => router.push({ pathname: '/request-details', params: { id: item.rawId } })}");
    expect(home).toContain("onTrack={(item) => router.push({ pathname: '/request-tracking', params: { id: item.rawId } })}");
    expect(component).toContain('onOpen={() => onOpen(item)} onTrack={() => onTrack(item)}');
  });
  test('My Requests: the same two actions for an active request', () => {
    const mr = read('app', '(tabs)', 'my-requests.js');
    expect(mr).toContain("onOpen={() => router.push({ pathname: '/request-details', params: { id: r.rawId } })} onTrack={() => router.push({ pathname: '/request-tracking', params: { id: r.rawId } })}");
  });
});

describe('Private Charter progress stays evidence-based', () => {
  const view = (extra) => A.activeCardView(toListItem(req({ serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', ...extra })), t);
  test('a step is shown only when the data proves one; otherwise no bar and no step text (never a guess, never a percentage)', () => {
    expect(view({ status: 'in_progress' }).progress).toBeNull(); // legacy request, no Case in the list: nothing proves a step
    expect(view({ status: 'submitted' }).progress).toBeNull();
    expect(view({ status: 'submitted', reviewStatus: 'in_review' }).progress).toMatchObject({ step: 2 });
    expect(view({ status: 'in_progress', reviewStatus: 'approved' }).progress).toMatchObject({ stage: expect.any(String) });
    expect(view({ status: 'in_progress' }).label).not.toMatch(/step|%/i);
    expect(read('lib', 'activeRequests.js')).not.toMatch(/percent|\* 100|%/);
  });
});

describe('Home has no "View All Active Requests" button any more', () => {
  const component = read('components', 'home', 'ActiveRequestCard.js');
  const section = component.slice(component.indexOf('export function ActiveRequestsSection'));
  test('the header is the title only: no count pill, and its screen-reader label has no number', () => {
    expect(section).not.toContain('{section.count}');
    expect(section).not.toMatch(/section.count}/);
    expect(section).toContain("<Text accessibilityRole=\"header\"");
    expect(section).not.toMatch(/accessibilityLabel={`${t('home_active_requests')}/);
  });
  test('the button, its handler and its text are gone from the section, the screen and all six dictionaries', () => {
    expect(section).not.toMatch(/home_all_active_requests|onViewAll|hasMore|ChevronRight/);
    expect(read('app', '(tabs)', 'home.js')).not.toMatch(/onViewAll={() => navReplace|home_all_active_requests/);
    for (const lang of LANGS) expect({ lang, has: 'home_all_active_requests' in I18N[lang] }).toEqual({ lang, has: false });
  });
});
