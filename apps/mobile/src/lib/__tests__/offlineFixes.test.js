/* global describe, test, expect, beforeEach, afterEach, jest, __dirname */
// Regression tests for the offline / slow-network audit fixes (one block per reported bug). Pure logic is run (fake timers); screens are checked at the source level, like the app's other screen tests.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { createBannerPresenter, OUTAGE_DELAY_MS } = require('../bannerPresenter');
const { hideToastForBanner, isNetworkToast, retryOnRestoration } = require('../networkUi');
const {
  withPhoneTimeout, withSendTimeout, withConfirmTimeout, PHONE_SEND_TIMEOUT_MS, PHONE_CONFIRM_TIMEOUT_MS, PHONE_TIMEOUT_CODE, SEND_TIMEOUT_KEY, CONFIRM_TIMEOUT_KEY, isPhoneTimeout,
} = require('../phoneAuthTimeout');
const { locationProblems } = require('../locationRules');
const { resolveCharterCities } = require('../citySearch');
const { isRetryablePushFailure } = require('../pushRetry');
const { openLink, toastDuration, TOAST_MIN_MS, TOAST_MAX_MS } = require('../openLink');

const SRC = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\r\n').join('\n');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const NETWORK_MESSAGES = [
  'Could not reach the server. Please check your connection and try again.',
  "We couldn't confirm that this went through because the connection was lost. Please check before trying again.",
  'The server took too long to answer. Please try again.',
  'No internet connection. Connect to the internet to continue.',
];

describe('P0: an error is never hidden unless a visible banner says the same', () => {
  test('a message that sounds like a network problem is hidden ONLY when a banner is really visible', () => {
    for (const message of NETWORK_MESSAGES) {
      expect(isNetworkToast(message)).toBe(true);
      expect(hideToastForBanner({ message, bannerVisible: true })).toBe(true);
      expect(hideToastForBanner({ message, bannerVisible: false })).toBe(false);
      expect(hideToastForBanner({ message })).toBe(false); // nothing says a banner exists: show it
      expect(hideToastForBanner({ message, status: 'offline' })).toBe(false); // the network state alone never hides a message any more
      expect(hideToastForBanner({ message, status: 'serverDown' })).toBe(false);
    }
  });
  test('"visible" means a problem banner is showing AND the screen in front has a banner (a header-less screen never does)', () => {
    const p = createBannerPresenter();
    expect(p.isVisible()).toBe(false);
    p.observe('serverDown');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS);
    expect(p.isVisible()).toBe(false); // the app-wide state says "servers unreachable", but no screen in front has a banner (login, register, the code screens)
    const unregister = p.registerHost(); // a screen with a header comes to the front
    expect(p.isVisible()).toBe(true);
    unregister();
    unregister(); // idempotent
    expect(p.isVisible()).toBe(false);
  });
  test('a banner that is not showing (online, a blip, "Back online") hides nothing, even on a screen with a header', () => {
    const p = createBannerPresenter();
    p.registerHost();
    expect(p.isVisible()).toBe(false);
    p.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS - 1);
    expect(p.isVisible()).toBe(false); // the first second: the banner is not up yet, so the error must show
    jest.advanceTimersByTime(1);
    expect(p.isVisible()).toBe(true);
    p.observe('online');
    expect(p.get()).toBe('restored');
    expect(p.isVisible()).toBe(false);
  });
  test('the toast is told when visibility changes (so a toast that appeared before the banner is dropped once the banner is up)', () => {
    const p = createBannerPresenter();
    const seen = [];
    p.subscribeVisible(() => seen.push(p.isVisible()));
    const off = p.registerHost();
    p.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS);
    off();
    expect(seen).toEqual([false, true, false]);
  });
  test('the wiring: the banner registers while its screen is focused; the Toast reads the same fact', () => {
    expect(read('components/network/ConnectionBanner.js')).toContain('useFocusEffect(useCallback(() => bannerPresenter.registerHost(), []))');
    const toast = read('components/widgets.js');
    expect(toast).toContain('useSyncExternalStore(bannerPresenter.subscribeVisible, bannerPresenter.isVisible, bannerPresenter.isVisible)');
    expect(toast).toContain('hideToastForBanner({ message: toastMsg, bannerVisible })');
    expect(toast).not.toMatch(/useNetwork\(\)/);
  });
  test('the header-less authentication screens have no banner and show their errors with a toast, which now always shows', () => {
    for (const file of ['app/login.js', 'app/register.js', 'app/forgot-password.js', 'app/reset-password.js', 'app/set-password.js', 'app/complete-profile.js', 'app/corporate-login.js', 'components/OtpScreen.js']) {
      const code = read(file);
      expect({ file, banner: /ConnectionBanner|<TopBar/.test(code) }).toEqual({ file, banner: false });
      expect({ file, toast: /toast\(errorText\(err, t/.test(code) }).toEqual({ file, toast: true });
    }
  });
});

