/* global describe, test, expect, beforeEach, afterEach, jest, __dirname */
// Pull-to-refresh coverage and behaviour: the shared helper (one refresh at a time, a minimum and maximum spinner time, a failed read reported and never thrown, nothing but the two given functions run),
// which screens have it and why the others do not (an audit that fails when a screen is added without a decision), and the guarantees on the forms: a pull only re-checks the connection, so the
// fields, the documents and the saved draft cannot change. Pure and source checks: no device, no network.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { createRefreshGuard, runNetworkRefresh, REFRESH_MIN_MS, REFRESH_MAX_MS } = require('../networkRefresh');

const SRC = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];

describe('createRefreshGuard: one refresh at a time', () => {
  test('a second pull while one runs is the SAME run: the task runs once', async () => {
    const guard = createRefreshGuard();
    let release;
    const task = jest.fn(() => new Promise((resolve) => { release = resolve; }));
    const first = guard.run(task);
    const second = guard.run(task);
    const third = guard.run(task);
    await Promise.resolve();
    expect(guard.isRunning()).toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    release('done');
    await expect(first).resolves.toBe('done');
    expect(guard.isRunning()).toBe(false);
  });
  test('after a run ends (also by failing) the next pull runs again', async () => {
    const guard = createRefreshGuard();
    const task = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    await expect(guard.run(task)).rejects.toThrow('boom');
    expect(guard.isRunning()).toBe(false);
    await expect(guard.run(task)).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(2);
  });
  test('two guards are independent (two screens)', async () => {
    const a = createRefreshGuard();
    const b = createRefreshGuard();
    let release;
    a.run(() => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();
    expect(a.isRunning()).toBe(true);
    expect(b.isRunning()).toBe(false);
    release();
  });
});

describe('runNetworkRefresh', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const settled = async (promise, ms) => { const out = promise; await jest.advanceTimersByTimeAsync(ms); return out; };

  test('runs the connection re-check and the read ONCE each, together', async () => {
    const check = jest.fn(async () => undefined);
    const reload = jest.fn(async () => 'data');
    const outcome = await settled(runNetworkRefresh({ check, reload }), REFRESH_MIN_MS);
    expect(check).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ failed: false });
  });
  test('a form (no read): only the re-check runs', async () => {
    const check = jest.fn(async () => undefined);
    const outcome = await settled(runNetworkRefresh({ check }), REFRESH_MIN_MS);
    expect(check).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ failed: false });
  });
  test('a failed read is reported as failed (the caller says so), never thrown; a failed re-check is not a failed refresh', async () => {
    const failedRead = await settled(runNetworkRefresh({ check: async () => undefined, reload: async () => { throw new Error('offline'); } }), REFRESH_MIN_MS);
    expect(failedRead).toEqual({ failed: true });
    const failedCheck = await settled(runNetworkRefresh({ check: async () => { throw new Error('probe broke'); }, reload: async () => 1 }), REFRESH_MIN_MS);
    expect(failedCheck).toEqual({ failed: false });
    const syncThrow = await settled(runNetworkRefresh({ check: () => { throw new Error('sync'); }, reload: () => { throw new Error('sync'); } }), REFRESH_MIN_MS);
    expect(syncThrow).toEqual({ failed: true });
  });
  test('the spinner lasts at least REFRESH_MIN_MS even when everything finishes at once', async () => {
    let done = false;
    const promise = runNetworkRefresh({ check: async () => undefined, reload: async () => 1 }).then((o) => { done = true; return o; });
    await jest.advanceTimersByTimeAsync(REFRESH_MIN_MS - 1);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await promise;
    expect(done).toBe(true);
  });
  test('and at most REFRESH_MAX_MS when something hangs (the work itself is not cancelled)', async () => {
    let done = false;
    const never = () => new Promise(() => {});
    const promise = runNetworkRefresh({ check: never, reload: never }).then((o) => { done = true; return o; });
    await jest.advanceTimersByTimeAsync(REFRESH_MAX_MS - 1);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await promise).toMatchObject({ failed: false, timedOut: true });
  });
  test('with nothing to run it still ends (a screen with no data)', async () => {
    expect(await settled(runNetworkRefresh({}), REFRESH_MIN_MS)).toEqual({ failed: false });
  });
  test('the limits are sensible', () => {
    expect(REFRESH_MIN_MS).toBeGreaterThanOrEqual(300);
    expect(REFRESH_MAX_MS).toBeLessThanOrEqual(15000);
    expect(REFRESH_MAX_MS).toBeGreaterThan(REFRESH_MIN_MS);
  });
});

