/* global describe, test, expect, __dirname */
const fs = require('fs');
const path = require('path');
const i18n = require('../../data/i18n.json');
const { translate } = require('../translate');
const S = require('../sos');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const ctx = { authStatus: 'authed', isCorporate: false };
const shows = (pathname, extra = {}) => S.sosFabVisible({ pathname, ...ctx, ...extra });

// Every route in app/, grouped as in the brief.
const TAB_SCREENS = ['/all-services', '/my-requests', '/profile'];
const OTHER_SIGNED_IN = [
  '/my-documents', '/notifications', '/personal-details', '/edit-profile', '/change-contact', '/change-contact-otp',
  '/request-details', '/request-tracking', '/tracking', '/select-service', '/service/air', '/service/marine', '/air-ambulance',
  '/help-support', '/terms', '/privacy',
];
const REQUEST_FLOW = ['/request/step1', '/request/step2', '/request/review', '/request/submitted'];
const AUTH_ONBOARDING = [
  '/', '/welcome', '/login', '/login-otp', '/choose-login', '/register', '/register-otp', '/complete-profile',
  '/forgot-password', '/forgot-password-otp', '/reset-password', '/set-password',
];
const PREVIEW = ['/document-preview']; // a full-screen preview: no button over the document
const CORPORATE = ['/corporate-dashboard', '/corporate-new-case', '/corporate-login', '/corporate-otp'];

describe('where the floating SOS button shows', () => {
  test.each([...TAB_SCREENS, ...OTHER_SIGNED_IN])('%s: shown', (route) => expect(shows(route)).toBe(true));
  test.each(['/home', ...REQUEST_FLOW, ...AUTH_ONBOARDING, ...CORPORATE, ...PREVIEW])('%s: hidden', (route) => expect(shows(route)).toBe(false));

  test('every route of the app is covered by one of the groups', () => {
    const files = [];
    (function walk(dir, base) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full, `${base}/${name}`);
        else if (name.endsWith('.js') && name !== '_layout.js') files.push(name === 'index.js' ? (base || '/') : `${base}/${name.replace(/\.js$/, '')}`);
      }
    })(path.join(__dirname, '../../app'), '');
    const known = new Set(['/home', ...TAB_SCREENS, ...OTHER_SIGNED_IN, ...REQUEST_FLOW, ...AUTH_ONBOARDING, ...CORPORATE, ...PREVIEW]);
    const dynamic = (route) => route.replace(/\/\[[^\]]+\]$/, '/air');
    const missing = files.map(dynamic).filter((route) => !known.has(route));
    expect(missing).toEqual([]);
  });

  test('a signed-out, loading, unreachable or errored session never shows it, on any route', () => {
    for (const authStatus of ['loading', 'anon', 'unreachable', 'error', undefined]) {
      for (const route of [...TAB_SCREENS, ...OTHER_SIGNED_IN]) expect(S.sosFabVisible({ pathname: route, authStatus, isCorporate: false })).toBe(false);
    }
  });
  test('a corporate account never sees it, even on the shared screens', () => {
    for (const route of [...TAB_SCREENS, ...OTHER_SIGNED_IN, '/profile', '/notifications']) expect(shows(route, { isCorporate: true })).toBe(false);
  });
  test('it hides while the keyboard is open', () => {
    expect(shows('/profile', { keyboardOpen: true })).toBe(false);
    expect(shows('/profile', { keyboardOpen: false })).toBe(true);
  });
  test('a query, a hash and a trailing slash do not change the answer', () => {
    expect(shows('/profile?x=1')).toBe(true);
    expect(shows('/profile/')).toBe(true);
    expect(shows('/home?tab=1')).toBe(false);
    expect(shows('/request/step1/')).toBe(false);
    expect(shows('/corporate-dashboard#top')).toBe(false);
  });
  test('a screen added later is shown by default (only the listed ones are hidden), and a corporate one by prefix is hidden', () => {
    expect(shows('/some-new-screen')).toBe(true);
    expect(shows('/corporate-reports')).toBe(false);
    expect(shows('/request/step3')).toBe(false);
  });
  test('missing input hides it', () => {
    expect(S.sosFabVisible()).toBe(false);
    expect(S.sosFabVisible({})).toBe(false);
  });
});

