/* global describe, test, expect, __dirname */
// Profile: About HumanCare (above Delete account), Delete account (above Log out, patients only, two-step re-authenticated, never one tap), the About screen's content
// (only what the project already publishes), six-language strings, route guarding, and Medical Reports staying optional everywhere except Private Charter (untouched).
// (The screens are not rendered here: this project's Jest covers lib/ logic and reads screen source, see jest.config.js; the behaviour on a phone is checked by hand.)
const fs = require('fs');
const path = require('path');
const { isPublicRoute, guardDecision } = require('../authGuard');
const { needsDocument } = require('../privateCharter');
const { homeStep2Problems } = require('../homeHealthcare');
const { mortalStep2Problems } = require('../mortalRemains');
const { teleStep2Problems } = require('../teleConsultation');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
// The source without its comments: the checks are about what the code does, not what its comments say.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const OTHERS = ['HI', 'MR', 'GU', 'TE', 'AR'];

describe('Profile: About HumanCare, Delete account, Log out', () => {
  const profile = code('app/(tabs)/profile.js');
  test('the order is About HumanCare, then Delete account, then Log out', () => {
    const about = profile.indexOf("t('prof_about')");
    const del = profile.indexOf("t('prof_delete')");
    const logout = profile.indexOf("t('prof_logout')");
    expect(about).toBeGreaterThan(-1);
    expect(about).toBeLessThan(del);
    expect(del).toBeLessThan(logout);
    // Delete account sits directly above the Log out button: nothing but it between the Support section and Log out
    const between = profile.slice(profile.indexOf('<Section label={t(\'prof_support\')}'), profile.indexOf("accessibilityLabel={t('prof_logout')}"));
    expect(between.match(/<PressBox/g)).toHaveLength(2); // Delete account's, and Log out's own opening
  });
  test('About HumanCare is a row of the Support section and opens the About screen', () => {
    expect(profile).toMatch(/const support = \[[\s\S]*?label: t\('prof_about'\), onPress: \(\) => router\.push\('\/about'\)[\s\S]*?\];/);
  });
  test('Delete account is hidden for a corporate account, and only opens the explanation screen (it deletes nothing itself)', () => {
    expect(profile).toMatch(/\{isCorporate \? null : \(\s*<PressBox/);
    expect(profile).toContain("router.push('/delete-account')");
    expect(profile).not.toMatch(/apiPost|apiDelete|\/auth\/me\/delete/);
  });
  test('it is drawn as a destructive action (red icon and text, red-tinted border) and has an accessibility label', () => {
    expect(profile).toMatch(/accessibilityLabel=\{t\('prof_delete'\)\}/);
    expect(profile).toMatch(/borderColor: '#F3C4C4'/);
    expect(profile).toMatch(/<UserX[^>]*color="#C53030"/);
  });
  test('Log out is unchanged', () => {
    expect(profile).toContain("const signOut = async () => { navReplace(isCorporate ? '/corporate-login' : '/login'); await signOutSession({ isCorporate, beforeClear: clearDraftEverywhere }); };");
    expect(profile).toContain('onPress={signOut}');
  });
});

describe('Delete account, step 1 (explanation, then a code: no password)', () => {
  const screen = code('app/delete-account.js');
  test('patients only: a corporate account is sent back to Profile', () => {
    expect(screen).toContain('if (isCorporate) return <Redirect href="/profile" />;');
  });
  test('it explains the consequences before anything can happen', () => {
    for (const key of ['del_warning_title', 'del_warning_body', 'del_item_personal', 'del_item_records', 'del_item_files', 'del_item_active']) expect(screen).toContain(`'${key}'`);
    expect(i18n.EN.del_warning_body).toMatch(/cannot be undone/);
    expect(i18n.EN.del_item_records).toMatch(/may be kept where the law or our operations require it/);
    expect(i18n.EN.del_item_files).toMatch(/not deleted automatically/);
    // it never claims that records are erased, or that Bitrix24 / files are removed
    expect(JSON.stringify(i18n.EN)).not.toMatch(/all your (requests|data|documents) (will be|are) (deleted|erased)/i);
  });
  test('one tap can never delete: the person must tick "I understand" and press a separate button, which only STARTS the two-step flow', () => {
    expect(screen).toContain('accessibilityRole="checkbox"');
    expect(screen).toContain('const ready = understood;');
    expect(screen).toContain("apiPost('/auth/me/delete/start', {})");
    expect(screen).not.toContain('/auth/me/delete/confirm');
    expect(screen).toContain("router.push('/delete-account-otp')");
    expect(screen).toContain('if (!ready || busy) return;');
  });
  test('no password is asked for, for any account: no password field, state, check or message on the screen, and nothing about a password is sent', () => {
    for (const gone of ['secureTextEntry', 'password', 'Password', 'needsPassword', 'hasPassword', 'invalid_password', 'del_password', 'del_wrong_password', 'textContentType']) {
      expect({ gone, present: screen.includes(gone) }).toEqual({ gone, present: false });
    }
    expect(screen).not.toMatch(/import \{[^}]*\bField\b[^}]*\} from '..\/components\/ui'/); // the input component is no longer used here
    expect(screen).toContain("apiPost('/auth/me/delete/start', {})");
  });
  test('the code is still mandatory: Continue only starts the flow and moves to the code screen; nothing is deleted without it', () => {
    expect(screen).toContain("setAuthStep('delete-account-otp', codeStepFrom(data));");
    expect(screen).toContain("router.push('/delete-account-otp')");
    expect(screen).not.toContain('/auth/me/delete/confirm');
    expect(read('app/delete-account-otp.js')).toContain("apiPost('/auth/me/delete/confirm', { ticket, confirm: true, ...(await proof(code)) })");
  });
  test('requests in progress: a clear message and a way to reach support, not a silent failure', () => {
    expect(screen).toContain("err.code === 'active_requests'");
    expect(screen).toContain("t('del_blocked_body', { n: blocked })");
    expect(screen).toContain("router.push('/help-support')");
  });
});

