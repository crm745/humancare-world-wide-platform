/* global describe, test, expect, __dirname */
const fs = require('fs');
const path = require('path');
const { trackingPosition, trackingView, routeProgress, cityName, TRACKING_STEPS } = require('../requestTracking');

const req = (status, events = []) => ({ status, createdAt: '2026-11-03T04:42:00.000Z', case: events.length ? { stageEvents: events } : null });

describe('trackingPosition', () => {
  test('each status is its own step', () => {
    expect(['submitted', 'scheduled', 'payment', 'in_progress', 'completed'].map((s) => trackingPosition(req(s)).index)).toEqual([0, 1, 2, 3, 4]);
  });
  test('an unknown status falls back to the first step', () => {
    expect(trackingPosition(req('whatever'))).toEqual({ index: 0, cancelled: false });
  });
  test('a cancelled request stops at the furthest step it reached', () => {
    const events = [{ stage: 'submitted', occurredAt: '2026-11-03T05:00:00Z' }, { stage: 'scheduled', occurredAt: '2026-11-03T09:00:00Z' }];
    expect(trackingPosition(req('cancelled', events))).toEqual({ index: 1, cancelled: true });
  });
  test('a cancelled request with no history stops at the first step', () => {
    expect(trackingPosition(req('cancelled'))).toEqual({ index: 0, cancelled: true });
  });
});

describe('trackingView', () => {
  test('past steps are done, the current one is now, the rest are todo', () => {
    const v = trackingView(req('payment'));
    expect(v.steps.map((s) => s.state)).toEqual(['done', 'done', 'now', 'todo', 'todo']);
    expect(v.segments).toEqual(['done', 'done', 'now', 'todo', 'todo']);
    expect(v.chip).toBe('trk_chip_quote');
  });
  test('completed marks every step done', () => {
    expect(trackingView(req('completed')).steps.map((s) => s.state)).toEqual(Array(5).fill('done'));
  });
  test('cancelled shows the stop in red and the cancelled chip', () => {
    const v = trackingView(req('cancelled', [{ stage: 'scheduled', occurredAt: '2026-11-03T09:00:00Z' }]));
    expect(v.steps.map((s) => s.state)).toEqual(['done', 'bad', 'todo', 'todo', 'todo']);
    expect(v.chip).toBe('trk_chip_cancelled');
  });
  test('a step with no event has no time, except the first, which uses the request date', () => {
    const v = trackingView(req('scheduled'));
    expect(v.steps[0].time).not.toBe('');
    expect(v.steps[1].time).toBe('');
    expect(v.steps[2].time).toBe('');
  });
  test('the time of a step comes from its latest stage event', () => {
    const v = trackingView(req('scheduled', [{ stage: 'scheduled', occurredAt: '2026-11-03T09:00:00Z' }]));
    expect(v.steps[1].time).not.toBe('');
  });
});

describe('routeProgress / cityName', () => {
  test('0 at the first step, 1 at the last, halfway when cancelled', () => {
    expect(routeProgress(trackingView(req('submitted')))).toBe(0);
    expect(routeProgress(trackingView(req('completed')))).toBe(1);
    expect(routeProgress(trackingView(req('cancelled')))).toBe(0.5);
  });
  test('cityName keeps the city part', () => {
    expect(cityName('Mumbai, Maharashtra, India')).toBe('Mumbai');
    expect(cityName(null)).toBe('');
  });
});

describe('screen wiring', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  const i18n = JSON.parse(read('../../data/i18n.json'));
  test('every text the page uses exists in English', () => {
    for (const s of TRACKING_STEPS) for (const k of [s.title, s.sub, s.chip]) expect(i18n.EN[k]).toBeTruthy();
    for (const k of ['trk_title', 'trk_load_failed', 'trk_cancelled_sub', 'trk_chip_cancelled', 'timeline_pending']) expect(i18n.EN[k]).toBeTruthy();
  });
  test('Track request on Home opens this page, and only that button', () => {
    const home = read('../../app/home.js');
    expect(home).toMatch(/onTrack=\{\(\) => router\.push\(\{ pathname: '\/request-tracking'/);
  });
});
