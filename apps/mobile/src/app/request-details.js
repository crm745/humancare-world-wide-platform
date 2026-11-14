import { useState } from 'react';
import { Linking, Pressable, Share, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowRight, Ban, Check, ChevronLeft, CircleCheck, Download, Phone, Share2,
} from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { downloadAndShare } from '../lib/download';
import { openDocumentPreview } from '../lib/documentPreview';
import { goBack } from '../lib/nav';
import { toUiStatus } from '../lib/requestShape';
import { reviewPill } from '../lib/requestDocuments';
import { detailsView } from '../lib/requestDetailsView';
import { Screen, Body } from '../components/layout';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { LoadFailure } from '../components/LoadFailure';
import { Reveal } from '../components/skeleton/Reveal';
import { useSkeletonGate } from '../components/skeleton/hooks';
import { RequestDetailsSkeleton } from '../components/skeleton/screens';
import { useResource } from '../lib/useResource';
import { ServiceIcon } from '../components/home/ServiceIcon';
import AdditionalDocuments from '../components/request/AdditionalDocuments';
import { DocumentRow, Medical, PatientGrid, Trip } from '../components/request/DetailsBlocks';
import DocumentHistory from '../components/request/DocumentHistory';
import ReviewBanner from '../components/request/ReviewBanner';
import { C, Card, FONT, Section, StatusLayout, WRAP } from '../components/request/DetailsParts';
import { COLORS } from '../theme/colors';
import { PressBox } from '../components/PressBox';

// Request Details, drawn to the design. Everything on it is worked out in lib/requestDetailsView.js; this file only
// draws it. Every value wraps (nothing is cut off) except a file name, which is one line with an ellipsis.

function Header({ title, backLabel, isRTL }) {
  return (
    <View style={{ height: 76, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: C.line }}>
      <Pressable
        accessibilityRole="button" accessibilityLabel={backLabel} onPress={goBack}
        style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' }}
      >
        <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}><ChevronLeft size={22} color={C.navy} strokeWidth={2.4} /></View>
      </Pressable>
      <Text accessibilityRole="header" numberOfLines={2} style={{ flex: 1, minWidth: 0, fontFamily: FONT[800], fontSize: 18, lineHeight: 24, color: C.navy }}>{title}</Text>
    </View>
  );
}

function Action({ Icon, label, onPress }) {
  return (
    <PressBox
      accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 66, borderRadius: 14, backgroundColor: '#F5F8FC', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 8, opacity: pressed ? 0.8 : 1 })}
    >
      <Icon size={20} color={C.blueText} />
      <Text style={{ fontFamily: FONT[700], fontSize: 12.5, lineHeight: 16, color: C.ink, textAlign: 'center' }}>{label}</Text>
    </PressBox>
  );
}

function Summary({ view, t, onDownload, onShare, onContact }) {
  const h = view.header;
  return (
    <Card big>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14 }}>
        <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <ServiceIcon serviceKey={h.serviceKey} size={24} color={C.navy} fill={C.navy} fillOpacity={0.12} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {h.reference ? <Text style={{ fontFamily: FONT[600], fontSize: 13, lineHeight: 18, color: C.muted }}>{h.reference}</Text> : null}
          <Text accessibilityRole="header" style={[{ fontFamily: FONT[800], fontSize: 19, lineHeight: 25, color: C.navy }, WRAP]}>{h.name}</Text>
        </View>
      </View>
      <View style={{ marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <View style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, backgroundColor: h.badge.bg }}>
          <Text style={{ fontFamily: FONT[800], fontSize: 11.5, lineHeight: 14, textTransform: 'uppercase', color: h.badge.fg }}>{h.badge.label}</Text>
        </View>
        {h.requested ? <Text style={{ flexShrink: 1, fontFamily: FONT[400], fontSize: 13, lineHeight: 18, color: C.muted }}>{t('rd_requested', { date: h.requested })}</Text> : null}
      </View>
      <View style={{ marginTop: 16, flexDirection: 'row', gap: 8 }}>
        <Action Icon={Download} label={t('rd_download')} onPress={onDownload} />
        <Action Icon={Share2} label={t('rd_share')} onPress={onShare} />
        <Action Icon={Phone} label={t('rd_contact_team')} onPress={onContact} />
      </View>
    </Card>
  );
}

