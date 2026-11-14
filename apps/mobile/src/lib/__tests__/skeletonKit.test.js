/* global describe, test, expect, __dirname, beforeEach */
// The loading kit: shimmer skeletons on the first load, and pull-to-refresh on the data screens.
// Pure rules (when a skeleton may show, which items are new, the in-memory cache) are tested by running them; the components and screens are
// tested as source (this project's Jest runs in node, with no component rendering): the wiring each screen must have.
const fs = require('fs');
const path = require('path');
const { SHOW_AFTER_MS, MIN_SHOW_MS, skeletonVisible, nextChangeAt } = require('../skeletonGate');
const { newIds, HIGHLIGHT_MS, HIGHLIGHT_FROM } = require('../newItems');
const { getCached, setCached, clearCache } = require('../screenCache');
const { SKELETON, COLORS } = require('../../theme/colors');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const app = (name) => read(`../../app/${name}.js`);
const comp = (rel) => read(`../../components/${rel}`);
const i18n = JSON.parse(read('../../data/i18n.json'));

describe('when a skeleton may show (150 ms in, 400 ms at least)', () => {
  test('the numbers', () => {
    expect(SHOW_AFTER_MS).toBe(150);
    expect(MIN_SHOW_MS).toBe(400);
  });
  test('not loading: never', () => {
    expect(skeletonVisible({ startedAt: null, now: 1000 })).toBe(false);
  });
  test('a quick load never flashes it', () => {
    expect(skeletonVisible({ startedAt: 0, now: 100 })).toBe(false);
    expect(skeletonVisible({ startedAt: 0, endedAt: 120, now: 120 })).toBe(false);
    expect(skeletonVisible({ startedAt: 0, endedAt: 150, now: 400 })).toBe(false);
  });
  test('after 150 ms of loading it shows, and keeps showing while the load goes on', () => {
    expect(skeletonVisible({ startedAt: 0, now: 151 })).toBe(true);
    expect(skeletonVisible({ startedAt: 0, now: 60000 })).toBe(true);
  });
  test('once shown it stays for at least 400 ms, even if the data arrives at once', () => {
    expect(skeletonVisible({ startedAt: 0, endedAt: 200, now: 300 })).toBe(true);
    expect(skeletonVisible({ startedAt: 0, endedAt: 200, now: 549 })).toBe(true);
    expect(skeletonVisible({ startedAt: 0, endedAt: 200, now: 550 })).toBe(false);
  });
  test('a long load goes away as soon as the data is there', () => {
    expect(skeletonVisible({ startedAt: 0, endedAt: 2000, now: 1999 })).toBe(true);
    expect(skeletonVisible({ startedAt: 0, endedAt: 2000, now: 2000 })).toBe(false);
  });
  test('the next moment it changes, for one timer', () => {
    expect(nextChangeAt({ startedAt: 0, now: 10 })).toBe(150);
    expect(nextChangeAt({ startedAt: 0, endedAt: 100, now: 100 })).toBe(null);
    expect(nextChangeAt({ startedAt: 0, now: 300 })).toBe(null); // shown, still loading: nothing to wait for
    expect(nextChangeAt({ startedAt: 0, endedAt: 200, now: 300 })).toBe(550);
    expect(nextChangeAt({ startedAt: 0, endedAt: 200, now: 600 })).toBe(null);
  });
});

describe('new items after a pull (highlight only for ids that were not there before)', () => {
  test('only the ids that were not in the list before', () => {
    expect(newIds([1, 2, 3], [4, 1, 2, 3])).toEqual([4]);
    expect(newIds([1, 2], [1, 2])).toEqual([]);
    expect(newIds([1, 2, 3], [2])).toEqual([]);
  });
  test('no highlight on a first load or when the earlier list is unknown', () => {
    expect(newIds(undefined, [1, 2])).toEqual([]);
    expect(newIds(null, [1, 2])).toEqual([]);
    expect(newIds([], [1, 2])).toEqual([1, 2]); // an empty list that was really loaded: everything is new
    expect(newIds([1], undefined)).toEqual([]);
  });
  test('the fade is 1.8 s from #E2E3EF', () => {
    expect(HIGHLIGHT_MS).toBe(1800);
    expect(HIGHLIGHT_FROM).toBe('#E2E3EF');
    expect(SKELETON.newItem).toBe('#E2E3EF');
  });
});

