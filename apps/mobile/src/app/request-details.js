import { useEffect, useState } from 'react';
import { Linking, Pressable, Share, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowRight, Ban, Check, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Clock, Download, FileText, Image as ImageIcon, Phone, Share2,
} from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { downloadAndShare } from '../lib/download';
import { goBack } from '../lib/nav';
import { toUiStatus } from '../lib/requestShape';
import { reviewPill } from '../lib/requestDocuments';
import { detailsView, needsClamp } from '../lib/requestDetailsView';
import { Screen, Body } from '../components/layout';
import { LoadError, LoadingState } from '../components/LoadingState';
import { ServiceIcon } from '../components/home/ServiceIcon';
import { useReportFixedBar } from '../components/sos/hooks';
import AdditionalDocuments from '../components/request/AdditionalDocuments';
import DocumentHistory from '../components/request/DocumentHistory';
import ReviewBanner from '../components/request/ReviewBanner';
import { C, Card, DashedLine, FONT, Field, Section, StatusLayout, WRAP } from '../components/request/DetailsParts';

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
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 66, borderRadius: 14, backgroundColor: '#F5F8FC', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 8, opacity: pressed ? 0.8 : 1 })}
    >
      <Icon size={20} color={C.blueText} />
      <Text style={{ fontFamily: FONT[700], fontSize: 12.5, lineHeight: 16, color: C.ink, textAlign: 'center' }}>{label}</Text>
    </Pressable>
  );
}

function Chip({ children, bg, fg, Icon, padV = 5, padH = 10, size = 13, line = 18 }) {
  return (
    <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: padV, paddingHorizontal: padH, borderRadius: 999, backgroundColor: bg }}>
      {Icon ? <Icon size={15} color={fg} strokeWidth={2.4} /> : null}
      <Text style={[{ flexShrink: 1, fontFamily: FONT[700], fontSize: size, lineHeight: line, color: fg }, WRAP]}>{children}</Text>
    </View>
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
          <View style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, backgroundColor: '#E7F0FE' }}>
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
  return <StatusLayout bg="#FDF0DA" fg="#8F4C08" Icon={Clock} title={t('rd_review_title')} text={t('rd_review_text')} />;
}

// Two columns, 14 between the rows and 12 between the columns; a full-width field takes its own row.
function PatientGrid({ fields }) {
  const rows = [];
  let pair = [];
  const flush = () => { if (pair.length) { rows.push(pair); pair = []; } };
  fields.forEach((f) => {
    if (f.full) { flush(); rows.push([f]); } else { pair.push(f); if (pair.length === 2) flush(); }
  });
  flush();
  return (
    <View style={{ gap: 14 }}>
      {rows.map((row) => (
        <View key={row[0].key} style={{ flexDirection: 'row', gap: 12 }}>
          {row.length === 1 && row[0].full ? <Field label={row[0].label} value={row[0].value} style={{ flex: 1 }} /> : (
            <>
              <Field label={row[0].label} value={row[0].value} style={{ flex: 1 }} />
              {row[1] ? <Field label={row[1].label} value={row[1].value} style={{ flex: 1 }} /> : <View style={{ flex: 1 }} />}
            </>
          )}
        </View>
      ))}
    </View>
  );
}

function Trip({ trip, t }) {
  const hasRoute = trip.from || trip.to;
  return (
    <Card>
      {hasRoute ? (
        <View>
          {trip.from ? (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ width: 14, alignItems: 'center' }}>
                <View style={{ marginTop: 1, width: 14, height: 14, borderRadius: 7, borderWidth: 3, borderColor: C.blue, backgroundColor: '#FFFFFF' }} />
                {trip.to ? <View style={{ flex: 1, paddingTop: 4, paddingBottom: 2 }}><DashedLine /></View> : null}
              </View>
              <Field label={t('lbl_from')} value={trip.from} style={{ flex: 1, paddingBottom: trip.to ? 14 : 0 }} />
            </View>
          ) : null}
          {trip.to ? (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ width: 14, alignItems: 'center' }}>
                <View style={{ marginTop: 1, width: 14, height: 14, borderRadius: 7, backgroundColor: C.blue }} />
              </View>
              <Field label={t('lbl_to')} value={trip.to} style={{ flex: 1 }} />
            </View>
          ) : null}
        </View>
      ) : null}
      {trip.rows.length ? (
        <View style={hasRoute ? { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: C.divider, gap: 14 } : { gap: 14 }}>
          {trip.rows.map((r) => <Field key={r.key} label={r.label} value={r.value} />)}
        </View>
      ) : null}
    </Card>
  );
}

