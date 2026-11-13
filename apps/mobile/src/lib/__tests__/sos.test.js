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
const CORPORATE = ['/corporate-dashboard', '/corporate-new-case', '/corporate-login', '/corporate-otp'];

describe('where the floating SOS button shows', () => {
  test.each([...TAB_SCREENS, ...OTHER_SIGNED_IN])('%s: shown', (route) => expect(shows(route)).toBe(true));
  test.each(['/home', ...REQUEST_FLOW, ...AUTH_ONBOARDING, ...CORPORATE])('%s: hidden', (route) => expect(shows(route)).toBe(false));

  test('every route of the app is covered by one of the groups', () => {
    const files = [];
    (function walk(dir, base) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full, `${base}/${name}`);
        else if (name.endsWith('.js') && name !== '_layout.js') files.push(name === 'index.js' ? (base || '/') : `${base}/${name.replace(/\.js$/, '')}`);
      }
    })(path.join(__dirname, '../../app'), '');
    const known = new Set(['/home', ...TAB_SCREENS, ...OTHER_SIGNED_IN, ...REQUEST_FLOW, ...AUTH_ONBOARDING, ...CORPORATE]);
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
  test('on a tab screen: 16 above the tab bar (64 plus the inset)', () => {
    for (const route of TAB_SCREENS) {
      expect(S.fabBottom({ pathname: route, insetBottom: 0 })).toBe(80);
      expect(S.fabBottom({ pathname: route, insetBottom: 34 })).toBe(114);
    }
  });
  test('above a screen\'s own fixed bar: 16 above that bar', () => {
    expect(S.fabBottom({ pathname: '/request-details', insetBottom: 34, barHeight: 118 })).toBe(134);
    expect(S.fabBottom({ pathname: '/request-details', insetBottom: 0, barHeight: 84 })).toBe(100);
  });
  test('on a screen with neither: 16 above the bottom inset', () => {
    expect(S.fabBottom({ pathname: '/notifications', insetBottom: 0 })).toBe(16);
    expect(S.fabBottom({ pathname: '/notifications', insetBottom: 24 })).toBe(40);
  });
  test('a tab screen ignores a stale bar, and odd numbers count as none', () => {
    expect(S.fabBottom({ pathname: '/profile', insetBottom: 10, barHeight: 500 })).toBe(90);
    expect(S.fabBottom({ pathname: '/notifications', insetBottom: NaN, barHeight: -4 })).toBe(16);
    expect(S.fabBottom({ pathname: '/notifications', insetBottom: undefined })).toBe(16);
  });
  test('a scrolling screen gets 96 more at its end while it shows, and nothing otherwise', () => {
    expect(S.fabContentPad(true)).toBe(96);
    expect(S.fabContentPad(false)).toBe(0);
  });
  test('the numbers are the design\'s', () => {
    expect([S.FAB_CORE, S.FAB_RIGHT, S.FAB_GAP, S.FAB_RING, S.TAB_BAR_HEIGHT]).toEqual([56, 16, 16, 80, 64]);
  });
});

describe('the fixed-bar store', () => {
  test('it keeps the last height, tells listeners only when it changes, and ignores nonsense', () => {
    const seen = [];
    const off = S.subscribeFixedBar(() => seen.push(S.getFixedBar()));
    S.setFixedBar(84); S.setFixedBar(84); S.setFixedBar(0); S.setFixedBar(NaN); S.setFixedBar(-3);
    expect(seen).toEqual([84, 0]);
    off();
    S.setFixedBar(50);
    expect(seen).toEqual([84, 0]);
    expect(S.getFixedBar()).toBe(50);
    S.setFixedBar(0);
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
    expect(fab.match(/<Pressable/g)).toHaveLength(1);
    expect(fab).toContain('accessibilityRole="button"');
    expect(fab).toContain("accessibilityLabel={t('sos_fab_a11y')}");
    expect(fab).toContain('onPress={() => setOpen(true)}');
    expect(fab).toContain("import { SosModal } from './SosModal';");
  });
  test('it sits 16 from the right and above the bar, with the 80 box centred on the core', () => {
    expect(fab).toContain('right: FAB_RIGHT - RING_INSET, bottom: bottom - RING_INSET');
    expect(fab).toContain('const bottom = fabBottom({ pathname, insetBottom: insets.bottom, barHeight });');
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
  test('Request Details reports the height of its own bar, only while it is drawn and in front', () => {
    const screen = read('../../app/request-details.js');
    expect(screen).toContain('useReportFixedBar(view && view.showTrackingBar ? barHeight : 0);');
    expect(screen).toContain('onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}');
    expect(read('../../components/sos/hooks.js')).toContain('useFocusEffect(');
  });
  test('the scrolling screens leave 96 more at the end while the button shows', () => {
    expect(read('../../components/layout.js')).toContain('+ insets.bottom + fabPad }}');
    expect(read('../../app/my-requests.js')).toMatch(/TAB_BAR \+ insets\.bottom \+ fabPad, gap: /);
    expect(read('../../app/profile.js')).toContain('TAB_BAR + insets.bottom + 24 + fabPad');
    expect(read('../../app/all-services.js')).toContain('TAB_BAR + insets.bottom + 16 + fabPad');
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
