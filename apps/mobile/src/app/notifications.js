import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Bell, CircleCheck, CircleX, Clock, FileText, KeyRound, Loader, ShieldCheck, Trash, Undo2 } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { goBack } from '../lib/nav';
import { targetFromNotification } from '../lib/notificationLink';
import { deleteNotification, fetchPreferences, markAllNotificationsRead, markNotificationRead, updatePreferences } from '../lib/notificationsApi';
import { applyEdits, EMPTY_EDITS, hasUnread, unreadIds, withDeleted, withRead } from '../lib/notificationsView';
import { setCached } from '../lib/screenCache';
import { TRACKING_PALETTE as P } from '../lib/tracking/palette';
import { Body, Screen, TopBar } from '../components/layout';
import { Button, Card, Spacer, Text } from '../components/ui';
import { SwitchRow } from '../components/request/fields';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { LoadFailure } from '../components/LoadFailure';
import { CachedNote } from '../components/network/CachedNote';
import { HighlightFill } from '../components/skeleton/HighlightFill';
import { Reveal } from '../components/skeleton/Reveal';
import { useSkeletonGate } from '../components/skeleton/hooks';
import { RowsSkeleton } from '../components/skeleton/screens';
import { useResource } from '../lib/useResource';
import { COLORS } from '../theme/colors';

