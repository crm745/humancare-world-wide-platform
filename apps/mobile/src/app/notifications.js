import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Bell, Clock, FileText, FileWarning, Hospital, Loader, MessageSquare, Plane, CircleCheck } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { goBack } from '../lib/nav';
import { ALERTS_PREVIEW_ITEMS, groupAlerts, markAlertRead } from '../lib/alertsPreview';
import { TRACKING_PALETTE as P } from '../lib/tracking/palette';
import { Body, Screen, TopBar } from '../components/layout';
import { Button, Card, Spacer, Text } from '../components/ui';
import { LoadingState } from '../components/LoadingState';

// Development-only preview of this screen with six fictional alerts (lib/alertsPreview.js). It is false in a
// production build (__DEV__ is false there), and while it is on the screen calls no notification API and writes
// nothing: the alerts and their read state live in this component only.
const ALERTS_PREVIEW = __DEV__ && true;

const KIND = {
  stage_update: { bg: 'bg-primary-soft', color: '#1A5FC4', Icon: Loader },
  quotation_ready: { bg: 'bg-warning-soft', color: '#B4740D', Icon: Clock },
  document: { bg: 'bg-success-soft', color: '#1E8E4A', Icon: FileText },
  system: { bg: 'bg-cancel-soft', color: '#C23B3B', Icon: Bell },
};

// The preview's categories: one icon each, all in the official brand blue.
const CATEGORY_ICON = { flight: Plane, quote: FileText, message: MessageSquare, hospital: Hospital, documents: FileWarning, request: CircleCheck };

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(1, Math.round(diffMs / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// TODAY / YESTERDAY, each one white card of compact rows with thin separators. An unread alert has a dot; tapping
// an alert reads it.
function AlertGroups({ items, onRead, t }) {
  return groupAlerts(items).map(({ group, items: rows }) => (
    <View key={group}>
      <Text className="mb-2.5 font-inter-black text-[12.5px] uppercase tracking-wider" style={{ color: P.brand }}>{t(`alerts_${group}`)}</Text>
      <Card className="overflow-hidden p-0">
        {rows.map((a, i) => {
          const Icon = CATEGORY_ICON[a.category];
          return (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              accessibilityLabel={`${a.title}. ${a.unread ? 'Unread. ' : ''}${a.time}`}
              onPress={() => onRead(a.id)}
              className={`flex-row items-start gap-2.5 px-3.5 py-3 active:opacity-80 ${i > 0 ? 'border-t border-divider' : ''}`}
            >
              <View className="h-8 w-8 items-center justify-center rounded-[10px]" style={{ backgroundColor: P.brandSoft }}><Icon size={16} color={P.brand} /></View>
              <View className="flex-1">
                <Text className={`text-[14px] ${a.unread ? 'font-inter-bold' : 'font-inter-semibold text-slate'}`}>{a.title}</Text>
                <Text className="mt-1 text-[13px] text-muted">{a.body}</Text>
              </View>
              <View className="items-end">
                <Text className="text-[11.5px] text-faint">{a.time}</Text>
                {a.unread ? <View className="mt-1.5 h-2 w-2 rounded-full" style={{ backgroundColor: P.brand }} /> : null}
              </View>
            </Pressable>
          );
        })}
      </Card>
    </View>
  ));
}

export default function Notifications() {
  const { t, toast } = useApp();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(!ALERTS_PREVIEW);
  const [preview, setPreview] = useState(ALERTS_PREVIEW ? ALERTS_PREVIEW_ITEMS : []);

  const load = () => {
    apiGet('/notifications')
      .then(({ notifications }) => setItems(notifications))
      .catch((err) => toast(err.message))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount (never in preview mode)
  useEffect(() => { if (!ALERTS_PREVIEW) load(); }, []);

  return (
    <Screen>
      <TopBar title={t('notifications_title')} />
      <Body contentClassName="gap-2.5 px-[18px] py-4">
        {ALERTS_PREVIEW ? (
          <AlertGroups items={preview} onRead={(id) => setPreview((rows) => markAlertRead(rows, id))} t={t} />
        ) : (
          <>
            {loading && <LoadingState />}
            {items.map((n) => {
              const { bg, color, Icon } = KIND[n.kind] || KIND.system;
              const read = !!n.readAt;
              return (
                <Card key={n.id} className={`flex-row items-start gap-2.5 ${read ? 'opacity-55' : ''}`}>
                  <View className={`h-8 w-8 items-center justify-center rounded-[10px] ${bg}`}><Icon size={16} color={color} /></View>
                  <View className="flex-1">
                    <View className="flex-row justify-between">
                      <Text className="font-inter-bold text-[14px]">{n.title}</Text>
                      <Text className="text-[11.5px] text-faint">{timeAgo(n.createdAt)}</Text>
                    </View>
                    {n.body ? <Text className="mt-1 text-[13px] text-muted">{n.body}</Text> : null}
                  </View>
                </Card>
              );
            })}
            {!loading && items.length === 0 && (
              <View className="items-center px-5 py-[50px]"><Text className="text-[12.5px] text-faint">No notifications yet.</Text></View>
            )}
          </>
        )}
        <Spacer min={16} />
        <Button title={t('btn_return_home')} onPress={goBack} />
      </Body>
    </Screen>
  );
}
