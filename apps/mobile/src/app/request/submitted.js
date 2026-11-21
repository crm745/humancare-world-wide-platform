import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Animated, { Easing, withDelay, withSequence, withSpring, withTiming, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { BellRing, Check, ClipboardCheck, Phone, PhoneCall, RefreshCw, TriangleAlert } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { EMERGENCY_DISPLAY, EMERGENCY_TEL } from '../../data/mock';
import { errorText } from '../../lib/errorText';
import { navReplace } from '../../lib/nav';
import { apiGet, apiUpload } from '../../lib/api';
import { pendingFiles, recoverUploads, submissionState } from '../../lib/requestUploads';
import { uploadSummary } from '../../lib/uploadRecovery';
import { fieldsFor } from '../../lib/additionalUploads';
import { secureUuid } from '../../lib/secureRandom';
import { uploadJournal } from '../../lib/uploadJournalDevice';
import { isPrivateCharter } from '../../lib/privateCharter';
import { UploadStatusList } from '../../components/request/UploadStatusList';
import { Body, Screen, TopBar } from '../../components/layout';
import { Button, Card, Heading, Pill, Spacer, Text } from '../../components/ui';
import { StatusNotice } from '../../components/network/StatusNotice';
import { ProgressButton } from '../../components/network/ProgressButton';
import { TextButton } from '../../components/network/TextButton';
import { pluralText } from '../../lib/plural';
import { COLORS } from '../../theme/colors';
import { useOpenLink } from '../../lib/useOpenLink';

// Handshake pops in and wiggles, a ring pulses out, then the green check pops —
// the prototype's hs-enter / hs-shake / hs-pulse-ring / hs-pop keyframes.
function Celebration() {
  const scale = useSharedValue(0);
  const rotate = useSharedValue(-15);
  const ring = useSharedValue(0);
  const check = useSharedValue(0);

  useEffect(() => {
    scale.value = withSpring(1, { damping: 7, stiffness: 160 });
    rotate.value = withSequence(
      withTiming(0, { duration: 600 }),
      withTiming(-8, { duration: 140 }), withTiming(7, { duration: 140 }),
      withTiming(-5, { duration: 140 }), withTiming(4, { duration: 140 }), withTiming(0, { duration: 140 })
    );
    ring.value = withDelay(550, withTiming(1, { duration: 1000, easing: Easing.out(Easing.quad) }));
    check.value = withDelay(1100, withSpring(1, { damping: 8, stiffness: 180 }));
  }, [scale, rotate, ring, check]);

  const emoji = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }, { rotate: `${rotate.value}deg` }] }));
  const pulse = useAnimatedStyle(() => ({ opacity: 0.55 * (1 - ring.value), transform: [{ scale: 0.6 + 1.1 * ring.value }] }));
  const badge = useAnimatedStyle(() => ({ opacity: check.value, transform: [{ scale: check.value }] }));

  return (
    <View className="mb-5 h-[130px] w-[130px] items-center justify-center rounded-full bg-primary-soft">
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 999, backgroundColor: COLORS.primary }, pulse]} />
      <Animated.Text style={[{ fontSize: 58, lineHeight: 70 }, emoji]}>🤝</Animated.Text>
      <Animated.View style={[{ position: 'absolute', right: 2, bottom: 4 }, badge]}>
        <View className="h-[30px] w-[30px] items-center justify-center rounded-full border-[3px] border-white bg-success">
          <Check size={14} color="#fff" strokeWidth={3} />
        </View>
      </Animated.View>
    </View>
  );
}

const STEPS = [
  ['next_step_call', PhoneCall],
  ['next_step_arrange', ClipboardCheck],
  ['next_step_updates', BellRing],
];

