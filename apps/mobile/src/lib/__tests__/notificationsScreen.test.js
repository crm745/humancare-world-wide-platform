/* global describe, test, expect, __dirname */
// How the Notifications screen, Home, the push tap handler and the layout are wired to the notification API and link mapping.
// The mobile jest setup tests pure logic only (no renderer), so these read the source, like the other screen tests here.
const fs = require('fs');
const path = require('path');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const screen = read('../../app/notifications.js');
const handler = read('../../components/NotificationTapHandler.js');
const layout = read('../../app/_layout.js');
const home = read('../../app/home.js');
const i18n = JSON.parse(read('../../data/i18n.json'));

describe('the list', () => {
  test('rows are pressable, mark the notification read and open its link; a notification with no link is only marked read', () => {
    expect(screen).toContain('<Card key={n.id} onPress={() => open(n)}');
    expect(screen).toContain('if (!n.readAt) readOne(n.id);');
    expect(screen).toContain('const target = targetFromNotification(n);');
    expect(screen).toContain('if (target) router.push(target);');
  });

  test('read, read-all and delete go through the API and only update the screen after the server accepted them', () => {
    expect(screen).toContain('markNotificationRead(id)');
    expect(screen).toContain('markAllNotificationsRead');
    expect(screen).toContain('deleteNotification(n.id)');
    // the change is applied after `await call()` succeeded; a failure returns before it, with a toast
    const perform = screen.slice(screen.indexOf('const perform = useCallback'), screen.indexOf('const readOne'));
    expect(perform.indexOf('await call();')).toBeGreaterThan(-1);
    expect(perform.indexOf('toast(t(\'notif_action_failed\'))')).toBeGreaterThan(perform.indexOf('await call();'));
    expect(perform.indexOf('return false;')).toBeLessThan(perform.indexOf('const next = change('));
    expect(perform).toContain('if (inFlight.current.has(key)) return false;'); // a repeat tap while one is running is ignored
    expect(perform).toContain("setCached('notifications'"); // the cached list takes the change too
    expect(perform).toContain('reload();'); // and the list is quietly re-read
  });

  test('mark all read is offered only when something is unread, and a delete button is on every row', () => {
    expect(screen).toContain('{hasUnread(items) ? (');
    expect(screen).toContain("t('notif_mark_all_read')");
    expect(screen).toContain("accessibilityLabel={t('notif_delete')}");
    expect(screen).toContain('onPress={() => confirmRemove(n)}');
  });

  test('a delete is confirmed first: Cancel makes no request, Delete runs the existing delete', () => {
    // the button asks, it never deletes directly
    expect(screen).not.toContain('onPress={() => remove(n)}');
    const confirm = screen.slice(screen.indexOf('const confirmRemove'), screen.indexOf('// A tap opens what the notification is about'));
    expect(confirm).toContain("t('notif_delete_title')");
    expect(confirm).toContain("t('notif_delete_message')");
    // exactly one place calls remove(n): the Delete action (and the browser's confirm on the web)
    expect(confirm.match(/remove\(n\)/g)).toHaveLength(2);
    expect(confirm).toContain("{ text: t('notif_cancel'), style: 'cancel' },"); // Cancel has no onPress: nothing runs
    expect(confirm).toContain("{ text: t('notif_delete_confirm'), style: 'destructive', onPress: () => remove(n) },");
    expect(confirm).toContain('if (typeof globalThis.confirm === \'function\' && globalThis.confirm(`${title}\\n${message}`)) remove(n);');
    // the request and the on-screen change still happen only inside perform, after the server accepted it
    expect(screen).toContain('const remove = (n) => perform(`delete:${n.id}`, () => deleteNotification(n.id), (e) => withDeleted(e, n.id));');
    expect(screen.match(/deleteNotification\(/g)).toHaveLength(1);
  });

  test('the existing skeleton, pull-to-refresh, failure and fade-in behaviour is kept', () => {
    expect(screen).toContain('<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />');
    expect(screen).toContain("onRefreshError: () => toast(t('sk_refresh_failed')),");
    expect(screen).toContain('<Reveal animate={gate.wasShown}');
    expect(screen).not.toContain('<Spinner');
  });

  test('the two preference switches use the saved values and move only after the server saved them', () => {
    expect(screen).toContain('fetchPreferences()');
    expect(screen).toContain("t('notif_pref_in_app')");
    expect(screen).toContain("t('notif_pref_push')");
    expect(screen).toContain("value={prefs.inAppEnabled}");
    expect(screen).toContain("value={prefs.pushEnabled}");
    const change = screen.slice(screen.indexOf('const changePref'), screen.indexOf('return (\n    <Screen>'));
    expect(change).toContain('setPrefs(await updatePreferences({ [key]: value }));'); // set from the server's answer, not optimistically
    expect(change).toContain("toast(t('notif_action_failed'))");
    expect(change).toContain('if (!prefs || savingPref) return;');
  });

  test('it is patient-only: no corporate code is imported', () => {
    expect(screen).not.toMatch(/corporate/i);
  });
});

describe('push tap handling', () => {
  test('uses the same link mapping as the list, listens for taps, handles a cold start and cleans up', () => {
    expect(handler).toContain("import { targetFromPushResponse } from '../lib/notificationLink'");
    expect(handler).toContain('Notifications.addNotificationResponseReceivedListener(handle)');
    expect(handler).toContain('handle(Notifications.getLastNotificationResponse())');
    expect(handler).toContain('Notifications.clearLastNotificationResponse()');
    expect(handler).toContain('if (subscription) subscription.remove();');
    expect(handler).toContain('Notifications.DEFAULT_ACTION_IDENTIFIER');
  });

  test('acts only for a signed-in patient past the splash, and clears an unused tap when signed out or corporate', () => {
    expect(handler).toContain("authStatus === 'authed' && !isCorporate && pastSplash");
    expect(handler).toContain("authStatus === 'anon' || (authStatus === 'authed' && isCorporate)");
    expect(handler).toContain("const pastSplash = pathname !== '/';");
  });

  test('never imports expo-notifications in Expo Go or on the web (same rule as the registration helper)', () => {
    expect(handler).toContain("if (Platform.OS === 'web' || isExpoGo) return undefined;");
    expect(handler).toContain("await import('expo-notifications')");
    expect(handler).not.toMatch(/^import .*expo-notifications/m);
  });

  test('is mounted once, in the app shell', () => {
    expect(layout).toContain("import { NotificationTapHandler } from '../components/NotificationTapHandler';");
    expect(layout.match(/<NotificationTapHandler \/>/g)).toHaveLength(1);
  });
});

describe('Home and registration are as before', () => {
  test('the bell still comes from the unread-only list; Home re-reads it when it regains focus (not on the first focus)', () => {
    expect(home).toContain("apiGet('/notifications?unreadOnly=true')");
    expect(home).toContain('hasUnread: unread.status === \'fulfilled\' && unread.value.notifications.length > 0');
    expect(home).toContain('useFocusEffect(useCallback(() => {');
    expect(home).toContain('if (firstFocus.current) { firstFocus.current = false; return; }');
  });

  // Device registration now lives in lib/deviceRegistry.js (see deviceRegistry.test.js); the legacy call is kept and the
  // Notifications screen and the tap handler stay free of it.
  test('the legacy push-token call is kept; the screen and the tap handler know nothing about devices', () => {
    const reg = read('../pushNotifications.js');
    expect(reg).toContain("apiPost('/auth/push-token', { pushToken })");
    for (const source of [screen, handler]) expect(source).not.toMatch(/unregister|NotificationDevice|deviceId|\/devices/i);
  });
});

describe('strings', () => {
  const KEYS = ['notif_pref_in_app', 'notif_pref_push', 'notif_mark_all_read', 'notif_delete', 'notif_action_failed',
    'notif_delete_title', 'notif_delete_message', 'notif_cancel', 'notif_delete_confirm'];
  test('every new string exists in all six languages', () => {
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) for (const key of KEYS) expect(typeof i18n[lang][key]).toBe('string');
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) for (const key of KEYS) expect(i18n[lang][key].length).toBeGreaterThan(2);
  });
});