function StatusCard({ view, request, t }) {
  const s = view.status;
  if (s.kind === 'active') {
    return (
      <Card big>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <Text accessibilityRole="header" style={{ flex: 1, minWidth: 0, fontFamily: FONT[800], fontSize: 16, lineHeight: 22, color: C.navy }}>{t('rd_live_tracking')}</Text>
          <View style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, backgroundColor: COLORS.primarySoft }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.blue }} />
            <Text style={{ fontFamily: FONT[800], fontSize: 12, lineHeight: 16, color: C.blueText }}>{t('rd_case_active')}</Text>
          </View>
        </View>
        <View style={{ marginTop: 12, flexDirection: 'row', gap: 4 }}>
          {Array.from({ length: s.total }, (_, i) => (
            <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i < s.step ? C.blue : C.line }} />
          ))}
        </View>
        <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: 8, rowGap: 2 }}>
          <Text style={{ flexShrink: 1, fontSize: 13.5, lineHeight: 19 }}>
            <Text style={{ fontFamily: FONT[700], color: C.ink }}>{t('mr_step_of', { n: s.step, total: s.total })}</Text>
            <Text style={{ fontFamily: FONT[500], color: C.muted }}>{` · ${t(s.stageKey)}`}</Text>
          </Text>
          {s.updated ? <Text style={{ flexShrink: 1, fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: C.muted }}>{t('rd_updated', { when: s.updated })}</Text> : null}
        </View>
      </Card>
    );
  }
  if (s.kind === 'review') return <ReviewBanner request={request} />;
  if (s.kind === 'approved') return <StatusLayout bg="#E0F5F4" fg="#0B6564" Icon={CircleCheck} title={t('rd_approved_title')} text={t('rd_approved_text')} />;
  if (s.kind === 'completed') return <StatusLayout bg="#E0F5F4" fg="#0B6564" Icon={Check} title={t('rd_completed_title')} text={s.date ? t('rd_completed_on', { date: s.date }) : t('rd_completed_text')} />;
  if (s.kind === 'cancelled') return <StatusLayout bg="#EEF1F6" fg="#5B6B84" Icon={Ban} title={t('rd_cancelled_title')} text={t('rd_cancelled_text')} />;
  return null; // the case has not started: no card
}

