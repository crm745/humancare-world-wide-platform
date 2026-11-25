/* global describe, test, expect, __dirname, jest */
// Responsiveness, phase 1: the navigation guard, the Home banner's timer, the press components and the saved-draft sheet's immediate feedback.
const fs = require('fs');
const path = require('path');
const { GUARD_MS, createNavGuard, guardRouter, targetKey } = require('../navGuard');

const SRC = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8').split('\r\n').join('\n');

const clock = () => { let t = 1000; return { now: () => t, tick: (ms) => { t += ms; } }; };
const fakeRouter = () => ({
  push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn(), dismiss: jest.fn(), dismissTo: jest.fn(), dismissAll: jest.fn(), canGoBack: jest.fn(() => true),
});

describe('the navigation guard rules', () => {
  test('the same navigation twice within the window is stopped once, and allowed again after it', () => {
    const c = clock();
    const guard = createNavGuard({ now: c.now });
    expect(guard.allow('push:/a')).toBe(true);
    c.tick(GUARD_MS - 1);
    expect(guard.allow('push:/a')).toBe(false);
    c.tick(GUARD_MS);
    expect(guard.allow('push:/a')).toBe(true);
  });
  test('a different route is never stopped, and a multi-step sequence goes through', () => {
    const guard = createNavGuard({ now: clock().now });
    for (const key of ['push:/request/step1', 'push:/request/step2', 'push:/request/review']) expect(guard.allow(key)).toBe(true);
  });
  test('the same route with different parameters is a different navigation', () => {
    expect(targetKey({ pathname: '/request-details', params: { id: 12 } })).not.toBe(targetKey({ pathname: '/request-details', params: { id: 13 } }));
    expect(targetKey({ pathname: '/p', params: { b: 2, a: 1 } })).toBe(targetKey({ pathname: '/p', params: { a: 1, b: 2 } }));
    expect(targetKey('/home')).toBe('/home');
  });
  test('reset forgets the last navigation', () => {
    const guard = createNavGuard({ now: clock().now });
    guard.allow('push:/a');
    guard.reset();
    expect(guard.allow('push:/a')).toBe(true);
  });
});

describe('guardRouter on the router', () => {
  test('a repeated push is ignored, every other call goes through with its arguments', () => {
    const router = fakeRouter();
    const originalPush = router.push;
    guardRouter(router, createNavGuard({ now: clock().now }));
    router.push('/service/air');
    router.push('/service/air');
    expect(originalPush).toHaveBeenCalledTimes(1);
    router.push({ pathname: '/request-details', params: { id: 1 } });
    router.push({ pathname: '/request-details', params: { id: 2 } });
    expect(originalPush).toHaveBeenCalledTimes(3);
    expect(originalPush).toHaveBeenLastCalledWith({ pathname: '/request-details', params: { id: 2 } });
  });
  test('push and replace of the same path are different navigations', () => {
    const router = fakeRouter();
    const { replace } = router;
    const { push } = router;
    guardRouter(router, createNavGuard({ now: clock().now }));
    router.push('/home');
    router.replace('/home');
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });
  test('going back is never blocked, and it lets the same screen be opened again at once', () => {
    const router = fakeRouter();
    const { push, back } = router;
    guardRouter(router, createNavGuard({ now: clock().now }));
    router.push('/x');
    router.back();
    router.back();
    router.push('/x');
    expect(back).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledTimes(2);
    for (const method of ['dismiss', 'dismissTo', 'dismissAll']) { const fn = router[method]; router[method]('/y'); expect(fn).toBeDefined(); }
  });
  test('it is applied once, and methods that are not navigation are left alone', () => {
    const router = fakeRouter();
    const { canGoBack } = router;
    guardRouter(router, createNavGuard({ now: clock().now }));
    const wrapped = router.push;
    guardRouter(router, createNavGuard({ now: clock().now }));
    expect(router.push).toBe(wrapped);
    expect(router.canGoBack).toBe(canGoBack);
  });
  test('a router that cannot be changed is left as it is', () => {
    const frozen = Object.freeze({ push: () => 'pushed' });
    expect(() => guardRouter(frozen)).not.toThrow();
    expect(frozen.push()).toBe('pushed');
    expect(guardRouter(null)).toBeNull();
  });
});

