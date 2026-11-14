/* global describe, test, expect, __dirname */
const fs = require('fs');
const path = require('path');
const i18n = require('../../data/i18n.json');
const { translate } = require('../translate');
const R = require('../recaptcha');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

// Every route of the app (the files of app/, as in sos.test.js).
function allRoutes() {
  const files = [];
  (function walk(dir, base) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full, `${base}/${name}`);
      else if (name.endsWith('.js') && name !== '_layout.js') files.push(name === 'index.js' ? (base || '/') : `${base}/${name.replace(/\.js$/, '')}`);
    }
  })(path.join(__dirname, '../../app'), '');
  return files.map((route) => route.replace(/\/\[[^\]]+\]$/, '/air'));
}

describe('where the reCAPTCHA badge shows', () => {
  const SIGN_IN = ['/login', '/login-otp', '/choose-login', '/register', '/register-otp', '/forgot-password', '/forgot-password-otp'];
  test.each(SIGN_IN)('%s: shown', (route) => expect(R.recaptchaBadgeVisible(route)).toBe(true));

  test('every other route of the app hides it, every signed-in screen included', () => {
    const others = allRoutes().filter((route) => !SIGN_IN.includes(route));
    expect(others).toEqual(expect.arrayContaining(['/home', '/all-services', '/my-requests', '/profile', '/my-documents', '/notifications', '/request-details', '/request-tracking', '/tracking', '/service/air', '/change-contact-otp', '/request/step1', '/corporate-dashboard']));
    for (const route of others) expect(R.recaptchaBadgeVisible(route)).toBe(false);
  });
  test('a query, a hash and a trailing slash do not change the answer; nothing hides it', () => {
    expect(R.recaptchaBadgeVisible('/login-otp?x=1')).toBe(true);
    expect(R.recaptchaBadgeVisible('/login/')).toBe(true);
    expect(R.recaptchaBadgeVisible('/home?tab=1')).toBe(false);
    expect(R.recaptchaBadgeVisible(undefined)).toBe(false);
    expect(R.recaptchaBadgeVisible('')).toBe(false);
  });
});

describe('the rule that hides it', () => {
  test('visibility is hidden unless the page says it is on a sign-in screen; display is not touched, so the script keeps working', () => {
    expect(R.BADGE_CSS).toBe('html:not([data-recaptcha-badge="visible"]) .grecaptcha-badge { visibility: hidden !important; }');
    expect(R.BADGE_CSS).not.toMatch(/display\s*:/);
  });
  test('the gate is mounted once in the root layout, is web only, renders nothing and sets the attribute from the route', () => {
    const gate = read('../../components/RecaptchaBadgeGate.js');
    expect(read('../../app/_layout.js').match(/<RecaptchaBadgeGate \/>/g)).toHaveLength(1);
    expect(gate).toContain("if (Platform.OS !== 'web' || typeof document === 'undefined') return;");
    expect(gate).toContain("document.documentElement.setAttribute(BADGE_ATTRIBUTE, visible ? 'visible' : 'hidden');");
    expect(gate).toContain('return null;');
  });
  test('how reCAPTCHA works is not changed: the Firebase verifier code is as it was', () => {
    const web = read('../phoneAuth.web.js');
    expect(web).toContain("new RecaptchaVerifier(auth, el, { size: 'invisible' })");
    expect(web).toContain('window.grecaptcha.reset(widgetId)');
    expect(web).not.toMatch(/visibility|grecaptcha-badge|\.clear\(\)/);
  });
});

describe('the notice Google asks for', () => {
  const t = (lang, key, values) => translate(i18n, lang, key, values);
  test('the English sentence is the one Google specifies', () => {
    expect(t('EN', 'recaptcha_notice', { privacy: i18n.EN.recaptcha_privacy, terms: i18n.EN.recaptcha_terms }))
      .toBe('This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.');
  });
  test('it exists in all six languages, keeps both link places, and the link names are translated', () => {
    for (const lang of Object.keys(i18n)) {
      for (const key of ['recaptcha_notice', 'recaptcha_privacy', 'recaptcha_terms']) expect(typeof i18n[lang][key]).toBe('string');
      expect(i18n[lang].recaptcha_notice).toContain('{{privacy}}');
      expect(i18n[lang].recaptcha_notice).toContain('{{terms}}');
    }
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) expect(i18n[lang].recaptcha_privacy).not.toBe(i18n.EN.recaptcha_privacy);
  });
  test('the links go to Google\'s pages, and the component shows only on the web', () => {
    expect(R.RECAPTCHA_PRIVACY_URL).toBe('https://policies.google.com/privacy');
    expect(R.RECAPTCHA_TERMS_URL).toBe('https://policies.google.com/terms');
    expect(read('../../components/RecaptchaNotice.js')).toContain("if (Platform.OS !== 'web') return null;");
  });
  test('every screen that sends a code through Firebase shows it, and the corporate code screen (no reCAPTCHA) does not', () => {
    expect(read('../../components/OtpScreen.js')).toContain('{recaptcha ? <RecaptchaNotice /> : null}');
    for (const screen of ['login-otp', 'register-otp', 'forgot-password-otp', 'change-contact-otp']) {
      const source = read(`../../app/${screen}.js`);
      expect(source).toContain('usePhoneCode(step)');
      expect(source).toMatch(/\brecaptcha\b/);
    }
    expect(read('../../app/corporate-otp.js')).not.toMatch(/recaptcha/);
  });
});
