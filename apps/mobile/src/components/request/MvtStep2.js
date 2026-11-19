import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Activity } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import {
  HISTORY_MAX, MVT_OTHER_SPECIALTY, MVT_SPECIALTIES, OTHER_MAX, codePointLength, freeTextProblem, isValidTreatmentDate, mvtStep2Problems, mvtText, textErrorMessage,
} from '../../lib/medicalValueTravel';
import { Anchor, RequestFrame } from './RequestFrame';
import { FieldError, FieldHeader, ReportTiles } from './fields';
import { MultilineInput } from './MultilineInput';
import { MvtDateField } from './MvtDateField';
import { Field, FieldLabel, Text } from '../ui';
import { Select } from '../widgets';

// Step 2 of 3 for Medical Value Travel: the treatment. The Preferred Treatment Date (optional: the day the treatment should START), the Specialty Required
// (a searchable list; "Other" asks for the specialty in the patient's own words, required then), the Medical History (the existing Condition & Diagnosis field,
// relabelled; optional) and the Medical Reports (optional; the shared upload tiles with their shared limits). No urgency, care level, mobility or equipment.
// Used by app/request/step2.js when the chosen service is "medvalue".
export function MvtStep2() {
  const { t, draft, updateDraft } = useApp();
  const [attempted, setAttempted] = useState(false);
  const problems = mvtStep2Problems(draft);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const required = t('req_required');
  const isOther = draft.specialty === MVT_OTHER_SPECIALTY;
  const otherProblem = freeTextProblem(draft.otherSpecialty, { required: true, max: OTHER_MAX, oneLine: true });
  const historyProblem = freeTextProblem(draft.desc, { required: false, max: HISTORY_MAX });

  return (
    <RequestFrame
      step={2} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/review')}
      nextKey="req_next_review"
    >
      <Anchor id="date">
        <MvtDateField
          label={mvtText(t, 'mvt_treatment_date')} hint={mvtText(t, 'mvt_treatment_date_hint')} clearLabel={mvtText(t, 'mvt_date_clear')}
          value={draft.date} onChange={(date) => updateDraft({ date })}
          error={draft.date && !isValidTreatmentDate(draft.date) ? mvtText(t, 'mvt_err_date') : undefined}
        />
      </Anchor>

      <Anchor id="specialty">
        <FieldLabel required>{mvtText(t, 'mvt_specialty')}</FieldLabel>
        <Select
          value={draft.specialty} options={MVT_SPECIALTIES} title={mvtText(t, 'mvt_specialty')} placeholder={mvtText(t, 'mvt_specialty_placeholder')}
          // Leaving "Other" drops its text: it is only asked (and sent) while Other is chosen.
          onChange={(specialty) => updateDraft(specialty === MVT_OTHER_SPECIALTY ? { specialty } : { specialty, otherSpecialty: '' })}
        />
        {attempted && !draft.specialty ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : null}
      </Anchor>

      {isOther && (
        <Anchor id="otherSpecialty">
          <Field
            required label={mvtText(t, 'mvt_other_specialty')} placeholder={mvtText(t, 'mvt_other_specialty_placeholder')}
            value={draft.otherSpecialty} onChangeText={(otherSpecialty) => updateDraft({ otherSpecialty })}
            error={textErrorMessage(otherProblem, t, { max: OTHER_MAX, attempted }) || undefined}
          />
        </Anchor>
      )}

      <Anchor id="history">
        <FieldHeader title={mvtText(t, 'mvt_history')} hint={`${codePointLength(draft.desc)}/${HISTORY_MAX}`} />
        <View className="min-h-[88px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><Activity size={18} color="#97A4B8" strokeWidth={2} /></View>
          <MultilineInput
            multiline textAlignVertical="top" value={draft.desc} onChangeText={(desc) => updateDraft({ desc })}
            accessibilityLabel={mvtText(t, 'mvt_history')} placeholder={mvtText(t, 'mvt_history_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[64px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{textErrorMessage(historyProblem, t, { max: HISTORY_MAX, attempted })}</FieldError>
      </Anchor>

      <Anchor id="files">
        <ReportTiles title={t('req_reports')} files={draft.files} onChange={(files) => updateDraft({ files })} />
      </Anchor>
    </RequestFrame>
  );
}