describe('where it sits', () => {
  test('the same place on every screen: 16 above where the tab bar ends (64 plus the inset)', () => {
    expect(S.fabBottom({ insetBottom: 0 })).toBe(80);
    expect(S.fabBottom({ insetBottom: 34 })).toBe(114);
    expect(S.fabBottom({ insetBottom: 24 })).toBe(104);
  });
  test('odd numbers count as no inset, and it does not depend on the screen or on a bar of its own', () => {
    expect(S.fabBottom({ insetBottom: NaN })).toBe(80);
    expect(S.fabBottom({ insetBottom: -4 })).toBe(80);
    expect(S.fabBottom({ insetBottom: undefined })).toBe(80);
    expect(S.fabBottom()).toBe(80);
    expect(S.fabBottom({ insetBottom: 10, pathname: '/request-details', barHeight: 118 })).toBe(90);
    expect(S.fabBottom({ insetBottom: 10, pathname: '/notifications' })).toBe(90);
  });
  test('the room at the end of a scrolling screen is ONE rule: max(the screen own padding, the clearance), never the two added', () => {
    // a tab screen: the scroll area ends above the tab bar (64 + inset), so 16 + 56 + 16 = 88
    for (const inset of [0, 24, 34]) expect(S.fabClearance({ edge: 64 + inset, insetBottom: inset })).toBe(88);
    expect(S.scrollPadFor({ ownPad: 16, visible: true, clearance: 88 })).toBe(88);
    expect(S.scrollPadFor({ ownPad: 24, visible: true, clearance: 88 })).toBe(88);
    expect(S.scrollPadFor({ ownPad: 120, visible: true, clearance: 88 })).toBe(120);
    expect(S.scrollPadFor({ ownPad: 24, visible: false, clearance: 88 })).toBe(24);
  });
  test('a screen with no bar under it: the button floats 80 + inset above the screen bottom, so the clearance reaches over it (152 + inset)', () => {
    expect(S.fabClearance({ edge: 0, insetBottom: 0 })).toBe(152);
    expect(S.fabClearance({ edge: 0, insetBottom: 34 })).toBe(186);
  });
  test('a screen with its own bottom bar: measured from above that bar, the inset cancels (it is already in the bar)', () => {
    expect(S.fabClearance({ edge: 84, insetBottom: 0 })).toBe(68);
    expect(S.fabClearance({ edge: 84 + 34, insetBottom: 34 })).toBe(68);
    expect(S.fabClearance({ edge: 400, insetBottom: 0 })).toBe(0);
  });
  test('the last item ends 16 above the top of the button, on every kind of screen', () => {
    // from the bottom of the screen: the top of the button, plus 16, minus how far up the scroll area ends
    for (const [edge, inset] of [[64, 0], [64 + 34, 34], [0, 0], [0, 34], [84, 0], [84 + 34, 34]]) {
      const buttonTopFromScreenBottom = S.fabBottom({ insetBottom: inset }) + S.FAB_CORE;
      const lastItemBottomFromScreenBottom = edge + S.scrollPadFor({ ownPad: 16, visible: true, clearance: S.fabClearance({ edge, insetBottom: inset }) });
      expect(lastItemBottomFromScreenBottom - buttonTopFromScreenBottom).toBe(16);
    }
  });
  test('content that already ends above the button zone adds nothing, so a screen whose content fits does not scroll for the button', () => {
    const clearance = 88;
    expect(S.scrollPadFor({ ownPad: 16, visible: true, clearance, itemsHeight: 400, viewHeight: 640 })).toBe(16);
    expect(S.scrollPadFor({ ownPad: 16, visible: true, clearance, itemsHeight: 552, viewHeight: 640 })).toBe(16); // exactly fits
    expect(S.scrollPadFor({ ownPad: 16, visible: true, clearance, itemsHeight: 553, viewHeight: 640 })).toBe(88);
    expect(S.scrollPadFor({ ownPad: 16, visible: true, clearance, itemsHeight: 2000, viewHeight: 640 })).toBe(88);
    expect(S.scrollPadFor({ ownPad: 16, visible: true, clearance })).toBe(88); // not measured yet: assume it overflows
  });
  test('odd numbers are tolerated', () => {
    expect(S.fabClearance()).toBe(152);
    expect(S.fabClearance({ edge: NaN, insetBottom: NaN })).toBe(152);
    expect(S.scrollPadFor({ ownPad: NaN, visible: true, clearance: 88 })).toBe(88);
    expect(S.scrollPadFor({})).toBe(0);
  });
  test('the numbers are the design values', () => {
    expect([S.FAB_CORE, S.FAB_RIGHT, S.FAB_GAP, S.FAB_RING, S.TAB_BAR_HEIGHT]).toEqual([56, 16, 16, 80, 64]);
  });
  test('there is no per-screen lift left in the code: no bar store, no tab-route switch', () => {
    const lib = read('../sos.js');
    expect(lib).not.toMatch(/setFixedBar|getFixedBar|subscribeFixedBar|isTabRoute|TAB_ROUTES|barHeight/);
    const hooks = read('../../components/sos/hooks.js');
    expect(hooks).not.toMatch(/useFixedBarHeight|useReportFixedBar|useFocusEffect/);
    expect(read('../../app/request-details.js')).not.toMatch(/useReportFixedBar/);
  });
});

