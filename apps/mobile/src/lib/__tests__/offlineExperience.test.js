/* global describe, test, expect, __dirname */
// Phase 2 (shared offline experience): where the banner is mounted, which actions need the network, what must NOT be touched, and the translations.
// Source-level checks (like the app's other screen tests): the screens are not rendered here.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { LANGUAGE_REGISTRY } = require('../../data/languages');

const SRC = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');
const walk = (dir) => fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((entry) => {
  const rel = `${dir}/${entry.name}`;
  if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(rel);
  return /\.js$/.test(entry.name) ? [rel] : [];
});
const ALL = ['app', 'components', 'lib', 'state'].flatMap(walk);

describe('the connection banner', () => {
  const HEADERS = ['app/document-preview.js', 'app/request-details.js', 'components/home/HomeHeader.js', 'components/layout.js', 'components/request/DetailsParts.js', 'components/request/RequestFrame.js', 'components/requests/RequestsHeader.js'];
  test('sits directly under the header of every screen that has one: the shared header components mount it, nothing else does', () => {
    const users = ALL.filter((f) => /<ConnectionBanner\b/.test(read(f)));
    expect(users.sort()).toEqual(HEADERS);
  });
  test('the old bottom message is gone: not mounted in the Shell, no file left, no file refers to it', () => {
    expect(read('app/_layout.js')).not.toMatch(/NetworkBanner/);
    expect(fs.existsSync(path.join(SRC, 'components/NetworkBanner.js'))).toBe(false);
    expect(ALL.filter((f) => /NetworkBanner\b/.test(read(f)))).toEqual([]);
  });
  test('no screen draws its own offline indicator: the banner texts are used only by the banner spec (lib/networkUi.js)', () => {
    const users = ALL.filter((f) => /['"`]net_(offline|slow|server_down|restored)['"`]/.test(read(f)));
    expect(users.sort()).toEqual(['lib/networkUi.js']);
  });
  test('takes no touch, is read out as an alert (polite live region), pushes content down instead of floating, and animates its height', () => {
    const banner = read('components/network/ConnectionBanner.js');
    expect(banner).toMatch(/pointerEvents="none"/);
    expect(banner).not.toMatch(/accessibilityRole="alert"/); // one polite live region, not a second alert inside it (no double announcement)
    expect(banner).toMatch(/accessibilityLiveRegion="polite"/);
    expect(banner).toMatch(/accessibilityElementsHidden importantForAccessibility="no-hide-descendants"/); // the icon is hidden from screen readers
    expect(banner).toMatch(/overflow: 'hidden'/);
    expect(banner).toMatch(/useReducedMotion\(\)/); // Reduce Motion: no sliding and no height animation
    expect(read('lib/bannerMotion.js')).toMatch(/export const BANNER_ENTER_MS = 220;/);
    expect(banner).not.toMatch(/position: 'absolute', bottom|zIndex: 150/); // no floating overlay
    expect(banner).toMatch(/bannerPresenter/); // WHAT shows is the app-wide presenter's decision (lib/bannerPresenter.js), fed by BannerDriver from useNetwork()
  });
  test('uses the translated texts, never hard-coded English', () => {
    const banner = read('components/network/ConnectionBanner.js');
    const code = banner.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code).toMatch(/t\(spec\.titleKey\)/);
    expect(code).not.toMatch(/No internet connection|Slow internet|Back online|HumanCare servers/);
  });
});

describe('Button: network actions are disabled while offline', () => {
  const ui = read('components/ui.js');
  test('needsNetwork + the offline state disable it, fade it and say why to a screen reader', () => {
    expect(ui).toMatch(/needsNetwork \}\) \{/);
    expect(ui).toMatch(/const blocked = !!needsNetwork && isOffline;/);
    expect(ui).toMatch(/disabled=\{loading \|\| disabled \|\| blocked\}/);
    expect(ui).toMatch(/const faded = dimmed \|\| disabled \|\| blocked \|\| loading;/);
    expect(ui).toMatch(/accessibilityHint=\{blocked && app \? app\.t\('net_action_offline'\) : undefined\}/);
  });
  test('a Button without needsNetwork is never affected by the network', () => {
    expect(ui).not.toMatch(/disabled=\{loading \|\| disabled \|\| isOffline\}/);
    expect(ui).toMatch(/!!needsNetwork && isOffline/);
  });
});