describe('the hook only re-checks and reads: it cannot change a draft, a form, a document or a submission', () => {
  const hook = read('lib/useNetworkRefresh.js');
  const helper = read('lib/networkRefresh.js');
  test('it uses the app only for the toast and the text, and the network context only for check()', () => {
    expect(hook).toContain('const { t, toast } = useApp();');
    expect(hook).toContain('const { check } = useNetwork();');
    for (const forbidden of ['updateDraft', 'resetDraft', 'discardDraft', 'draft', 'setProfile', 'apiPost', 'apiPatch', 'apiUpload', 'apiDelete', 'submit', 'retry', 'restore']) {
      expect({ forbidden, found: new RegExp(`\\b${forbidden}\\b`).test(hook.replace(/\/\/[^\n]*/g, '')) }).toEqual({ forbidden, found: false });
    }
  });
  test('the helper imports nothing (pure) and runs only the two functions it is given', () => {
    expect(helper).not.toMatch(/^import /m);
    const code = helper.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n'); // the code, not its comments
    expect(code).not.toMatch(/\bfetch\b|apiGet|apiPost|storage|draft/i);
  });
  test('one guard per hook, created once, and a failed read uses the shared "Couldn\'t refresh" text', () => {
    expect(hook).toContain('const [guard] = useState(createRefreshGuard);');
    expect(hook).toContain("t('sk_refresh_failed')");
  });
  test('"Couldn\'t refresh" exists in all six languages (the Arabic one reads right to left like every other text)', () => {
    for (const lang of LANGS) expect({ lang, text: typeof I18N[lang].sk_refresh_failed }).toEqual({ lang, text: 'string' });
  });
});

describe('the request forms (every service): a pull re-checks the connection and nothing else', () => {
  const frame = read('components/request/RequestFrame.js');
  test('the frame shared by step 1, step 2 and Review has the control, with NO reload', () => {
    expect(frame).toContain("import { AppRefreshControl } from '../AppRefreshControl';");
    expect(frame).toContain('const { refreshing, onRefresh } = useNetworkRefresh();'); // no `reload`: only check()
    expect(frame).toContain('refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}');
  });
  test('every form step goes through that frame, so all eight services have it', () => {
    for (const step of ['app/request/step1.js', 'app/request/step2.js', 'app/request/review.js']) expect(read(step)).toContain('<RequestFrame');
    // and none of them adds a second control or its own reload on a pull
    for (const step of ['app/request/step1.js', 'app/request/step2.js', 'app/request/review.js']) expect(read(step)).not.toMatch(/RefreshControl|onRefresh/);
  });
  test('the pull cannot reach the form state: the frame\'s pull code never touches the draft', () => {
    const pullLines = frame.split('\n').filter((line) => /useNetworkRefresh|AppRefreshControl|onRefresh|refreshing/.test(line)).join('\n');
    expect(pullLines).not.toMatch(/updateDraft|resetDraft|discardDraft|setFormStep|files|uploaded/);
  });
  test('the submission-result screen has no pull gesture: its "Try again" is the only thing that can send a missing file (nothing is sent by itself)', () => {
    expect(read('app/request/submitted.js')).not.toMatch(/RefreshControl|useNetworkRefresh/);
  });
});