// A row of the Medical card: 12 above and below, a 1px line between rows.
function MedicalRow({ first, label, children }) {
  return (
    <View style={{ paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: C.divider }}>
      <Text style={{ fontFamily: FONT[600], fontSize: 12.5, lineHeight: 16, color: C.muted, marginBottom: 2 }}>{label}</Text>
      {children}
    </View>
  );
}

// The condition: line breaks kept, four lines when closed. A copy of the full text, invisible, is measured; the button
// shows only when the full text is taller than four lines.
function Condition({ text, t }) {
  const [open, setOpen] = useState(false);
  const [fullHeight, setFullHeight] = useState(0);
  const textStyle = [{ fontFamily: FONT[500], fontSize: 14.5, lineHeight: 21, color: C.ink }, WRAP];
  const long = needsClamp(fullHeight, 21);
  return (
    <View>
      <View style={{ position: 'absolute', left: 0, right: 0, opacity: 0 }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" onLayout={(e) => setFullHeight(e.nativeEvent.layout.height)}>
        <Text style={textStyle}>{text}</Text>
      </View>
      <Text style={textStyle} numberOfLines={open ? undefined : 4}>{text}</Text>
      {long ? (
        <Pressable
          accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)}
          style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
        >
          <Text style={{ fontFamily: FONT[700], fontSize: 14, color: C.blueText }}>{t(open ? 'rd_show_less' : 'rd_show_more')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Medical({ medical, t }) {
  const rows = [];
  if (medical.urgency) {
    rows.push(['urgency', t('rd_urgent'), <Chip key="u" bg={medical.urgency.bg} fg={medical.urgency.fg} Icon={medical.urgency.alert ? CircleAlert : null}>{medical.urgency.label}</Chip>]);
  }
  if (medical.condition) rows.push(['condition', medical.conditionLabel, <Condition key="c" text={medical.condition} t={t} />]);
  if (medical.care.length) {
    rows.push(['care', t('field_care_level'), (
      <View key="care" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
        {medical.care.map((c) => <Chip key={c} bg={C.soft} fg={C.navy} padV={6} padH={12} size={13.5}>{c}</Chip>)}
      </View>
    )]);
  }
  if (medical.mobility) {
    rows.push(['mobility', t('req_mobility'), <Text key="m" style={[{ fontFamily: FONT[700], fontSize: 15, lineHeight: 21, color: C.ink }, WRAP]}>{medical.mobility}</Text>]);
  }
  if (medical.equipment) {
    rows.push(['equipment', t('req_on_board'), medical.equipment.none ? (
      <Text key="n" style={{ fontFamily: FONT[700], fontSize: 15, lineHeight: 21, color: C.ink }}>{t('req_none')}</Text>
    ) : (
      <View key="e" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
        {medical.equipment.items.map((label) => <Chip key={label} bg={C.soft} fg={C.navy} Icon={Check} padV={6} padH={12} size={13.5}>{label}</Chip>)}
      </View>
    )]);
  }
  if (!rows.length) return null;
  return (
    <Section title={t('rd_medical')}>
      <Card padding={0} style={{ paddingVertical: 4, paddingHorizontal: 16 }}>
        {rows.map(([key, label, node], i) => <MedicalRow key={key} first={i === 0} label={label}>{node}</MedicalRow>)}
      </Card>
    </Section>
  );
}

function DocumentRow({ doc, first, t, onOpen }) {
  const Icon = doc.isImage ? ImageIcon : FileText;
  const body = (
    <>
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: doc.isImage ? '#E0F5F4' : C.soft, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={20} color={doc.isImage ? '#0B6564' : C.blueText} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} ellipsizeMode="tail" style={{ fontFamily: FONT[600], fontSize: 14.5, lineHeight: 20, color: C.ink }}>{doc.name}</Text>
        {doc.meta ? <Text style={[{ fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: C.muted }, WRAP]}>{doc.meta}</Text> : null}
        {doc.statusLabel ? <Text style={{ marginTop: 2, fontFamily: FONT[700], fontSize: 12.5, lineHeight: 17, color: doc.status === 'approved' ? '#0B6564' : ['rejected', 'unsafe', 'scan_failed'].includes(doc.status) ? '#C53030' : C.blueText }}>{doc.statusLabel}</Text> : null}
        {doc.reason ? <Text style={[{ marginTop: 2, fontFamily: FONT[400], fontSize: 12.5, lineHeight: 18, color: '#C53030' }, WRAP]}>{doc.reason}</Text> : null}
      </View>
      {doc.openable ? <ChevronRight size={20} color="#8A97AB" /> : null}
    </>
  );
  const box = { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, borderTopWidth: first ? 0 : 1, borderTopColor: C.divider };
  if (!doc.openable) return <View style={box}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t('rd_open_document', { name: doc.name })} onPress={onOpen} style={({ pressed }) => [box, { opacity: pressed ? 0.8 : 1 }]}>{body}</Pressable>
  );
}

export default function RequestDetails() {
  const { t, toast, isRTL } = useApp();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams();
  const [request, setRequest] = useState(null);
  const [failed, setFailed] = useState(false);
  // The "Open live tracking" bar is this screen's own fixed bottom bar: its height is reported so the floating SOS button sits above it.
  const [barHeight, setBarHeight] = useState(0);
  const view = request ? detailsView(request, t) : null;
  useReportFixedBar(view && view.showTrackingBar ? barHeight : 0);

  useEffect(() => {
    if (!id) return;
    apiGet(`/requests/me/${id}`)
      .then(({ request: r }) => setRequest(r))
      .catch((err) => { setFailed(true); toast(err.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per id
  }, [id]);

  // Reloads the request after documents were sent. The screen keeps showing the current request while
  // this runs (and if it fails), so an upload's results on screen are never lost to a failed reload.
  const reload = () => apiGet(`/requests/me/${id}`)
    .then(({ request: r }) => setRequest(r))
    .catch((err) => toast(err.message));

  const page = { backgroundColor: '#F2F6FC' };

  if (!request) {
    return (
      <Screen style={page}>
        <Header title={t('request_details_title')} backLabel={t('home_back')} isRTL={isRTL} />
        {failed || !id ? <LoadError message={t('rd_load_failed')} /> : <LoadingState />}
      </Screen>
    );
  }

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
      <Body contentClassName="">
        <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 24, gap: 14 }}>
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
                  onOpen={() => downloadAndShare(`/documents/${doc.id}/file`, doc.name).catch((err) => toast(err.message))}
                />
              ))}
            </Card>
          </Section>

          <DocumentHistory request={request} styled />
          <AdditionalDocuments request={request} onUploaded={reload} />
        </View>
      </Body>
      {view.showTrackingBar ? (
        <View onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)} style={{ backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: C.line, paddingTop: 12, paddingHorizontal: 16, paddingBottom: 20 + insets.bottom }}>
          <Pressable
            accessibilityRole="button" accessibilityLabel={t('rd_open_tracking')}
            onPress={() => router.push({ pathname: '/request-tracking', params: { id: request.id } })}
            style={({ pressed }) => ({ minHeight: 52, borderRadius: 16, backgroundColor: C.blue, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, opacity: pressed ? 0.88 : 1 })}
          >
            <Text style={{ fontFamily: FONT[800], fontSize: 16, color: '#FFFFFF' }}>{t('rd_open_tracking')}</Text>
            <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}><ArrowRight size={18} color="#FFFFFF" strokeWidth={2.4} /></View>
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}