describe('the guard is wired once, without touching the screens', () => {
  test('the root layout installs it first; nav.js guards the tab replace on its own', () => {
    expect(read('app/_layout.js')).toContain("import '../lib/navGuardInstall';");
    expect(read('lib/navGuardInstall.js')).toContain('guardRouter(router);');
    const nav = read('lib/nav.js');
    expect(nav).toContain('if (!replaceGuard.allow(targetKey(path))) return;');
    expect(nav).toContain('export function goBack()'); // going back is untouched
    expect(nav.slice(nav.indexOf('export function goBack()'))).not.toMatch(/Guard/);
  });
  test('the intentional multi-step push of a resumed draft is three different routes', () => {
    const service = read('app/service/[key].js');
    expect(service).toContain("router.push('/request/step1');");
    expect(service).toContain("router.push('/request/step2');");
    expect(service).toContain("router.push('/request/review');");
  });
});

describe('the Home banner does not move under a finger', () => {
  const banner = read('components/home/BannerCarousel.js');
  test('a touch is kept in refs, not state, and the timer reads it when it fires', () => {
    expect(banner).not.toMatch(/useState\(false\);\s*\n\s*const \[reduceMotion/);
    expect(banner).not.toContain('const [touching, setTouching]');
    expect(banner).toContain('const touchingRef = useRef(false);');
    expect(banner).toContain('if (touchingRef.current || Date.now() - lastTouchAt.current < TOUCH_PAUSE_MS) return;');
    expect(banner).toContain('}, [reduceMotion, goTo, navigation]);'); // a touch no longer restarts the timer
    expect(banner).toContain('if (!navigation.isFocused()) return;'); // Home stays mounted behind the other tabs: the banner sleeps there
  });
  test('every way a finger can land or leave is still reported', () => {
    for (const handler of ['onScrollBeginDrag', 'onScrollEndDrag', 'onTouchStart', 'onTouchEnd', 'onTouchCancel']) expect(banner).toContain(`${handler}={() => setTouching(`);
    expect(banner).toContain('const TOUCH_PAUSE_MS = 2000;');
    expect(banner).toContain('const ADVANCE_MS = 3500;'); // the pace is unchanged
  });
});

describe('a press sets no React state it does not need', () => {
  test('PressBox tracks pressed only for a function style', () => {
    const box = read('components/PressBox.js');
    expect(box).toContain("const needsPressed = typeof style === 'function';");
    expect(box).toContain('if (needsPressed) setPressed(true);');
    expect(box).toContain('if (needsPressed) setPressed(false);');
    expect(box).toContain("typeof style === 'function' ? style({ pressed }) : style"); // a function style still gets `pressed`
  });
  test('AnimatedPressBox writes the pressed dim to its shared value, with no state', () => {
    const box = read('components/AnimatedPressBox.js');
    expect(box).not.toContain('useState');
    expect(box).not.toContain('setPressed');
    expect(box).toContain('const pressedRef = useRef(false);');
    expect(box).toContain('onPressIn={(e) => { press(true); if (onPressIn) onPressIn(e); }}');
    expect(box).toContain('onPressOut={(e) => { press(false); if (onPressOut) onPressOut(e); }}');
    expect(box).toContain('export const FADED_OPACITY = 0.45;');
    expect(box).toContain('export const PRESSED_OPACITY = 0.85;');
  });
});

describe('the saved-draft sheet answers the tap at once', () => {
  const sheet = read('components/home/DraftSheet.js');
  const service = read('app/service/[key].js');
  test('the tapped button shows its spinner, the other is switched off, and the three handlers are the same', () => {
    expect(sheet).toContain("loading={busy === 'resume'}");
    expect(sheet).toContain("busy === 'new' ? <Spinner");
    expect(sheet).toContain('disabled={!!busy}');
    for (const handler of ['onResume', 'onStartNew', 'onCancel']) expect(sheet).toContain(`onPress={${handler}}`);
  });
  test('a second tap while the choice runs does nothing, and the busy state is always cleared', () => {
    expect(service).toContain('if (busyRef.current) return;');
    expect(service).toMatch(/try \{ await work\(\); \} finally \{ busyRef\.current = false; setBusy\(null\); \}/);
  });
  test('the data steps and their order are as before: read the draft, then open the form; discard, then reset, then a new request', () => {
    expect(service).toMatch(/const opened = await resumeDraft\(\);\s+setAsking\(false\);\s+if \(!opened\) \{ toast\(t\('draft_unusable'\)\); return; \}/);
    expect(service).toMatch(/await discardDraft\(\);\s+resetDraft\(key\);/);
  });
  test('the Home card already shows its spinner at once (busy is set before the draft is read)', () => {
    const notice = read('components/home/DraftNotice.js');
    expect(notice).toMatch(/if \(busy\) return;\s+setBusy\(true\);\s+try \{\s+const opened = await resumeDraft\(\);/);
  });
});
