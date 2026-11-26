/* global describe, test, expect, __dirname, jest, beforeEach */
// Responsiveness, phase 2: the four bottom tabs live in one navigator (app/(tabs)/_layout.js) and stay mounted. Switching is a navigate, not a dismissAll + replace.
const fs = require('fs');
const path = require('path');

jest.mock('expo-router', () => ({
  router: { navigate: jest.fn(), replace: jest.fn(), push: jest.fn(), back: jest.fn(), dismissAll: jest.fn(), canDismiss: jest.fn(() => true), canGoBack: jest.fn(() => false) },
  useFocusEffect: jest.fn(),
}));

const { router } = require('expo-router');
const nav = require('../nav');
const { HOP_GAP_MS, RETURN_GAP_MS, SWITCH_WINDOW_MS, shouldRefreshOnFocus } = require('../useTabRefresh');
const { systemBackAction } = require('../systemBack');

const SRC = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8').split('\r\n').join('\n');

describe('the files: same routes, new folder', () => {
  const TABS = ['home', 'active-tracking', 'my-requests', 'profile', 'corporate-dashboard'];
  test('the five tab screens are in app/(tabs), and no longer at the top of app/', () => {
    for (const name of TABS) {
      expect(fs.existsSync(path.join(SRC, `app/(tabs)/${name}.js`))).toBe(true);
      expect(fs.existsSync(path.join(SRC, `app/${name}.js`))).toBe(false); // two files for one address would clash
    }
    expect(fs.existsSync(path.join(SRC, 'app/(tabs)/_layout.js'))).toBe(true);
  });
  test('All Services is an ordinary screen above the tabs, not a tab', () => {
    expect(fs.existsSync(path.join(SRC, 'app/all-services.js'))).toBe(true);
    expect(fs.existsSync(path.join(SRC, 'app/(tabs)/all-services.js'))).toBe(false);
    expect(nav.TAB_PATHS).not.toContain('/all-services');
    expect(nav.isTabTarget('/all-services')).toBe(false);
  });
  test('every tab route the app uses is one of the tab screens (the group name is not an address)', () => {
    expect(nav.TAB_PATHS.slice().sort()).toEqual(TABS.map((n) => `/${n}`).sort());
  });
  test('the tab screens reach the rest of the app one folder deeper', () => {
    for (const name of TABS) expect(read(`app/(tabs)/${name}.js`)).not.toMatch(/from '\.\.\/(components|lib|state|data|theme)\//);
  });
});

describe('the tab navigator', () => {
  const layout = read('app/(tabs)/_layout.js');
  test('a JS tab navigator with the bar switched off (every tab screen draws the same BottomNav), lazy, frozen when behind, no history, no animation', () => {
    expect(layout).toContain("import { Tabs } from 'expo-router/js-tabs';");
    expect(layout).toContain('tabBar={() => null}');
    expect(layout).toContain('lazy: true');
    expect(layout).toContain('freezeOnBlur: true');
    expect(layout).toContain('backBehavior="none"');
    expect(layout).toContain("animation: 'none'");
    expect(layout).toContain('initialRouteName="home"');
  });
  test('it declares every tab screen and registers itself with nav.js', () => {
    for (const name of ['home', 'active-tracking', 'my-requests', 'profile', 'corporate-dashboard']) expect(layout).toContain(`<Tabs.Screen name="${name}" />`);
    expect(layout).toContain('useEffect(() => registerTabs(), []);');
  });
  test('no new dependency: the navigator ships with expo-router', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, '../package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies).filter((d) => /react-navigation/.test(d))).toEqual([]);
  });
});

describe('switching tabs', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  test('switchTab navigates in place: no dismissAll, no replace', () => {
    nav.switchTab('/my-requests');
    expect(router.navigate).toHaveBeenCalledWith('/my-requests');
    expect(router.dismissAll).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(nav.lastTabSwitchAt()).toBeGreaterThan(0);
  });
  test('the bottom bar switches (or scrolls to the top on the tab you are on); it no longer uses navReplace', () => {
    const layoutJs = read('components/layout.js');
    expect(layoutJs).toContain('onPress={() => (on ? emitTabReselect() : switchTab(target))}');
    expect(layoutJs).not.toContain('navReplace');
    expect(layoutJs).toContain("import { emitTabReselect, goBack, onTabReselect, switchTab } from '../lib/nav';");
  });
  test('Home, Tracking, Requests, Profile keep their own BottomNav (no screen changes its layout)', () => {
    for (const name of ['home', 'active-tracking', 'my-requests', 'profile']) expect(read(`app/(tabs)/${name}.js`)).toContain('<BottomNav />');
  });
});

