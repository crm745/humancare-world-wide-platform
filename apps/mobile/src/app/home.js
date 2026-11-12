import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { SERVICE_LABELS, SERVICE_TILES } from '../data/mock';
import { apiGet } from '../lib/api';
import { registerForPushNotifications } from '../lib/pushNotifications';
import { serviceKeyFromTitle, toUiStatus } from '../lib/requestShape';
import { navReplace } from '../lib/nav';
import { BottomNav, Screen, useScrollToTopOnTabTap } from '../components/layout';
import { Text } from '../components/ui';
import { openService } from '../components/ServiceGrid';
import { ActiveRequestCard } from '../components/home/ActiveRequestCard';
import { ActiveRequestSkeleton } from '../components/home/HomeSkeleton';
import { BannerCarousel } from '../components/home/BannerCarousel';
import { Greeting } from '../components/home/Greeting';
import { HomeHeader } from '../components/home/HomeHeader';
import { ServicesGrid } from '../components/home/ServicesGrid';
import { SosBar } from '../components/home/SosBar';

const TAB_BAR = 64;
const MAX_WIDTH = 720;
const HOME_TILES = SERVICE_TILES.slice(0, 6);
// What the app tracks for a request: submitted -> in progress -> completed.
const STEP_BY_STATUS = { submitted: 1, in_progress: 2 };
const TOTAL_STEPS = 3;

export default function Home() {
  const { t, isCorporate, profile } = useApp();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tablet = width >= 600;
  const contentW = Math.min(width, MAX_WIDTH);

  const [hasUnread, setHasUnread] = useState(false);
  const [requests, setRequests] = useState([]);
  const [loaded, setLoaded] = useState(isCorporate);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [slow, setSlow] = useState(false);
  const [sosH, setSosH] = useState(72);
  const scrollRef = useRef(null);
  useScrollToTopOnTabTap(scrollRef);

  const firstName = (profile.name || '').split(' ')[0] || profile.name;

  // The same two calls as before (notifications for the bell dot, the request list that
  // My Requests uses). Whatever was loaded last stays on screen if a refresh fails.
  const fetchHome = useCallback(
    () => Promise.allSettled([apiGet('/notifications?unreadOnly=true'), apiGet('/requests/me')]),
    [],
  );
  const applyHome = useCallback(([unread, mine]) => {
    if (unread.status === 'fulfilled') setHasUnread(unread.value.notifications.length > 0);
    if (mine.status === 'fulfilled') {
      setRequests(mine.value.requests);
      setFailed(false);
    } else {
      setFailed(true);
    }
    setLoaded(true);
  }, []);
  const load = useCallback(() => fetchHome().then(applyHome), [fetchHome, applyHome]);

  useEffect(() => {
    if (isCorporate) return;
    fetchHome().then(applyHome);
    registerForPushNotifications();
  }, [isCorporate, fetchHome, applyHome]);

  // The skeleton only appears if loading takes a moment, so a fast load never flashes it.
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(timer);
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

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
        refreshControl={isCorporate ? undefined : <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={{ width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 18, paddingTop: 18 }}>
          <Greeting name={isCorporate ? profile.name : firstName} />

          {isCorporate ? (
            <Pressable onPress={() => router.push('/corporate-new-case')} style={{ marginBottom: 18, borderRadius: 18, overflow: 'hidden' }}>
              <LinearGradient colors={['#1A73E8', '#3E8EF7']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
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
              {/* Only warn when a refresh failed while older requests are on screen; with nothing
                  to show, a failed first load looks the same as having no active request. */}
              {failed && requests.length > 0 && (
                <Pressable accessibilityRole="button" onPress={load} style={{ minHeight: 44, marginBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <Text style={{ fontSize: 12.5, color: '#5B6B84' }}>{t('home_refresh_failed')}</Text>
                  <Text className="font-inter-black" style={{ fontSize: 12.5, color: '#1A5FC4' }}>{t('home_try_again')}</Text>
                </Pressable>
              )}
              {!loaded && slow && <ActiveRequestSkeleton />}
              {activeRequest && (
                <ActiveRequestCard request={activeRequest} onTrack={() => router.push({ pathname: '/request-tracking', params: { id: current.id } })} />
              )}
            </>
          )}

          <ServicesGrid
            services={HOME_TILES}
            columns={tablet ? 4 : 3}
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
