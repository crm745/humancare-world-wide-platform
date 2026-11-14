/* global describe, test, expect, jest, __dirname */
// Google sign-in on the web: the popup hand-over (which must work under Google's Cross-Origin-Opener-Policy) and one attempt from the tap to the
// signed-in screen. These tests use FAKES for Google, the backend and the navigation: they prove the app's logic, not that real Google sign-in
// works. The browser runs against a fake Google page that is served with the same COOP header are described in the report.
const fs = require('fs');
const path = require('path');
const flow = require('../googleWebFlow');
const { runGoogleLogin } = require('../googleLogin');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\r\n').join('\n');
// the code without its comments (the comments explain what is NOT used)
const code = (rel) => read(rel).split('\n').filter((line) => !line.trim().startsWith('//')).map((line) => line.replace(/ \/\/ .*$/, '')).join('\n');
const SESSION = { token: 'access', refreshToken: 'refresh', user: { id: 1 } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenWith = (nonce) => `${b64({ alg: 'RS256' })}.${b64({ nonce, email: 'must-not-be-read@example.com' })}.sig`;
const PENDING = { state: 'S1', nonce: 'N1', at: 1000 };

describe('the Google address: the same request as before (so what is registered with Google stays valid)', () => {
  const url = new URL(flow.buildGoogleAuthUrl({ clientId: 'client-id', redirectUri: 'http://localhost:8082', state: 'S1', nonce: 'N1' }));
  test('the endpoint, the response type, the account chooser and the redirect URI (the app\'s own origin)', () => {
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('id_token');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8082');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('scope')).toBe('openid https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email');
    expect(url.searchParams.get('state')).toBe('S1');
    expect(url.searchParams.get('nonce')).toBe('N1');
  });
  test('the redirect URI is the page\'s origin, never a path (the web Client must have been registered with exactly this)', () => {
    expect(read('lib/googleAuth.web.js')).toContain('redirectUri: window.location.origin');
  });
  test('state and nonce are random and long enough', () => {
    const a = flow.randomToken();
    const b = flow.randomToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(() => flow.randomToken(16, {})).toThrow('cannot start a secure sign-in');
  });
});

describe('reading the answer in the popup', () => {
  test('a good answer, an error, and things that are not an answer', () => {
    expect(flow.parseCallbackHash('#state=S1&id_token=abc.def.ghi&authuser=0&iss=https%3A%2F%2Faccounts.google.com')).toEqual({ state: 'S1', idToken: 'abc.def.ghi', error: null });
    expect(flow.parseCallbackHash('state=S1&error=access_denied')).toEqual({ state: 'S1', idToken: null, error: 'access_denied' });
    ['', '#', '#foo=bar', '#state=S1', '#id_token=abc', null, undefined].forEach((h) => expect(flow.parseCallbackHash(h)).toBe(null));
  });
  test('only an answer to the sign-in THIS browser started is taken (same state, not stale)', () => {
    const cb = { state: 'S1', idToken: 't', error: null };
    expect(flow.isOurCallback(cb, PENDING, 2000)).toBe(true);
    expect(flow.isOurCallback({ ...cb, state: 'OTHER' }, PENDING, 2000)).toBe(false);
    expect(flow.isOurCallback(cb, null, 2000)).toBe(false);
    expect(flow.isOurCallback(cb, PENDING, 1000 + flow.PENDING_MAX_AGE_MS + 1)).toBe(false);
    expect(flow.isOurCallback(null, PENDING, 2000)).toBe(false);
  });
});

describe('what the answer means (3-5: cancel, popup closed, invalid or missing token)', () => {
  test('a token with our nonce is the token', () => {
    expect(flow.outcomeOf({ state: 'S1', idToken: tokenWith('N1'), error: null }, PENDING)).toEqual({ idToken: tokenWith('N1') });
  });
  test('Cancel at Google is a quiet end (no message, no sign-in)', () => {
    expect(flow.outcomeOf({ state: 'S1', idToken: null, error: 'access_denied' }, PENDING)).toEqual({ idToken: null });
  });
  test('any other error from Google is an error', () => {
    expect(flow.outcomeOf({ state: 'S1', idToken: null, error: 'server_error' }, PENDING).error.message).toBe('Google sign-in failed. Please try again.');
  });
  test('no token is an error, never a silent nothing', () => {
    expect(flow.outcomeOf({ state: 'S1', idToken: null, error: null }, PENDING).error.message).toContain('did not send a sign-in token');
  });
  test('a token for a different sign-in (another nonce, or none) is refused', () => {
    expect(flow.outcomeOf({ state: 'S1', idToken: tokenWith('SOMEONE-ELSE'), error: null }, PENDING).error.message).toContain('could not be verified');
    expect(flow.outcomeOf({ state: 'S1', idToken: 'not-a-jwt', error: null }, PENDING).error).toBeTruthy();
    expect(flow.outcomeOf({ state: 'S1', idToken: `${b64({})}.${b64({ sub: '1' })}.s`, error: null }, PENDING).error).toBeTruthy();
  });
  test('an answer for another state is ignored (it is not this sign-in)', () => {
    expect(flow.outcomeOf({ state: 'OTHER', idToken: tokenWith('N1'), error: null }, PENDING)).toEqual({ ignore: true });
    expect(flow.outcomeOf(null, PENDING)).toEqual({ ignore: true });
    expect(flow.outcomeOf({ state: 'S1', idToken: 'x', error: null }, null)).toEqual({ ignore: true });
  });
  test('the nonce is the ONLY thing read from the token: the app never reads or trusts an email from it (the backend verifies the token)', () => {
    expect(flow.nonceOf(tokenWith('N1'))).toBe('N1');
    [read('lib/googleWebFlow.js'), read('lib/googleAuth.web.js'), read('lib/googleCallback.web.js'), read('lib/googleLogin.js'), read('lib/useSocialAuth.js')].forEach((src) => {
      expect(src).not.toMatch(/claims\.email|payload\.email|email_verified|\.sub\b/);
    });
  });
});

// a harness: every step recorded, so the ORDER and the absence of steps can be checked
function harness({ token = 'google-id-token', post = async () => SESSION, getIdToken } = {}) {
  const calls = [];
  const deps = {
    begin: jest.fn(() => { calls.push('begin'); return 7; }),
    getIdToken: getIdToken || jest.fn(async () => { calls.push('picker'); return token; }),
    postToken: jest.fn(async (t) => { calls.push('backend'); return post(t); }),
    afterLogin: jest.fn(async () => { calls.push('signed-in and navigated'); }),
  };
  return { deps, calls };
}

describe('1-2, 9. a successful sign-in: Google -> backend -> session -> the next screen, in that order', () => {
  test('the ID token goes to the backend, and only then is the session saved and Home opened', async () => {
    const { deps, calls } = harness();
    await expect(runGoogleLogin(deps, { busy: false })).resolves.toBe('done');
    expect(deps.postToken).toHaveBeenCalledWith('google-id-token');
    expect(deps.afterLogin).toHaveBeenCalledWith(SESSION, 7);
    expect(calls).toEqual(['begin', 'picker', 'backend', 'signed-in and navigated']);
  });
  test('the screen sends the token as { idToken } to the existing endpoint, and the backend answer is what is saved', () => {
    const hook = read('lib/useSocialAuth.js');
    expect(hook).toContain("postToken: (idToken) => apiPost('/auth/google', { idToken }),");
    expect(hook).toContain('afterLogin: afterSocialLogin,');
    const login = read('app/login.js');
    expect(login).toContain('await saveTokens({ token, refreshToken }, { signIn: true, attempt });');
    expect(login.indexOf('await saveTokens(')).toBeLessThan(login.indexOf('navReplace(destination);'));
  });
});

describe('3-4. not finishing: nothing happens', () => {
  test('no request, no session, no navigation, no message', async () => {
    const { deps, calls } = harness({ token: null });
    await expect(runGoogleLogin(deps, { busy: false })).resolves.toBe('cancelled');
    expect(deps.postToken).not.toHaveBeenCalled();
    expect(deps.afterLogin).not.toHaveBeenCalled();
    expect(calls).toEqual(['begin', 'picker']);
  });
  test('the person cannot be told that the popup was closed (Google cuts the link), so an unfinished attempt ends by itself, quietly', () => {
    const web = read('lib/googleAuth.web.js');
    expect(web).toContain('timer = setTimeout(() => finish(resolve, null), WAIT_MAX_MS);');
    expect(flow.WAIT_MAX_MS).toBe(3 * 60 * 1000);
    expect(code('lib/googleAuth.web.js')).not.toMatch(/popup\.closed|\.closed\b/); // popup.closed is not trusted: Google's COOP makes it read true while the popup is open
  });
  test('the native picker also ends quietly when it is backed out of', () => {
    expect(read('lib/googleAuth.native.js')).toContain('err.code === statusCodes.SIGN_IN_CANCELLED || err.code === statusCodes.IN_PROGRESS) return null;');
  });
});

describe('6-7. the backend refuses, or the network fails: the error is shown and no one is signed in or sent Home', () => {
  test.each([
    ['the backend refuses the token', Object.assign(new Error('Google sign-in could not be verified.'), { status: 401, code: 'invalid_token' })],
    ['no account', Object.assign(new Error('No account found'), { status: 404, code: 'no_account' })],
    ['the network fails', Object.assign(new Error('Could not reach the server'), { code: 'network' })],
    ['the server fails', Object.assign(new Error('Something went wrong'), { status: 500 })],
  ])('%s', async (_name, err) => {
    const { deps, calls } = harness({ post: async () => { throw err; } });
    await expect(runGoogleLogin(deps, { busy: false })).rejects.toBe(err);
    expect(deps.afterLogin).not.toHaveBeenCalled();
    expect(calls).not.toContain('signed-in and navigated');
  });
  test('and the screen shows it', () => {
    const hook = read('lib/useSocialAuth.js');
    expect(hook).toContain('onFailed(err);');
    expect(hook).toContain('toast(err.message);');
  });
});

describe('8. no duplicate requests', () => {
  test('a tap while the backend is working does nothing: one request', async () => {
    let release;
    const { deps } = harness({ post: () => new Promise((resolve) => { release = () => resolve(SESSION); }) });
    const guard = { busy: false };
    const first = runGoogleLogin(deps, guard);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const reopenPicker = jest.fn();
    await expect(runGoogleLogin({ ...deps, reopenPicker }, guard)).resolves.toBe('busy');
    await expect(runGoogleLogin({ ...deps, reopenPicker }, guard)).resolves.toBe('busy');
    expect(reopenPicker).not.toHaveBeenCalled(); // the picker is already done: nothing to bring back
    release();
    await expect(first).resolves.toBe('done');
    expect(deps.postToken).toHaveBeenCalledTimes(1);
    expect(deps.begin).toHaveBeenCalledTimes(1);
  });
  test('a tap while the popup is still open brings the popup back, and starts nothing new', async () => {
    let release;
    const { deps } = harness({ getIdToken: () => new Promise((resolve) => { release = () => resolve('tok'); }) });
    const guard = { busy: false };
    const reopenPicker = jest.fn();
    const first = runGoogleLogin({ ...deps, reopenPicker }, guard);
    await expect(runGoogleLogin({ ...deps, reopenPicker }, guard)).resolves.toBe('busy');
    expect(reopenPicker).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toBe('done');
    expect(deps.begin).toHaveBeenCalledTimes(1);
    expect(deps.postToken).toHaveBeenCalledTimes(1);
  });
  test('after an attempt ends, in any way, the next tap works (the guard never sticks)', async () => {
    const guard = { busy: false };
    await expect(runGoogleLogin(harness({ token: null }).deps, guard)).resolves.toBe('cancelled');
    await expect(runGoogleLogin(harness({ post: async () => { throw new Error('x'); } }).deps, guard)).rejects.toThrow('x');
    await expect(runGoogleLogin(harness().deps, guard)).resolves.toBe('done');
    expect(guard.busy).toBe(false);
    expect(guard.phase).toBe(null);
  });
  test('the screen keeps one guard for its lifetime and passes the reopen', () => {
    const hook = read('lib/useSocialAuth.js');
    expect(hook).toContain('const googleGuard = useRef({ busy: false });');
    expect(hook).toContain('reopenPicker: google.reopen,');
    expect(hook).toContain('}, googleGuard.current);');
  });
});

describe('10. navigation: Home only after the backend succeeded', () => {
  test('on every failure path afterLogin (the only thing that navigates) is not called', async () => {
    const paths = [
      harness({ token: null }),
      harness({ post: async () => { throw new Error('refused'); } }),
      harness({ getIdToken: async () => { throw new Error('picker failed'); } }),
    ];
    for (const { deps } of paths) {
      await runGoogleLogin(deps, { busy: false }).catch(() => {});
      expect(deps.afterLogin).not.toHaveBeenCalled();
    }
  });
});

describe('THE BUG: the popup came back and ran the whole app (Getting Started) while Login waited', () => {
  test('the popup\'s answer is handed over through same-origin storage and a BroadcastChannel, not window.opener', () => {
    const cb = read('lib/googleCallback.web.js');
    expect(cb).toContain('window.localStorage.setItem(RESULT_KEY');
    expect(cb).toContain('new BroadcastChannel(CHANNEL_NAME)');
    expect(code('lib/googleCallback.web.js')).not.toMatch(/window\.opener|opener\.postMessage|parent\.postMessage/); // (channel.postMessage is the BroadcastChannel)
    const web = read('lib/googleAuth.web.js');
    expect(web).toContain("window.addEventListener('storage', onStorage);");
    expect(web).toContain('channel = new BroadcastChannel(CHANNEL_NAME);');
    expect(code('lib/googleAuth.web.js')).not.toMatch(/window\.opener|expo-auth-session|expo-web-browser/);
  });
  test('it is the FIRST import of the root layout, so it runs before any screen and any redirect', () => {
    const layout = read('app/_layout.js');
    expect(layout.indexOf("import { googleCallback } from '../lib/googleCallback';")).toBeLessThan(layout.indexOf("import '../../global.css';"));
    expect(layout.indexOf("import { googleCallback }")).toBeLessThan(layout.indexOf("import { Stack }"));
  });
  test('the popup does NOT start the app: no providers, no splash, no Getting Started', () => {
    const layout = read('app/_layout.js');
    expect(layout).toContain('if (googleCallback) return <GoogleCallbackScreen />;');
    expect(layout.indexOf('if (googleCallback) return')).toBeLessThan(layout.indexOf('<SafeAreaProvider>'));
    const screen = read('components/GoogleCallbackScreen.js');
    expect(screen).not.toMatch(/useApp|router|useRouter|navReplace/);
  });
  test('it only acts on an answer to the sign-in that was started (the pending state is in storage), and takes the answer out of the address', () => {
    const cb = read('lib/googleCallback.web.js');
    expect(cb).toContain('isOurCallback(callback, pending, Date.now())');
    expect(cb).toContain("window.history.replaceState(null, '', window.location.pathname + window.location.search);");
    expect(cb).toContain('window.close();');
  });
  test('the window opens the popup straight from the tap, and says so when the browser blocks it', () => {
    const web = read('lib/googleAuth.web.js');
    expect(web).toContain('// Not async before window.open: the popup has to be opened inside the tap.');
    expect(web).toContain('The sign-in window was blocked. Allow pop-ups for this site and try again.');
  });
  test('the answer is used once and does not stay in storage', () => {
    const web = read('lib/googleAuth.web.js');
    expect(web).toContain('window.localStorage.removeItem(RESULT_KEY); // the answer is used once and does not stay in storage');
    expect(web).toContain('window.localStorage.removeItem(PENDING_KEY);');
  });
  test('the phone has nothing to hand over (it uses the native picker)', () => {
    expect(read('lib/googleCallback.js')).toContain('export const googleCallback = null;');
  });
  test('email and password, OTP, the backend and the auth guards are untouched', () => {
    ['lib/authGuard.js', 'components/AuthGate.js', 'components/OtpScreen.js', 'lib/session.js'].forEach((f) => expect(read(f)).not.toMatch(/googleCallback|googleLogin|googleWebFlow/));
  });
});
