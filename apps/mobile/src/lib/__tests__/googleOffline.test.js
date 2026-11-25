/* global describe, test, expect, beforeEach, afterEach, jest, __dirname */
// Google (and Apple) sign-in while the phone is offline. No token or real account appears here: the providers and the backend are stand-ins.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { runGoogleLogin } = require('../googleLogin');
const { createNetworkStore, NET } = require('../network');
const {
  SOCIAL_STEP_TIMEOUT_MS, OFFLINE_CODE, TIMEOUT_CODE, createFlowWatch, isOfflineError, offlineError, startSocialSignIn,
} = require('../socialGuard');

const SRC = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\r\n').join('\n');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// One full attempt the way the hook runs it, with stand-ins for the provider and the backend.
function attemptWith({ isOffline, providerAnswer, watch, postToken = jest.fn(async () => ({ ok: true })) }) {
  const getIdToken = jest.fn(() => providerAnswer());
  const afterLogin = jest.fn(async () => {});
  const guard = { busy: false };
  const run = () => runGoogleLogin({ begin: () => 1, getIdToken: () => watch.run(getIdToken()), postToken, afterLogin }, guard);
  return { getIdToken, postToken, afterLogin, guard, start: () => startSocialSignIn({ isOffline, run }) };
}
const watchFor = () => createFlowWatch({ offlineMessage: 'offline', timeoutMessage: 'too long' });

describe('offline: nothing starts', () => {
  test('the provider, the browser or popup and the backend are never called, also when the button is tapped', async () => {
    const watch = watchFor();
    const a = attemptWith({ isOffline: true, providerAnswer: () => Promise.resolve('id-token'), watch });
    expect(await a.start()).toBe('offline');
    expect(await a.start()).toBe('offline'); // tapped again
    expect(a.getIdToken).not.toHaveBeenCalled();
    expect(a.postToken).not.toHaveBeenCalled();
    expect(a.afterLogin).not.toHaveBeenCalled();
    expect(watch.isRunning()).toBe(false);
    expect(a.guard.busy).toBe(false);
  });
  test('the hook checks the state at the moment of the tap (not only when the screen drew) and shows the sentence', () => {
    const hook = read('lib/useSocialAuth.js');
    expect(hook).toContain('startSocialSignIn({ isOffline: offlineRef.current, run: () => runGoogle() })');
    expect(hook).toContain("if (started === 'offline') toast(t('net_google_offline'));");
    expect(hook).toContain("if (offlineRef.current) { toast(t('net_google_offline')); return; }"); // Apple
  });
});

describe('online: the flow is exactly as before', () => {
  test('the provider is asked once, the backend once, and the app signs in only after the backend said yes', async () => {
    const watch = watchFor();
    const a = attemptWith({ isOffline: false, providerAnswer: () => Promise.resolve('id-token'), watch });
    expect(await a.start()).toBe('done');
    expect(a.getIdToken).toHaveBeenCalledTimes(1);
    expect(a.postToken).toHaveBeenCalledTimes(1);
    expect(a.postToken).toHaveBeenCalledWith('id-token');
    expect(a.afterLogin).toHaveBeenCalledTimes(1);
  });
  test('closing the picker ends quietly: no backend call, no sign-in', async () => {
    const a = attemptWith({ isOffline: false, providerAnswer: () => Promise.resolve(null), watch: watchFor() });
    expect(await a.start()).toBe('cancelled');
    expect(a.postToken).not.toHaveBeenCalled();
    expect(a.afterLogin).not.toHaveBeenCalled();
  });
  test('the web popup still opens inside the tap: the provider is called with nothing awaited first', () => {
    const calls = [];
    const watch = watchFor();
    const run = () => runGoogleLogin({ begin: () => 1, getIdToken: () => { calls.push('provider'); return watch.run(new Promise(() => {})); }, postToken: async () => ({}), afterLogin: async () => {} }, { busy: false });
    startSocialSignIn({ isOffline: false, run });
    expect(calls).toEqual(['provider']); // synchronously, before any microtask
  });
});

