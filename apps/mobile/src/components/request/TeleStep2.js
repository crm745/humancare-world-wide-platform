import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Activity, CircleAlert } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { TEXT_MAX, codePointLength, isHouseCall, isValidVisitDate, teleStep2Problems, tomorrowString } from '../../lib/teleConsultation';
import { Anchor, RequestFrame } from './RequestFrame';
import { FieldError, FieldHeader } from './fields';
import { MultilineInput } from './MultilineInput';
import { VisitDateField } from './VisitDateField';

// Step 2 of 3 for Teleconsultation: Present Medical Issue and Any Allergic Issue (both optional, 2,000 characters at most) and, for a House Call
// only, the Preferred Visit Date (tomorrow or later). No urgency, no care level or equipment, and no medical-report upload. Used by
// app/request/step2.js when the chosen service is "tele"; every other service keeps its own Step 2.
export function TeleStep2() {
  const { t, draft, updateDraft } = useApp();
  const [attempted, setAttempted] = useState(false);
  const problems = teleStep2Problems(draft);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const houseCall = isHouseCall(draft);
  const tooLong = (text) => (codePointLength(text) > TEXT_MAX ? t('tele_err_too_long', { max: TEXT_MAX }) : null);

  return (
    <RequestFrame
      step={2} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/review')}
      nextKey="req_next_review"
    >
      <Anchor id="issue">
        <FieldHeader title={t('field_present_issue')} hint={`${codePointLength(draft.desc)}/${TEXT_MAX}`} />
        <View className="min-h-[88px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><Activity size={18} color="#97A4B8" strokeWidth={2} /></View>
          <MultilineInput
            multiline textAlignVertical="top" maxLength={TEXT_MAX} value={draft.desc} onChangeText={(desc) => updateDraft({ desc })}
            accessibilityLabel={t('field_present_issue')} placeholder={t('field_present_issue_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[64px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{tooLong(draft.desc)}</FieldError>
      </Anchor>

      <Anchor id="allergies">
        <FieldHeader title={t('field_allergy')} hint={`${codePointLength(draft.allergies)}/${TEXT_MAX}`} />
        <View className="min-h-[88px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><CircleAlert size={18} color="#97A4B8" strokeWidth={2} /></View>
          <MultilineInput
            multiline textAlignVertical="top" maxLength={TEXT_MAX} value={draft.allergies} onChangeText={(allergies) => updateDraft({ allergies })}
            accessibilityLabel={t('field_allergy')} placeholder={t('field_allergy_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[64px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{tooLong(draft.allergies)}</FieldError>
      </Anchor>

      {houseCall && (
        <Anchor id="visitDate">
          <VisitDateField
            required label={t('field_visit_date')} value={draft.date} onChange={(date) => updateDraft({ date })}
            error={(attempted || draft.date) && !isValidVisitDate(draft.date) ? t('tele_err_visit_date', { date: tomorrowString() }) : undefined}
          />
        </Anchor>
      )}
    </RequestFrame>
  );
}
