import { useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Animated, { Easing, withDelay, withSequence, withSpring, withTiming, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { BellRing, Check, ClipboardCheck, Phone, PhoneCall, TriangleAlert } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { EMERGENCY_DISPLAY, EMERGENCY_TEL } from '../../data/mock';
import { navReplace } from '../../lib/nav';
import { apiUpload } from '../../lib/api';
import { pendingFiles, runSubmission, submissionState } from '../../lib/requestUploads';
import { Body, Screen, TopBar } from '../../components/layout';
import { Button, Card, Heading, Pill, Spacer, Text } from '../../components/ui';
import { COLORS } from '../../theme/colors';

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
  const { t, draft, updateDraft, toast } = useApp();
  const { id, requestId, service } = useLocalSearchParams();
  const [retrying, setRetrying] = useState(null); // null, or { index, total, progress } while files upload
  const [recovered, setRecovered] = useState(false); // every file went through on a retry

  // Private Charter only: the report files the server has not accepted (see lib/requestUploads).
  // Always empty for every other service, which keeps this screen exactly as it was.
  const saved = draft.sentRequest && String(draft.sentRequest.id) === String(requestId) ? draft.sentRequest : null;
  const missing = saved ? pendingFiles(draft.files, draft.uploaded) : [];
  const incomplete = missing.length > 0;
  // Not one document has been accepted: the request is only a draft, not submitted (it needs at least one).
  const isDraft = saved ? submissionState(draft) === 'draft' : false;

  // Uploads only the files still missing, to the request that is already saved: never a new request.
  const retry = async () => {
    setRetrying({ index: 1, total: missing.length, progress: 0 });
    try {
      const result = await runSubmission({
        sentRequest: draft.sentRequest, uploaded: draft.uploaded, uploadErrors: draft.uploadErrors, files: draft.files,
        upload: (file, onProgress, sent) => apiUpload(`/requests/me/${sent.id}/documents`, file, false, onProgress),
        onProgress: setRetrying,
      });
      updateDraft(result);
      if (!pendingFiles(draft.files, result.uploaded).length) setRecovered(true);
    } catch (err) {
      toast(err.message);
    } finally {
      setRetrying(null);
    }
  };
  const retryLabel = retrying
    ? t('req_uploading').replace('{i}', retrying.index).replace('{n}', retrying.total).replace('{p}', Math.round(retrying.progress * 100))
    : `Retry failed uploads (${missing.length})`;

  return (
    <Screen>
      <TopBar title={t('request_submitted_title')} onBack={() => navReplace('/home')} />
      <Body contentClassName="items-center px-6 pt-6">
        {incomplete ? (
          <View className="mb-5 h-[130px] w-[130px] items-center justify-center rounded-full bg-warning-soft">
            <TriangleAlert size={56} color="#B4740D" strokeWidth={2} />
          </View>
        ) : <Celebration />}
        <Heading className="text-[25px]">{isDraft ? 'Request not submitted yet' : incomplete ? 'Documents not uploaded' : t('thank_you_title')}</Heading>
        <Text className="mb-6 mt-2.5 max-w-[300px] text-center text-[15px] leading-[22px] text-muted" accessibilityRole={incomplete ? 'alert' : undefined}>
          {isDraft
            ? 'Your request is saved as a draft, but none of your documents uploaded. A request needs at least one document before it can be submitted. Retry below.'
            : incomplete
            ? `Your request was saved, but ${missing.length} document${missing.length > 1 ? 's' : ''} did not upload, so we do not have ${missing.length > 1 ? 'them' : 'it'} yet. Retry below.`
            : recovered ? 'All your documents are now uploaded. We have received your request and documents.' : t('request_received_sub')}
        </Text>

        <Card className="mb-3 w-full flex-row items-center justify-between px-[18px] py-4">
          <View className="min-w-0 flex-1">
            <Text className="text-[12px] text-faint">{t('lbl_request_id')}</Text>
            <Text className="mt-0.5 font-inter-black text-[17px] text-navy">{id}</Text>
            <Text className="mt-0.5 text-[12.5px] text-muted" numberOfLines={1}>{service}</Text>
          </View>
          {incomplete ? (
            <View className="rounded-full bg-warning-soft px-2.5 py-1">
              <Text className="font-inter-black text-[11.5px] uppercase tracking-wide text-warning">{isDraft ? 'Not submitted' : 'Documents missing'}</Text>
            </View>
          ) : <Pill status="submitted" />}
        </Card>

        {incomplete && (
          <Card className="mb-3 w-full p-[18px]">
            <Text className="mb-3 font-inter-black text-[13.5px] text-navy">Not uploaded</Text>
            <View className="gap-3">
              {missing.map((file) => (
                <View key={file.uri}>
                  <Text className="font-inter-bold text-[13.5px] text-navy" numberOfLines={2}>{file.name}</Text>
                  <Text className="mt-0.5 text-[12.5px] text-danger">{draft.uploadErrors[file.uri] || 'Upload failed. Please try again.'}</Text>
                </View>
              ))}
            </View>
            <Button title={retryLabel} onPress={retry} loading={!!retrying} className="mt-4 w-full" />
            <Text className="mt-3 text-[12px] leading-[18px] text-muted">If you leave this screen without retrying, these documents are not sent with your request.</Text>
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

        <Pressable onPress={() => Linking.openURL(`tel:${EMERGENCY_TEL}`)} className="mt-4 flex-row items-center gap-1.5">
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