describe('P1: every disabled auth and OTP action says why', () => {
  const SCREENS = ['app/login.js', 'app/register.js', 'app/forgot-password.js', 'app/reset-password.js', 'app/set-password.js', 'app/complete-profile.js', 'app/corporate-login.js', 'components/OtpScreen.js'];
  test('each has the shared internet-required line right under its button', () => {
    for (const file of SCREENS) {
      const code = read(file);
      expect({ file, line: (code.match(/<NeedsInternet \/>/g) || []).length }).toEqual({ file, line: 1 });
      const lines = code.split('\n');
      const at = lines.findIndex((l) => /<NeedsInternet \/>/.test(l));
      expect({ file, buttonAbove: /needsNetwork/.test(lines[at - 1]) }).toEqual({ file, buttonAbove: true });
    }
  });
  test('the line is shown only while the phone is KNOWN offline, with the shared motion and the banner\'s words', () => {
    const line = read('components/network/NeedsInternet.js');
    expect(line).toContain('const { isOffline } = useNetwork();');
    expect(line).toContain('<Collapse show={isOffline}>');
    expect(line).toContain("t('net_offline_text')");
    expect(I18N.EN.net_offline_text).toBe('Connect to the internet to continue.');
  });
  test('Resend OTP says it is unavailable and why to a screen reader', () => {
    const otp = read('components/OtpScreen.js');
    expect(otp).toContain('accessibilityState={{ disabled: resending || isOffline }}');
    expect(otp).toContain("accessibilityHint={isOffline ? t('net_offline_text') : undefined}");
  });
});

