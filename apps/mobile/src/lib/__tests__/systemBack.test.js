/* global describe, test, expect, __dirname */
// Android system back: it follows the navigation history, like the app's own back button. Automated checks of the rule and the wiring;
// the real button and the gesture need a phone (see the report).
const fs = require('fs');
const path = require('path');
const { systemBackAction } = require('../systemBack');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\r\n').join('\n');
const act = (pathname, canGoBack) => systemBackAction({ pathname, canGoBack });

describe('there is a screen to go back to: the navigator goes back (never Home)', () => {
  test.each([
    ['/my-documents', 'Profile -> My Documents'],
    ['/personal-details', 'Profile -> Personal Details'],
    ['/request-details', 'My Requests -> Request Details'],
    ['/request-tracking', 'Request Details -> Tracking Details'],
    ['/request/step2', 'New Request: step 2 -> step 1'],
    ['/request/review', 'New Request: review -> step 2'],
    ['/forgot-password', 'Login -> Forgot password'],
    ['/login-otp', 'Login -> code screen'],
    ['/register-otp', 'Register -> code screen'],
    ['/notifications', 'Home -> Notifications'],
    ['/home', 'Home with something under it'],
    ['/profile', 'a tab screen that has history'],
    ['/corporate-new-case', 'Corporate dashboard -> new case'],
    ['/terms', 'Profile -> Terms'],
  ])('%s (%s)', (p) => expect(act(p, true)).toBe('default'));
});

describe('nothing to go back to: the app\'s own fallback, the same as its back button', () => {
  test.each(['/profile', '/my-requests', '/all-services', '/corporate-dashboard'])('a tab screen (%s) goes to Home', (p) => expect(act(p, false)).toBe('home'));
  test.each(['/my-documents', '/request-details', '/request/step1', '/notifications', '/personal-details', '/service/ground'])('a screen opened with no history (%s) goes to Home', (p) => expect(act(p, false)).toBe('home'));
  test.each(['/terms', '/privacy', '/help-support'])('a page that is opened from somewhere (%s) goes to Home', (p) => expect(act(p, false)).toBe('home'));
});

describe('Home, the splash and the sign-in screens keep the phone\'s default (the app is left, as before)', () => {
  test.each(['/home', '/', '/welcome', '/login', '/choose-login', '/register', '/forgot-password', '/login-otp', '/corporate-login', '/corporate-otp'])('%s', (p) => {
    expect(act(p, false)).toBe('default');
  });
  test('a query string or a trailing slash does not change the answer', () => {
    expect(act('/profile/?x=1', false)).toBe('home');
    expect(act('/home/', false)).toBe('default');
    expect(act(undefined, false)).toBe('default'); // the splash
  });
});

describe('the wiring: ONE listener, at the root, only for Android', () => {
  const src = (rel) => read(rel);
  const all = (dir) => fs.readdirSync(path.join(__dirname, '../..', dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? all(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
  test('BackHandler is used in exactly one place', () => {
    const users = [...all('app'), ...all('components'), ...all('lib'), ...all('state')].filter((f) => !f.includes('__tests__') && /BackHandler/.test(src(f)));
    expect(users).toEqual(['components/SystemBack.js']);
    expect(src('components/SystemBack.js').match(/BackHandler\.addEventListener/g)).toHaveLength(1);
  });
  test('the tab bar no longer has its own (it was running under the screens pushed on top of it)', () => {
    const layout = src('components/layout.js');
    expect(layout).not.toContain('BackHandler');
    expect(layout).not.toContain('hardwareBackPress');
  });
  test('it asks the navigator at the moment of the press; when it can go back it returns false so the navigator pops', () => {
    const c = src('components/SystemBack.js');
    expect(c).toContain('router.canGoBack()');
    expect(c).toContain("!== 'home') return false;");
    expect(c).toContain("if (Platform.OS !== 'android') return undefined;");
  });
  test('it is registered once and removed when it goes away', () => {
    const c = src('components/SystemBack.js');
    expect(c).toMatch(/\}, \[\]\);/);
    expect(c).toContain('return () => sub.remove();');
  });
  test('it is mounted once, in the root layout', () => {
    const layout = src('app/_layout.js');
    expect(layout).toContain('<SystemBack />');
    expect(layout.match(/<SystemBack/g)).toHaveLength(1);
  });
  test('the app\'s own back button is unchanged: pop, or Home when there is nothing to pop', () => {
    const nav = src('lib/nav.js');
    expect(nav).toContain('if (router.canGoBack()) router.back();\n  else navReplace(\'/home\');');
  });
  test('the authentication guard and the modals are untouched (RN modals close themselves on back)', () => {
    expect(src('components/AuthGate.js')).toContain('router.replace(target)');
    expect(src('lib/authGuard.js')).toContain("export const PATIENT_LOGIN = '/login';");
  });
});