describe('the button and the pulse (source checks)', () => {
  const fab = read('../../components/sos/SosFab.js');
  test('the core is 56 and red, with a white 24 phone icon at stroke 2.1, and the shadow of the design', () => {
    expect(fab).toContain("const RED = '#C53030';");
    expect(fab).toContain('width: FAB_CORE, height: FAB_CORE, borderRadius: FAB_CORE / 2, backgroundColor: RED');
    expect(fab).toContain('<Phone size={24} color="#FFFFFF" strokeWidth={2.1} />');
    expect(fab).toContain("shadowColor: RED, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 6 }, elevation: 6");
  });
  test('the static ring is 68 with a 2px border, always drawn; the pulse ring is 80 with the 0.24 fill; both ignore touches', () => {
    expect(fab).toContain('const STATIC_RING = 68;');
    expect(fab).toContain("borderWidth: 2, borderColor: 'rgba(197,48,48,0.22)'");
    expect(fab).toContain("backgroundColor: 'rgba(197,48,48,0.24)'");
    expect(fab.match(/pointerEvents="none"/g)).toHaveLength(2);
  });
  test('the pulse: scale 0.86 to 1.2 and opacity 0.6 to 0 over 1800 ms ease-out, then a 500 ms rest, three times', () => {
    expect(S.PULSE).toEqual({ runs: 3, duration: 1800, rest: 500, scaleFrom: 0.86, scaleTo: 1.2, opacityFrom: 0.6, opacityTo: 0 });
    expect(fab).toContain('Easing.out(Easing.quad)');
    expect(fab).toContain('useNativeDriver: true');
    expect(fab).toContain('{ iterations: PULSE.runs }');
    expect(fab).toContain('Animated.delay(PULSE.rest)');
    expect(fab).toContain('outputRange: [PULSE.scaleFrom, PULSE.scaleTo]');
    expect(fab).toContain('outputRange: [PULSE.opacityFrom, PULSE.opacityTo]');
  });
  test('it runs on every route change to a screen that shows it, stops on leaving and unmount, and not with Reduce Motion', () => {
    expect(fab).toContain('[pathname, visible, reduceMotion]');
    expect(fab).toContain('return () => { run.stop(); progress.setValue(1); };');
    expect(fab).toContain('if (!show || reduceMotion) return undefined;');
    expect(fab).toContain('AccessibilityInfo.isReduceMotionEnabled()');
    expect(fab).toContain("AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)");
    expect(fab).not.toMatch(/AppState/);
  });
  test('the progress value is created at 0, so each run of the loop starts from 0', () => {
    expect(fab).toContain('useState(() => new Animated.Value(0))');
  });
  test('only the core is a button, with the new label; tapping it opens the shared confirmation', () => {
    expect(fab.match(/<PressBox/g)).toHaveLength(1);
    expect(fab).toContain('accessibilityRole="button"');
    expect(fab).toContain("accessibilityLabel={t('sos_fab_a11y')}");
    expect(fab).toContain('onPress={() => setOpen(true)}');
    expect(fab).toContain("import { SosModal } from './SosModal';");
  });
  test('it sits 16 from the right and 16 above where the tab bar ends, with the 80 box centred on the core', () => {
    expect(fab).toContain('right: FAB_RIGHT - RING_INSET, bottom: bottom - RING_INSET');
    expect(fab).toContain('const bottom = fabBottom({ insetBottom: insets.bottom });');
    expect(fab).toContain('pointerEvents="box-none"');
  });
  test('it is mounted once, in the root layout, under the sign-in cover and the toast', () => {
    const layout = read('../../app/_layout.js');
    expect(layout).toContain("import { SosFab } from '../components/sos/SosFab';");
    expect(layout.match(/<SosFab \/>/g)).toHaveLength(1);
    expect(layout.indexOf('<SosFab />')).toBeLessThan(layout.indexOf('<AuthGate />'));
    expect(layout.indexOf('<SosFab />')).toBeLessThan(layout.indexOf('<Toast />'));
  });
});

