import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { HOME_SERVICES, SERVICE_LABELS } from '../data/mock';
import { apiGet } from '../lib/api';
import { registerForPushNotifications } from '../lib/pushNotifications';
import { serviceKeyFromTitle, toUiStatus } from '../lib/requestShape';
import { navReplace } from '../lib/nav';
import { BottomNav, Screen, useScrollToTopOnTabTap } from '../components/layout';
import { Text } from '../components/ui';
import { openService } from '../components/ServiceGrid';
import { ActiveRequestCard } from '../components/home/ActiveRequestCard';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { LoadFailure } from '../components/LoadFailure';
import { Reveal } from '../components/skeleton/Reveal';
import { useSkeletonGate } from '../components/skeleton/hooks';
import { ActiveRequestSkeleton } from '../components/skeleton/screens';
import { useResource } from '../lib/useResource';
import { BannerCarousel } from '../components/home/BannerCarousel';
import { Greeting } from '../components/home/Greeting';
import { HomeHeader } from '../components/home/HomeHeader';
import { ServicesGrid } from '../components/home/ServicesGrid';
import { SosBar } from '../components/home/SosBar';
import { COLORS } from '../theme/colors';

const TAB_BAR = 64;
const MAX_WIDTH = 720;
const HOME_TILES = HOME_SERVICES;
// What the app tracks for a request: submitted -> in progress -> completed.
const STEP_BY_STATUS = { submitted: 1, in_progress: 2 };
const TOTAL_STEPS = 3;

export default function Home() {
  const { t, toast, isCorporate, profile } = useApp();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tablet = width >= 600;
  const contentW = Math.min(width, MAX_WIDTH);

  const [sosH, setSosH] = useState(72);
  const scrollRef = useRef(null);
  useScrollToTopOnTabTap(scrollRef);

  const firstName = (profile.name || '').split(' ')[0] || profile.name;

  // The same two calls as before (notifications for the bell dot, the request list that My Requests uses), loaded the way every data
  // screen loads (lib/useResource.js). The request list is what the screen needs: if it fails there is nothing new to show (the error is
  // thrown, so a first load offers "Try again" and a refresh keeps what is on screen); the bell dot is a bonus and may fail alone.
  const { data: home, loading, error, reload, onRefresh, refreshing } = useResource({
    key: 'home',
    enabled: !isCorporate,
    fetcher: async () => {
      const [unread, mine] = await Promise.allSettled([apiGet('/notifications?unreadOnly=true'), apiGet('/requests/me')]);
      if (mine.status === 'rejected') throw mine.reason;
      return { hasUnread: unread.status === 'fulfilled' && unread.value.notifications.length > 0, requests: mine.value.requests };
    },
    onRefreshError: () => toast(t('sk_refresh_failed')),
  });
  const gate = useSkeletonGate(loading && !isCorporate);
  const hasUnread = home ? home.hasUnread : false;
  const requests = home ? home.requests : [];

  useEffect(() => {
    if (!isCorporate) registerForPushNotifications();
  }, [isCorporate]);

  // The newest request that is still being worked on (the list comes newest first).
  const current = requests.find((r) => r.status === 'submitted' || r.status === 'in_progress');
  let activeRequest = null;
  if (current) {
    const key = serviceKeyFromTitle(current.serviceType);
    activeRequest = {
      serviceKey: key,
      serviceName: SERVICE_LABELS[key] ? t(SERVICE_LABELS[key]) : current.serviceType,
      reference: current.referenceNumber,
      statusLabel: t(`status_${toUiStatus(current.status)}`),
      origin: current.origin,
      destination: current.destination,
      step: STEP_BY_STATUS[current.status],
      totalSteps: TOTAL_STEPS,
    };
  }

  const openTile = (s) => (s.route ? router.push(s.route) : openService(s.key));

  return (
    <Screen>
      <HomeHeader hasUnread={hasUnread} onBell={() => router.push('/notifications')} />

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: TAB_BAR + insets.bottom + sosH + 16 }}
        showsVerticalScrollIndicator={false}
        refreshControl={isCorporate ? undefined : <AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={{ width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 18, paddingTop: 18 }}>
          <Greeting name={isCorporate ? profile.name : firstName} />

          {isCorporate ? (
            <Pressable onPress={() => router.push('/corporate-new-case')} style={{ marginBottom: 18, borderRadius: 18, overflow: 'hidden' }}>
              <LinearGradient colors={[COLORS.primary, COLORS.primaryPressed]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
                <View style={{ flex: 1 }}>
                  <Text className="font-inter-black" style={{ fontSize: 16.5, color: '#FFFFFF' }}>{t('btn_initiate_new_case')}</Text>
                  <Text style={{ marginTop: 7, fontSize: 13.5, color: '#FFFFFF', opacity: 0.9 }}>{t('createReqSub')}</Text>
                </View>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' }}>
                  <Plus size={17} color="#FFFFFF" strokeWidth={2.4} />
                </View>
              </LinearGradient>
            </Pressable>
          ) : (
            <>
              <BannerCarousel width={contentW - 36} tablet={tablet} onRequest={() => navReplace('/all-services')} />
              {loading && gate.visible && <ActiveRequestSkeleton label={t('sk_loading_active')} />}
              {error && !home && <LoadFailure onRetry={reload} />}
              {activeRequest && (
                <Reveal animate={gate.wasShown}>
                  <ActiveRequestCard request={activeRequest} onTrack={() => router.push({ pathname: '/request-tracking', params: { id: current.id } })} />
                </Reveal>
              )}
            </>
          )}

          <ServicesGrid
            services={HOME_TILES}
            onPressService={openTile}
            onViewAll={() => navReplace('/all-services')}
          />
        </View>
      </ScrollView>

      <SosBar bottom={TAB_BAR + insets.bottom} onLayout={(e) => setSosH(e.nativeEvent.layout.height)} />
      <BottomNav />
    </Screen>
  );
}