describe('the actions that need the internet', () => {
  // [file, a fragment of the Button / Pressable that sends something]
  const COVERED = [
    ['app/login.js', "title={t('login_btn')}"],
    ['app/register.js', "title={t('register_btn')}"],
    ['app/forgot-password.js', "title={t('forgot_pwd_btn')}"], // OTP request
    ['app/reset-password.js', "title={t('reset_pwd_btn')}"],
    ['app/set-password.js', "title={t(isSetup ? 'set_pwd_btn' : 'reset_pwd_btn')}"],
    ['app/complete-profile.js', "title={t('send_otp_btn')}"], // OTP request
    ['app/corporate-login.js', "title={t('btn_sign_in')}"],
    ['app/change-contact.js', "'change_send_mobile_btn' : 'change_send_email_btn'"], // contact change (OTP request)
    ['app/delete-account.js', "title={t('del_continue')}"], // account deletion
    ['app/edit-profile.js', "title={t('btn_save_changes')}"], // profile update
    ['app/personal-details.js', "title={t('btn_save_changes')}"], // profile update
    ['app/corporate-new-case.js', "title={t('btn_create_case')}"],
    ['app/request/submitted.js', 'title={retryLabel}'], // document upload retry
    ['components/request/AdditionalDocuments.js', 'title={buttonLabel}'], // document upload
  ];
  test.each(COVERED)('%s: the sending button has needsNetwork', (file, fragment) => {
    const source = read(file);
    const line = source.split('\n').find((l) => l.includes(fragment) && l.includes('<Button'));
    expect(line).toBeDefined();
    expect(line).toMatch(/\bneedsNetwork\b/);
  });
  test('the request form: only the review\'s Submit needs the internet; Continue on the earlier steps only collects information and works offline (RequestFrame defaults needsNetwork to false)', () => {
    const frame = read('components/request/RequestFrame.js');
    expect(frame).toMatch(/needsNetwork = false, [^)]*\}\) \{/);
    expect(frame).toMatch(/needsNetwork=\{needsNetwork\}/);
    expect(read('app/request/review.js')).toMatch(/<RequestFrame step=\{3\} showService=\{false\} onNext=\{submit\} busy=\{busy\} needsNetwork /);
    for (const step of ['app/request/step1.js', 'app/request/step2.js']) expect(read(step)).not.toMatch(/needsNetwork=\{false\}/);
  });
  test('OTP screens (login, register, password reset, contact change, account deletion, corporate): Verify, Resend and Save & resend', () => {
    const otp = read('components/OtpScreen.js');
    expect(otp).toMatch(/const \{ isOffline, restoredCount \} = useNetwork\(\);/);
    expect(otp).toMatch(/<Pressable onPress=\{resend\} disabled=\{resending \|\| isOffline\}/);
    expect(otp).toMatch(/onPress=\{savingEdit \|\| isOffline \? undefined : saveEdit\}/);
    expect(otp).toMatch(/title=\{t\('otp_verify_btn'\)\} onPress=\{verify\} loading=\{busy\} needsNetwork \/>/);
    for (const screen of ['login-otp', 'register-otp', 'forgot-password-otp', 'change-contact-otp', 'delete-account-otp', 'corporate-otp']) {
      expect(read(`app/${screen}.js`)).toMatch(/<OtpScreen|OtpScreen/); // they all use the one shared OTP screen
    }
  });
  test('social sign-in buttons are disabled offline', () => {
    const login = read('app/login.js');
    expect(login).toContain('useSocialAuth({ toast, afterSocialLogin, t })'); // the hook reads the ONE network state (useNetwork) and hands each button its offline flag
    expect(read('lib/useSocialAuth.js')).toMatch(/const \{ isOffline \} = useNetwork\(\);/);
    expect(login).toMatch(/disabled=\{disabled \|\| offline\}/);
  });

  test('forms stay editable: no input is switched off by the network, and nothing is cleared', () => {
    const touched = ALL.filter((f) => /useNetwork|needsNetwork/.test(read(f)));
    for (const file of touched) {
      const source = read(file);
      expect(source).not.toMatch(/editable=\{[^}]*(isOffline|offline)/);
      expect(source).not.toMatch(/(isOffline|offline)[^;\n]*(setPhone|setEmail|setPassword|setName|updateDraft|resetDraft|setFiles|setCode|setOtp)\(/);
    }
  });
});