describe('unknown network state counts as online', () => {
  test('only a KNOWN offline state switches the button off', async () => {
    expect(read('state/NetworkContext.js')).toContain('isOffline: state.status === NET.OFFLINE,');
    expect(NET.UNKNOWN).toBe('unknown');
    const watch = watchFor();
    const a = attemptWith({ isOffline: false /* unknown, slow and server-down are not offline */, providerAnswer: () => Promise.resolve('x'), watch });
    expect(await a.start()).toBe('done');
  });
});

describe('connectivity restored', () => {
  test('the shared network store goes offline -> online, and the hook reads that same flag (the button and the line follow it with no reload)', async () => {
    let link = { isConnected: false, isInternetReachable: false, type: 'none' };
    let push = () => {};
    const store = createNetworkStore({ probe: async () => ({ ok: true, ms: 50 }), subscribeLink: (cb) => { push = cb; cb(link); return () => {}; } });
    const stop = store.start ? store.start() : undefined;
    await Promise.resolve();
    expect(store.getState().status).toBe(NET.OFFLINE);
    link = { isConnected: true, isInternetReachable: true, type: 'wifi' };
    push(link);
    await jest.advanceTimersByTimeAsync(10);
    expect([NET.ONLINE, NET.SLOW, NET.UNKNOWN]).toContain(store.getState().status);
    expect(store.getState().status).not.toBe(NET.OFFLINE);
    if (typeof stop === 'function') stop();
    // the screen re-renders from that state: the pale look and the line exist only while it says offline
    const login = read('app/login.js');
    expect(login).toContain('faded={!!(offline || disabled)}'); // the pale look, which fades (components/AnimatedPressBox.js)
    expect(login).toContain("<Collapse show={!!offline}><View style={{ paddingTop: 8 }}><OfflineLine text={t('net_google_offline')} /></View></Collapse>");
    expect(read('lib/useSocialAuth.js')).toContain('offline: isOffline');
  });
});

describe('the connection drops during the flow, or a provider or server never answers', () => {
  test('the picker is open, the connection drops: the flow ends with the offline error, nothing is saved, the guard is released', async () => {
    const watch = watchFor();
    const a = attemptWith({ isOffline: false, providerAnswer: () => new Promise(() => {}), watch }); // the picker never answers
    const result = a.start();
    const caught = result.catch((e) => e);
    await Promise.resolve();
    expect(watch.isRunning()).toBe(true);
    watch.abort(); // what the hook does when the shared state turns offline
    const err = await caught;
    expect(isOfflineError(err)).toBe(true);
    expect(err.code).toBe(OFFLINE_CODE);
    expect(a.postToken).not.toHaveBeenCalled();
    expect(a.afterLogin).not.toHaveBeenCalled(); // never half signed in
    expect(a.guard.busy).toBe(false); // the person can try again
    expect(watch.isRunning()).toBe(false);
  });
  test('the provider never answers: the flow ends by itself with a clear error, no endless wait', async () => {
    const watch = watchFor();
    const a = attemptWith({ isOffline: false, providerAnswer: () => new Promise(() => {}), watch });
    const caught = a.start().catch((e) => e);
    await jest.advanceTimersByTimeAsync(SOCIAL_STEP_TIMEOUT_MS + 1);
    const err = await caught;
    expect(err.code).toBe(TIMEOUT_CODE);
    expect(err.message).toBe('too long');
    expect(a.afterLogin).not.toHaveBeenCalled();
    expect(a.guard.busy).toBe(false);
    expect(jest.getTimerCount()).toBe(0); // no timer left running
  });
  test('our server fails or times out after the provider answered: the error reaches the screen and nothing is saved', async () => {
    const watch = watchFor();
    const postToken = jest.fn(async () => { throw Object.assign(new Error('Could not reach the server. Please try again.'), { code: 'network' }); });
    const a = attemptWith({ isOffline: false, providerAnswer: () => Promise.resolve('x'), watch, postToken });
    await expect(a.start()).rejects.toMatchObject({ code: 'network' });
    expect(a.afterLogin).not.toHaveBeenCalled();
    expect(a.guard.busy).toBe(false);
  });
  test('a late answer after the flow ended is ignored', async () => {
    const watch = watchFor();
    let answer;
    const a = attemptWith({ isOffline: false, providerAnswer: () => new Promise((resolve) => { answer = resolve; }), watch });
    const caught = a.start().catch((e) => e);
    await Promise.resolve();
    watch.abort();
    await caught;
    answer('late-token');
    await Promise.resolve();
    expect(a.postToken).not.toHaveBeenCalled();
  });
  test('the screen shows the message and stays on the login screen: the offline sentence when offline, the existing error otherwise; no spinner is involved', () => {
    const hook = read('lib/useSocialAuth.js');
    expect(hook).toContain("toast(isOfflineError(err) ? t('net_google_offline') : err.code === TIMEOUT_CODE ? t('net_social_timeout') : errorText(err, t));");
    expect(hook).toContain('if (isOffline) watch.abort();');
    expect(hook).toContain('getIdToken: () => watch.run(google.signIn())');
    expect(hook).not.toMatch(/Spinner|setBusy|loading/); // nothing here can spin for ever
    expect(offlineError('x').code).toBe(OFFLINE_CODE);
  });
});

