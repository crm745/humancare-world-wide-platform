import { useEffect, useState } from 'react';
import { Linking, Pressable, Share, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Check, Download, Phone, Share2 } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { downloadAndShare } from '../lib/download';
import { isMortalRequest, toUiStatus, formatDisplayDate, careLevelText } from '../lib/requestShape';
import { Body, Screen, TopBar } from '../components/layout';
import { Button, Card, InfoRow, Spacer, Text } from '../components/ui';
import { LoadError, LoadingState } from '../components/LoadingState';
import AdditionalDocuments from '../components/request/AdditionalDocuments';
import DocumentHistory from '../components/request/DocumentHistory';
import ReviewBanner from '../components/request/ReviewBanner';
import RequestStatusPill from '../components/request/RequestStatusPill';
import { documentsSummary } from '../lib/documentHistoryView';
import { reviewPill } from '../lib/requestDocuments';
import { trackingRoute } from '../lib/trackingItem';

function Action({ Icon, label, onPress }) {
  return (
    <Pressable onPress={onPress} className="flex-1 items-center gap-1.5 rounded-xl border border-line bg-white px-1.5 py-3.5 active:opacity-80">
      <Icon size={18} color="#1A73E8" />
      <Text className="text-center font-inter-bold text-[11px]">{label}</Text>
    </Pressable>
  );
}

const STATUS_ORDER = ['submitted', 'in_progress', 'completed'];
const STATUS_STEP_KEY = { submitted: 'status_submitted', in_progress: 'status_progress', completed: 'status_completed' };

function stepsFor(status) {
  const idx = STATUS_ORDER.indexOf(status);
  return STATUS_ORDER.map((s, i) => ({
    key: STATUS_STEP_KEY[s],
    state: status === 'cancelled' ? 'todo' : i < idx ? 'done' : i === idx ? 'current' : 'todo',
  }));
}

function StatusTracker({ status }) {
  const { t } = useApp();
  const steps = stepsFor(status);
  return (
    <View className="flex-row items-start">
      {steps.map((s, i) => (
        <View key={s.key} className={`flex-row items-start ${i < steps.length - 1 ? 'flex-1' : ''}`}>
          <View className="w-[26px] items-center">
            <View className={`h-[26px] w-[26px] items-center justify-center rounded-full ${s.state === 'done' ? 'bg-success' : s.state === 'current' ? 'bg-primary' : 'border-2 border-line bg-white'}`}>
              {s.state === 'done' && <Check size={13} color="#fff" strokeWidth={3} />}
              {s.state === 'current' && <View className="h-2 w-2 rounded-full bg-white" />}
            </View>
            <Text numberOfLines={1} style={{ width: 90 }} className={`mt-1.5 text-center font-inter-bold text-[10.5px] ${s.state === 'current' ? 'text-primary' : s.state === 'todo' ? 'text-faint' : 'text-ink'}`}>
              {t(s.key)}
            </Text>
          </View>
          {i < steps.length - 1 && (
            <View className={`mt-[13px] h-0.5 flex-1 ${steps[i + 1].state === 'todo' ? 'bg-line' : steps[i + 1].state === 'current' ? 'bg-primary' : 'bg-success'}`} />
          )}
        </View>
      ))}
    </View>
  );
}

export default function RequestDetails() {
  const { t, toast } = useApp();
  const { id } = useLocalSearchParams();
  const [request, setRequest] = useState(null);
  const [failed, setFailed] = useState(false);

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

  if (!request) {
    return (
      <Screen>
        <TopBar title={t('request_details_title')} />
        {failed || !id ? <LoadError message="Couldn't load this request. Please go back and try again." /> : <LoadingState />}
      </Screen>
    );
  }

  // Workflow requests list requestDocuments; every other request keeps its Case documents (see documentHistoryView).
  const docsLabel = documentsSummary(request);
  // A workflow request's chip says the same as its banner; every other request keeps the usual chip.
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

  return (
    <Screen>
      <TopBar title={t('request_details_title')} />
      <Body contentClassName="px-5 py-6">
        <Text className="mb-[5px] text-[12.5px] text-faint">{request.referenceNumber}</Text>
        <View className="mb-6 flex-row items-center justify-between">
          <Text className="font-inter-black text-[20px] text-navy">{request.serviceType}</Text>
          <RequestStatusPill pill={pill} status={request.status} />
        </View>
        <ReviewBanner request={request} />
        <View className="mb-6 flex-row gap-2.5">
          <Action Icon={Download} label={t('btn_download_summary')} onPress={downloadSummary} />
          <Action Icon={Share2} label={t('btn_share')} onPress={shareRequest} />
          <Action Icon={Phone} label={t('btn_contact_team')} onPress={() => Linking.openURL('tel:+919699999065')} />
        </View>
        <Card>
          <InfoRow label={t('lbl_request_date')} value={formatDisplayDate(request.createdAt)} />
          <InfoRow label={t(isMortalRequest(request) ? 'lbl_deceased_name' : 'lbl_patient_name')} value={request.patientName} />
          <InfoRow label={t('field_care_level')} value={careLevelText(request.careLevel, t) || '—'} />
          <InfoRow label={t('lbl_service')} value={request.serviceType} />
          <InfoRow label={t('lbl_from')} value={request.origin} />
          <InfoRow label={t('lbl_to')} value={request.destination} />
          <InfoRow label={t(isMortalRequest(request) ? 'field_transfer_date' : 'lbl_expected_date')} value={request.preferredDate ? formatDisplayDate(request.preferredDate) : '—'} />
          <InfoRow last label={t('lbl_documents')} value={docsLabel} valueClassName="text-primary" onPress={() => router.push(trackingRoute(request, 'docs'))} />
        </Card>
        <Card className="mt-5">
          <Text className="mb-[22px] font-inter-black text-[14.5px] text-navy">{t('lbl_tracking_status')}</Text>
          <StatusTracker status={request.status} />
        </Card>
        <DocumentHistory request={request} />
        <AdditionalDocuments request={request} onUploaded={reload} />
        <Spacer />
        <Button title={t('btn_track_details')} onPress={() => router.push(trackingRoute(request))} />
      </Body>
    </Screen>
  );
}
