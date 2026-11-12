/* global describe, test, expect, __dirname */
// The Tracking screen follows the app's design system: official colours, shared components, Inter only.
const fs = require('fs');
const path = require('path');
const { TRACKING_PALETTE: P, toneFor } = require('../tracking/palette');
const { trackingView } = require('../requestTracking');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const screen = read('../../app/request-tracking.js');
const req = (status, events = []) => ({ status, createdAt: '2026-11-03T04:42:00.000Z', case: events.length ? { stageEvents: events } : null });

describe('palette', () => {
  test('the official logo blue and secondary navy', () => {
    expect(P.brand).toBe('#303A8F');
    expect(P.navy).toBe('#2F2A62');
  });
  test('the neutral and state colours are the app\'s own (cancel red, success green, line, text)', () => {
    const tailwind = read('../../../tailwind.config.js');
    expect(tailwind).toContain(`'${P.cancelled}'`);
    expect(tailwind).toContain(`'${P.done}'`);
    expect(tailwind).toContain(`'${P.line}'`);
    expect(tailwind).toContain(`'${P.faint}'`);
    expect(tailwind).toContain(`'${P.muted}'`);
    expect(tailwind).toContain(`'${P.heading}'`);
  });
  test('toneFor: brand blue in progress, green when completed, the muted red when cancelled', () => {
    expect(toneFor(trackingView(req('payment'))).solid).toBe('#303A8F');
    expect(toneFor(trackingView(req('submitted'))).solid).toBe('#303A8F');
    expect(toneFor(trackingView(req('completed'))).solid).toBe(P.done);
    expect(toneFor(trackingView(req('cancelled'))).solid).toBe(P.cancelled);
    // the route card is blue, so each tone also has a light version for it
    expect(toneFor(trackingView(req('payment'))).onDark).toBe(P.brandOnDark);
    expect(toneFor(trackingView(req('completed'))).onDark).toBe(P.doneOnDark);
    expect(toneFor(trackingView(req('cancelled'))).onDark).toBe(P.cancelledOnDark);
  });
});

describe('the Tracking screen', () => {
  test('uses the shared TopBar, Body and Card', () => {
    expect(screen).toContain("import { Body, Screen, TopBar } from '../components/layout'");
    expect(screen).toContain("import { Card, Text } from '../components/ui'");
    expect(screen).toContain('<TopBar title={t(\'trk_title\')} />');
    expect(screen).toContain('<Body contentClassName="px-[18px] py-6">');
  });
  test('no gradient hero, no monospace font, no oversized halo', () => {
    expect(screen).not.toMatch(/LinearGradient|expo-linear-gradient/);
    expect(screen).not.toMatch(/Menlo|monospace|fontFamily/);
    expect(screen).not.toMatch(new RegExp('opacity: 0.16|width: 40, height: 40'));
  });
  test('the route is an arc over a faint grid, with the aircraft in the middle and the cities under their markers', () => {
    expect(screen).toContain("from 'react-native-svg'");
    expect(screen).toContain('strokeDasharray="2 5"'); // the dotted route
    expect(screen).toContain('const mid = quad(p0, c, p2, 0.5)'); // the aircraft sits in the middle, always
    expect(screen.match(new RegExp('cityName[(]', 'g')).length).toBeGreaterThanOrEqual(2);
    expect(screen).toContain('fill="#FFFFFF" />'); // the aircraft is white, clear on the blue
    expect(screen).toContain('backgroundColor: P.brand, borderColor: P.brand'); // the route card is the brand blue, not white
  });
  test('the route and the timeline are each in a Card, and the colours come from the palette', () => {
    expect(screen.match(/<Card /g)).toHaveLength(2);
    expect(screen).toContain("from '../lib/tracking/palette'");
    expect(screen).not.toMatch(/#2F3A8E|#1A73E8|#A9B3F0/);
    const hexes = [...new Set(screen.match(new RegExp('#[0-9A-Fa-f]{6}', 'g')) || [])];
    expect(hexes).toEqual(['#FFFFFF']); // every other colour comes from the palette; only white is inline
  });
  test('the type sizes are Request Details\' (20 heading, 12.5 reference and body, 14.5 titles, 11.5 chip)', () => {
    for (const size of ['text-[20px]', 'text-[12.5px]', 'text-[14.5px]', 'text-[11.5px]']) expect(screen).toContain(size);
    expect(screen).not.toMatch(/fontSize: (28|17|13)\b/);
  });
  test('timeline indicators are 26 px', () => {
    expect(screen).toContain('h-[26px] w-[26px]');
  });
  test('the tracking logic and the API call are unchanged', () => {
    expect(screen).toContain('apiGet(`/requests/me/${id}`)');
    expect(screen).toContain("trackingView(request)");
    expect(screen).toContain("routeProgress(view)");
    const logic = read('../requestTracking.js');
    expect(logic).toContain("{ key: 'submitted', title: 'trk_received'");
    expect(logic).toContain("{ key: 'payment', title: 'trk_quote'");
  });
  test('no share, no invented operational information', () => {
    // comments may say what is not shown, so only code is checked
    const code = screen.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//') && !l.includes('{/*')).join(String.fromCharCode(10));
    expect(code).not.toMatch(new RegExp('Share|ETA|coordinator|aircraft|distance'));
  });
});
