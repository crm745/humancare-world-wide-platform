/* global describe, test, expect, beforeEach, afterEach, jest, __dirname */
// How the network messages APPEAR: when the banner is shown (delays, "Back online"), what each change animates (enter, exit, swap, none), the Reduce Motion path, and that the components wire it.
// The animation itself runs in react-native-reanimated on the UI thread (checked in the web build); everything decided in JS is pure and tested here with fake timers.
const fs = require('fs');
const path = require('path');
const {
  createBannerPresenter, OUTAGE_DELAY_MS, SLOW_DELAY_MS, RESTORED_VISIBLE_MS, problemKindOf,
} = require('../bannerPresenter');
const {
  BANNER_ENTER_MS, BANNER_EXIT_MS, BANNER_SWAP_MS, BANNER_SLIDE_PX, COLLAPSE_MS, BUTTON_FADE_MS, REDUCED_FADE_MS, EASE_OUT, EASE_IN,
  planBannerTransition, bannerTimings, collapseTimings, buttonFadeMs, bannerHeightFor, rememberBannerHeight, DEFAULT_BANNER_HEIGHT,
} = require('../bannerMotion');

const SRC = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\r\n').join('\n');

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const rig = () => {
  const presenter = createBannerPresenter();
  const log = [];
  presenter.subscribe(() => log.push(presenter.get()));
  return { presenter, log };
};

describe('no flicker on short drops', () => {
  test('a drop shorter than 1 s shows nothing, and no "Back online" afterwards', () => {
    const { presenter, log } = rig();
    presenter.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS - 1);
    expect(presenter.get()).toBeNull();
    presenter.observe('online');
    jest.advanceTimersByTime(10000);
    expect(log).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('"No internet" shows once the problem has lasted 1 s', () => {
    const { presenter, log } = rig();
    presenter.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS);
    expect(presenter.get()).toBe('offline');
    expect(log).toEqual(['offline']);
  });
  test('"Servers unreachable" also waits 1 s; "Slow connection" waits about 3 s', () => {
    const a = rig();
    a.presenter.observe('serverDown');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS - 1);
    expect(a.presenter.get()).toBeNull();
    jest.advanceTimersByTime(1);
    expect(a.presenter.get()).toBe('serverDown');
    const b = rig();
    b.presenter.observe('slow');
    jest.advanceTimersByTime(SLOW_DELAY_MS - 1);
    expect(b.presenter.get()).toBeNull();
    jest.advanceTimersByTime(1);
    expect(b.presenter.get()).toBe('slow');
    expect(OUTAGE_DELAY_MS).toBe(1000);
    expect(SLOW_DELAY_MS).toBe(3000);
  });
  test('a slow blip (under 3 s) shows nothing', () => {
    const { presenter, log } = rig();
    presenter.observe('slow');
    jest.advanceTimersByTime(2999);
    presenter.observe('online');
    jest.advanceTimersByTime(10000);
    expect(log).toEqual([]);
  });
  test('the same problem reported again does not restart its timer', () => {
    const { presenter } = rig();
    presenter.observe('offline');
    jest.advanceTimersByTime(600);
    presenter.observe('offline');
    jest.advanceTimersByTime(400);
    expect(presenter.get()).toBe('offline');
  });
  test('an unknown state at app start, and online, show nothing', () => {
    const { presenter, log } = rig();
    presenter.observe('unknown');
    presenter.observe('online');
    jest.advanceTimersByTime(10000);
    expect(log).toEqual([]);
    expect(problemKindOf('unknown')).toBeNull();
    expect(problemKindOf('online')).toBeNull();
  });
});

describe('"Back online"', () => {
  test('appears only after a problem banner was really visible, stays 2.5 s, then closes', () => {
    const { presenter, log } = rig();
    presenter.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS);
    presenter.observe('online');
    expect(presenter.get()).toBe('restored');
    jest.advanceTimersByTime(RESTORED_VISIBLE_MS - 1);
    expect(presenter.get()).toBe('restored');
    jest.advanceTimersByTime(1);
    expect(presenter.get()).toBeNull();
    expect(log).toEqual(['offline', 'restored', null]);
    expect(RESTORED_VISIBLE_MS).toBe(2500);
  });
  test('also after a visible slow banner', () => {
    const { presenter } = rig();
    presenter.observe('slow');
    jest.advanceTimersByTime(SLOW_DELAY_MS);
    presenter.observe('online');
    expect(presenter.get()).toBe('restored');
  });
  test('a problem that returns during "Back online" replaces it at once and cancels its closing', () => {
    const { presenter, log } = rig();
    presenter.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS);
    presenter.observe('online');
    jest.advanceTimersByTime(1000);
    presenter.observe('offline');
    expect(presenter.get()).toBe('offline');
    jest.advanceTimersByTime(10000);
    expect(presenter.get()).toBe('offline');
    expect(log).toEqual(['offline', 'restored', 'offline']);
  });
  test('a restoration with nothing visible before it stays silent', () => {
    const { presenter, log } = rig();
    presenter.observe('serverDown');
    jest.advanceTimersByTime(300);
    presenter.observe('online');
    expect(log).toEqual([]);
  });
});

