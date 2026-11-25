import { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { PencilLine } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { SERVICE_TILES } from '../../data/mock';
import { formatDate } from '../../lib/dateFormat';
import { COLORS, NOTICE } from '../../theme/colors';
import { Button, Text } from '../ui';

// On Home: an unfinished request saved (encrypted) on this phone (lib/draftStore.js). Resume restores the saved answers and the step the person was on; Discard deletes the draft and
// its key. Neither sends anything: Resume only fills the form, and the person still goes through the steps and Submit. A draft that expired or could not be read is deleted
// quietly: there is nothing to show for it.
// The card: a 48 px pencil tile, a small label ("Unfinished request"), the service name, "Saved <date> · Nothing has been sent", and Discard (outline) and Resume (primary) side by side.
const FONT = { 400: 'Inter_400Regular', 800: 'Inter_800ExtraBold' };

export function DraftNotice() {
  const { t, savedDraft, refreshSavedDraft, resumeDraft, discardDraft, toast } = useApp();
  const [busy, setBusy] = useState(false);

  useFocusEffect(useCallback(() => { refreshSavedDraft(); }, [refreshSavedDraft]));

  if (!savedDraft) return null;

  const tile = SERVICE_TILES.find((s) => s.key === (savedDraft.service === 'air' ? 'privatecharter' : savedDraft.service));
  const resume = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const opened = await resumeDraft();
      if (!opened) { toast(t('draft_unusable')); return; }
      router.push('/request/step1');
      if (opened.step >= 2) router.push('/request/step2');
      if (opened.step >= 3) router.push('/request/review');
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => { if (!busy) await discardDraft(); };

  return <DraftCard serviceTitle={tile ? t(tile.title) : ''} savedAt={savedDraft.savedAt} busy={busy} onResume={resume} onDiscard={discard} />;
}

// The card itself (no state): what the Home card looks like.
export function DraftCard({ serviceTitle, savedAt, busy = false, onResume, onDiscard }) {
  const { t } = useApp();
  return (
    <View style={{ borderRadius: 24, borderWidth: 1, padding: 16, marginBottom: 12, backgroundColor: '#FFFFFF', borderColor: '#E4E9F2', shadowColor: '#0D2340', shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: COLORS.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
          <PencilLine size={22} color={COLORS.primary} strokeWidth={2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text accessibilityRole="header" style={{ fontFamily: FONT[800], fontSize: 12, lineHeight: 16, letterSpacing: 1, textTransform: 'uppercase', color: NOTICE.warning.text }}>{t('draft_card_title')}</Text>
          {serviceTitle ? <Text style={{ marginTop: 2, fontFamily: FONT[800], fontSize: 16, lineHeight: 22, color: '#0D2340' }}>{serviceTitle}</Text> : null}
          <Text style={{ marginTop: 2, fontFamily: FONT[400], fontSize: 13.5, lineHeight: 19, color: '#5B6B84' }}>{t('draft_card_meta', { date: formatDate(savedAt) })}</Text>
        </View>
      </View>
      <View style={{ marginTop: 14, flexDirection: 'row', gap: 12 }}>
        <Pressable
          accessibilityRole="button" accessibilityState={{ disabled: busy }} onPress={onDiscard} disabled={busy}
          style={{ flex: 1, minHeight: 46, borderRadius: 16, borderWidth: 1.5, borderColor: '#D6DCE8', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', opacity: busy ? 0.5 : 1 }}
        >
          <Text className="font-inter-bold" style={{ fontSize: 15, color: '#5B6B84' }}>{t('draft_discard')}</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Button title={t('draft_resume')} loading={busy} onPress={onResume} className="min-h-[46px] rounded-2xl" />
        </View>
      </View>
    </View>
  );
}
