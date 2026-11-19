/* global describe, test, expect, __dirname */
// The splash screen (app/index.js, lib/splash.js): at least 3 seconds on every launch, then ONE destination decided by the resolved authentication state: Home only when the
// server accepted the saved session, Getting Started for everything else; a tap cannot skip the check; it never goes twice and is never stuck.
// The authentication states used here come from the REAL session check and state store (lib/sessionCheck.js, lib/authState.js), so "what a logged-in / logged-out / new /
// failing person ends up as" is tested on the real code, with a fake token store and a fake /auth/me. (The screen itself is not rendered: this project's Jest covers lib/
// logic and reads screen source, see jest.config.js; the timing on a phone is checked by hand.)
const fs = require('fs');
const path = require('path');
const splash = require('../splash');
const { createAuthStore } = require('../authState');

const { MIN_SPLASH_MS, SESSION_TIMEOUT_MS, HOME_ROUTE, START_ROUTE, destinationFor, splashDecision } = splash;
const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('the numbers', () => {
  test('the minimum is 3 seconds; the longest wait for the session check stays 4 seconds', () => {
    expect(MIN_SPLASH_MS).toBe(3000);
    expect(SESSION_TIMEOUT_MS).toBe(4000);
    expect(SESSION_TIMEOUT_MS).toBeGreaterThan(MIN_SPLASH_MS);
  });
  test('the screen uses these (there is no 5-second constant left, and no number of its own)', () => {
    const screen = code('app/index.js');
    expect(screen).toContain("import { MIN_SPLASH_MS, SESSION_TIMEOUT_MS, splashDecision } from '../lib/splash';");
    expect(screen).toContain('setTimeout(() => setMinElapsed(true), MIN_SPLASH_MS)');
    expect(screen).toContain('setTimeout(() => setTimedOut(true), SESSION_TIMEOUT_MS)');
    expect(screen).not.toMatch(/\b5000\b/);
    expect(screen).not.toMatch(/MIN_SPLASH_MS\s*=/);
  });
});