describe('a state change while the banner is visible', () => {
  test('changes in place at once (no waiting, never closed in between)', () => {
    const { presenter, log } = rig();
    presenter.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS);
    presenter.observe('serverDown');
    expect(presenter.get()).toBe('serverDown');
    presenter.observe('slow');
    expect(presenter.get()).toBe('slow');
    presenter.observe('online');
    expect(log).toEqual(['offline', 'serverDown', 'slow', 'restored']);
    expect(log).not.toContain(null);
  });
  test('the display plans for that sequence are enter, swap, swap, swap, exit: never exit followed by enter', () => {
    const { presenter, log } = rig();
    presenter.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS);
    presenter.observe('serverDown');
    presenter.observe('online');
    jest.advanceTimersByTime(RESTORED_VISIBLE_MS);
    const shown = [null, ...log];
    const plans = shown.slice(1).map((next, i) => planBannerTransition(shown[i], next));
    expect(plans).toEqual(['enter', 'swap', 'swap', 'exit']);
  });
  test('a swap cross-fades over 200 ms in place with no slide and no ease-in', () => {
    const t = bannerTimings('swap', false);
    expect(t).toMatchObject({ fadeMs: BANNER_SWAP_MS, heightMs: BANNER_SWAP_MS, slidePx: 0 });
    expect(BANNER_SWAP_MS).toBe(200);
    expect(t.easing).toEqual(EASE_OUT);
  });
});

describe('enter and exit motion', () => {
  test('enter: 220 ms ease-out cubic-bezier(0.2, 0, 0, 1), content slides down 8 px; exit: 180 ms ease-in cubic-bezier(0.4, 0, 1, 1)', () => {
    expect(bannerTimings('enter', false)).toEqual({ fadeMs: 220, heightMs: 220, slidePx: 8, easing: [0.2, 0, 0, 1] });
    expect(bannerTimings('exit', false)).toEqual({ fadeMs: 180, heightMs: 180, slidePx: 8, easing: [0.4, 0, 1, 1] });
    expect([BANNER_ENTER_MS, BANNER_EXIT_MS, BANNER_SLIDE_PX]).toEqual([220, 180, 8]);
    expect(EASE_OUT).toEqual([0.2, 0, 0, 1]);
    expect(EASE_IN).toEqual([0.4, 0, 1, 1]);
  });
  test('the helper lines take 180 ms and a button\'s fade 150 ms', () => {
    expect(collapseTimings(false)).toEqual({ fadeMs: 180, heightMs: 180 });
    expect(buttonFadeMs(false)).toBe(150);
    expect([COLLAPSE_MS, BUTTON_FADE_MS]).toEqual([180, 150]);
  });
});

describe('no pop-in on every new page', () => {
  test('a screen that opens while the phone is already offline draws the banner in place: "settle", with no animation at all', () => {
    expect(planBannerTransition(null, 'offline', { mounted: false })).toBe('settle');
    expect(planBannerTransition(null, 'restored', { mounted: false })).toBe('settle');
    expect(bannerTimings('settle', false)).toEqual({ fadeMs: 0, heightMs: 0, slidePx: 0 });
    expect(bannerTimings('settle', true)).toEqual({ fadeMs: 0, heightMs: 0, slidePx: 0 });
    expect(planBannerTransition(null, null, { mounted: false })).toBe('none');
  });
  test('the banner is one app-wide fact: what a screen that mounts later reads is what is already showing', () => {
    const { presenter } = rig();
    presenter.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS);
    const readByNewScreen = presenter.get(); // a screen opening now
    expect(readByNewScreen).toBe('offline');
    expect(planBannerTransition(undefined, readByNewScreen, { mounted: false })).toBe('settle');
    jest.advanceTimersByTime(60000);
    expect(presenter.get()).toBe('offline'); // moving between screens changes nothing
  });
  test('an unchanged state animates nothing; only a change does', () => {
    expect(planBannerTransition('offline', 'offline')).toBe('none');
    expect(planBannerTransition(null, 'offline')).toBe('enter');
    expect(planBannerTransition('offline', null)).toBe('exit');
    expect(planBannerTransition('offline', 'restored')).toBe('swap');
  });
  test('the height a banner had last time is remembered, so a new screen draws it at full height at once', () => {
    expect(bannerHeightFor('serverDown-never-seen')).toBe(DEFAULT_BANNER_HEIGHT);
    rememberBannerHeight('offline', 57);
    rememberBannerHeight('restored', 41);
    expect(bannerHeightFor('offline')).toBe(57);
    expect(bannerHeightFor('restored')).toBe(41);
    rememberBannerHeight('offline', NaN);
    expect(bannerHeightFor('offline')).toBe(57);
  });
  test('the component starts "settled" with the cached height, and the driver is mounted once', () => {
    const banner = read('components/network/ConnectionBanner.js');
    expect(banner).toContain("plan: 'settle'");
    expect(banner).toContain('useSharedValue(kind ? bannerHeightFor(kind) : 0)');
    expect(banner).toContain('useSyncExternalStore(bannerPresenter.subscribe, bannerPresenter.get, bannerPresenter.get)');
    expect((read('app/_layout.js').match(/<BannerDriver \/>/g) || []).length).toBe(1);
    expect(read('components/network/BannerDriver.js')).toContain('bannerPresenter.observe(status)');
  });
});

