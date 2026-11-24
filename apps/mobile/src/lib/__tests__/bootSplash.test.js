/* global describe, test, expect, jest, __dirname */
// The reload screen: the browser draws the splash's own picture at once (public/index.html) and the app shows the same picture while its fonts load (BootScreen), so a reload is never an empty
// white page. Source checks only.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

describe('the page the browser loads', () => {
  const html = read('public', 'index.html');
  test('keeps what Expo needs from its template (placeholders, the root element) and adds the boot splash as an overlay OUTSIDE the root', () => {
    expect(html).toContain('lang="%LANG_ISO_CODE%"');
    expect(html).toContain('<title>%WEB_TITLE%</title>');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toMatch(/<div id="root"><\/div>\s*<div id="boot"/); // React never replaces it: the app removes it
    expect(html).toMatch(/#boot \{ position: fixed;[^}]*z-index: 2147483000/);
    expect(html).toContain('#boot.hide { opacity: 0; pointer-events: none; }');
    expect(html).toContain('id="expo-reset"');
  });
  test('draws the splash colour and picture before any JavaScript: the globe, the logo and the sweeping line', () => {
    expect(html).toContain('#EEF6FD');
    expect(html).toContain('/boot/splash-globe.jpg');
    expect(html).toContain('/boot/logo-full.png');
    expect(html).toContain('@keyframes boot-sweep');
    expect(html).toMatch(/#B41C2D/); // the line's red and blue, as in the app's splash
    expect(html).toContain('#303A8F');
  });
  test('its two pictures are exact copies of the app\'s own splash files', () => {
    for (const [copy, original] of [['public/boot/splash-globe.jpg', 'assets/images/splash-globe.jpg'], ['public/boot/logo-full.png', 'assets/images/logo-full.png']]) {
      expect({ copy, same: fs.readFileSync(path.join(root, copy)).equals(fs.readFileSync(path.join(root, original))) }).toEqual({ copy, same: true });
    }
  });
  test('the tagline only holds the logo\'s place (hidden): the app\'s language is not known yet', () => {
    expect(html).toMatch(/\.tag \{[^}]*visibility: hidden/);
  });
});

describe('the app while its fonts load', () => {
  const layout = read('src', 'app', '_layout.js');
  test('shows the boot picture, never an empty page', () => {
    expect(layout).toContain('if (!fontsLoaded) return <BootScreen />');
    expect(layout).not.toMatch(/if \(!fontsLoaded\) return null/);
  });
  test('BootScreen uses the splash\'s own picture and colour, has no text and is hidden from screen readers', () => {
    const boot = read('src', 'components', 'BootScreen.js');
    expect(boot).toContain('SPLASH_BG');
    expect(boot).toContain('LOGO');
    expect(boot).toContain("'#EEF6FD'");
    expect(boot).not.toMatch(/<Text|t\('/);
    expect(boot).toContain('importantForAccessibility="no-hide-descendants"');
  });
});

describe('the browser boot picture stays until the app\'s own first screen is on screen (no emptier frame in between)', () => {
  const boot = require('../bootSplash');
  const layout = read('src', 'app', '_layout.js');
  const splash = read('src', 'app', 'index.js');
  test('hideBootSplash fades the overlay and removes it; calling it again does nothing; without a page it is harmless', () => {
    expect(boot.hideBootSplash()).toBe(false); // no document in the test environment
    const classes = new Set();
    const removed = [];
    const element = { classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) }, parentNode: { removeChild: (el) => removed.push(el) } };
    global.document = { getElementById: (id) => (id === 'boot' ? element : null) };
    jest.useFakeTimers();
    expect(boot.hideBootSplash()).toBe(true);
    expect(classes.has('hide')).toBe(true);
    expect(boot.hideBootSplash()).toBe(false); // already going
    expect(removed).toHaveLength(0);
    jest.advanceTimersByTime(boot.BOOT_FADE_MS + 60);
    expect(removed).toEqual([element]);
    jest.useRealTimers();
    delete global.document;
  });
  test('the splash removes it only when BOTH its pictures have loaded (or failed, so it is never stuck)', () => {
    expect(splash).toContain("import { hideBootSplash } from '../lib/bootSplash';");
    expect(splash).toContain('useEffect(() => { if (loaded.bg && loaded.logo) hideBootSplash(); }, [loaded]);');
    expect(splash).toContain("onLoad={() => setLoaded((s) => ({ ...s, bg: true }))} onError={() => setLoaded((s) => ({ ...s, bg: true }))}");
    expect(splash).toContain("onLoad={() => setLoaded((s) => ({ ...s, logo: true }))} onError={() => setLoaded((s) => ({ ...s, logo: true }))}");
  });
  test('any other first screen (a reload on Login, Home ...) removes it at once, and a safety timer removes it whatever happens', () => {
    expect(read('src', 'components', 'BootSplashHider.js')).toContain("useEffect(() => { if (pathname !== '/') hideBootSplash(); }, [pathname]);");
    expect(layout).toContain('<BootSplashHider />');
    expect(layout).toContain('useEffect(() => { const timer = setTimeout(hideBootSplash, BOOT_MAX_MS); return () => clearTimeout(timer); }, []);');
    expect(boot.BOOT_MAX_MS).toBeLessThanOrEqual(5000);
    // the safety timer is in RootLayout (always mounted), so it also covers the Google sign-in window, which has no splash
    expect(layout.indexOf('setTimeout(hideBootSplash, BOOT_MAX_MS)')).toBeGreaterThan(layout.indexOf('export default function RootLayout'));
  });
});