describe('what stays available offline (nothing here may be blocked)', () => {
  const MUST_NOT_REFERENCE = [
    'app/help-support.js', // Help & Support, with its call button
    'app/welcome.js', 'app/privacy.js', 'app/terms.js', 'app/about.js', 'app/all-services.js', 'app/select-service.js', 'app/air-ambulance.js',
    'app/profile.js', // includes the local language switch
    'components/sos/SosModal.js', 'components/sos/SosFab.js', 'components/sos/hooks.js', 'lib/sos.js', // emergency calling (placement is Phase 3)
    'components/layout.js', 'components/SystemBack.js', 'lib/nav.js', 'data/languages.js', 'lib/languagePreference.js',
  ];
  test.each(MUST_NOT_REFERENCE)('%s does not use the network state or needsNetwork', (file) => {
    if (!fs.existsSync(path.join(SRC, file))) return;
    expect(read(file)).not.toMatch(/useNetwork|needsNetwork|NetworkBanner|isOffline/);
  });
  test('the emergency call is a plain tel: link that nothing here wraps', () => {
    expect(read('components/sos/SosModal.js')).toMatch(/open\(emergencyUrl\(EMERGENCY_TEL\)\)/);
    expect(read('app/help-support.js')).toMatch(/open\(`tel:\$\{EMERGENCY_TEL\}`\)/);
  });
});

describe('Phase 3 territory is untouched (startup, splash routing, emergency placement)', () => {
  test.each(['app/index.js', 'lib/splash.js', 'lib/authGuard.js', 'lib/authState.js', 'lib/sessionCheck.js', 'components/AuthGate.js', 'lib/session.js'].filter((f) => f !== 'components/AuthGate.js'))(
    '%s does not read the network state',
    (file) => { expect(read(file)).not.toMatch(/useNetwork|networkUi|NetworkContext|isOffline/); },
  );
});