describe('Reduce Motion', () => {
  test('no sliding and no height animation: only a fade of at most 100 ms', () => {
    for (const plan of ['enter', 'exit', 'swap']) {
      const t = bannerTimings(plan, true);
      expect(t.slidePx).toBe(0);
      expect(t.heightMs).toBe(0);
      expect(t.fadeMs).toBeLessThanOrEqual(100);
      expect(t.fadeMs).toBe(REDUCED_FADE_MS);
    }
    expect(collapseTimings(true)).toEqual({ fadeMs: 100, heightMs: 0 });
    expect(buttonFadeMs(true)).toBe(0);
  });
  test('the components read the system setting from reanimated', () => {
    for (const file of ['components/network/ConnectionBanner.js', 'components/network/Collapse.js', 'components/AnimatedPressBox.js']) {
      expect({ file, ok: /useReducedMotion\(\)/.test(read(file)) }).toEqual({ file, ok: true });
    }
  });
});

describe('the other offline UI moves the same way (wiring)', () => {
  test('everything animates with reanimated on the UI thread; no setState on a frame', () => {
    for (const file of ['components/network/ConnectionBanner.js', 'components/network/Collapse.js', 'components/AnimatedPressBox.js']) {
      const code = read(file);
      expect({ file, reanimated: /from 'react-native-reanimated'/.test(code), coreAnimated: /Animated\.(Value|timing)\(/.test(code), onFrame: /useFrameCallback|requestAnimationFrame/.test(code) }).toEqual({ file, reanimated: true, coreAnimated: false, onFrame: false });
    }
  });
  test('the helper lines expand and fade (Collapse): the request form line and the Google line', () => {
    expect(read('components/request/RequestFrame.js')).toContain('<Collapse show={!!(needsNetwork && isOffline)}>');
    expect(read('app/login.js')).toContain('<Collapse show={!!offline}>');
    const collapse = read('components/network/Collapse.js');
    expect(collapse).toContain('collapseTimings(reduceMotion)');
    expect(collapse).toContain('if (show !== v.seen)'); // animates when `show` CHANGES, not when the screen opens
  });
  test('buttons fade between pale and on (150 ms) instead of switching', () => {
    expect(read('components/ui.js')).toContain('<AnimatedPressBox');
    expect(read('components/ui.js')).toContain('faded={!!faded}');
    const box = read('components/AnimatedPressBox.js');
    expect(box).toContain('buttonFadeMs(reduceMotion)');
    expect(box).toContain('withTiming(target');
    expect(read('app/login.js')).toContain('<AnimatedPressBox');
  });
  test('notice cards appear with the existing Reveal (fade + 6 px rise); load-failure and Can\'t Connect states cross-fade in', () => {
    expect(read('components/network/StatusNotice.js')).toContain('<Reveal animate>');
    expect(read('components/LoadFailure.js')).toContain('<Reveal animate>');
    expect(read('app/cant-connect.js')).toContain('<Reveal animate');
    const reveal = read('components/skeleton/Reveal.js');
    expect(reveal).toContain('REVEAL_RISE = 6');
  });
  test('web: it uses style animations (opacity, height, transform), which reanimated supports on the web build, not a layout animation', () => {
    for (const file of ['components/network/ConnectionBanner.js', 'components/network/Collapse.js']) {
      expect({ file, layoutAnimation: /entering=|exiting=|layout=\{|LayoutAnimation/.test(read(file)) }).toEqual({ file, layoutAnimation: false });
    }
  });
});