describe('navReplace with and without the tabs on screen', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  // each call uses a different target so the double-tap guard (lib/navGuard.js) never sees a repeat
  test('no tab navigator yet (sign-in): the history is cleared and the screen is replaced, as before', () => {
    expect(nav.tabsAreMounted()).toBe(false);
    nav.navReplace('/home');
    expect(router.dismissAll).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/home');
    expect(router.navigate).not.toHaveBeenCalled();
  });
  test('tabs on screen: a tab target goes back to them in place; anything else still clears and replaces', () => {
    const unregister = nav.registerTabs();
    expect(nav.tabsAreMounted()).toBe(true);
    nav.navReplace('/active-tracking');
    expect(router.navigate).toHaveBeenCalledWith('/active-tracking');
    expect(router.dismissAll).not.toHaveBeenCalled();
    nav.navReplace('/login'); // sign-out
    expect(router.dismissAll).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/login');
    unregister();
    expect(nav.tabsAreMounted()).toBe(false);
  });
  test('a status link ("All Active Requests") carries its params, and a fresh `at` so a second identical link still reaches the screen', () => {
    const unregister = nav.registerTabs();
    nav.navReplace({ pathname: '/my-requests', params: { status: 'active' } });
    const [target] = router.navigate.mock.calls[0];
    expect(target.pathname).toBe('/my-requests');
    expect(target.params.status).toBe('active');
    expect(typeof target.params.at).toBe('string');
    unregister();
  });
  test('registering is counted, so two navigators (a tab opened from inside the request form) do not switch it off early', () => {
    const a = nav.registerTabs();
    const b = nav.registerTabs();
    a();
    expect(nav.tabsAreMounted()).toBe(true);
    b();
    expect(nav.tabsAreMounted()).toBe(false);
    b(); // releasing twice never goes below zero
    expect(nav.tabsAreMounted()).toBe(false);
  });
  test('isTabTarget reads a path, a path with a query and a { pathname, params } target', () => {
    expect(nav.isTabTarget('/home')).toBe(true);
    expect(nav.isTabTarget('/my-requests?status=active')).toBe(true);
    expect(nav.isTabTarget({ pathname: '/profile', params: {} })).toBe(true);
    expect(nav.isTabTarget('/my-documents')).toBe(false);
    expect(nav.isTabTarget('/login')).toBe(false);
  });
});

describe('Android back and the reselect scroll-to-top', () => {
  test('a tab reached by tapping the bar has no history of its own: back goes Home, then leaves the app (unchanged rule)', () => {
    expect(systemBackAction({ pathname: '/my-requests', canGoBack: false })).toBe('home');
    expect(systemBackAction({ pathname: '/profile', canGoBack: false })).toBe('home');
    expect(systemBackAction({ pathname: '/home', canGoBack: false })).toBe('default');
  });
  test('a screen opened from a tab still pops back to it', () => {
    expect(systemBackAction({ pathname: '/my-documents', canGoBack: true })).toBe('default');
  });
  test('the one back listener still sends Home through navReplace, which now switches in place', () => {
    const back = read('components/SystemBack.js');
    expect(back).toContain("navReplace('/home');");
    expect((back.match(/BackHandler\.addEventListener/g) || []).length).toBe(1);
  });
  test('every mounted tab is listening for a reselect, so only the tab in front answers', () => {
    const layoutJs = read('components/layout.js');
    expect(layoutJs).toContain('if (navigation.isFocused()) ref.current?.scrollTo({ y: 0, animated: true });');
    expect(layoutJs).toContain('if (navigation.isFocused()) inner.current?.scrollTo({ y: 0, animated: true });');
    expect(layoutJs).toContain('emitTabReselect()');
  });
});