export default function RequestDetails() {
  const { t, toast, isRTL } = useApp();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams();
  // Loaded the way every data screen loads (lib/useResource.js): a shimmer skeleton on the first load only, what an earlier visit loaded
  // shows at once and refreshes quietly, "Try again" if the first load fails, and pull-to-refresh with the page staying on screen.
  // `reload` (after documents were sent) is the same quiet refetch: the screen keeps showing the current request meanwhile.
  const { data, loading, error, reload, onRefresh, refreshing } = useResource({
    key: `request:${id}`,
    enabled: Boolean(id),
    fetcher: () => apiGet(`/requests/me/${id}`).then(({ request: r }) => r),
    onRefreshError: () => toast(t('sk_refresh_failed')),
  });
  const request = data ?? null;
  const gate = useSkeletonGate(loading && Boolean(id));
  // The height of the "Open live tracking" bar under the scroll area (0 when it is not drawn): the room the floating SOS button needs is measured from above it.
  const [barHeight, setBarHeight] = useState(0);

  const page = { backgroundColor: '#F2F6FC' };

  if (!request) {
    return (
      <Screen style={page}>
        <Header title={t('request_details_title')} backLabel={t('home_back')} isRTL={isRTL} />
        {!id || (error && !request) ? <LoadFailure message={t('rd_load_failed')} onRetry={id ? reload : undefined} /> : null}
        {loading && id && gate.visible ? <RequestDetailsSkeleton label={t('sk_loading_request')} /> : null}
      </Screen>
    );
  }

  const view = detailsView(request, t);
  // A workflow request's status is said the same way in the shared message as on the card.
  const pill = reviewPill(request);

  const downloadSummary = async () => {
    try {
      toast('Downloading request summary…');
      await downloadAndShare(`/requests/me/${request.id}/summary`, `${request.referenceNumber}-summary.pdf`);
    } catch (err) {
      toast(err.message);
    }
  };

  const shareRequest = async () => {
    try {
      await Share.share({
        title: `HumanCare World Wide — ${request.referenceNumber}`,
        message:
          `HumanCare World Wide request ${request.referenceNumber}\n` +
          `${request.serviceType} — ${request.origin} to ${request.destination}\n` +
          `Status: ${pill ? pill.label : t('status_' + toUiStatus(request.status))}`,
      });
    } catch (err) {
      // On web, browsers without the Web Share API reject here (desktop Firefox,
      // older Chrome) — on native, cancelling the share sheet itself is not an
      // error (it resolves normally), so this only fires for a real failure.
      toast(err.message || 'Sharing is not supported on this browser.');
    }
  };

  const docs = view.documents;

  return (
    <Screen style={page}>
      <Header title={t('request_details_title')} backLabel={t('home_back')} isRTL={isRTL} />
      <Body contentClassName="" bottomEdge={view.showTrackingBar ? barHeight : 0} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <Reveal animate={gate.wasShown} style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 0, gap: 14 }}>
          <Summary view={view} t={t} onDownload={downloadSummary} onShare={shareRequest} onContact={() => Linking.openURL('tel:+919699999065')} />
          <StatusCard view={view} request={request} t={t} />

          {view.patient.fields.length ? (
            <Section title={t(view.patient.titleKey)}>
              <Card><PatientGrid fields={view.patient.fields} /></Card>
            </Section>
          ) : null}

          {view.trip.from || view.trip.to || view.trip.rows.length ? (
            <Section title={t('rd_trip')}><Trip trip={view.trip} t={t} /></Section>
          ) : null}

          <Medical medical={view.medical} t={t} />

          <Section title={t('rd_documents_n', { n: docs.length })}>
            <Card padding={0} style={{ overflow: 'hidden' }}>
              {docs.length === 0 ? (
                <Text style={{ padding: 16, fontFamily: FONT[400], fontSize: 13.5, lineHeight: 19, color: C.muted }}>{t('rd_no_documents')}</Text>
              ) : docs.map((doc, i) => (
                <DocumentRow
                  key={doc.id} doc={doc} first={i === 0} t={t}
                  onOpen={() => openDocumentPreview(router.push, doc)}
                />
              ))}
            </Card>
          </Section>

          <DocumentHistory request={request} styled />
          <AdditionalDocuments request={request} onUploaded={reload} />
        </Reveal>
      </Body>
      {view.showTrackingBar ? (
        <View onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)} style={{ backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: C.line, paddingTop: 12, paddingHorizontal: 16, paddingBottom: 20 + insets.bottom }}>
          <PressBox
            accessibilityRole="button" accessibilityLabel={t('rd_open_tracking')}
            onPress={() => router.push({ pathname: '/request-tracking', params: { id: request.id } })}
            style={({ pressed }) => ({ minHeight: 52, borderRadius: 16, backgroundColor: C.blue, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, opacity: pressed ? 0.88 : 1 })}
          >
            <Text style={{ fontFamily: FONT[800], fontSize: 16, color: '#FFFFFF' }}>{t('rd_open_tracking')}</Text>
            <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}><ArrowRight size={18} color="#FFFFFF" strokeWidth={2.4} /></View>
          </PressBox>
        </View>
      ) : null}
    </Screen>
  );
}