describe('where each state goes', () => {
  test('only an accepted session goes Home; everything else goes to Getting Started', () => {
    expect(destinationFor('authed')).toBe('/home');
    for (const status of ['anon', 'unreachable', 'error', 'loading', undefined, null, '', 'aborted', 'authed ']) expect({ status, to: destinationFor(status) }).toEqual({ status, to: '/welcome' });
    expect([HOME_ROUTE, START_ROUTE]).toEqual(['/home', '/welcome']);
  });
  test('the routes are real screens, and Getting Started is public (a signed-out person can reach it)', () => {
    const { isPublicRoute } = require('../authGuard');
    expect(fs.existsSync(path.join(__dirname, '../../app/home.js'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../../app/welcome.js'))).toBe(true);
    expect(isPublicRoute(START_ROUTE)).toBe(true);
    expect(isPublicRoute('/')).toBe(true); // the splash itself
  });
});

describe('the decision, over time', () => {
  const at = (ms, status, navigated = false) => splashDecision({ status, minElapsed: ms >= MIN_SPLASH_MS, timedOut: ms >= SESSION_TIMEOUT_MS, navigated });
  test('never before 3 seconds, whatever the state is (a quick check does not shorten the splash)', () => {
    for (const status of ['authed', 'anon', 'unreachable', 'error', 'loading']) for (const ms of [0, 500, 1500, 2999]) expect({ status, ms, to: at(ms, status) }).toEqual({ status, ms, to: null });
  });
  test('at 3 seconds with the answer already known: goes at once (the splash is not stretched)', () => {
    expect(at(3000, 'authed')).toBe('/home');
    expect(at(3000, 'anon')).toBe('/welcome');
    expect(at(3000, 'unreachable')).toBe('/welcome');
    expect(at(3000, 'error')).toBe('/welcome');
  });
  test('the check still running at 3 seconds: waits, and goes the moment it answers', () => {
    expect(at(3000, 'loading')).toBeNull();
    expect(at(3500, 'loading')).toBeNull();
    expect(at(3500, 'authed')).toBe('/home');
    expect(at(3999, 'anon')).toBe('/welcome');
  });
  test('the check not answered by 4 seconds: Getting Started (never stuck); a late answer cannot undo it', () => {
    expect(at(4000, 'loading')).toBe('/welcome');
    expect(at(9000, 'loading')).toBe('/welcome');
    expect(at(5000, 'authed', true)).toBeNull(); // already gone: it never goes twice
    expect(at(9000, 'loading', true)).toBeNull();
  });
  test('it never goes twice: once navigated, every later state is ignored', () => {
    for (const status of ['authed', 'anon', 'unreachable', 'error', 'loading']) expect(splashDecision({ status, minElapsed: true, timedOut: true, navigated: true })).toBeNull();
  });
  test('nothing known at all (no arguments) waits', () => {
    expect(splashDecision()).toBeNull();
    expect(splashDecision({})).toBeNull();
  });
});

describe('what each kind of person ends up as, on the real session check', () => {
  // A store wired as AppContext wires it, with a fake token store and a fake /auth/me.
  const run = async ({ token, me, tokenTimeoutMs, meTimeoutMs }) => {
    const seen = [];
    const store = createAuthStore({
      getToken: async () => (typeof token === 'function' ? token() : token),
      fetchMe: async () => (typeof me === 'function' ? me() : me),
      onChange: (status) => seen.push(status),
      tokenTimeoutMs,
      meTimeoutMs,
    });
    await store.validate();
    return { status: store.getStatus(), seen };
  };
  const fail = (status) => { const error = new Error(`HTTP ${status}`); error.status = status; return error; };

  test('a new person (nothing saved): no session -> Getting Started', async () => {
    const { status } = await run({ token: null, me: () => { throw new Error('must not be called'); } });
    expect(status).toBe('anon');
    expect(destinationFor(status)).toBe('/welcome');
  });
  test('a logged-out person (nothing saved) is the same as a new one: Getting Started', async () => {
    const { status } = await run({ token: undefined, me: {} });
    expect(destinationFor(status)).toBe('/welcome');
  });
  test('a logged-in person whose session the server accepts -> Home', async () => {
    const { status } = await run({ token: 'saved-token', me: { user: { name: 'Aisha' } } });
    expect(status).toBe('authed');
    expect(destinationFor(status)).toBe('/home');
  });
  test('a saved token is NOT enough: one the server refuses (expired, revoked, forged) -> Getting Started', async () => {
    const { status } = await run({ token: 'saved-token', me: () => { throw fail(401); } });
    expect(status).toBe('anon');
    expect(destinationFor(status)).toBe('/welcome');
  });
  test('a saved token with a role/permission answer (403) grants nothing -> Getting Started', async () => {
    const { status } = await run({ token: 'saved-token', me: () => { throw fail(403); } });
    expect(status).not.toBe('authed');
    expect(destinationFor(status)).toBe('/welcome');
  });
  test('the server cannot be reached, or answers with an error -> Getting Started', async () => {
    for (const error of [fail(500), fail(503), Object.assign(new Error('Network request failed'), { code: 'network' })]) {
      const { status } = await run({ token: 'saved-token', me: () => { throw error; } });
      expect(status).toBe('unreachable');
      expect(destinationFor(status)).toBe('/welcome');
    }
  });
  test('the server takes too long (the session-check timeout) -> Getting Started', async () => {
    const { status } = await run({ token: 'saved-token', me: () => new Promise(() => {}), meTimeoutMs: 40 });
    expect(status).toBe('unreachable');
    expect(destinationFor(status)).toBe('/welcome');
  });
  test('the saved session cannot be read (secure storage fails, or never answers) -> Getting Started', async () => {
    const failing = await run({ token: () => { throw new Error('Keychain is locked'); }, me: {} });
    expect(failing.status).toBe('error');
    expect(destinationFor(failing.status)).toBe('/welcome');
    const hanging = await run({ token: () => new Promise(() => {}), me: {}, tokenTimeoutMs: 40 });
    expect(hanging.status).toBe('error');
    expect(destinationFor(hanging.status)).toBe('/welcome');
  });
  test('only the accepted session is ever "authed": every other outcome is something else', async () => {
    const outcomes = await Promise.all([
      run({ token: null, me: {} }), run({ token: 't', me: () => { throw fail(401); } }), run({ token: 't', me: () => { throw fail(500); } }), run({ token: () => { throw new Error('x'); }, me: {} }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['anon', 'anon', 'unreachable', 'error']);
    expect(outcomes.filter((o) => destinationFor(o.status) === '/home')).toEqual([]);
  });
});

describe('the screen', () => {
  const screen = code('app/index.js');
  test('a tap does nothing: the splash is not a Pressable and has no onPress, so nothing can bypass the authentication check', () => {
    expect(screen).not.toContain('Pressable');
    expect(screen).not.toContain('onPress');
    expect(screen).not.toContain('onTouch');
    expect(screen).not.toMatch(/navReplace\('\/welcome'\)/); // the old tap-to-skip
    expect(screen).toContain('<View className="flex-1" style={{ backgroundColor: BG_COLOR }}>');
  });
  test('it navigates in one place only, from the resolved state, and only once', () => {
    expect((screen.match(/navReplace\(/g) || []).length).toBe(1);
    expect(screen).toContain('splashDecision({ status: authStatus, minElapsed, timedOut, navigated: navigated.current })');
    expect(screen).toContain('navigated.current = true;');
    expect(screen).toContain('navReplace(route);');
    expect(screen).toContain('const navigated = useRef(false);');
  });
  test('it reads the authentication state the app already keeps (the server-checked one), not the saved token', () => {
    expect(screen).toContain('const { t, authStatus } = useApp();');
    expect(screen).not.toContain('getAccessToken');
    expect(screen).not.toContain("from '../lib/session'");
  });
  test('the clocks are cleared when the splash goes away (no timer left running, no navigation after it is gone)', () => {
    expect(screen).toContain('return () => { clearTimeout(minimum); clearTimeout(limit); };');
  });
  test('the branding is as it was: the logo, the globe picture, the tagline and the sweeping line', () => {
    expect(screen).toContain("import { LOGO, SPLASH_BG } from '../data/images';");
    expect(screen).toContain("t('splash_tagline')");
    expect(screen).toContain('LOGO_RED');
    expect(screen).toContain('sweepOnce');
  });
  test('the sign-in gate still treats the splash as public, so it is never covered', () => {
    expect(read('lib/authGuard.js')).toContain("'/', // the splash, which decides where to go next");
  });
});

describe('the native splash is untouched', () => {
  test('no splash plugin, image or dependency was added (the app has none configured)', () => {
    const appJson = JSON.parse(read('../app.json'));
    expect(JSON.stringify(appJson)).not.toMatch(/splash/i);
    const pkg = JSON.parse(read('../package.json'));
    expect(JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies })).not.toMatch(/splash/i);
  });
});