export default function RequestSubmitted() {
  const { t, lang, draft, updateDraft, toast, discardDraft } = useApp();
  const open = useOpenLink();
  useEffect(() => { discardDraft().catch(() => undefined); }, [discardDraft]); // every confirmed submission ends here: its saved draft (and key) is deleted
  const { id, requestId, service } = useLocalSearchParams();
  const [retrying, setRetrying] = useState(null); // null, or { index, total, progress } while files upload
  const [sendingUri, setSendingUri] = useState(null); // the file being sent right now
  const [recovered, setRecovered] = useState(false); // every file went through on a retry

  // The report files the server has not accepted, for EVERY service that takes documents (lib/uploadRecovery.js). Teleconsultation and Corporate Medical Solutions never save a request
  // here, so this screen stays exactly as it was for them.
  const saved = draft.sentRequest && String(draft.sentRequest.id) === String(requestId) ? draft.sentRequest : null;
  const listState = { uploaded: draft.uploaded, unknown: draft.uploadUnknown || {}, errors: draft.uploadErrors };
  const summary = saved ? uploadSummary(draft.files, listState, sendingUri) : null;
  const missing = saved ? pendingFiles(draft.files, draft.uploaded) : [];
  const incomplete = missing.length > 0;
  // Private Charter only: not one document has been accepted, so the request is only a draft, not submitted (it needs at least one).
  const isDraft = saved && isPrivateCharter(draft.service) ? submissionState(draft) === 'draft' : false;
  const fetchRequest = (id) => apiGet(`/requests/me/${id}`);

  // "Try again": nothing is sent by itself. It first asks the server which of the files it already has (by each file's upload id), then uploads only the ones it does not have, to the
  // request that is already saved: never a new request, never a duplicate.
  const retry = async () => {
    setRetrying({ index: 1, total: Math.max(1, summary.sendable.length), progress: 0 });
    try {
      const result = await recoverUploads({
        requestId: draft.sentRequest.id, files: draft.files, uploaded: draft.uploaded, uploadErrors: draft.uploadErrors, uploadUnknown: draft.uploadUnknown || {}, fetchRequest, generateId: secureUuid, journal: uploadJournal,
        upload: (file, onProgress, sent) => apiUpload(`/requests/me/${sent.id}/documents`, file, false, onProgress, fieldsFor(file)),
        onProgress: setRetrying,
        onFile: (file) => setSendingUri(file ? file.uri : null),
      });
      const { note: _note, check: _check, ...state } = result;
      updateDraft(state);
      if (!pendingFiles(draft.files, result.uploaded).length) setRecovered(true);
    } catch (err) {
      toast(errorText(err, t));
    } finally {
      setRetrying(null);
      setSendingUri(null);
    }
  };
  const retryLabel = retrying
    ? t('req_uploading').replace('{i}', retrying.index).replace('{n}', retrying.total).replace('{p}', Math.round(retrying.progress * 100))
    : t('sk_try_again');

  // The request was received but a file did not go: the request is confirmed (green check), a warning says how many files were not sent, the files are listed, and the bar under them has the one
  // Try again (which, behind the scenes, asks the server first) and Return home.
  if (incomplete && !isDraft) {
    const overall = retrying ? Math.max(0, Math.min(1, ((retrying.index - 1) + retrying.progress) / Math.max(1, retrying.total))) : null;
    return (
      <Screen>
        <TopBar title={t('request_submitted_title')} onBack={() => navReplace('/home')} />
        <Body contentClassName="px-4 pt-6" grow>
          <View style={{ alignItems: 'center' }}>
            <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#E0F5F4', alignItems: 'center', justifyContent: 'center' }}>
              <Check size={30} color="#0B6564" strokeWidth={2.6} />
            </View>
            <Text accessibilityRole="header" style={{ marginTop: 16, textAlign: 'center', fontFamily: 'Inter_800ExtraBold', fontSize: 22, lineHeight: 28, color: '#0D2340' }}>{t('sub_received_title')}</Text>
            <Text style={{ marginTop: 4, textAlign: 'center', fontSize: 15, lineHeight: 22, color: '#5B6B84' }}>{t('sub_request_ref', { id })}</Text>
          </View>
          <View style={{ marginTop: 20, gap: 14 }}>
            <StatusNotice tone="warning" icon="alert" title={t('sub_docs_missing_title')} text={pluralText(t, lang, 'sub_docs_missing', missing.length)} />
            <UploadStatusList files={draft.files} state={listState} sendingUri={sendingUri} progress={retrying ? retrying.progress : 0} />
          </View>
        </Body>
        <View style={{ backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#E4E9F2', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16 }}>
          {retrying ? (
            <ProgressButton title={retryLabel} progress={overall} />
          ) : (
            <Button title={t('sk_try_again')} onPress={retry} needsNetwork className="min-h-[52px] rounded-2xl" icon={<RefreshCw size={19} color="#FFFFFF" strokeWidth={2.4} />} />
          )}
          <TextButton title={t('sub_return_home')} onPress={() => navReplace('/home')} style={{ marginTop: 4 }} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar title={t('request_submitted_title')} onBack={() => navReplace('/home')} />
      <Body contentClassName="items-center px-6 pt-6">
        {incomplete ? (
          <View className="mb-5 h-[130px] w-[130px] items-center justify-center rounded-full bg-primary-soft">
            <TriangleAlert size={56} color={COLORS.primary} strokeWidth={2} />
          </View>
        ) : <Celebration />}
        <Heading className="text-[25px]">{isDraft ? t('sub_draft_title') : incomplete ? t('sub_docs_missing_title') : t('thank_you_title')}</Heading>
        <Text className="mb-6 mt-2.5 max-w-[300px] text-center text-[15px] leading-[22px] text-muted" accessibilityRole={incomplete ? 'alert' : undefined}>
          {isDraft
            ? t('sub_draft_body')
            : incomplete
            ? pluralText(t, lang, 'sub_incomplete_body', missing.length)
            : recovered ? t('sub_recovered_body') : t('request_received_sub')}
        </Text>

        <Card className="mb-3 w-full flex-row items-center justify-between px-[18px] py-4">
          <View className="min-w-0 flex-1">
            <Text className="text-[12px] text-faint">{t('lbl_request_id')}</Text>
            <Text className="mt-0.5 font-inter-black text-[17px] text-navy">{id}</Text>
            <Text className="mt-0.5 text-[12.5px] text-muted" numberOfLines={1}>{service}</Text>
          </View>
          {incomplete ? (
            <View className="rounded-full bg-primary-soft px-2.5 py-1">
              <Text className="font-inter-black text-[11.5px] uppercase tracking-wide text-primary-dark">{isDraft ? t('sub_not_submitted_pill') : t('sub_docs_missing_pill')}</Text>
            </View>
          ) : <Pill status="submitted" />}
        </Card>

        {incomplete && (
          <Card className="mb-3 w-full p-[18px]">
            <UploadStatusList files={draft.files} state={listState} sendingUri={sendingUri} progress={retrying ? retrying.progress : 0} />
            <Button title={retryLabel} onPress={retry} loading={!!retrying} needsNetwork className="mt-4 w-full" />
          </Card>
        )}

        {!incomplete && (
        <Card className="w-full p-[20px]">
          <Text className="mb-4 font-inter-black text-[13.5px] text-navy">{t('next_steps_label')}</Text>
          <View className="gap-4">
            {STEPS.map(([key, Icon]) => (
              <View key={key} className="flex-row items-center gap-3">
                <View className="h-[34px] w-[34px] items-center justify-center rounded-full bg-success-soft"><Icon size={16} color="#1E8E4A" /></View>
                <Text className="flex-1 text-[14px] leading-5">{t(key)}</Text>
              </View>
            ))}
          </View>
        </Card>
        )}

        <Pressable onPress={() => open(`tel:${EMERGENCY_TEL}`)} className="mt-4 flex-row items-center gap-1.5">
          <Phone size={13} color={COLORS.primary} />
          <Text className="text-[13px] text-muted">
            {t('urgent_help_q')} <Text className="font-inter-bold text-primary">{EMERGENCY_DISPLAY}</Text>
          </Text>
        </Pressable>

        <Spacer />
        <Button title={t('view_my_request_btn')} onPress={() => navReplace({ pathname: '/request-details', params: { id: requestId } })} className="w-full" />
        <Button variant="ghost" title={t('btn_return_home')} onPress={() => navReplace('/home')} className="mt-2.5 w-full" />
      </Body>
    </Screen>
  );
}
