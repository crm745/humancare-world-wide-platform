/* global describe, test, expect, jest, beforeEach, afterEach, __dirname */
// The 30-minute idle session timeout, with a fake clock: the limit, activity, the background, work that must not be cut off, one expiry only, and where it is wired.
const fs = require('fs');
const path = require('path');
const { createIdleSession, holdIdle, isIdleHeld, resetIdleHoldsForTests, IDLE_LIMIT_MS, CHECK_EVERY_MS } = require('../idleSession');

const MIN = 60 * 1000;
const SRC = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\r\n').join('\n');

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 10, 21, 9, 0, 0)); resetIdleHoldsForTests(); });
afterEach(() => { jest.useRealTimers(); });

function rig(extra = {}) {
  const onExpire = jest.fn();
  const monitor = createIdleSession({ onExpire, ...extra });
  return { monitor, onExpire };
}

describe('the numbers', () => {
  test('30 minutes, checked every 15 seconds', () => {
    expect(IDLE_LIMIT_MS).toBe(30 * MIN);
    expect(CHECK_EVERY_MS).toBe(15 * 1000);
  });
});

describe('the idle limit', () => {
  test('nothing happens before 30 minutes', () => {
    const { monitor, onExpire } = rig();
    monitor.start();
    jest.advanceTimersByTime(29 * MIN + 45 * 1000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(monitor.isRunning()).toBe(true);
  });
  test('the session ends within one check (15 s) after 30 minutes without activity, once', () => {
    const { monitor, onExpire } = rig();
    monitor.start();
    jest.advanceTimersByTime(30 * MIN + 15 * 1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(monitor.isRunning()).toBe(false);
    jest.advanceTimersByTime(60 * MIN);
    expect(onExpire).toHaveBeenCalledTimes(1); // it never fires twice
  });
  test('exactly 30 minutes counts as idle; one second less does not', () => {
    const a = rig(); a.monitor.start();
    jest.setSystemTime(Date.now() + 30 * MIN - 1000);
    expect(a.monitor.check()).toBe(false);
    jest.setSystemTime(Date.now() + 1000);
    expect(a.monitor.check()).toBe(true);
  });
  test('every touch starts the 30 minutes again', () => {
    const { monitor, onExpire } = rig();
    monitor.start();
    for (let i = 0; i < 6; i += 1) { jest.advanceTimersByTime(25 * MIN); monitor.touch(); }
    expect(onExpire).not.toHaveBeenCalled(); // 150 minutes in total, never 30 without a touch
    jest.advanceTimersByTime(30 * MIN + 15 * 1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
  test('a touch while stopped (signed out) is ignored, and starting again begins a fresh 30 minutes', () => {
    const { monitor, onExpire } = rig();
    monitor.touch();
    expect(monitor.expiresAt()).toBeNull();
    monitor.start();
    jest.advanceTimersByTime(20 * MIN);
    monitor.stop();
    monitor.start();
    jest.advanceTimersByTime(20 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
  });
  test('expiresAt tells when the session would end', () => {
    const { monitor } = rig();
    monitor.start();
    expect(monitor.expiresAt()).toBe(Date.now() + 30 * MIN);
    jest.advanceTimersByTime(10 * MIN);
    monitor.touch();
    expect(monitor.expiresAt()).toBe(Date.now() + 30 * MIN);
  });
});

describe('the background', () => {
  test('the time spent away counts: coming back after 31 minutes ends the session at once', () => {
    const { monitor, onExpire } = rig();
    monitor.start();
    // the phone was locked: no timer ran, only the clock moved on
    jest.setSystemTime(Date.now() + 31 * MIN);
    expect(monitor.resume()).toBe(true);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
  test('coming back after 10 minutes does not; and it does not count as a touch', () => {
    const { monitor, onExpire } = rig();
    monitor.start();
    jest.setSystemTime(Date.now() + 10 * MIN);
    expect(monitor.resume()).toBe(false);
    jest.setSystemTime(Date.now() + 20 * MIN + 1000);
    expect(monitor.resume()).toBe(true); // 30 minutes since the last touch, resuming twice did not reset anything
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
  test('resume when stopped does nothing', () => {
    const { monitor, onExpire } = rig();
    expect(monitor.resume()).toBe(false);
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe('work that must not be cut off', () => {
  test('a running upload / download holds the timeout for as long as it lasts; the 30 minutes start after it ends', () => {
    const { monitor, onExpire } = rig({ isBusy: isIdleHeld });
    monitor.start();
    const release = holdIdle();
    jest.advanceTimersByTime(90 * MIN); // a very long transfer, no touches
    expect(onExpire).not.toHaveBeenCalled();
    release();
    jest.advanceTimersByTime(29 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2 * MIN);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
  test('holds count and release once: two transfers, one released twice, still held until both are done', () => {
    const a = holdIdle();
    const b = holdIdle();
    expect(isIdleHeld()).toBe(true);
    a(); a();
    expect(isIdleHeld()).toBe(true);
    b();
    expect(isIdleHeld()).toBe(false);
  });
  test('a submission waiting for its answer (isBusy) holds it too, and a busy check that throws does not hold it forever', () => {
    let waiting = true;
    const { monitor, onExpire } = rig({ isBusy: () => waiting });
    monitor.start();
    jest.advanceTimersByTime(45 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
    waiting = false;
    jest.advanceTimersByTime(31 * MIN);
    expect(onExpire).toHaveBeenCalledTimes(1);
    const broken = rig({ isBusy: () => { throw new Error('boom'); } });
    broken.monitor.start();
    jest.advanceTimersByTime(31 * MIN);
    expect(broken.onExpire).toHaveBeenCalledTimes(1);
  });
});

describe('the handler', () => {
  test('setOnExpire replaces what happens at the end; a handler that throws does not break the timer', () => {
    const first = jest.fn();
    const second = jest.fn(() => { throw new Error('sign-out failed'); });
    const monitor = createIdleSession({ onExpire: first });
    monitor.setOnExpire(second);
    monitor.start();
    expect(() => jest.advanceTimersByTime(31 * MIN)).not.toThrow();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(monitor.isRunning()).toBe(false);
  });
  test('no handler at all is fine', () => {
    const monitor = createIdleSession();
    monitor.start();
    expect(() => jest.advanceTimersByTime(31 * MIN)).not.toThrow();
  });
});

describe('where it is wired', () => {
  test('the root layout mounts it once and passes its touch props to the root View', () => {
    const layout = read('app/_layout.js');
    expect(layout).toContain("import { useIdleSession } from '../components/IdleSessionGuard';");
    expect(layout).toContain('const idle = useIdleSession();');
    expect(layout).toContain('{...idle.viewProps}');
  });
  test('the guard watches only while signed in, counts touches, typing and the web mouse, and ends the session like Log out (without removing the draft)', () => {
    const guard = read('components/IdleSessionGuard.js');
    expect(guard).toContain("const signedIn = authStatus === 'authed';");
    expect(guard).toContain('monitor.start();');
    expect(guard).toContain('onTouchStartCapture: () => monitor.touch()');
    expect(guard).toContain('useKeyboardOpen()');
    expect(guard).toContain('subscribeAppActive(() => monitor.resume())');
    expect(guard).toContain('subscribeWebActivity(() => monitor.touch())');
    expect(guard).toContain("toast(t('idle_signed_out'))");
    expect(guard).toContain('signOutSession({ isCorporate })');
    expect(guard).not.toContain('beforeClear'); // the encrypted draft is kept
    expect(guard).toContain('submissionTracker.isAwaitingAnswer()');
  });
  test('uploads and downloads hold the timeout for as long as they run (and release it however they end)', () => {
    const api = read('lib/api.js');
    expect(api).toContain("import { holdIdle } from './idleSession';");
    expect(api).toContain('const release = holdIdle();\n  try { return await uploadOnce(path, file, isRetry, onProgress, fields, options); } finally { release(); }');
    expect(api).toContain('const release = holdIdle();\n  try { return await downloadOnce(path, options); } finally { release(); }');
    expect(api).toContain('export async function apiUpload(');
    expect(api).toContain('export async function apiDownload(');
  });
  test('the explanation exists in all six languages', () => {
    const I18N = require('../../data/i18n.json');
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) expect(I18N[lang].idle_signed_out).toContain('30');
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) expect(I18N[lang].idle_signed_out).not.toBe(I18N.EN.idle_signed_out);
  });
});