describe('the in-memory cache', () => {
  beforeEach(() => clearCache());
  test('keeps what a screen loaded, per key', () => {
    expect(getCached('a')).toBeUndefined();
    setCached('a', [1]);
    setCached('b', [2]);
    expect(getCached('a')).toEqual([1]);
    expect(getCached('b')).toEqual([2]);
  });
  test('an empty list is a real answer, not "nothing cached"', () => {
    setCached('a', []);
    expect(getCached('a')).toEqual([]);
  });
  test('is emptied at every sign-in and sign-out, so one account never sees another\'s data', () => {
    setCached('my-requests', [1]);
    clearCache();
    expect(getCached('my-requests')).toBeUndefined();
    expect(read('../../state/AppContext.js')).toContain('onSessionChange((signedIn) => { clearCache();');
  });
});

describe('the Skeleton components', () => {
  const sk = comp('skeleton/Skeleton.js');
  const hooks = comp('skeleton/hooks.js');
  test('the look: block #E3E9F2, highlight #F5F8FC, sweep every 1.3 s, linear, on the native thread', () => {
    expect(SKELETON.block).toBe('#E3E9F2');
    expect(SKELETON.highlight).toBe('#F5F8FC');
    expect(sk).toContain('export const SHIMMER_MS = 1300;');
    expect(sk).toContain('Easing.linear');
    expect(sk).toContain('useNativeDriver: true');
    expect(sk).toContain('Animated.loop(');
    expect(sk).toContain('LinearGradient');
    expect(sk).toContain('backgroundColor: SKELETON.block');
  });
  test('one animation value for the whole area (every block follows the same clock)', () => {
    expect(sk.match(/new Animated\.Value\(/g)).toHaveLength(1);
  });
  test('Skeleton (width, height, radius), SkeletonText (lines, last line width), SkeletonCircle (size)', () => {
    expect(sk).toContain('export function Skeleton({ width, height = 14, radius = SHIMMER_RADIUS');
    expect(sk).toContain('export function SkeletonText({ lines');
    expect(sk).toContain("lastLineWidth = '60%'");
    expect(sk).toContain('export function SkeletonCircle({ size');
    expect(sk).toContain('export function SkeletonArea(');
  });
  test('Reduce motion: no animation at all (static blocks)', () => {
    expect(hooks).toContain("AccessibilityInfo.isReduceMotionEnabled()");
    expect(hooks).toContain("'reduceMotionChanged'");
    expect(sk).toContain('if (reduce) return undefined;');
    expect(sk).toContain('const shimmer = !reduce && clock && w > 0;');
  });
  test('the area is ONE element with a label; the blocks are hidden from screen readers', () => {
    expect(sk).toContain('accessible accessibilityRole="progressbar" accessibilityLabel={label}');
    expect(sk).toContain('importantForAccessibility="no-hide-descendants" accessibilityElementsHidden');
  });
});

describe('data arrives: fade in and rise 6 px over 320 ms; nothing with Reduce motion', () => {
  const reveal = comp('skeleton/Reveal.js');
  test('the numbers', () => {
    expect(reveal).toContain('REVEAL_MS = 320');
    expect(reveal).toContain('outputRange: [REVEAL_RISE, 0]');
    expect(reveal).toContain('REVEAL_RISE = 6');
    expect(reveal).toContain('useNativeDriver: true');
  });
  test('instant when there was no skeleton (animate false) or with Reduce motion', () => {
    expect(reveal).toContain('if (!animate || reduce) { progress.setValue(1); return; }');
  });
});

describe('the new-item highlight', () => {
  const fill = comp('skeleton/HighlightFill.js');
  test('fades #E2E3EF to the card colour over 1.8 s, removes itself, and does nothing with Reduce motion', () => {
    expect(fill).toContain('HIGHLIGHT_FROM');
    expect(fill).toContain('duration: HIGHLIGHT_MS');
    expect(fill).toContain('if (reduce) { setDone(true); return undefined; }');
    expect(fill).toContain('if (done) return null;');
  });
  test('there is no "New" badge anywhere', () => {
    ['skeleton/HighlightFill.js', 'requests/RequestCard.js', 'tracking/TrackingDetails.js'].forEach((f) => {
      expect(comp(f)).not.toMatch(/>\s*New\s*</);
      expect(comp(f)).not.toContain("t('new')");
    });
  });
});

describe('pull-to-refresh control', () => {
  test('the brand colours: #303A8F spinner, white background on Android', () => {
    const c = comp('AppRefreshControl.js');
    expect(COLORS.primary).toBe('#303A8F');
    expect(c).toContain('tintColor={COLORS.primary}');
    expect(c).toContain('colors={[COLORS.primary]}');
    expect(c).toContain('progressBackgroundColor="#FFFFFF"');
  });
  test('passes its other props on: the web ScrollView hands the screen content to its refresh control as children (without this the screen is empty)', () => {
    const c = comp('AppRefreshControl.js');
    expect(c).toContain('{ refreshing, onRefresh, ...rest }');
    expect(c).toContain('{...rest}');
  });
});

describe('useResource (the one way a data screen loads)', () => {
  const hook = read('../useResource.js');
  test('shows nothing to load for when something is cached, and starts from the cache', () => {
    expect(hook).toContain('useState(() => getCached(key))');
    expect(hook).toContain('loading: data === undefined && !error');
  });
  test('a failed first load is an error with Try again; a failed refresh keeps the data', () => {
    expect(hook).toContain('dataRef.current === undefined) setError(err)');
    expect(hook).toContain('failRef.current(err)');
  });
  test('refreshing is true only during a pull, and a second pull while one runs does nothing', () => {
    expect(hook).toContain('if (refreshingRef.current) return;');
    expect(hook).toContain('setRefreshing(true);');
    // reload (first load / quiet refetch) never sets it
    const reload = hook.slice(hook.indexOf('const reload = useCallback'), hook.indexOf('useEffect(() => {\n    keyRef.current = key;'));
    expect(reload).not.toContain('setRefreshing');
  });
  test('only the ids that were not there before the pull are highlighted, and only for 1.8 s', () => {
    expect(hook).toContain('newIds(before, idsRef.current(next))');
    expect(hook).toContain('HIGHLIGHT_MS + 200');
  });
  test('the cache is written with every answer', () => {
    expect(hook).toContain('setCached(forKey, next);');
  });
});

describe('requests never wait for ever (15 s)', () => {
  test('apiGet times out and says so', () => {
    const api = read('../api.js');
    expect(api).toContain('export const GET_TIMEOUT_MS = 15000;');
    expect(api).toContain("code: 'timeout'");
    expect(api).toContain('The server took too long to answer. Please try again.');
  });
});

describe('LoadFailure: a short message and Try again', () => {
  const lf = comp('LoadFailure.js');
  test('message, a button that runs onRetry', () => {
    expect(lf).toContain("t('sk_load_failed')");
    expect(lf).toContain("title={t('sk_try_again')} onPress={onRetry}");
  });
});

describe('the words, in all six languages', () => {
  const KEYS = ['sk_loading_requests', 'sk_loading_request', 'sk_loading_tracking', 'sk_loading_documents', 'sk_loading_notifications', 'sk_loading_active', 'sk_loading_profile', 'sk_loading_cases', 'sk_load_failed', 'sk_try_again', 'sk_refresh_failed'];
  const langs = Object.keys(i18n);
  test('there are six languages and every key is in each of them', () => {
    expect(langs.length).toBe(6);
    KEYS.forEach((k) => langs.forEach((l) => expect(typeof i18n[l][k]).toBe('string')));
    KEYS.forEach((k) => langs.forEach((l) => expect(i18n[l][k].length).toBeGreaterThan(0)));
  });
  test('the English wording asked for', () => {
    expect(i18n.EN.sk_refresh_failed).toBe("Couldn't refresh. Pull down to try again.");
    expect(i18n.EN.sk_loading_requests).toBe('Loading your requests');
  });
});

describe('every data screen: skeleton while the first load runs, then content', () => {
  const screens = {
    'my-requests': [/gate\.visible && <RequestsSkeleton label=\{t\('sk_loading_requests'\)\}/, 'AppRefreshControl'],
    home: [/gate\.visible && <ActiveRequestSkeleton label=\{t\('sk_loading_active'\)\}/, 'AppRefreshControl'],
    'request-details': [/<RequestDetailsSkeleton label=\{t\('sk_loading_request'\)\}/, 'AppRefreshControl'],
    'request-tracking': [/<TrackingSkeleton label=\{t\('sk_loading_tracking'\)\}/, 'AppRefreshControl'],
    tracking: [/<TrackingSkeleton label=\{t\('sk_loading_tracking'\)\}/, 'AppRefreshControl'],
    'my-documents': [/<RowsSkeleton label=\{t\('sk_loading_documents'\)\}/, 'AppRefreshControl'],
    notifications: [/<RowsSkeleton label=\{t\('sk_loading_notifications'\)\}/, 'AppRefreshControl'],
    'corporate-dashboard': [/<RowsSkeleton label=\{t\('sk_loading_cases'\)\}/, 'AppRefreshControl'],
  };
  Object.entries(screens).forEach(([name, [skeletonRe, refresh]]) => {
    test(`${name}: gated skeleton (not a spinner), pull-to-refresh, and no full-screen "Loading…"`, () => {
      const src = app(name);
      expect(src).toMatch(skeletonRe);
      expect(src).toContain('useSkeletonGate(');
      expect(src).toContain(`<${refresh} refreshing={refreshing} onRefresh={onRefresh} />`);
      expect(src).not.toContain('LoadingState');
      expect(src).not.toContain('<RefreshControl');
    });
  });
  test('a failed first load: an error with Try again, on every screen that loads with useResource', () => {
    ['my-requests', 'home', 'request-tracking', 'request-details', 'notifications', 'corporate-dashboard'].forEach((name) => {
      const src = app(name);
      expect(src).toContain('<LoadFailure');
      expect(src).toContain('onRetry=');
    });
    expect(app('tracking')).toContain('<LoadFailure');
    expect(app('my-documents')).toContain("t('docs_try_again')");
  });
  test('a failed pull keeps the content and says "Couldn\'t refresh. Pull down to try again."', () => {
    ['my-requests', 'home', 'request-tracking', 'request-details', 'notifications', 'corporate-dashboard', 'my-documents'].forEach((name) => {
      expect(app(name)).toContain("onRefreshError: () => toast(t('sk_refresh_failed')),");
    });
    expect(app('tracking')).toContain("toast(t('sk_refresh_failed'))");
    expect(app('profile')).toContain("toast(t('sk_refresh_failed'))");
  });
  test('the content fades in only after a skeleton was shown', () => {
    ['my-requests', 'home', 'request-details', 'request-tracking', 'my-documents', 'notifications', 'corporate-dashboard'].forEach((name) => {
      expect(app(name)).toContain('<Reveal animate={gate.wasShown}');
    });
  });
});

describe('Home', () => {
  const home = app('home');
  test('also refreshes the bell and the active-request banner in one pull', () => {
    expect(home).toContain("apiGet('/notifications?unreadOnly=true')");
    expect(home).toContain("apiGet('/requests/me')");
    expect(home).toContain('key: \'home\',');
    expect(home).toContain('enabled: !isCorporate,');
  });
  test('the page, header, tab bar and SOS stay: only the active-request area is a skeleton', () => {
    expect(home).toContain('<HomeHeader');
    expect(home).toContain('<SosBar');
    expect(home).toContain('<BottomNav />');
    expect(home.indexOf('<ActiveRequestSkeleton')).toBeGreaterThan(home.indexOf('<BannerCarousel'));
    expect(fs.existsSync(path.join(__dirname, '../../components/home/HomeSkeleton.js'))).toBe(false);
  });
  test('a corporate account (nothing to load here) has no pull-to-refresh', () => {
    expect(home).toContain('refreshControl={isCorporate ? undefined :');
  });
});

describe('Tracking Details', () => {
  const screen = app('request-tracking');
  const details = comp('tracking/TrackingDetails.js');
  test('refreshes the case status and the stage events (one request), and quietly again on coming back', () => {
    expect(screen).toContain("fetcher: () => apiGet(`/requests/me/${id}`).then((data) => data.request),");
    expect(screen).toContain('useFocusEffect(');
    expect(screen).toContain('if (focused.current && id) reload();');
  });
  test('a stage event that is new after a pull highlights its step', () => {
    expect(screen).toContain('idsOf: (r) => (r && r.case && r.case.stageEvents ? r.case.stageEvents.map((e) => e.id) : []),');
    expect(screen).toContain('events.filter((e) => highlight.includes(e.id)).map((e) => e.stage)');
    expect(details).toContain('{isNew ? <HighlightFill radius={10} /> : null}');
    expect(details).toContain('isNew={highlightKeys.includes(step.key)}');
  });
});

describe('Profile and the forms', () => {
  test('Profile is pulled to refresh (the account details), not skeletoned: it is already there', () => {
    const src = app('profile');
    expect(src).toContain('refreshControl={isCorporate ? undefined : <AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}');
    expect(src).toContain('await refreshProfile();');
    expect(read('../../state/AppContext.js')).toContain("apiGet('/auth/me')");
  });
  test('forms have no pull-to-refresh', () => {
    ['personal-details', 'edit-profile', 'login', 'register', 'login-otp', 'register-otp', 'complete-profile', 'change-contact', 'corporate-new-case', 'forgot-password', 'reset-password', 'set-password'].forEach((name) => {
      expect(app(name)).not.toContain('RefreshControl');
    });
    ['step1', 'step2', 'step3'].forEach((n) => {
      const file = path.join(__dirname, `../../app/request/${n}.js`);
      if (fs.existsSync(file)) expect(fs.readFileSync(file, 'utf8')).not.toContain('RefreshControl');
    });
  });
  test('personal details loads with a skeleton (and keeps its own Try again)', () => {
    const src = app('personal-details');
    expect(src).toContain('<FormSkeleton');
    expect(src).toContain("t('pd_try_again')");
  });
});

describe('what a skeleton never covers, and where the logo loaders are', () => {
  test('the header, tab bar and SOS button are drawn by the screen, never by a skeleton', () => {
    const screens = comp('skeleton/screens.js');
    ['BottomNav', 'SosBar', 'HomeHeader', 'TopBar', 'ScreenHeader'].forEach((n) => expect(screens).not.toContain(n));
  });
  test('the logo loaders are untouched: no data screen uses a spinner as its page-open loader', () => {
    ['my-requests', 'home', 'request-details', 'request-tracking', 'tracking', 'my-documents', 'notifications', 'corporate-dashboard', 'personal-details'].forEach((name) => {
      expect(app(name)).not.toContain('<Spinner');
      expect(app(name)).not.toContain('Splash');
    });
  });
});

describe('the 15 s limit is only for plain data reads', () => {
  const api = read('../api.js');
  test('apiGet has the limit, with an option for a longer one (0 = none)', () => {
    expect(api).toContain('const { timeoutMs = GET_TIMEOUT_MS, ...rest } = options || {};');
    expect(api).toContain('timeoutMs > 0 ?');
  });
  test('downloads and uploads never go through apiGet, so a large file is never cut off', () => {
    const body = (name) => { const i = api.indexOf(`export async function ${name}(`); return api.slice(i, api.indexOf('\nexport ', i + 10)); };
    expect(body('apiUpload')).not.toContain('apiGet(');
    expect(body('apiDownload')).not.toContain('apiGet(');
    expect(read('../download.js')).not.toContain('apiGet');
    expect(read('../download.js')).not.toContain('GET_TIMEOUT_MS');
  });
  test('the only apiGet callers are data screens and lookups (none fetches a file)', () => {
    ['request-details', 'request-tracking', 'my-requests', 'home', 'my-documents', 'notifications', 'corporate-dashboard'].forEach((n) => {
      expect(app(n)).not.toMatch(/apiGet\([^)]*(\/summary|\/file)/);
    });
  });
});

describe('My Documents: a document that is new after a pull is highlighted', () => {
  test('ids are the document ids; only new ones get the 1.8 s highlight; the corporate dashboard is unchanged', () => {
    const docs = app('my-documents');
    expect(docs).toContain('idsOf: (list) => list.map((d) => d.id),');
    expect(docs).toContain('isNew={highlight.includes(d.id)}');
    expect(comp('documents/DocumentCard.js')).toContain('{isNew ? <HighlightFill radius={16} /> : null}');
    expect(app('corporate-dashboard')).not.toContain('highlight');
    expect(app('corporate-dashboard')).not.toContain('HighlightFill');
  });
});
