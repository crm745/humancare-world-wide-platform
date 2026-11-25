import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { HOME_SERVICES } from '../../data/mock';
import { apiGet } from '../../lib/api';
import { registerForPushNotifications } from '../../lib/pushNotifications';
import { toListItem } from '../../lib/requestShape';
import { homeActiveSection } from '../../lib/activeRequests';
import { BottomNav, Screen, useScrollToTopOnTabTap } from '../../components/layout';
import { Text } from '../../components/ui';
import { openService } from '../../components/ServiceGrid';
import { ActiveRequestsSection } from '../../components/home/ActiveRequestCard';
import { AppRefreshControl } from '../../components/AppRefreshControl';
import { LoadFailure } from '../../components/LoadFailure';
import { DraftNotice } from '../../components/home/DraftNotice';
import { Reveal } from '../../components/skeleton/Reveal';
import { useResource } from '../../lib/useResource';
import { seedMyRequests } from '../../lib/myRequestsResource';
import { sessionEpoch } from '../../lib/screenCache';
import { BannerCarousel } from '../../components/home/BannerCarousel';
import { Greeting } from '../../components/home/Greeting';
import { HomeHeader } from '../../components/home/HomeHeader';
import { ServicesGrid } from '../../components/home/ServicesGrid';
import { SosBar } from '../../components/home/SosBar';
import { COLORS } from '../../theme/colors';
import { useRetryOnRestore } from '../../lib/useRetryOnRestore';
import { useRefreshOnFocus } from '../../lib/useTabRefresh';

const TAB_BAR = 64;
const MAX_WIDTH = 720;
const HOME_TILES = HOME_SERVICES;

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
      const epoch = sessionEpoch(); // before asking, so a list that arrives after a sign-out or an account switch is not stored for the next account
      const [unread, mine] = await Promise.allSettled([apiGet('/notifications?unreadOnly=true'), apiGet('/requests/me')]);
      if (mine.status === 'rejected') throw mine.reason;
      seedMyRequests(mine.value.requests, epoch); // the same list, for My Requests and Tracking (their first opening then needs no second call)
      return { hasUnread: unread.status === 'fulfilled' && unread.value.notifications.length > 0, requests: mine.value.requests };
    },
    onRefreshError: () => toast(t('sk_refresh_failed')),
  });
  useRefreshOnFocus(reload, { enabled: !isCorporate }); // the tab stays mounted: brought up to date quietly when it comes back into front (lib/useTabRefresh.js)
  // No skeleton for the Active Request section: only a patient with exactly one active request has a card, so a placeholder would be wrong for everyone else. The card fades in when the list
  // arrives after a cold start (nothing was cached), and simply appears when an earlier visit already had the list.
  const [arrivesLater] = useState(() => loading && !isCorporate);
  const hasUnread = home ? home.hasUnread : false;
  const requests = home ? home.requests : [];

  // Push registration is best-effort, but if it failed for want of a connection it is tried once more when the connection returns (lib/pushNotifications.js says which).
  const [pushFailed, setPushFailed] = useState(false);
  const registerPush = useCallback(() => { registerForPushNotifications().then((result) => setPushFailed(result === 'retry'), () => setPushFailed(false)); }, []);
  useEffect(() => { if (!isCorporate) registerPush(); }, [isCorporate, registerPush]);
  useRetryOnRestore({ failed: pushFailed, retry: registerPush, enabled: !isCorporate });

  // The active requests (the SAME rule as the Active filter of My Requests, lib/myRequestsView.js isActiveRequest): the card for exactly one; nothing for none or for two or more (the Tracking tab).
  const activeSection = homeActiveSection(requests.map(toListItem));

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
              <DraftNotice />
              <BannerCarousel width={contentW - 36} tablet={tablet} onRequest={() => router.push('/all-services')} />
              {error && !home && <LoadFailure titleKey="lf_title_home" error={error} onRetry={reload} />}
              {activeSection.visible && (
                <Reveal animate={arrivesLater}>
                  <ActiveRequestsSection
                    section={activeSection}
                    onOpen={(item) => router.push({ pathname: '/request-details', params: { id: item.rawId } })}
                    onTrack={(item) => router.push({ pathname: '/request-tracking', params: { id: item.rawId } })}                  />
                </Reveal>
              )}
            </>
          )}

          <ServicesGrid
            services={HOME_TILES}
            onPressService={openTile}
            onViewAll={() => router.push('/all-services')}
          />
        </View>
      </ScrollView>

      <SosBar bottom={TAB_BAR + insets.bottom} onLayout={(e) => setSosH(e.nativeEvent.layout.height)} />
      <BottomNav />
    </Screen>
  );
}