describe('P1: Firebase phone verification has time limits and never doubles an action', () => {
  test('a send that finishes in time is returned as it is', async () => {
    const result = withSendTimeout(Promise.resolve('handle'));
    await expect(result).resolves.toBe('handle');
    expect(jest.getTimerCount()).toBe(0);
  });
  test('a send that hangs ends after 25 s with a clear error that points to Resend OTP', async () => {
    const hung = new Promise(() => {});
    const result = withSendTimeout(hung).catch((e) => e);
    await jest.advanceTimersByTimeAsync(PHONE_SEND_TIMEOUT_MS - 1);
    jest.advanceTimersByTime(1);
    const err = await result;
    expect(isPhoneTimeout(err)).toBe(true);
    expect(err.code).toBe(PHONE_TIMEOUT_CODE);
    expect(err.messageKey).toBe(SEND_TIMEOUT_KEY);
    expect(err.message).toMatch(/Resend OTP/);
    expect(PHONE_SEND_TIMEOUT_MS).toBeGreaterThanOrEqual(20000);
    expect(PHONE_SEND_TIMEOUT_MS).toBeLessThanOrEqual(30000);
  });
  test('a code check that hangs ends after 25 s too', async () => {
    const result = withConfirmTimeout(new Promise(() => {})).catch((e) => e);
    await jest.advanceTimersByTimeAsync(PHONE_CONFIRM_TIMEOUT_MS);
    const err = await result;
    expect(err.messageKey).toBe(CONFIRM_TIMEOUT_KEY);
    expect(PHONE_CONFIRM_TIMEOUT_MS).toBeLessThanOrEqual(30000);
  });
  test('a late success is dropped (reported to onLate only), a late failure is swallowed: nothing is used twice, nothing is unhandled', async () => {
    let finish;
    const late = new Promise((resolve) => { finish = resolve; });
    const heard = [];
    const result = withPhoneTimeout(late, { ms: 1000, messageKey: 'k', message: 'm', onLate: (v, ok) => heard.push([v, ok]) }).catch((e) => e);
    await jest.advanceTimersByTimeAsync(1000);
    expect((await result).code).toBe(PHONE_TIMEOUT_CODE);
    finish('late-handle');
    await Promise.resolve();
    await Promise.resolve();
    expect(heard).toEqual([['late-handle', true]]);
    let fail;
    const lateFail = new Promise((_, reject) => { fail = reject; });
    const result2 = withPhoneTimeout(lateFail, { ms: 1000, messageKey: 'k', message: 'm' }).catch((e) => e);
    await jest.advanceTimersByTimeAsync(1000);
    await result2;
    fail(new Error('boom')); // must not surface as an unhandled rejection
    await Promise.resolve();
    await Promise.resolve();
  });
  test('the limit only stops WAITING: it never repeats a step, and a send in flight is never started twice', () => {
    expect(read('lib/phoneAuthTimeout.js')).not.toMatch(/sendPhoneCode\(|confirmPhoneCode\(|signInWithPhoneNumber\(/);
    const hook = read('lib/usePhoneCode.js');
    expect(hook).toContain('if (inFlight.current) return inFlight.current;');
    expect(hook).toContain('pending.current = attempt;');
    for (const file of ['lib/phoneAuth.web.js', 'lib/phoneAuth.native.js']) {
      const code = read(file);
      expect({ file, send: code.includes('withSendTimeout(step)'), confirm: code.includes('withConfirmTimeout(step)') }).toEqual({ file, send: true, confirm: true });
    }
  });
  test('the screen says it in the person\'s language and OTP security is untouched (no new endpoint, no auto-resend)', () => {
    const otp = read('components/OtpScreen.js');
    expect(otp).toContain('classifyOtpError(err)'); // lib/otpErrors.js: phone_timeout -> its own translated message (err.messageKey)
    expect(read('lib/otpErrors.js')).toContain("case 'phone_timeout': return { kind: 'timeout', key: err.messageKey || 'otp_err_timeout', keepCode: true };");
    for (const key of ['otp_send_timeout', 'otp_confirm_timeout']) for (const lang of LANGS) {
      expect(typeof I18N[lang][key]).toBe('string');
      if (lang !== 'EN') expect(I18N[lang][key]).not.toBe(I18N.EN[key]);
    }
    expect(read('lib/usePhoneCode.js')).toContain("apiPost('/auth/otp/resend', { ticket })"); // the resend call is unchanged and still only on a tap
  });
});

describe('P1: downloads and document actions', () => {
  test('Request Details: Download summary is switched off offline (pale, reason for a screen reader), and uses the authenticated download', () => {
    const screen = read('app/request-details.js');
    expect(screen).toContain("<Action Icon={Download} label={t('rd_download')} onPress={onDownload} disabled={offline} hint={t('net_offline_text')} />");
    expect(screen).toContain('accessibilityHint={disabled ? hint : undefined}');
    expect(screen).toContain('await downloadDocument(`/requests/me/${request.id}/summary`');
    expect(screen).toContain("toast(t(downloadErrorInfo(err).key))");
    expect(screen).toContain("if (isOffline) { toast(t('net_offline_text')); return; }"); // the safety net never fails silently
  });
  test('Document preview: Try again and Share are switched off offline with the reason and the line; the connection returning fetches the file again once', () => {
    const screen = read('app/document-preview.js');
    expect(screen).toContain("disabled={isOffline} hint={t('net_offline_text')} />\n        <NeedsInternet />");
    expect(screen).toContain('useRetryOnRestore({ failed: file.status === \'error\'');
    expect(screen).toContain("if (isOffline && !file.file) { toast(t('net_offline_text')); return; }");
    expect(screen).toContain('<ConnectionBanner />');
  });
  test('corporate documents: the row is pale offline with "Opens when you\'re online", and the download is the authenticated one (no raw fetch)', () => {
    const tracking = read('app/tracking.js');
    expect(tracking).toContain('offline={isOffline} onPress={() => downloadCaseDocument(d)}');
    expect(tracking).toContain('await downloadDocument(`/documents/${d.id}/file`, d.name)');
    expect(read('components/widgets.js')).toContain('disabled={offline} accessibilityRole="button" accessibilityState={{ disabled: offline }}');
    expect(read('lib/download.js')).not.toMatch(/downloadAndShare|\bfetch\(/);
  });
});

describe('P1: Steps 1 and 2 work offline; only the final Submit needs the internet', () => {
  test('RequestFrame: Continue is not network-gated by default and shows no "to submit" line; the review still needs the network', () => {
    const frame = read('components/request/RequestFrame.js');
    expect(frame).toMatch(/needsNetwork = false, /);
    expect(frame).toContain('<Collapse show={!!(needsNetwork && isOffline)}>');
    expect(read('app/request/review.js')).toMatch(/<RequestFrame step=\{3\} showService=\{false\} onNext=\{submit\} busy=\{busy\} needsNetwork /);
    for (const file of ['app/request/step1.js', 'app/request/step2.js']) expect(read(file)).not.toMatch(/needsNetwork=\{true\}|needsNetwork /);
  });
  test('Private Charter offline: a typed place is accepted for now; a picked city is still held to the country; online nothing changes', () => {
    const draft = { location: 'Pune', dest: 'Dubai', originCity: null, destCity: null, countryIso: 'IN' };
    expect(locationProblems(draft, true)).toEqual({ location: 'pick_city', dest: 'pick_city' }); // online: a verified city is required
    expect(locationProblems(draft, true, { offline: true })).toEqual({ location: null, dest: null }); // offline: collected, verified later
    expect(locationProblems({ ...draft, location: '' }, true, { offline: true }).location).toBe('required'); // an empty field is still empty
    const wrong = { ...draft, originCity: { geonameId: 1, label: 'Dubai', countryCode: 'AE' } };
    expect(locationProblems(wrong, true, { offline: true }).location).toBe('wrong_country');
    expect(locationProblems(draft, false, { offline: true })).toEqual(locationProblems(draft, false)); // other services unaffected
  });
  test('step 1 asks the server nothing offline and keeps the typed places as typed (the encrypted draft stores them like any field)', () => {
    const step1 = read('app/request/step1.js');
    expect(step1).toContain('if (isOffline) return {};');
    expect(step1).toContain('locationProblems(d, charter, { offline: isOffline })');
    expect(step1).not.toMatch(/draftStore|draftCrypto|draftManager|submissionTracker/); // nothing of the draft or submission code is touched here
  });
  test('the typed city is matched to the verified list when the request is submitted, online; if it names no single city nothing is sent', async () => {
    const choice = (c) => ({ geonameId: c.geonameId, label: c.label });
    const fetcher = jest.fn(async (p) => (/q=Pune/.test(p) ? { cities: [{ geonameId: 7, label: 'Pune, India', name: 'Pune', countryCode: 'IN' }] } : { cities: [] }));
    const patch = await resolveCharterCities(fetcher, { location: 'Pune', dest: 'Nowhereville', countryIso: 'IN' }, choice);
    expect(patch).toEqual({ originCity: { geonameId: 7, label: 'Pune, India' } }); // the destination matched nothing: not guessed
    expect(await resolveCharterCities(fetcher, { location: '', dest: '' }, choice)).toEqual({});
    const review = read('app/request/review.js');
    expect(review).toContain('const patch = await resolveCharterCities(apiGet, d, toCityChoice);');
    expect(review).toContain("if (!charterDraft.originCity || !charterDraft.destCity) { toast(t('req_pick_city')); goToStep(1); return; }");
    expect(review.indexOf("toast(t('req_pick_city'))")).toBeLessThan(review.indexOf('await sendWithDocuments(() => buildPrivateCharterPayload(charterDraft))')); // checked BEFORE anything is sent
  });
  test('idempotency and recovery are untouched: the same gate, the same key, the same payload rule', () => {
    const review = read('app/request/review.js');
    expect(review).toMatch(/const guardedSend = async \(body\) => \{\s+const gate = await checkBeforeSend\(/);
    expect(review).toContain('postWithKey(submissionTracker, apiPost, body, { service: serviceKey })');
    expect(review).toContain('journal: uploadJournal');
  });
});

describe('P1: screens with their own fetch read again once when the connection returns', () => {
  test('the rule: once per restoration, only if the last read failed, never for a restoration from before the screen existed', () => {
    expect(retryOnRestoration({ restoredCount: 1, seen: 1, failed: true })).toEqual({ seen: 1, retry: false, failed: true }); // nothing restored since
    expect(retryOnRestoration({ restoredCount: 2, seen: 1, failed: true }).retry).toBe(true);
    expect(retryOnRestoration({ restoredCount: 2, seen: 1, failed: false }).retry).toBe(false); // the read had not failed: nothing to redo
    expect(retryOnRestoration({ restoredCount: 2, seen: 1, failed: true, enabled: false }).retry).toBe(false);
    const again = retryOnRestoration({ restoredCount: 2, seen: 2, failed: true });
    expect(again.retry).toBe(false); // the same restoration never retries twice
  });
  test('the hook only ever calls the READ it is given, and every screen passes a read', () => {
    const hook = read('lib/useRetryOnRestore.js');
    expect(hook).toContain('retryOnRestoration({ restoredCount, seen: seen.current, enabled, failed: failedRef.current })');
    const code = hook.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // (comments may mention what it never does)
    expect(code).not.toMatch(/apiPost|apiPatch|apiUpload|submit|upload/i);
    const uses = {
      'app/tracking.js': 'useRetryOnRestore({ failed, retry: params.id ? retry : null });',
      'app/personal-details.js': 'useRetryOnRestore({ failed, retry, enabled: !isCorporate });',
      'app/service/[key].js': 'useRetryOnRestore({ failed: liveFailed, retry: loadLive });',
      'components/request/CityField.js': "useRetryOnRestore({ failed: state === 'error'",
      'app/document-preview.js': "useRetryOnRestore({ failed: file.status === 'error'",
      'app/(tabs)/home.js': 'useRetryOnRestore({ failed: pushFailed, retry: registerPush, enabled: !isCorporate });',
    };
    for (const [file, text] of Object.entries(uses)) expect({ file, ok: read(file).includes(text) }).toEqual({ file, ok: true });
  });
});

describe('P2: push registration is tried once more when the connection returns', () => {
  test('which failures are worth a retry', () => {
    expect(isRetryablePushFailure(Object.assign(new Error('x'), { code: 'network' }))).toBe(true);
    expect(isRetryablePushFailure(Object.assign(new Error('x'), { code: 'timeout' }))).toBe(true);
    expect(isRetryablePushFailure(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
    expect(isRetryablePushFailure(new Error('Network request failed'))).toBe(true);
    expect(isRetryablePushFailure(Object.assign(new Error('Forbidden'), { status: 403 }))).toBe(false);
    expect(isRetryablePushFailure(new Error('Permission denied'))).toBe(false);
    expect(isRetryablePushFailure(null)).toBe(false);
  });
  test('it reports registered / skipped / retry, and Home retries only on "retry"', () => {
    const push = read('lib/pushNotifications.js');
    expect(push).toContain("return 'registered';");
    expect(push).toContain("return isRetryablePushFailure(err) ? 'retry' : 'skipped';");
    expect(read('app/(tabs)/home.js')).toContain("setPushFailed(result === 'retry')");
  });
});

describe('P2: the Can\'t Connect and load-failure designs are reused', () => {
  test('the cover for a protected screen is the Can\'t Connect layout, localized', () => {
    const gate = read('components/AuthGate.js');
    expect(gate).toContain('<StateView');
    expect(gate).toContain('cantConnectState({ authStatus: reason === \'storage\' ? \'error\' : \'unreachable\', net })');
    expect(gate).not.toMatch(/We can't reach the server|We couldn't open your saved session|'Try again'|Check your connection and try again/);
    expect(gate).toContain("t('login_btn')");
  });
  test('Personal details uses LoadFailure with its own title, in all six languages', () => {
    expect(read('app/personal-details.js')).toContain('<LoadFailure titleKey="lf_title_profile"');
    for (const lang of LANGS) expect(I18N[lang].lf_title_profile.length).toBeGreaterThan(0);
  });
});

describe('P2: external links and toast duration', () => {
  test('a link that cannot be opened ends in a message, never silently and never as an unhandled rejection', async () => {
    const onError = jest.fn();
    expect(await openLink('tel:112', { open: async () => undefined, onError })).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(await openLink('mailto:a@b.c', { open: async () => { throw new Error('no handler'); }, onError })).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(await openLink('', { open: async () => undefined, onError })).toBe(false);
    expect(await openLink('tel:1', { open: async () => { throw new Error('x'); }, onError: () => { throw new Error('toast failed'); } })).toBe(false); // never throws
  });
  test('every screen that opens a link goes through useOpenLink; the raw call is gone', () => {
    const files = [];
    (function walk(dir) { for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) { if (e.isDirectory()) { if (e.name !== '__tests__') walk(`${dir}/${e.name}`); } else if (/\.js$/.test(e.name)) files.push(`${dir}/${e.name}`); } }('app'));
    (function walk(dir) { for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) { if (e.isDirectory()) { walk(`${dir}/${e.name}`); } else if (/\.js$/.test(e.name)) files.push(`${dir}/${e.name}`); } }('components'));
    const raw = files.filter((f) => /Linking\.openURL\(/.test(read(f)));
    expect(raw).toEqual(['components/request/CityField.js']); // (that one already has its own .catch)
    for (const file of ['app/help-support.js', 'app/request-details.js', 'app/request/submitted.js', 'components/sos/SosModal.js', 'components/RecaptchaNotice.js']) expect({ file, uses: read(file).includes('useOpenLink()') }).toEqual({ file, uses: true });
    expect(read('lib/useOpenLink.js')).toContain("toast(t('link_open_failed'))");
  });
  test('a toast stays long enough to read: 2.2 s for a short message, up to 7 s for a long one', () => {
    expect(toastDuration('Saved.')).toBe(TOAST_MIN_MS);
    expect(toastDuration(NETWORK_MESSAGES[1])).toBeGreaterThan(4000);
    expect(toastDuration(NETWORK_MESSAGES[1])).toBeLessThanOrEqual(TOAST_MAX_MS);
    expect(toastDuration('x'.repeat(1000))).toBe(TOAST_MAX_MS);
    expect(toastDuration(null)).toBe(TOAST_MIN_MS);
    let last = 0;
    for (const n of [0, 10, 30, 60, 100, 160, 400]) { const d = toastDuration('a'.repeat(n)); expect(d).toBeGreaterThanOrEqual(last); last = d; }
    expect(read('state/AppContext.js')).toContain('toastDuration(msg)');
  });
});

describe('P2: localization of what this change added', () => {
  const KEYS = ['rd_downloading', 'lf_title_profile', 'otp_send_timeout', 'otp_confirm_timeout', 'net_social_timeout', 'link_open_failed', 'req_pick_city'];
  test('every new string exists in all six languages and the five others are translated, not copied', () => {
    for (const key of KEYS) for (const lang of LANGS) {
      expect({ lang, key, text: typeof I18N[lang][key] === 'string' && I18N[lang][key].length > 0 }).toEqual({ lang, key, text: true });
      if (lang !== 'EN') expect({ lang, key, copy: I18N[lang][key] === I18N.EN[key] }).toEqual({ lang, key, copy: false });
    }
  });
  test('the Google timeout message is translated at display time, not built in English', () => {
    expect(read('lib/useSocialAuth.js')).toContain("timeoutMessage: t('net_social_timeout')");
    expect(read('lib/useSocialAuth.js')).toContain("err.code === TIMEOUT_CODE ? t('net_social_timeout')");
  });
  test('no English sentence of these flows is hard-coded any more', () => {
    expect(read('app/request-details.js')).not.toContain("'Downloading request summary…'");
    expect(read('app/request/step1.js')).not.toContain('Pick a city from the suggestions');
  });
});

describe('the city field while offline: the person just types', () => {
  const field = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'components', 'request', 'CityField.js'), 'utf8').replace(/\r\n/g, '\n');
  test('offline: no search is made, and nothing about the server is shown under the field', () => {
    expect(field).toContain("if (offline.current) { shown.current = ''; setCities([]); setProblem(QUIET_OFFLINE); setState('error'); return; }");
    expect(field).toContain("const QUIET_OFFLINE = Object.freeze({ kind: 'network', retry: true, message: '' });");
    expect(field).toContain("const quiet = state === 'error' && !!problem && problem.kind === 'network';");
    expect(field).toContain("const visible = open && state !== 'idle' && !quiet;");
  });
  test('the search is made again by itself when the connection returns; other failures still show their message', () => {
    expect(field).toContain("useRetryOnRestore({ failed: state === 'error' && !!(problem && problem.retry)");
    expect(field).toContain('{problem.message}'); // busy / unavailable / refused searches are still worded
  });
});
