/* global describe, test, expect, afterEach, __dirname */
const fs = require('fs');
const path = require('path');
const { formatDate, formatDayMonth, formatTime, setDateLocale, getDateLocale } = require('../dateFormat');
const { formatDisplayDate } = require('../requestShape');

afterEach(() => setDateLocale('en-GB'));

const ISO = '2026-10-05T08:30:00.000Z';
const local = new Date(ISO); // the phone's own time zone, as before

describe('English output is what it always was', () => {
  test('the default locale is en-GB and the date reads "05 Oct 2026"', () => {
    expect(getDateLocale()).toBe('en-GB');
    expect(formatDate(ISO)).toBe('05 Oct 2026');
    expect(formatDisplayDate(ISO)).toBe('05 Oct 2026');
  });
  test('identical to the old toLocaleDateString / toLocaleTimeString calls', () => {
    const oldDate = local.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const oldTime = local.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(formatDate(ISO)).toBe(oldDate);
    expect(formatTime(ISO)).toBe(oldTime);
    expect(formatDayMonth(ISO)).toBe(oldDate.replace(/ \d{4}$/, ''));
  });
  test('time is 24-hour', () => {
    expect(formatTime(new Date(2026, 0, 2, 14, 5))).toBe('14:05');
    expect(formatTime(new Date(2026, 0, 2, 0, 7))).toBe('00:07');
  });
});

describe('the selected locale is used', () => {
  test('an explicit locale', () => {
    const date = new Date(2026, 9, 5, 14, 5);
    expect(formatDate(date, 'hi-IN')).toBe(new Intl.DateTimeFormat('hi-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date));
    expect(formatDate(date, 'hi-IN')).not.toBe(formatDate(date, 'en-GB'));
    expect(formatDate(date, 'ar')).not.toBe(formatDate(date, 'en-GB'));
  });
  test('the app\'s locale when none is passed, and back again', () => {
    const date = new Date(2026, 9, 5, 14, 5);
    setDateLocale('mr-IN');
    expect(getDateLocale()).toBe('mr-IN');
    expect(formatDate(date)).toBe(formatDate(date, 'mr-IN'));
    expect(formatDisplayDate(date)).toBe(formatDate(date, 'mr-IN'));
    setDateLocale('en-GB');
    expect(formatDate(date)).toBe('05 Oct 2026');
  });
  test('time stays 24-hour in every language', () => {
    const date = new Date(2026, 0, 2, 14, 5);
    for (const locale of ['en-GB', 'hi-IN', 'mr-IN', 'gu-IN', 'te-IN', 'ar']) {
      const out = formatTime(date, locale);
      expect(out).not.toMatch(/am|pm|AM|PM|ص|م$/);
      expect(out.length).toBeGreaterThanOrEqual(4);
    }
  });
  test('setDateLocale ignores a bad value', () => {
    setDateLocale('hi-IN');
    for (const bad of [undefined, null, '', 5, {}]) setDateLocale(bad);
    expect(getDateLocale()).toBe('hi-IN');
  });
});

describe('invalid values and locales', () => {
  test('a missing or invalid date is empty text, never "Invalid Date" or a throw', () => {
    for (const bad of [undefined, null, '', 'garbage', 'not-a-date', NaN, {}]) {
      expect(formatDate(bad)).toBe('');
      expect(formatDayMonth(bad)).toBe('');
      expect(formatTime(bad)).toBe('');
    }
  });
  test('a locale the runtime rejects falls back to English instead of throwing', () => {
    expect(formatDate(ISO, 'not a locale!!')).toBe('05 Oct 2026');
    expect(formatDate(ISO, 'zz-ZZ-invalid-tag-')).toBe(formatDate(ISO, 'en-GB'));
  });
});

describe('time zone behaviour is unchanged', () => {
  test('the day shown is the phone\'s local day, for a moment near midnight UTC', () => {
    const justBeforeMidnightUtc = '2026-03-10T23:59:00.000Z';
    const d = new Date(justBeforeMidnightUtc);
    const expectedDay = String(d.getDate()).padStart(2, '0');
    expect(formatDate(justBeforeMidnightUtc).slice(0, 2)).toBe(expectedDay);
    expect(formatDayMonth(justBeforeMidnightUtc).slice(0, 2)).toBe(expectedDay);
    expect(formatTime(justBeforeMidnightUtc)).toBe(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  });
  test('no timeZone option is ever set', () => {
    expect(fs.readFileSync(path.join(__dirname, '../dateFormat.js'), 'utf8')).not.toMatch(/timeZone[:=]/);
  });
});

describe('the old hard-coded en-GB is gone from the two helpers', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  test('requestShape and requestTracking use the shared helper', () => {
    expect(read('../requestShape.js')).not.toContain("'en-GB'");
    expect(read('../requestTracking.js')).not.toContain("'en-GB'");
    expect(read('../requestTracking.js')).toContain("import { formatDayMonth, formatTime } from './dateFormat';");
  });
});
