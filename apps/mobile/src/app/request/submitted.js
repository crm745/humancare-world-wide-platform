import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ArrowRight, BellRing, Check, ClipboardCheck, Headset, Phone, PhoneCall, RefreshCw, TriangleAlert } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { EMERGENCY_TEL } from '../../data/mock';
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
import { Button, Card, Pill, Text } from '../../components/ui';
import { PressBox } from '../../components/PressBox';
import { FONT } from '../../components/request/DetailsParts';
import { SubmittedMark } from '../../components/request/SubmittedMark';
import { formatDate, formatTime } from '../../lib/dateFormat';
import { StatusNotice } from '../../components/network/StatusNotice';
import { ProgressButton } from '../../components/network/ProgressButton';
import { TextButton } from '../../components/network/TextButton';
import { pluralText } from '../../lib/plural';
import { COLORS } from '../../theme/colors';
import { useOpenLink } from '../../lib/useOpenLink';

const STEPS = [
  ['next_step_call', PhoneCall],
  ['next_step_arrange', ClipboardCheck],
  ['next_step_updates', BellRing],
];

export default function RequestSubmitted() {
  const { t, lang, isRTL, draft, updateDraft, toast, discardDraft } = useApp();
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
  const [submittedAt] = useState(() => new Date()); // this screen opens right after the request was saved: now is the submission time
  // Announced once, in the person's language, when the confirmation opens (the animated picture is hidden from screen readers).
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current || incomplete) return;
    announced.current = true;
    AccessibilityInfo.announceForAccessibility(t('sub_title_submitted'));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the screen opens
  }, []);

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

  const submittedOn = t('sub_submitted_on', { date: `${formatDate(submittedAt)}, ${formatTime(submittedAt)}` });
  const bodyText = isDraft
    ? t('sub_draft_body')
    : incomplete
    ? pluralText(t, lang, 'sub_incomplete_body', missing.length)
    : recovered ? t('sub_recovered_body') : t('request_received_sub');

  return (
    <Screen>
      <TopBar title={t('request_submitted_title')} onBack={() => navReplace('/home')} />
      <Body contentClassName="items-center px-4 pt-2 pb-4" grow>
        <View style={{ width: '100%', alignItems: 'center', gap: 12 }}>
          {incomplete ? (
            <View className="h-[108px] w-[108px] items-center justify-center rounded-full bg-primary-soft">
              <TriangleAlert size={48} color={COLORS.primary} strokeWidth={2} />
            </View>
          ) : <SubmittedMark />}

          <View style={{ alignItems: 'center' }}>
            <Text accessibilityRole="header" style={{ textAlign: 'center', fontFamily: FONT[800], fontSize: 24, lineHeight: 30, color: '#0D2340' }}>
              {isDraft ? t('sub_draft_title') : incomplete ? t('sub_docs_missing_title') : t('sub_title_submitted')}
            </Text>
            <Text accessibilityRole={incomplete ? 'alert' : undefined} style={{ marginTop: 6, maxWidth: 320, textAlign: 'center', fontFamily: FONT[400], fontSize: 15, lineHeight: 22, color: '#5B6B84' }}>{bodyText}</Text>
          </View>

          <View style={{ width: '100%', backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: '#E4E9F2', paddingVertical: 12, paddingHorizontal: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <View style={{ flexShrink: 1, minWidth: 0 }}>
                <Text style={{ fontFamily: FONT[600], fontSize: 12, lineHeight: 16, color: '#5B6B84' }}>{t('lbl_request_id')}</Text>
                <Text style={{ fontFamily: FONT[800], fontSize: 18, lineHeight: 24, color: '#0D2340' }}>{id}</Text>
              </View>
              {incomplete ? (
                <View className="rounded-full bg-primary-soft px-2.5 py-1">
                  <Text className="font-inter-black text-[11.5px] uppercase tracking-wide text-primary-dark">{isDraft ? t('sub_not_submitted_pill') : t('sub_docs_missing_pill')}</Text>
                </View>
              ) : <Pill status="submitted" />}
            </View>
            <View style={{ height: 1, backgroundColor: '#EEF1F6', marginVertical: 10 }} />
            <Text style={{ fontFamily: FONT[700], fontSize: 15, lineHeight: 21, color: '#17233D' }}>{service}</Text>
            <Text style={{ fontFamily: FONT[400], fontSize: 13, lineHeight: 18, color: '#5B6B84' }}>{submittedOn}</Text>
          </View>

          {incomplete && (
            <Card className="w-full p-[18px]" style={{ borderRadius: 18 }}>
              <UploadStatusList files={draft.files} state={listState} sendingUri={sendingUri} progress={retrying ? retrying.progress : 0} />
              <Button title={retryLabel} onPress={retry} loading={!!retrying} needsNetwork className="mt-4 w-full" />
            </Card>
          )}

          {!incomplete && (
            <Card className="w-full" style={{ borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16 }}>
              <Text className="mb-3 font-inter-black text-[13.5px] text-navy">{t('next_steps_label')}</Text>
              <View style={{ gap: 12 }}>
                {STEPS.map(([key, Icon]) => (
                  <View key={key} className="flex-row items-center gap-3">
                    <View className="h-[34px] w-[34px] items-center justify-center rounded-full bg-success-soft"><Icon size={16} color="#1E8E4A" /></View>
                    <Text className="flex-1 text-[14px] leading-5">{t(key)}</Text>
                  </View>
                ))}
              </View>
            </Card>
          )}

          <PressBox
            accessibilityRole="button" accessibilityLabel={`${t('sub_urgent_help')}, ${t('sub_call_btn')}`} onPress={() => open(`tel:${EMERGENCY_TEL}`)}
            style={({ pressed }) => ({ width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#E4E9F2', paddingVertical: 12, paddingHorizontal: 14, opacity: pressed ? 0.85 : 1 })}
          >
            <View style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: '#FDECEC', alignItems: 'center', justifyContent: 'center' }}><Headset size={20} color="#C53030" strokeWidth={2.2} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: '#5B6B84' }}>{t('sub_urgent_help')}</Text>
            </View>
            <View style={{ height: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: COLORS.primarySoft, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Phone size={15} color={COLORS.primary} strokeWidth={2.4} />
              <Text style={{ fontFamily: FONT[800], fontSize: 13, color: COLORS.primary }}>{t('sub_call_btn')}</Text>
            </View>
          </PressBox>
        </View>
      </Body>

      <View style={{ backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#E4E9F2', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 4 }}>
        <PressBox
          accessibilityRole="button" onPress={() => navReplace({ pathname: '/request-details', params: { id: requestId } })}
          style={({ pressed }) => ({
            height: 52, borderRadius: 16, backgroundColor: pressed ? COLORS.primaryPressed : COLORS.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            shadowColor: COLORS.primary, shadowOpacity: 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 8 }, elevation: 4,
          })}
        >
          <Text style={{ fontFamily: FONT[800], fontSize: 16, color: '#FFFFFF' }}>{t('view_my_request_btn')}</Text>
          <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}><ArrowRight size={19} color="#FFFFFF" strokeWidth={2.4} /></View>
        </PressBox>
        <PressBox accessibilityRole="button" onPress={() => navReplace('/home')} style={({ pressed }) => ({ minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ fontFamily: FONT[800], fontSize: 15, color: '#5B6B84' }}>{t('btn_return_home')}</Text>
        </PressBox>
      </View>
    </Screen>
  );
}