describe('screen audit: every patient screen has a decision (a new screen without one fails this test)', () => {
  // refresh: the screen reloads its server data on a pull | form: a pull re-checks the connection (the form is never reloaded) | none: why a pull would be meaningless
  const AUDIT = {
    'app/home.js': 'refresh', 'app/my-requests.js': 'refresh', 'app/my-documents.js': 'refresh', 'app/notifications.js': 'refresh', 'app/profile.js': 'refresh',
    'app/request-details.js': 'refresh', 'app/request-tracking.js': 'refresh', 'app/tracking.js': 'refresh', 'app/personal-details.js': 'refresh-or-recheck', 'app/service/[key].js': 'refresh',
    'app/request/step1.js': 'form', 'app/request/step2.js': 'form', 'app/request/review.js': 'form',
    'app/request/submitted.js': 'none: the result of a submission; its Try again is the only way a file is sent',
    'app/all-services.js': 'none: the bundled service list (no server data)', 'app/select-service.js': 'none: the bundled service list', 'app/air-ambulance.js': 'none: a choice between two bundled options',
    'app/about.js': 'none: static text', 'app/privacy.js': 'none: static text', 'app/terms.js': 'none: static text', 'app/help-support.js': 'none: static contacts',
    'app/cant-connect.js': 'none: a fixed screen with its own Try again', 'app/document-preview.js': 'none: a file viewer with its own retry', 'app/index.js': 'none: the splash',
    'app/welcome.js': 'none: sign-in entry', 'app/choose-login.js': 'none: sign-in entry', 'app/login.js': 'none: sign-in', 'app/login-otp.js': 'none: sign-in code',
    'app/register.js': 'none: sign-up', 'app/register-otp.js': 'none: sign-up code', 'app/forgot-password.js': 'none: password reset', 'app/forgot-password-otp.js': 'none: password reset code',
    'app/reset-password.js': 'none: password reset', 'app/set-password.js': 'none: sets a password', 'app/complete-profile.js': 'none: a one-time form',
    'app/edit-profile.js': 'none: an edit form with nothing to reload', 'app/change-contact.js': 'none: a code flow', 'app/change-contact-otp.js': 'none: a code flow',
    'app/delete-account.js': 'none: a confirmation flow', 'app/delete-account-otp.js': 'none: a confirmation flow',
    'app/_layout.js': 'none: layout',
  };
  const screens = (dir) => fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? screens(path.join(dir, e.name)) : [path.join(dir, e.name).replace(/\\/g, '/')]));
  // Corporate and Admin screens are not part of the patient app's audit.
  const patientScreens = screens('app').filter((file) => /\.js$/.test(file) && !/corporate-/.test(file));

  test('every patient screen file is in the audit, and the audit names no file that does not exist', () => {
    expect(patientScreens.filter((file) => !(file in AUDIT)).sort()).toEqual([]);
    expect(Object.keys(AUDIT).filter((file) => !patientScreens.includes(file)).sort()).toEqual([]);
  });
  test('the screens marked "refresh" really have the pull control, wired to their own reload (and a failure message)', () => {
    for (const [file, decision] of Object.entries(AUDIT)) {
      if (decision !== 'refresh') continue;
      const source = read(file);
      expect({ file, control: /AppRefreshControl/.test(source) }).toEqual({ file, control: true });
      expect({ file, wired: /onRefresh|useNetworkRefresh/.test(source) }).toEqual({ file, wired: true });
    }
  });
  test('the screens marked "none" really have no pull control (no meaningless gesture)', () => {
    for (const [file, decision] of Object.entries(AUDIT)) {
      if (!decision.startsWith('none')) continue;
      expect({ file, control: /RefreshControl/.test(read(file)) }).toEqual({ file, control: false });
    }
  });
  test('the list and details screens reload through the shared resource hook, which allows one refresh at a time and shows the spinner only for the pull', () => {
    const resource = read('lib/useResource.js');
    expect(resource).toContain('if (refreshingRef.current) return;');
    expect(resource).toContain('setRefreshing(true);');
    expect(resource).toContain('if (failRef.current) failRef.current(err);');
    for (const file of ['app/my-requests.js', 'app/my-documents.js', 'app/notifications.js', 'app/request-details.js', 'app/request-tracking.js', 'app/tracking.js', 'app/home.js']) {
      const source = read(file);
      expect({ file, hook: /useResource\(|useRequestTracking|useTracking/.test(source) || /onRefresh/.test(source) }).toEqual({ file, hook: true });
    }
  });
});

describe('the two screens that were not pulled before', () => {
  test('the service detail re-reads the live text (and keeps the bundled text on a failure)', () => {
    const screen = read('app/service/[key].js');
    expect(screen).toContain('useNetworkRefresh({ reload: loadLive })');
    expect(screen).toContain('refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}');
    expect(screen).toContain('const loadLive = useCallback(() => apiGet(');
    // the draft sheet and the start button are not touched by it
    expect(screen.split('\n').filter((l) => /useNetworkRefresh|onRefresh/.test(l)).join('\n')).not.toMatch(/resetDraft|resumeDraft|discardDraft|savedDraft/);
  });
  test('the personal details re-read the profile while viewing, and ONLY re-check the connection while editing (the typed form is never touched)', () => {
    const screen = read('app/personal-details.js');
    expect(screen).toContain('useNetworkRefresh({ reload: editing || isCorporate ? undefined : reloadProfile })');
    const reload = screen.slice(screen.indexOf('const reloadProfile'), screen.indexOf('const { refreshing, onRefresh }'));
    expect(reload).toContain("apiGet('/auth/me')");
    expect(reload).not.toMatch(/setForm|setErrors|setEditing|setPicker|set\(/); // the form state is not written by the re-read
    expect(reload).toContain('setUser(me);');
  });
});