describe('every screen with Google (or Apple) sign-in', () => {
  const walk = (dir) => fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(`${dir}/${e.name}`)) : /\.js$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  const files = ['app', 'components'].flatMap(walk);
  test('the social buttons exist on the login screen only, and every user of the hook switches the button off and shows the line', () => {
    const users = files.filter((f) => /useSocialAuth\(/.test(read(f)));
    expect(users).toEqual(['app/login.js']);
    const other = files.filter((f) => /continue_with_(google|apple)/.test(read(f)));
    expect(other).toEqual(['app/login.js']);
    const login = read('app/login.js');
    expect(login).toContain('useSocialAuth({ toast, afterSocialLogin, t })');
    expect(login).toContain('disabled={disabled || offline}');
    expect(login).toContain("accessibilityHint={offline ? t('net_google_offline') : undefined}");
    expect(login).toContain('accessibilityState={offline ? { disabled: true } : undefined}');
  });
  test('sign-up and the profile step have no Google button of their own (they start from the login screen)', () => {
    for (const file of ['app/register.js', 'app/complete-profile.js', 'app/register-otp.js']) expect({ file, google: /continue_with_google|useGoogleSignIn|signInWithApple/.test(read(file)) }).toEqual({ file, google: false });
  });
  test('Apple: the hook gives it the same flag and guard when it is shown (iOS); the dimmed placeholder is unchanged', () => {
    const hook = read('lib/useSocialAuth.js');
    expect(hook).toContain("{ key: 'apple', Mark: AppleMark, onPress: onApple, offline: isOffline }");
    expect(hook).toContain('await watch.run(signInWithApple())');
    expect(read('app/login.js')).toContain("b.key !== 'apple'");
  });
});

describe('look, accessibility, translations', () => {
  test('the line: wifi-off icon, 13 px, #5B6B84, centred; the button uses the same pale look as the app\'s other offline buttons (opacity-45)', () => {
    const line = read('components/network/OfflineLine.js');
    expect(line).toContain('<WifiOff size={16} color="#5B6B84"');
    expect(line).toContain("fontSize: 13, lineHeight: 18, color: '#5B6B84'");
    expect(line).toContain("textAlign: 'center'");
    expect(read('components/ui.js')).toContain('faded={!!faded}'); // every button goes pale the same way: AnimatedPressBox, FADED_OPACITY 0.45
    expect(read('components/AnimatedPressBox.js')).toContain('export const FADED_OPACITY = 0.45;');
    expect(read('app/login.js')).toContain('<AnimatedPressBox');
  });
  test('the sentence is in all six languages, translated, with the English wording', () => {
    expect(I18N.EN.net_google_offline).toBe('Internet connection is required to sign in with Google.');
    for (const lang of LANGS) {
      expect(typeof I18N[lang].net_google_offline).toBe('string');
      expect(I18N[lang].net_google_offline).toMatch(/Google/);
      if (lang !== 'EN') expect(I18N[lang].net_google_offline).not.toBe(I18N.EN.net_google_offline);
    }
  });
  test('the connection banner still shows on screens with a header (the login screen has none, as before)', () => {
    expect(read('components/layout.js')).toContain('{banner ? <ConnectionBanner /> : null}');
    expect(read('app/login.js')).not.toMatch(/ConnectionBanner|<TopBar/);
  });
});