describe('what a tab does when it comes back into front', () => {
  const now = 1_000_000;
  test('a hop between tabs refreshes only data older than HOP_GAP_MS', () => {
    const lastSwitchAt = now - 50;
    expect(shouldRefreshOnFocus({ now, lastLoadAt: now - 5000, lastSwitchAt })).toBe(false);
    expect(shouldRefreshOnFocus({ now, lastLoadAt: now - (HOP_GAP_MS - 1), lastSwitchAt })).toBe(false);
    expect(shouldRefreshOnFocus({ now, lastLoadAt: now - HOP_GAP_MS, lastSwitchAt })).toBe(true);
  });
  test('a return from a screen above the tabs (a request was just sent) refreshes anything older than RETURN_GAP_MS', () => {
    const lastSwitchAt = now - 60_000; // the bar was tapped long ago: this is not a hop
    expect(shouldRefreshOnFocus({ now, lastLoadAt: now - (RETURN_GAP_MS - 1), lastSwitchAt })).toBe(false);
    expect(shouldRefreshOnFocus({ now, lastLoadAt: now - RETURN_GAP_MS, lastSwitchAt })).toBe(true);
    expect(shouldRefreshOnFocus({ now, lastLoadAt: now - 20_000, lastSwitchAt: 0 })).toBe(true);
  });
  test('a focus just outside the hop window counts as a return', () => {
    expect(shouldRefreshOnFocus({ now, lastLoadAt: now - 10_000, lastSwitchAt: now - SWITCH_WINDOW_MS })).toBe(false);
    expect(shouldRefreshOnFocus({ now, lastLoadAt: now - 10_000, lastSwitchAt: now - SWITCH_WINDOW_MS - 1 })).toBe(true);
  });
  test('Home, My Requests and the corporate Cases refresh quietly on focus, through the screen\'s own reload', () => {
    expect(read('app/(tabs)/home.js')).toContain('useRefreshOnFocus(reload, { enabled: !isCorporate });');
    expect(read('app/(tabs)/my-requests.js')).toContain('useRefreshOnFocus(reload);');
    expect(read('app/(tabs)/corporate-dashboard.js')).toContain('useRefreshOnFocus(reload);');
  });
  test('the first focus is the mount (it already loads); the hook never loads on its own', () => {
    const hook = read('lib/useTabRefresh.js');
    expect(hook).toContain('if (firstFocus.current) { firstFocus.current = false; loadedAt.current = Date.now(); return; }');
    expect(hook).not.toMatch(/apiGet|apiPost|fetch\(/);
  });
  test('My Requests follows a status link on the screen that already exists', () => {
    const screen = read('app/(tabs)/my-requests.js');
    expect(screen).toContain('if (seenLink !== linkKey) { setSeenLink(linkKey); if (params.status) setStatus(params.status); }');
  });
});

describe('what this phase did not touch', () => {
  test('the context, authentication and the list rendering are as they were', () => {
    const screen = read('app/(tabs)/my-requests.js');
    expect(screen).toContain('{items.map((r) => ('); // the list is still drawn by the same map (the list work is a later phase)
    expect(read('state/AppContext.js')).toContain('const value = useMemo(');
    expect(read('lib/api.js')).toContain('await ensureAuthenticated();');
  });
  test('the pushes of a tab route from inside the request form are still pushes (back returns to the form)', () => {
    expect(read('components/request/RequestFrame.js')).toContain("router.push('/all-services');");
    expect(read('app/request/review.js')).toContain("router.push('/my-requests')");
  });
});

describe('the Tracking tab replaces Services in the bottom bar', () => {
  const layoutJs = read('components/layout.js');
  const tabs = /const TABS = \[([\s\S]*?)\];/.exec(layoutJs)[1];
  test('a patient sees Home, Tracking, Requests, Profile, in that order, and no Services', () => {
    expect([...tabs.matchAll(/id: '([^']+)'/g)].map((m) => m[1])).toEqual(['/home', '/active-tracking', '/my-requests', '/profile']);
    expect(tabs).toContain("key: 'nav_tracking'");
    expect(tabs).not.toMatch(/nav_services|all-services/);
  });
  test('a corporate account keeps Home, Cases, Profile (the patient request list is not theirs): Tracking is left out for them only', () => {
    expect(layoutJs).toContain("TABS.filter(({ id }) => !(isCorporate && id === '/active-tracking'))");
    expect(layoutJs).toContain("const corporateCases = id === '/my-requests' && isCorporate;");
    expect(layoutJs).toContain("const target = corporateCases ? '/corporate-dashboard' : id;");
  });
  test("Home's service grid, its More tile and its banner PUSH All Services, so back returns to Home", () => {
    const home = read('app/(tabs)/home.js');
    expect(home).toContain("onViewAll={() => router.push('/all-services')}");
    expect(home).toContain("onRequest={() => router.push('/all-services')}");
    expect(home).not.toContain("navReplace('/all-services')");
    expect(read('app/all-services.js')).toContain("<TopBar title={t('filter_svc_all')} />"); // TopBar's back button is goBack: pop, or Home when there is nothing to pop
  });
  test('the request flow still pushes All Services (back returns to the form)', () => {
    expect(read('components/request/RequestFrame.js')).toContain("router.push('/all-services');");
    expect(read('app/request/review.js')).toContain("router.push('/all-services');");
  });
  test('Android back from the Tracking tab (no history) goes Home', () => {
    expect(systemBackAction({ pathname: '/active-tracking', canGoBack: false })).toBe('home');
  });
});

describe('the Tracking screen', () => {
  const screen = read('app/(tabs)/active-tracking.js');
  test('it lists the active requests in the shared order (needs action first, then newest), on the Tracking card', () => {
    expect(screen).toContain("import { activeRequestsOf, matchesTrackingQuery } from '../../lib/activeRequests';");
    expect(screen).toContain('const active = activeRequestsOf(rows || []);');
    expect(screen).toContain('<TrackingRequestCard');
    expect(screen).toContain('key={r.id}');
  });
  test('Track Request opens /request-tracking with THAT request id; the card and the button both open it', () => {
    expect(screen).toContain("onTrack={() => router.push({ pathname: '/request-tracking', params: { id: r.rawId } })}");
  });
  test('loading, error, empty, refresh and a quiet refresh when the tab comes back into front', () => {
    expect(screen).toContain("<RequestsSkeleton label={t('sk_loading_requests')} />");
    expect(screen).toContain('<LoadFailure titleKey="lf_title_requests" error={error} onRetry={reload} />');
    expect(screen).toContain("t('tr_empty_title')");
    expect(screen).toContain("t('tr_empty_sub')");
    expect(screen).toContain('refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}');
    expect(screen).toContain('useRefreshOnFocus(reload);');
    expect(screen).toContain('useScrollToTopOnTabTap(scrollRef);');
    expect(screen).toContain('<BottomNav />');
    expect(screen).not.toMatch(/apiPost|apiPatch|apiUpload|fetch\(/);
  });
  test('it asks the server through the SAME resource and cache key as My Requests, and never calls the API itself', () => {
    const mine = read('app/(tabs)/my-requests.js');
    for (const source of [screen, mine]) {
      expect(source).toContain('key: MY_REQUESTS_KEY,');
      expect(source).toContain('fetcher: fetchMyRequests,');
      expect(source).not.toContain('apiGet(');
    }
    const shared = read('lib/myRequestsResource.js');
    expect(shared).toContain("export const MY_REQUESTS_KEY = 'my-requests';");
    expect((shared.match(/apiGet\(/g) || []).length).toBe(1);
  });
  test("the cached list is cleared when the account signs out or in (one patient never sees another's requests)", () => {
    expect(read('state/AppContext.js')).toContain('onSessionChange((signedIn) => { clearCache();');
  });
  test("the list is scoped by the server to the token's user: no id is sent", () => {
    expect(read('lib/myRequestsResource.js')).toContain("apiGet('/requests/me')");
  });
});

describe('Home shows the one card, or nothing', () => {
  test('the section is drawn only for exactly one active request, and the "View All" button is gone', () => {
    const { homeActiveSection } = require('../activeRequests');
    const row = (status, id) => ({ id, status, raw: { id }, rawId: id });
    expect(homeActiveSection([]).visible).toBe(false);
    expect(homeActiveSection([row('submitted', 'a')]).visible).toBe(true);
    expect(homeActiveSection([row('submitted', 'a'), row('progress', 'b')]).visible).toBe(false);
    expect(homeActiveSection([row('submitted', 'a'), row('completed', 'b')]).visible).toBe(true); // a finished request is not active
    expect(read('app/(tabs)/home.js')).not.toMatch(/onViewAll=\{\(\) => navReplace|status: 'active'/);
  });
});

describe('the new texts are in all six languages', () => {
  const I18N = JSON.parse(fs.readFileSync(path.join(SRC, 'data/i18n.json'), 'utf8'));
  test.each(['EN', 'HI', 'MR', 'GU', 'TE', 'AR'])('%s has Tracking and the empty state, and no Services tab label or View All text left', (lang) => {
    for (const key of ['nav_tracking', 'tr_empty_title', 'tr_empty_sub']) expect({ lang, key, ok: typeof I18N[lang][key] === 'string' && I18N[lang][key].trim() !== '' }).toEqual({ lang, key, ok: true });
    if (lang !== 'EN') for (const key of ['nav_tracking', 'tr_empty_title', 'tr_empty_sub']) expect(I18N[lang][key]).not.toBe(I18N.EN[key]);
    expect(I18N[lang]).not.toHaveProperty('nav_services');
    expect(I18N[lang]).not.toHaveProperty('home_all_active_requests');
  });
});