describe('Delete account, step 2 (the code)', () => {
  const screen = code('app/delete-account-otp.js');
  test('confirms with the code and the explicit confirmation, then shows Login first and clears the tokens (the same order as Log out)', () => {
    expect(screen).toContain("apiPost('/auth/me/delete/confirm', { ticket, confirm: true, ...(await proof(code)) })");
    const login = screen.indexOf("navReplace('/login')");
    const clear = screen.indexOf('await clearTokens()');
    expect(login).toBeGreaterThan(-1);
    expect(login).toBeLessThan(clear);
    expect(screen).toContain('clearAuthSteps();');
  });
  test('without a started flow it goes back to Profile, and it can resend the code like every other code screen', () => {
    expect(screen).toContain('if (!step) return <Redirect href="/profile" />;');
    expect(screen).toContain('usePhoneCode(step)');
    expect(screen).toContain('onResend={resend}');
  });
});

describe('About HumanCare', () => {
  const body = code('app/about.js');
  // (The About page now shows only the approved introduction, in an open layout: its content and layout are checked in aboutScreen.test.js. What stays checked here is
  // what this work must not break: the route, the title bar and the legal screens, which are still reachable from elsewhere.)
  test('shows the name, then the approved introduction (no logo): no Terms, Privacy or version', () => {
    expect(body).toContain("from '../data/aboutContent';");
    expect(body).not.toContain('LOGO'); // the logo was removed from this page
    expect(body).not.toContain("t('terms_title')");
    expect(body).not.toContain("t('privacy_title')");
    expect(body).not.toContain('prof_footer');
    expect(body).not.toContain('expoConfig');
  });
  test('the Terms and Privacy screens still exist (they are not part of this page any more)', () => {
    expect(fs.existsSync(path.join(__dirname, '../../app/terms.js'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../../app/privacy.js'))).toBe(true);
  });
  test('the page is still the title bar with the translated "About" title, in the root direction', () => {
    expect(body).toContain("<TopBar title={t('prof_about')} />");
    expect(read('app/_layout.js')).toContain("direction: isRTL ? 'rtl' : 'ltr'");
  });
});

describe('the new screens need a signed-in person', () => {
  test('none of them is public, so a signed-out person is sent to Login', () => {
    for (const route of ['/about', '/delete-account', '/delete-account-otp']) {
      expect({ route, public: isPublicRoute(route) }).toEqual({ route, public: false });
      expect(guardDecision({ pathname: route, status: 'anon' })).toEqual({ action: 'redirect', redirect: '/login' });
      expect(guardDecision({ pathname: route, status: 'authed' })).toEqual({ action: 'allow' });
    }
  });
});

describe('strings: all six languages', () => {
  const KEYS = [
    'prof_about', 'about_services', 'about_contact', 'about_website', 'about_legal', 'prof_delete', 'del_warning_title', 'del_warning_body', 'del_item_personal', 'del_item_records',
    'del_item_files', 'del_item_active', 'del_password', 'del_confirm_check', 'del_continue', 'del_cancel', 'del_blocked_title', 'del_blocked_body', 'del_contact_support',
    'del_wrong_password', 'del_done',
  ];
  test('every string exists in all six languages, and the five others are real translations', () => {
    for (const key of KEYS) {
      expect({ key, en: typeof i18n.EN[key] === 'string' && i18n.EN[key].length > 0 }).toEqual({ key, en: true });
      for (const lang of OTHERS) {
        // (a brand name or a proper noun may legitimately equal the English text: only "About HumanCare" qualifies, and it differs in every language here)
        expect({ key, lang, ok: typeof i18n[lang][key] === 'string' && i18n[lang][key].trim().length > 0 && i18n[lang][key] !== i18n.EN[key] }).toEqual({ key, lang, ok: true });
      }
    }
  });
  test('the placeholder survives in every language', () => {
    for (const lang of LANGS) expect(i18n[lang].del_blocked_body).toContain('{{n}}');
  });
  test('every key the new screens use exists', () => {
    for (const file of ['app/about.js', 'app/delete-account.js', 'app/(tabs)/profile.js']) {
      for (const match of read(file).matchAll(/\bt\('([a-z_0-9]+)'/g)) {
        expect({ file, key: match[1], exists: typeof i18n.EN[match[1]] === 'string' }).toEqual({ file, key: match[1], exists: true });
      }
    }
  });
});

describe('Medical Reports: optional everywhere except Private Charter, which is untouched', () => {
  test('Private Charter (and its generic "air" tile) still needs a document; nothing about it changed', () => {
    expect(needsDocument({ service: 'privatecharter', files: [] })).toBe(true);
    expect(needsDocument({ service: 'air', files: [] })).toBe(true);
    expect(needsDocument({ service: 'privatecharter', files: [{ uri: 'a' }] })).toBe(false);
  });
  test('every other service submits without a report', () => {
    for (const service of ['ground', 'hospital', 'commercialair', 'mortal', 'homecare', 'tele', 'marine', 'medvalue', 'corporate']) {
      expect({ service, needs: needsDocument({ service, files: [] }) }).toEqual({ service, needs: false });
    }
  });
  test('the Home Healthcare, Mortal Remains and Teleconsultation Step 2 pages have no report problem at all', () => {
    const draft = { files: [], desc: '', urgency: 'planned', homeOxygen: '', oxygenLpm: '', allergies: '', teleType: 'online', date: '' };
    expect(homeStep2Problems(draft).map(([id]) => id)).not.toContain('files');
    expect(mortalStep2Problems(draft).map(([id]) => id)).not.toContain('files');
    expect(teleStep2Problems(draft).map(([id]) => id)).not.toContain('files');
    expect(homeStep2Problems(draft).filter(([, bad]) => bad)).toEqual([]);
    expect(mortalStep2Problems(draft).filter(([, bad]) => bad)).toEqual([]);
  });
  test('the upload tiles and their limits are unchanged', () => {
    const mock = read('data/mock.js');
    expect(mock).toContain('export const MAX_REPORT_FILES = 10;');
    expect(mock).toContain('export const MAX_REPORT_BYTES = 10 * 1024 * 1024;');
    expect(read('components/request/fields.js')).toContain('maxFiles = MAX_REPORT_FILES');
  });
});
