/* global describe, test, expect, __dirname */
// The six fictional alerts (lib/alertsPreview.js) are kept as data with their own tests, but the Notifications screen no longer
// uses them: it always loads the real notifications. The screen's wiring is covered here and in notificationsScreen.test.js.
const fs = require('fs');
const path = require('path');
const { ALERTS_PREVIEW_ITEMS: ITEMS, groupAlerts, markAlertRead, markAllAlertsRead, unreadAlertCount } = require('../alertsPreview');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const screen = read('../../app/notifications.js');
const i18n = JSON.parse(read('../../data/i18n.json'));

describe('the six fictional alerts', () => {
  test('exactly the approved six, with their texts, times, categories and unread flags', () => {
    expect(ITEMS.map((a) => [a.title, a.time, a.category, a.unread, a.group])).toEqual([
      ['Air Ambulance, handover at 02:40', '21:28', 'flight', true, 'today'],
      ['Quote ready to approve', '19:55', 'quote', true, 'today'],
      ['New message from Dr. Rahman', '19:34', 'message', false, 'today'],
      ['Bed confirmed', '19:02', 'hospital', false, 'today'],
      ['Battery of documents expires soon', '16:10', 'documents', false, 'yesterday'],
      ['Request closed', '11:20', 'request', false, 'yesterday'],
    ]);
    expect(ITEMS.find((a) => a.id === 'p1').body).toBe('Case HC-2026-4821 left Dubai at 21:28. Patient handover confirmed.');
    expect(ITEMS.find((a) => a.id === 'p6').body).toBe('Hospital admission HC-2026-4402 completed. Discharge summary attached.');
  });
  test('Today / Yesterday grouping: four and two, in order', () => {
    const groups = groupAlerts(ITEMS);
    expect(groups.map((g) => [g.group, g.items.length])).toEqual([['today', 4], ['yesterday', 2]]);
    expect(groups[0].items.map((a) => a.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });
  test('a group with no alerts is left out', () => {
    expect(groupAlerts(ITEMS.filter((a) => a.group === 'today')).map((g) => g.group)).toEqual(['today']);
    expect(groupAlerts([])).toEqual([]);
  });
  test('two start unread; tapping one reads only it, and reading is idempotent', () => {
    expect(unreadAlertCount(ITEMS)).toBe(2);
    const once = markAlertRead(ITEMS, 'p1');
    expect(unreadAlertCount(once)).toBe(1);
    expect(once.find((a) => a.id === 'p2').unread).toBe(true);
    expect(markAlertRead(once, 'p1')).toEqual(once);
    expect(markAlertRead(ITEMS, 'missing')).toEqual(ITEMS);
  });
  test('Mark Read clears every unread dot, and the source list is never changed', () => {
    expect(unreadAlertCount(markAllAlertsRead(ITEMS))).toBe(0);
    expect(unreadAlertCount(ITEMS)).toBe(2);
  });
  test('they are plainly fictional UI data: no real records, no ids that look like API ids', () => {
    expect(ITEMS.every((a) => typeof a.id === 'string' && a.id.startsWith('p'))).toBe(true);
  });
});

describe('the screen', () => {
  test('the development preview is gone from the screen: it always loads the real notifications', () => {
    expect(screen).not.toContain('ALERTS_PREVIEW');
    expect(screen).not.toContain('alertsPreview');
    expect(screen).not.toContain('ALERTS_PREVIEW_ITEMS');
    expect(screen).not.toContain('__DEV__');
  });
  test('the real list is loaded through the API client, and nothing is shown as done before the server says so', () => {
    expect(screen).toContain("apiGet('/notifications')");
    expect(screen).toContain("from '../lib/notificationsApi'");
    expect(screen).toContain("{ notifications }) => notifications");
  });
  test('the existing API-based behaviour is unchanged', () => {
    expect(screen).toContain('No notifications yet.');
    expect(screen).toContain("{loading && gate.visible && <RowsSkeleton label={t('sk_loading_notifications')} count={5} lines={2} />}");
    expect(screen).toContain('{error && !data && <LoadFailure onRetry={reload} />}');
    expect(screen).toContain('${read ? \'opacity-55\' : \'\'}');
    expect(screen).toContain('timeAgo(n.createdAt)');
    expect(screen).toContain("<TopBar title={t('notifications_title')} />");
    expect(screen).toContain("<Button title={t('btn_return_home')} onPress={goBack} />");
    expect(screen).toContain('useSkeletonGate(loading)');
  });
  test('it is still the one existing screen, with the shared Screen, TopBar, Body and Card', () => {
    expect(screen).toContain("import { Body, Screen, TopBar } from '../components/layout'");
    expect(screen).toContain("import { Button, Card, Spacer, Text } from '../components/ui'");
    expect(fs.existsSync(path.join(__dirname, '../../app/alerts.js'))).toBe(false);
  });
  test('official brand blue, an unread dot and the approved icons for every kind', () => {
    expect(screen).toContain("from '../lib/tracking/palette'");
    expect(screen).toContain('backgroundColor: P.brand'); // the unread dot
    for (const kind of ['stage_update', 'quotation_ready', 'document', 'system', 'security_password_changed', 'security_new_login', 'payment_received', 'payment_failed', 'payment_refunded']) {
      expect(screen).toMatch(new RegExp('\\b' + kind + ': \\{ bg:'));
    }
    expect(screen).toContain('KIND[n.kind] || KIND.system'); // an unknown kind still falls back
  });
  test('the Home bell\'s real unread count is not touched by the preview any more', () => {
    expect(read('../../components/home/HomeHeader.js')).not.toMatch(/alertsPreview|ALERTS_PREVIEW/);
    expect(read('../../app/home.js')).not.toMatch(/alertsPreview|ALERTS_PREVIEW/);
    expect(read('../../app/home.js')).toContain("apiGet('/notifications?unreadOnly=true')");
  });
});

describe('Today / Yesterday in every language', () => {
  test('both labels exist in all six languages, with English as the default', () => {
    expect(Object.keys(i18n)).toHaveLength(6);
    for (const lang of Object.keys(i18n)) {
      expect(i18n[lang].alerts_today).toBeTruthy();
      expect(i18n[lang].alerts_yesterday).toBeTruthy();
    }
    expect([i18n.EN.alerts_today, i18n.EN.alerts_yesterday]).toEqual(['Today', 'Yesterday']);
    expect(i18n.HI.alerts_today).not.toBe('Today');
  });
});
