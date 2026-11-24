/* global describe, test, expect, __dirname */
// One status is one colour on all four screens: Home's Active Requests card, My Requests, Request Details and the Tracking banner. They all read the shared mapping
// (lib/myRequestsView.js STATUS_BADGE); there is no second colour table. Mock requests with dummy values only.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { translate } = require('../translate');
const { toListItem } = require('../requestShape');
const { STATUS_BADGE, BADGE_OTHER, badgeFor, cardView } = require('../myRequestsView');
const { activeCardView } = require('../activeRequests');
const { statusBadge } = require('../requestDetailsView');
const { statusColorOf } = require('../trackingBanner');
const { buildTrackingDetails } = require('../trackingDetailsView');

const t = (key, values) => translate(I18N, 'EN', key, values);
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const req = (status) => ({ id: 7, referenceNumber: 'REQ-1067', serviceType: 'Ground Ambulance', serviceKey: 'ground', status, origin: 'Pune, India', destination: 'Mumbai, India', createdAt: '2026-11-20T09:00:00.000Z', case: null });

describe('the shared mapping', () => {
  test('submitted soft blue, in progress amber, completed green, cancelled grey; anything else grey', () => {
    expect(STATUS_BADGE.submitted).toEqual({ bg: '#EAEBF4', fg: '#303A8F' });
    expect(STATUS_BADGE.progress).toEqual({ bg: '#FDF0DA', fg: '#8F4C08' });
    expect(STATUS_BADGE.completed).toEqual({ bg: '#E0F5F4', fg: '#0B6564' });
    expect(STATUS_BADGE.cancelled).toEqual({ bg: '#EEF1F6', fg: '#5B6B84' });
    for (const status of ['', undefined, null, 'on_hold', 'scheduled']) expect(badgeFor(status)).toEqual(BADGE_OTHER);
    expect(BADGE_OTHER).toEqual({ bg: '#EEF1F6', fg: '#5B6B84' });
  });
});

describe.each(['submitted', 'in_progress', 'completed', 'cancelled'])('%s looks the same on all four screens', (status) => {
  const ui = status === 'in_progress' ? 'progress' : status;
  const shared = STATUS_BADGE[ui];
  const item = toListItem(req(status));
  test('Home card, My Requests card, Request Details badge and the Tracking banner colour', () => {
    expect(cardView(item, t).badge).toEqual(shared); // My Requests
    if (ui === 'submitted' || ui === 'progress') expect(activeCardView(item, t).badge).toEqual(shared); // Home (and My Requests' active card): only active requests have the Home card
    const details = statusBadge(req(status), t); // Request Details
    expect({ bg: details.bg, fg: details.fg }).toEqual(shared);
    expect(statusColorOf(status)).toBe(shared.fg); // Tracking banner status text
    expect(buildTrackingDetails(req(status), t).badge).toMatchObject(shared); // what the tracking screens receive
  });
  test('the words are unchanged: the same label on every screen', () => {
    const words = cardView(item, t).statusLabel;
    expect(statusBadge(req(status), t).label).toBe(words);
    expect(buildTrackingDetails(req(status), t).badge.label).toBe(words);
  });
});

describe('an unknown status is neutral grey everywhere', () => {
  test('on My Requests, Request Details and the Tracking banner', () => {
    const item = toListItem(req('on_hold'));
    expect(cardView(item, t).badge).toEqual(BADGE_OTHER);
    expect(statusBadge(req('on_hold'), t)).toMatchObject(BADGE_OTHER);
    expect(statusColorOf('on_hold')).toBe(BADGE_OTHER.fg);
    expect(statusBadge(req('on_hold'), t).label).toBe('on_hold'); // shown as it is, as before
  });
});

describe('there is no second colour table', () => {
  test('the screens\' libraries do not define the status colours themselves', () => {
    for (const file of ['trackingBanner.js', 'activeRequests.js']) expect({ file, own: /#FDF0DA|#8F4C08|#E0F5F4|#0B6564/.test(read(file)) }).toEqual({ file, own: false });
    // Request Details keeps only its urgency chip colour (not a status); its old status table is gone.
    expect(read('requestDetailsView.js')).not.toMatch(/const BADGE\b|submitted: \['#|in_progress: \[COLORS/);
    expect(read('requestDetailsView.js')).toContain('badgeFor(toUiStatus(status))');
    expect(read('trackingBanner.js')).toContain('badgeFor(toUiStatus(status)).fg');
    expect(read('trackingBanner.js')).not.toMatch(/export const STATUS_COLOR/);
  });
});
