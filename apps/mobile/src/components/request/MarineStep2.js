import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Activity } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import {
  CRITICAL_LEVEL_KEYS, HISTORY_MAX, OXYGEN_LPM_MAX, codePointLength, freeTextProblem, isValidServiceDate, marineOxygenProblem, marineStep2Problems, marineText, textErrorMessage,
} from '../../lib/marineMedicalSafety';
import { Anchor, RequestFrame } from './RequestFrame';
import { ChoiceChips, FieldError, FieldHeader, ReportTiles } from './fields';
import { MultilineInput } from './MultilineInput';
import { MvtDateField } from './MvtDateField';
import { Field } from '../ui';

// Step 2 of 3 for Marine Medical Safety: the Date of Service (optional; today or later), the Medical History (the existing Condition & Diagnosis field, relabelled;
// optional), the Critical Level (optional; ICU, Ventilated, Tracheostomy, ECMO, any number of them), Oxygen (Yes or No, which the person must answer; Yes asks for the
// flow rate in LPM, which is then required, and No clears it) and the Medical Reports (optional; the shared upload tiles with their shared limits: 10 files of 10 MB,
// PDF, JPG, PNG, WEBP, DOC and DOCX). No urgency, mobility or equipment items. Used by app/request/step2.js when the chosen service is "marine".
// The date picker is the one Medical Value Travel's Preferred Treatment Date uses (a generic optional, clearable calendar day), reused unchanged.
export function MarineStep2() {
  const { t, draft, updateDraft } = useApp();
  const [attempted, setAttempted] = useState(false);
  const problems = marineStep2Problems(draft);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const oxygen = marineOxygenProblem(draft);
  const historyProblem = freeTextProblem(draft.desc, { required: false, max: HISTORY_MAX });

  return (
    <RequestFrame
      step={2} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/review')}
      nextKey="req_next_review"
    >
      <Anchor id="date">
        <MvtDateField
          label={marineText(t, 'marine_date')} clearLabel={marineText(t, 'marine_date_clear')}
          value={draft.date} onChange={(date) => updateDraft({ date })}
          error={draft.date && !isValidServiceDate(draft.date) ? marineText(t, 'marine_err_date') : undefined}
        />
      </Anchor>

      <Anchor id="history">
        <FieldHeader title={marineText(t, 'marine_history')} hint={`${codePointLength(draft.desc)}/${HISTORY_MAX}`} />
        <View className="min-h-[88px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><Activity size={18} color="#97A4B8" strokeWidth={2} /></View>
          <MultilineInput
            multiline textAlignVertical="top" value={draft.desc} onChangeText={(desc) => updateDraft({ desc })}
            accessibilityLabel={marineText(t, 'marine_history')} placeholder={marineText(t, 'marine_history_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[64px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{textErrorMessage(historyProblem, t, { max: HISTORY_MAX, attempted })}</FieldError>
      </Anchor>

      <Anchor id="critical">
        <FieldHeader title={marineText(t, 'marine_critical')} />
        <ChoiceChips
          multiple columns={2} label={marineText(t, 'marine_critical')} value={draft.marineCare} onChange={(marineCare) => updateDraft({ marineCare })}
          options={CRITICAL_LEVEL_KEYS.map((key) => ({ value: key, label: t(key) }))}
        />
      </Anchor>

      <Anchor id="oxygen">
        <FieldHeader title={marineText(t, 'marine_oxygen')} required />
        <ChoiceChips
          columns={2} label={marineText(t, 'marine_oxygen')} value={draft.marineOxygen}
          // No drops the flow rate: it is only asked (and sent) when Oxygen is Yes.
          onChange={(marineOxygen) => updateDraft(marineOxygen === 'yes' ? { marineOxygen } : { marineOxygen, oxygenLpm: '' })}
          options={[{ value: 'yes', label: t('answer_yes') }, { value: 'no', label: t('answer_no') }]}
        />
        <FieldError>{attempted && oxygen === 'unanswered' ? marineText(t, 'marine_oxygen_unanswered') : null}</FieldError>
      </Anchor>

      {draft.marineOxygen === 'yes' && (
        <Anchor id="oxygenLpm">
          <Field
            required label={t('req_oxygen_lpm')} placeholder={t('req_oxygen_lpm_placeholder')} keyboardType="decimal-pad" maxLength={4}
            value={draft.oxygenLpm} onChangeText={(text) => updateDraft({ oxygenLpm: text.replace(/[^0-9.,]/g, '') })}
            error={oxygen === 'lpm_required' && attempted ? t('req_oxygen_lpm_required') : oxygen === 'lpm_invalid' ? t('req_oxygen_lpm_invalid', { max: OXYGEN_LPM_MAX }) : undefined}
          />
        </Anchor>
      )}

      <Anchor id="files">
        <ReportTiles title={t('req_reports')} files={draft.files} onChange={(files) => updateDraft({ files })} />
      </Anchor>
    </RequestFrame>
  );
}
