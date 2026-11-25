/* global describe, test, expect, jest, __dirname */
// Pull-to-refresh must behave the same in EVERY language (English, Hindi, Marathi, Gujarati, Telugu, Arabic): the same screens, the same gesture, the same loading and error messages (each in its own
// language), nothing that depends on which language is chosen. The direction of the layout is set once, at the root, for Arabic: the refresh code adds nothing of its own. Source checks and the real
// dictionary: no device, no network.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { translate } = require('../translate');
const { isNetworkToast, hideToastForBanner } = require('../networkUi');
const { runNetworkRefresh, REFRESH_MIN_MS } = require('../networkRefresh');

const SRC = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const t = (lang) => (key, values) => translate(I18N, lang, key, values);
const placeholders = (text) => (String(text).match(/\{\{?[A-Za-z0-9_.]+\}?\}/g) || []).sort().join(',');

// Every screen that can be pulled (data screens that reload, and the forms whose pull re-checks the connection).
const PULL_SCREENS = [
  'app/(tabs)/home.js', 'app/(tabs)/my-requests.js', 'app/my-documents.js', 'app/notifications.js', 'app/(tabs)/profile.js', 'app/request-details.js', 'app/request-tracking.js', 'app/tracking.js',
  'app/personal-details.js', 'app/service/[key].js', 'components/request/RequestFrame.js',
];