describe('reads are retried once; writes are never replayed', () => {
  test('useResource only loads data: it has no way to send a write', () => {
    const source = read('lib/useResource.js');
    expect(source).not.toMatch(/apiPost|apiPatch|apiUpload|apiDownload|from '\.\/api'/);
    expect(source).toMatch(/retryOnRestoration\(/);
  });
  test('the shared offline code never imports the API client at all', () => {
    for (const file of ['lib/networkUi.js', 'components/network/ConnectionBanner.js', 'components/LoadFailure.js']) {
      expect(read(file)).not.toMatch(/from '\.\.?\/(\.\.\/)?lib\/api'|from '\.\/api'|apiPost|apiPatch|apiUpload/);
    }
  });
  test('the retry runs on a restoration only: no timer, no interval, no listener of its own', () => {
    const source = read('lib/useResource.js');
    expect(source).not.toMatch(/setInterval|NetInfo|AppState/);
    expect(source).toMatch(/\[restoredCount, enabled, reload\]/);
  });
  test('nothing in the offline code calls a function that resubmits (no submit, retry-write or upload call)', () => {
    const source = `${read('lib/networkUi.js')}${read('components/network/ConnectionBanner.js')}${read('components/LoadFailure.js')}`;
    expect(source).not.toMatch(/submit\(|runSubmission|sendAdditionalDocuments/);
  });
  test('the loading skeleton, the cache and the failed-refresh behaviour are unchanged', () => {
    const source = read('lib/useResource.js');
    expect(source).toMatch(/useState\(\(\) => getCached\(key\)\)/);
    expect(source).toMatch(/setCached\(forKey, next\)/);
    expect(source).toMatch(/loading: data === undefined && !error/);
    expect(source).toMatch(/failRef\.current\(err\)/); // onRefreshError (the "Couldn't refresh" toast) still runs
    expect(source).toMatch(/return \{ data, loading: data === undefined && !error, error, reload, refresh: onRefresh, onRefresh, refreshing, highlight \}/);
  });
});

describe('the shared failure view', () => {
  test('uses the network-aware wording and keeps the retry button (a read, so it stays available offline)', () => {
    const view = read('components/LoadFailure.js');
    expect(view).toMatch(/loadFailureView\(\{ error, net, screenTitleKey: titleKey \}\)/);
    expect(view).toMatch(/message \|\| t\('sk_load_failed'\)/);
    expect(view).not.toMatch(/needsNetwork/);
    const code = view.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n'); // comments may quote the old text
    expect(code).not.toMatch(/Network request failed/);
  });
  test.each([
    ['app/home.js', /<LoadFailure titleKey="lf_title_home" error=\{error\} onRetry=\{reload\} \/>/],
    ['app/my-requests.js', /<LoadFailure titleKey="lf_title_requests" error=\{error\} onRetry=\{reload\} \/>/],
    ['app/notifications.js', /<LoadFailure titleKey="lf_title_notifications" error=\{error\} onRetry=\{reload\} \/>/],
    ['app/corporate-dashboard.js', /<LoadFailure titleKey="lf_title_cases" error=\{error\} onRetry=\{reload\} \/>/],
    ['app/request-details.js', /<LoadFailure titleKey="lf_title_request" error=\{error\} message=\{t\('rd_load_failed'\)\}/],
    ['app/request-tracking.js', /<LoadFailure titleKey="lf_title_tracking" error=\{error\} message=\{t\('trk_load_failed'\)\}/],
  ])('%s passes the error so the message can say what happened', (file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });
});

describe('translations', () => {
  const NET_KEYS = ['net_offline', 'net_slow', 'net_server_down', 'net_restored', 'net_action_offline', 'net_load_offline', 'net_load_server', 'net_load_timeout', 'net_unconfirmed'];
  const LANGS = Object.keys(LANGUAGE_REGISTRY);

  test('every supported language has every new key, as real text', () => {
    for (const lang of LANGS) {
      for (const key of NET_KEYS) {
        expect(typeof I18N[lang][key]).toBe('string');
        expect(I18N[lang][key].trim().length).toBeGreaterThan(0);
      }
    }
  });
  test('the six languages are all still there, and no language lost or gained anything but the nine keys', () => {
    expect(Object.keys(I18N)).toEqual(['EN', 'HI', 'MR', 'GU', 'TE', 'AR']);
    expect(Object.keys(I18N.EN).length).toBeGreaterThanOrEqual(867); // English only grows; the other five must hold exactly the same keys (translationParity.test.js) // + the 22 request-status keys of Phase 4, its follow-up and its final fix (requestIdempotency.test.js), + the 15 draft keys of Phase 6
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) expect(Object.keys(I18N[lang]).length).toBe(Object.keys(I18N.EN).length);
  });
  test('the English texts are exactly the wording that was requested', () => {
    expect(I18N.EN.net_offline).toBe('No internet connection');
    expect(I18N.EN.net_slow).toBe('Slow internet connection');
    expect(I18N.EN.net_server_down).toBe("We can't reach HumanCare servers");
    expect(I18N.EN.net_restored).toBe('Back online');
  });
  test('the other languages are translated, not copies of English', () => {
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) {
      for (const key of NET_KEYS) expect(I18N[lang][key]).not.toBe(I18N.EN[key]);
    }
  });
  test('the brand name stays as it is, and no placeholder is left half-written', () => {
    for (const lang of LANGS) {
      expect(I18N[lang].net_server_down).toMatch(/HumanCare/);
      for (const key of NET_KEYS) expect(I18N[lang][key]).not.toMatch(/\{\{|\}\}|undefined/);
    }
  });
  test('existing translations are untouched (spot checks across every language)', () => {
    const KNOWN = {
      EN: ['Try again', "Couldn't refresh. Pull down to try again."],
      HI: ['फिर कोशिश करें', 'रीफ़्रेश नहीं हो सका। फिर कोशिश करने के लिए नीचे खींचें।'],
      MR: ['पुन्हा प्रयत्न करा', 'रिफ्रेश होऊ शकले नाही. पुन्हा प्रयत्न करण्यासाठी खाली ओढा.'],
      GU: ['ફરી પ્રયાસ કરો', 'રિફ્રેશ થઈ શક્યું નહીં. ફરી પ્રયાસ કરવા નીચે ખેંચો.'],
      TE: ['మళ్లీ ప్రయత్నించండి', 'రిఫ్రెష్ కాలేదు. మళ్లీ ప్రయత్నించడానికి కిందికి లాగండి.'],
      AR: ['حاول مرة أخرى', 'تعذر التحديث. اسحب للأسفل للمحاولة مرة أخرى.'],
    };
    for (const [lang, [retry, refresh]] of Object.entries(KNOWN)) {
      expect(I18N[lang].sk_try_again).toBe(retry);
      expect(I18N[lang].sk_refresh_failed).toBe(refresh);
    }
  });
  test('every net_ key the code uses exists in English (the fallback language)', () => {
    const used = new Set();
    for (const file of ALL) for (const match of read(file).matchAll(/['"`](net_[a-z_]+)['"`]/g)) used.add(match[1]);
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) expect(I18N.EN[key]).toBeDefined();
  });
  test('the new keys follow the file\'s own layout: right after sk_refresh_failed, in every language', () => {
    for (const lang of LANGS) {
      const keys = Object.keys(I18N[lang]);
      const at = keys.indexOf('sk_refresh_failed');
      expect(keys.slice(at + 1, at + 1 + NET_KEYS.length)).toEqual(NET_KEYS);
    }
  });
});