describe('the same flow as the Home banner', () => {
  const bar = read('../../components/home/SosBar.js');
  const modal = read('../../components/sos/SosModal.js');
  test('the banner and the button open the same SosModal; the banner keeps its look', () => {
    expect(bar).toContain("import { SosModal } from '../sos/SosModal';");
    expect(bar).toContain('<SosModal visible={open} onClose={() => setOpen(false)} />');
    expect(bar).not.toContain('Linking');
    expect(bar).toContain("minHeight: 56, borderRadius: 16, backgroundColor: '#C53030'");
    expect(bar).toContain("t('sos_title')");
    expect(bar).toContain("t('sos_sub')");
  });
  test('the modal dials the same number, after the same question and two buttons', () => {
    expect(modal).toContain('Linking.openURL(emergencyUrl(EMERGENCY_TEL))');
    expect(modal).toContain("import { EMERGENCY_DISPLAY, EMERGENCY_TEL } from '../../data/mock';");
    expect(modal).toContain('onClose(); Linking.openURL');
    expect(S.emergencyUrl('+919699999065')).toBe('tel:+919699999065');
  });
  test('Services has no red banner of its own any more; Home keeps it', () => {
    expect(read('../../app/all-services.js')).not.toContain('SosBar');
    expect(read('../../app/home.js')).toContain('<SosBar bottom={TAB_BAR + insets.bottom}');
  });
  test('every scrolling screen uses the one rule (useFabScrollPad), and the scroll area of a tab screen ends above the tab bar', () => {
    expect(read('../../components/layout.js')).toContain('useFabScrollPad({ ownPad: (withNav ? 64 : 0) + BOTTOM_GAP + insets.bottom, edge: bottomEdge })');
    expect(read('../../components/layout.js')).toContain('contentContainerStyle={{ paddingBottom }}');
    for (const [file, own] of [['all-services', '16'], ['profile', '24'], ['my-requests', 'L.listPadBottom']]) {
      const source = read('../../app/' + file + '.js');
      expect(source).toMatch(/useFabScrollPad\(\{ ownPad: (16|24|L\.listPadBottom), edge: TAB_BAR \+ insets\.bottom \}\)/);
      expect(source).toContain(`ownPad: ${own.split('|')[0]},`);
      expect(source).toContain('marginBottom: TAB_BAR + insets.bottom');
      expect(source).toContain('{...scrollProps}');
      expect(source).not.toMatch(/fabPad|useSosFabPad/);
      expect(source).not.toMatch(/paddingBottom: [^,}]*TAB_BAR/);
    }
  });
  test('Request Details measures its own bar and tells the scroll area to end above it', () => {
    const screen = read('../../app/request-details.js');
    expect(screen).toContain('bottomEdge={view.showTrackingBar ? barHeight : 0}');
    expect(screen).toContain('onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}');
  });
  test('no screen adds a bottom padding of its own on top of the rule: the content blocks end flush with the scroll content', () => {
    expect(read('../../app/request-details.js')).toContain('paddingTop: 16, paddingHorizontal: 16, paddingBottom: 0, gap: 14');
    expect(read('../../components/tracking/TrackingDetails.js')).toContain('paddingTop: 16, paddingHorizontal: 16, paddingBottom: 0, gap: 14');
  });
});

describe('the words', () => {
  const t = (lang, key, values) => translate(i18n, lang, key, values);
  test('the label and the confirmation exist in all six languages; the English wording is the one that was hard-coded', () => {
    for (const key of ['sos_fab_a11y', 'sos_modal_title', 'sos_modal_body', 'sos_modal_cancel', 'sos_modal_call']) {
      for (const lang of Object.keys(i18n)) expect(typeof i18n[lang][key]).toBe('string');
    }
    expect(i18n.EN.sos_fab_a11y).toBe('SOS emergency assistance, call our 24/7 team');
    expect(i18n.EN.sos_modal_title).toBe('Call Emergency Assistance?');
    expect(i18n.EN.sos_modal_cancel).toBe('Cancel');
    expect(i18n.EN.sos_modal_call).toBe('Call Now');
    expect(t('EN', 'sos_modal_body', { number: '+91 96999 99065' })).toBe('This will immediately call our 24/7 emergency line at +91 96999 99065.');
  });
  test('the body keeps its {{number}} place in every language, so the number can be set in bold', () => {
    for (const lang of Object.keys(i18n)) expect(i18n[lang].sos_modal_body).toContain('{{number}}');
    for (const lang of Object.keys(i18n)) {
      const text = t(lang, 'sos_modal_body', { number: 'N1' });
      expect(text.split('N1')).toHaveLength(2);
    }
  });
  test('the modal has no hard-coded English left', () => {
    const modal = read('../../components/sos/SosModal.js');
    for (const text of ['Call Emergency Assistance?', '"Cancel"', '"Call Now"', 'This will immediately call']) expect(modal).not.toContain(text);
  });
});