describe('the same screens are pullable whatever the language', () => {
  test('every pullable screen wires the one shared control with no condition on the language', () => {
    for (const file of PULL_SCREENS) {
      const source = read(file);
      expect({ file, control: source.includes('AppRefreshControl') }).toEqual({ file, control: true });
      // the lines that create or wire the control mention no language, direction or script
      const lines = source.split('\n').filter((line) => /AppRefreshControl|onRefresh|useNetworkRefresh|refreshControl/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('import'));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect({ file, line, langSpecific: /\blang\b|isRTL|rtl|direction|['"](?:AR|HI|MR|GU|TE|EN)['"]/i.test(line) }).toEqual({ file, line, langSpecific: false });
    }
  });
  test('the only conditions on the control are about the account (a corporate account has its own screens), never the language', () => {
    for (const file of ['app/(tabs)/home.js', 'app/(tabs)/profile.js', 'app/notifications.js']) {
      const lines = read(file).split('\n').filter((l) => /refreshControl=/.test(l));
      for (const line of lines) expect(line).not.toMatch(/lang|isRTL|AR\b/);
    }
  });
  test('the control itself is language-free: a plain RefreshControl with the brand colours, passing every other prop on', () => {
    const control = read('components/AppRefreshControl.js');
    const code = control.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/useApp|isRTL|lang|direction|transform|I18nManager|Platform\.OS/);
    expect(code).toContain('{...rest}');
    expect(code).toContain('tintColor={COLORS.primary}');
    expect(code).toContain('colors={[COLORS.primary]}');
  });
  test('the shared pieces add nothing of their own for any language', () => {
    for (const file of ['lib/useNetworkRefresh.js', 'lib/networkRefresh.js', 'lib/useResource.js']) {
      const code = read(file).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      expect({ file, langSpecific: /isRTL|\brtl\b|direction|I18nManager|['"](?:AR|HI|MR|GU|TE)['"]/.test(code) }).toEqual({ file, langSpecific: false });
    }
  });
});

describe('the layout direction is decided once, at the root, not by the refresh code', () => {
  test('only the root view sets direction (from the selected language); no pullable screen sets its own', () => {
    expect(read('app/_layout.js')).toContain("style={{ direction: isRTL ? 'rtl' : 'ltr' }}");
    for (const file of PULL_SCREENS) expect({ file, direction: /direction:/.test(read(file)) }).toEqual({ file, direction: false });
  });
  test('the scroll containers forward the control, in the real keyboard-aware scroll view and in its stand-in, for every language alike', () => {
    expect(read('components/layout.js')).toContain('refreshControl={refreshControl}');
    const keyboard = read('components/keyboard/index.js');
    expect(keyboard).toMatch(/\{\.\.\.props\}/); // KeyboardScroll hands every ScrollView prop (the control included) on
    expect(read('components/keyboard/controller.js')).toMatch(/<ScrollView[\s\S]*\{\.\.\.props\}/); // and so does the stand-in used when the native module is missing
  });
  test('the pull gesture is the phone\'s own RefreshControl: its spinner is placed by the system at the top centre, so it does not depend on the text direction', () => {
    const code = read('components/AppRefreshControl.js');
    expect(code).toContain("import { RefreshControl } from 'react-native';");
    expect(code).not.toMatch(/progressViewOffset|style=/); // no custom positioning that could differ by direction
  });
});

describe('the loading and error messages exist, translated, in all six languages', () => {
  const KEYS = Object.keys(I18N.EN).filter((k) => /^sk_|^net_|^lf_|^home_refresh|^err_network|^err_timeout|^docs_err_|^up_state_|^srv_/.test(k));
  test('there are plenty of them (the filter found the families)', () => { expect(KEYS.length).toBeGreaterThan(60); });
  test.each(LANGS)('%s: every one is present, non-empty and keeps its placeholders', (lang) => {
    for (const key of KEYS) {
      const text = I18N[lang][key];
      expect({ lang, key, ok: typeof text === 'string' && text.trim() !== '' }).toEqual({ lang, key, ok: true });
      expect({ lang, key, p: placeholders(text) }).toEqual({ lang, key, p: placeholders(I18N.EN[key]) });
    }
  });
  test('the pull-to-refresh failure message is translated in every language (not the English text)', () => {
    for (const lang of LANGS.filter((l) => l !== 'EN')) {
      expect({ lang, same: I18N[lang].sk_refresh_failed === I18N.EN.sk_refresh_failed }).toEqual({ lang, same: false });
      expect({ lang, same: I18N[lang].home_refresh_failed === I18N.EN.home_refresh_failed }).toEqual({ lang, same: false });
    }
  });
  test('every pullable screen reports a failed pull with the SAME key, so the message differs only by language', () => {
    for (const file of ['app/(tabs)/home.js', 'app/(tabs)/my-requests.js', 'app/my-documents.js', 'app/notifications.js', 'app/(tabs)/profile.js', 'app/request-details.js', 'app/request-tracking.js', 'app/tracking.js']) {
      expect({ file, key: read(file).includes("t('sk_refresh_failed')") }).toEqual({ file, key: true });
    }
    expect(read('lib/useNetworkRefresh.js')).toContain("t('sk_refresh_failed')"); // the forms, the service detail and the personal details
  });
  test('the loading label of each screen that shows a skeleton exists in all six languages', () => {
    for (const key of ['sk_loading_requests', 'sk_loading_request', 'sk_loading_tracking', 'sk_loading_documents', 'sk_loading_notifications', 'sk_loading_active', 'sk_loading_profile', 'sk_loading_cases']) {
      for (const lang of LANGS) expect({ lang, key, ok: !!I18N[lang][key] }).toEqual({ lang, key, ok: true });
    }
  });
});

describe('the failure toast is shown, and the banner-duplicate rule applies, identically in every language', () => {
  test('"Couldn\'t refresh" is never hidden by a banner, in any language', () => {
    for (const lang of LANGS) {
      const message = t(lang)('sk_refresh_failed');
      expect({ lang, hidden: hideToastForBanner({ message, bannerVisible: true }) }).toEqual({ lang, hidden: false });
      expect({ lang, hidden: hideToastForBanner({ message: t(lang)('home_refresh_failed'), bannerVisible: true }) }).toEqual({ lang, hidden: false });
    }
  });
  test('a network message that only repeats the banner is left out while a banner is showing, in EVERY language (it used to be English only)', () => {
    const NETWORK_KEYS = ['err_network_read', 'err_network_short', 'err_network_write', 'net_load_timeout', 'net_load_offline', 'net_load_server'];
    for (const lang of LANGS) {
      for (const key of NETWORK_KEYS) {
        const message = t(lang)(key);
        expect({ lang, key, hiddenWithBanner: hideToastForBanner({ message, bannerVisible: true }) }).toEqual({ lang, key, hiddenWithBanner: true });
        expect({ lang, key, hiddenWithoutBanner: hideToastForBanner({ message, bannerVisible: false }) }).toEqual({ lang, key, hiddenWithoutBanner: false }); // no banner: the toast is the only message
      }
    }
  });
  test('the same set of keys is hidden in every language (no language is left out)', () => {
    const hiddenKeys = (lang) => Object.keys(I18N.EN).filter((key) => isNetworkToast(I18N[lang][key]));
    const english = hiddenKeys('EN');
    expect(english.length).toBeGreaterThan(5);
    for (const lang of LANGS.filter((l) => l !== 'EN')) {
      const missing = english.filter((key) => !hiddenKeys(lang).includes(key));
      expect({ lang, missing }).toEqual({ lang, missing: [] });
    }
  });
  test('an unrelated message is never hidden, in any language', () => {
    for (const lang of LANGS) {
      for (const key of ['sk_refresh_failed', 'req_required', 'pd_saved', 'err_generic']) {
        expect({ lang, key, hidden: isNetworkToast(I18N[lang][key]) }).toEqual({ lang, key, hidden: false });
      }
    }
    for (const value of [undefined, null, 5, {}, '']) expect(isNetworkToast(value)).toBe(false);
  });
});

describe('the refresh logic does not depend on the language', () => {
  test('the same outcome for every language: a failed read gives { failed: true } and the message comes from that language\'s dictionary', async () => {
    jestFakeTimers();
    for (const lang of LANGS) {
      const promise = runNetworkRefresh({ check: async () => undefined, reload: async () => { throw new Error('offline'); } });
      await advance(REFRESH_MIN_MS);
      const outcome = await promise;
      expect({ lang, failed: outcome.failed }).toEqual({ lang, failed: true });
      expect({ lang, shown: t(lang)('sk_refresh_failed') }).toEqual({ lang, shown: I18N[lang].sk_refresh_failed });
    }
    jestRealTimers();
  });
});

function jestFakeTimers() { jest.useFakeTimers(); }
function jestRealTimers() { jest.useRealTimers(); }
const advance = (ms) => jest.advanceTimersByTimeAsync(ms);
