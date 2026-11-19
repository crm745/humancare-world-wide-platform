import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Activity } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { URGENCY_OPTIONS } from '../../data/mock';
import { codePointLength } from '../../lib/teleConsultation';
import { DETAILS_MAX, mortalStep2Problems } from '../../lib/mortalRemains';
import { Anchor, RequestFrame } from './RequestFrame';
import { ChoiceChips, FieldError, FieldHeader, ReportTiles } from './fields';
import { MultilineInput } from './MultilineInput';

// Step 2 of 3 for Mortal Remains Transportation: Details (optional, 2,000 characters at most), ONE combined upload section "Death Certificate /
// Additional Supporting Documents" (optional, up to 10 files of 10 MB: PDF, JPG, PNG, WEBP, DOC, DOCX; no separate slots, no mandatory certificate)
// and Urgency (required). Used by app/request/step2.js when the chosen service is "mortal"; every other service keeps its own Step 2.
export function MortalStep2() {
  const { t, draft, updateDraft } = useApp();
  const [attempted, setAttempted] = useState(false);
  const problems = mortalStep2Problems(draft);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const length = codePointLength(String(draft.desc || '').trim());

  return (
    <RequestFrame
      step={2} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/review')}
      nextKey="req_next_review"
    >
      <Anchor id="desc">
        <FieldHeader title={t('req_details')} hint={`${codePointLength(draft.desc)}/${DETAILS_MAX}`} />
        <View className="min-h-[88px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><Activity size={18} color="#97A4B8" strokeWidth={2} /></View>
          <MultilineInput
            multiline textAlignVertical="top" maxLength={DETAILS_MAX} value={draft.desc} onChangeText={(desc) => updateDraft({ desc })}
            accessibilityLabel={t('req_details')} placeholder={t('req_details_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[64px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{length > DETAILS_MAX ? t('mortal_err_too_long', { max: DETAILS_MAX }) : null}</FieldError>
      </Anchor>

      <Anchor id="files">
        <ReportTiles title={t('req_death_docs')} files={draft.files} onChange={(files) => updateDraft({ files })} />
      </Anchor>

      <Anchor id="urgency">
        <FieldHeader title={t('req_urgency')} required />
        <ChoiceChips
          columns={3} label={t('req_urgency')} value={draft.urgency} onChange={(urgency) => updateDraft({ urgency })}
          options={URGENCY_OPTIONS.map((key) => ({ value: key, label: t(`urgency_${key}`), danger: key === 'critical_6h' }))}
        />
        <FieldError>{attempted && !draft.urgency ? t('req_required') : null}</FieldError>
      </Anchor>
    </RequestFrame>
  );
}