// One icon and colour per kind. A kind this list does not know (an older or a newer one) shows as `system`.
const KIND = {
  stage_update: { bg: 'bg-primary-soft', color: COLORS.primary, Icon: Loader },
  quotation_ready: { bg: 'bg-warning-soft', color: '#B4740D', Icon: Clock },
  document: { bg: 'bg-success-soft', color: '#1E8E4A', Icon: FileText },
  system: { bg: 'bg-cancel-soft', color: '#C23B3B', Icon: Bell },
  security_password_changed: { bg: 'bg-primary-soft', color: COLORS.primary, Icon: KeyRound },
  security_new_login: { bg: 'bg-primary-soft', color: COLORS.primary, Icon: ShieldCheck },
  payment_received: { bg: 'bg-success-soft', color: '#1E8E4A', Icon: CircleCheck },
  payment_failed: { bg: 'bg-cancel-soft', color: '#C23B3B', Icon: CircleX },
  payment_refunded: { bg: 'bg-warning-soft', color: '#B4740D', Icon: Undo2 },
};

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(1, Math.round(diffMs / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function Notifications() {
  const { t, toast } = useApp();

  // Loaded the way every data screen loads (lib/useResource.js): a shimmer skeleton on the first load only, quiet
  // refresh of what an earlier visit loaded, "Try again" if the first load fails, and pull-to-refresh with the list staying on screen.
  const { data, loading, error, reload, onRefresh, refreshing, highlight } = useResource({
    key: 'notifications',
    fetcher: () => apiGet('/notifications').then(({ notifications }) => notifications),
    idsOf: (list) => list.map((n) => n.id),
    onRefreshError: () => toast(t('sk_refresh_failed')),
  });
  const gate = useSkeletonGate(loading);

  // What the patient changed and the server confirmed (a read, a delete). Nothing is shown as done before the server says so.
  const [edits, setEdits] = useState(EMPTY_EDITS);
  const editsRef = useRef(edits);
  const dataRef = useRef(data);
  useEffect(() => { editsRef.current = edits; dataRef.current = data; });
  const inFlight = useRef(new Set());
  const items = data ? applyEdits(data, edits) : [];

  // Runs one write. A repeat tap while it is running is ignored. On failure nothing changes on screen and the patient is told.
  // On success the screen and the cached list take the change, and the list is quietly re-read so it matches the server.
  const perform = useCallback(async (key, call, change) => {
    if (inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    try {
      await call();
    } catch {
      toast(t('notif_action_failed'));
      return false;
    } finally {
      inFlight.current.delete(key);
    }
    const next = change(editsRef.current);
    editsRef.current = next;
    setEdits(next);
    if (dataRef.current) setCached('notifications', applyEdits(dataRef.current, next));
    reload();
    return true;
  }, [reload, t, toast]);

  const readOne = (id) => perform(`read:${id}`, () => markNotificationRead(id), (e) => withRead(e, [id], new Date().toISOString()));
  const readAll = () => {
    const ids = unreadIds(items);
    if (ids.length) perform('read-all', markAllNotificationsRead, (e) => withRead(e, ids, new Date().toISOString()));
  };
  const remove = (n) => perform(`delete:${n.id}`, () => deleteNotification(n.id), (e) => withDeleted(e, n.id));

  // A delete cannot be undone from the app, so it is confirmed first. Cancel (or dismissing the dialog) makes no request; Delete runs
  // `remove` above, which only takes the notification off the screen after the server has accepted the delete.
  // (React Native's Alert.alert does nothing in the browser preview, so the web uses the browser's own confirm.)
  const confirmRemove = (n) => {
    const title = t('notif_delete_title');
    const message = t('notif_delete_message');
    if (Platform.OS === 'web') {
      if (typeof globalThis.confirm === 'function' && globalThis.confirm(`${title}\n${message}`)) remove(n);
      return;
    }
    Alert.alert(title, message, [
      { text: t('notif_cancel'), style: 'cancel' },
      { text: t('notif_delete_confirm'), style: 'destructive', onPress: () => remove(n) },
    ]);
  };

  // A tap opens what the notification is about (the same mapping a push tap uses) and marks it read in the background.
  // A notification with no usable link (an older one) is only marked read: nothing is navigated to.
  const open = (n) => {
    if (!n.readAt) readOne(n.id);
    const target = targetFromNotification(n);
    if (target) router.push(target);
  };

  // The two switches. Shown once the saved values are known; a switch only moves after the server has saved it.
  const [prefs, setPrefs] = useState(null);
  const [savingPref, setSavingPref] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchPreferences().then((saved) => { if (alive) setPrefs(saved); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const changePref = async (key, value) => {
    if (!prefs || savingPref) return;
    setSavingPref(true);
    try {
      setPrefs(await updatePreferences({ [key]: value }));
      reload(); // what the list shows depends on the in-app switch
    } catch {
      toast(t('notif_action_failed'));
    } finally {
      setSavingPref(false);
    }
  };

  return (
    <Screen>
      <TopBar title={t('notifications_title')} />
      <Body contentClassName="gap-2.5 px-[18px] py-4" noScrollWhenFits={!!error && !data} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {loading && gate.visible && <RowsSkeleton label={t('sk_loading_notifications')} count={5} lines={2} />}
        {error && !data && <LoadFailure titleKey="lf_title_notifications" error={error} onRetry={reload} />}
        {data ? <Reveal animate={gate.wasShown} style={{ gap: 10 }}>
        {prefs ? (
          <Card className={`py-1 ${savingPref ? 'opacity-60' : ''}`}>
            <SwitchRow label={t('notif_pref_in_app')} value={prefs.inAppEnabled} onChange={(v) => changePref('inAppEnabled', v)} />
            <SwitchRow label={t('notif_pref_push')} value={prefs.pushEnabled} onChange={(v) => changePref('pushEnabled', v)} last />
          </Card>
        ) : null}
        {hasUnread(items) ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('notif_mark_all_read')} onPress={readAll} className="self-end px-1 py-1 active:opacity-70">
            <Text className="font-inter-bold text-[13px]" style={{ color: P.brand }}>{t('notif_mark_all_read')}</Text>
          </Pressable>
        ) : null}
        {items.map((n) => {
          const { bg, color, Icon } = KIND[n.kind] || KIND.system;
          const read = !!n.readAt;
          return (
            <Card key={n.id} onPress={() => open(n)} className={`flex-row items-start gap-2.5 ${read ? 'opacity-55' : ''}`}>
              {highlight.includes(n.id) ? <HighlightFill radius={16} /> : null}
              <View className={`h-8 w-8 items-center justify-center rounded-[10px] ${bg}`}><Icon size={16} color={color} /></View>
              <View className="flex-1">
                <View className="flex-row justify-between">
                  <Text className="font-inter-bold text-[14px]">{n.title}</Text>
                  <Text className="text-[11.5px] text-faint">{timeAgo(n.createdAt)}</Text>
                </View>
                {n.body ? <Text className="mt-1 text-[13px] text-muted">{n.body}</Text> : null}
              </View>
              <View className="items-center">
                {!read ? <View accessible accessibilityLabel={t('notif_unread')} className="h-2 w-2 rounded-full" style={{ backgroundColor: P.brand }} /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('notif_delete')}
                  hitSlop={8}
                  onPress={() => confirmRemove(n)}
                  className="mt-1 h-7 w-7 items-center justify-center active:opacity-60"
                >
                  <Trash size={15} color="#8A97AB" />
                </Pressable>
              </View>
            </Card>
          );
        })}
        {items.length === 0 && (
          <View className="items-center px-5 py-[50px]"><Text className="text-[12.5px] text-faint">{t('notif_empty')}</Text></View>
        )}
        {items.length > 0 ? <CachedNote /> : null}
        </Reveal> : null}
        <Spacer min={16} />
        <Button title={t('btn_return_home')} onPress={goBack} />
      </Body>
    </Screen>
  );
}
