import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Activity } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { OXYGEN_LPM_MAX } from '../../lib/requestForm';
import {
  CARETAKER_KEYS, CARETAKER_LABEL_KEYS, HOURS_KEYS, HOURS_LABEL_KEYS, LEVEL_KEYS, LEVEL_LABEL_KEYS, TEXT_MAX, codePointLength, freeTextProblem,
  homeOxygenProblem, homeStep2Problems,
} from '../../lib/homeHealthcare';
import { Anchor, RequestFrame } from './RequestFrame';
import { ChoiceChips, FieldError, FieldHeader, ReportTiles } from './fields';
import { MultilineInput } from './MultilineInput';
import { Field } from '../ui';

// Step 2 of 3 for Home Healthcare Services: the care selections (Nurse / Caretaker, Care Requirement, Care Level, Oxygen: ALL optional; the oxygen
// flow rate is required only when Oxygen is Yes), Medical History (the existing Condition & Diagnosis field, relabelled; optional) and Medical Reports
// (optional; the shared upload tiles: 10 files of 10 MB). No urgency. Used by app/request/step2.js when the chosen service is "homecare".
export function HomeStep2() {
  const { t, draft, updateDraft } = useApp();
  const [attempted, setAttempted] = useState(false);
  const problems = homeStep2Problems(draft);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const lpmProblem = homeOxygenProblem(draft);
  const historyProblem = freeTextProblem(draft.desc, { required: false });
  const historyError = historyProblem === 'too_long' ? t('home_err_too_long', { max: TEXT_MAX }) : historyProblem === 'characters' ? t('home_err_text_chars') : null;

  return (
    <RequestFrame
      step={2} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/review')}
      nextKey="req_next_review"
    >
      <Anchor id="caretaker">
        <FieldHeader title={t('field_caretaker')} />
        <ChoiceChips
          multiple columns={2} label={t('field_caretaker')} value={draft.homeCaretakers} onChange={(homeCaretakers) => updateDraft({ homeCaretakers })}
          options={CARETAKER_KEYS.map((key) => ({ value: key, label: t(CARETAKER_LABEL_KEYS[key]) }))}
        />
      </Anchor>

      <Anchor id="hours">
        <FieldHeader title={t('field_care_requirement')} />
        <ChoiceChips
          clearable columns={2} label={t('field_care_requirement')} value={draft.homeCareHours} onChange={(homeCareHours) => updateDraft({ homeCareHours })}
          options={HOURS_KEYS.map((key) => ({ value: key, label: t(HOURS_LABEL_KEYS[key]) }))}
        />
      </Anchor>

      <Anchor id="level">
        <FieldHeader title={t('field_home_care_level')} />
        <ChoiceChips
          clearable columns={2} label={t('field_home_care_level')} value={draft.homeCareLevel} onChange={(homeCareLevel) => updateDraft({ homeCareLevel })}
          options={LEVEL_KEYS.map((key) => ({ value: key, label: t(LEVEL_LABEL_KEYS[key]) }))}
        />
      </Anchor>

      <Anchor id="oxygen">
        <FieldHeader title={t('equip_oxygen')} />
        <ChoiceChips
          clearable columns={2} label={t('equip_oxygen')} value={draft.homeOxygen}
          // Anything but Yes drops the flow rate: it is only asked (and sent) when Oxygen is Yes.
          onChange={(homeOxygen) => updateDraft(homeOxygen === 'yes' ? { homeOxygen } : { homeOxygen, oxygenLpm: '' })}
          options={[{ value: 'yes', label: t('answer_yes') }, { value: 'no', label: t('answer_no') }]}
        />
      </Anchor>

      {draft.homeOxygen === 'yes' && (
        <Anchor id="oxygenLpm">
          <Field
            required label={t('home_oxygen_lpm')} placeholder={t('home_oxygen_lpm_placeholder')} keyboardType="decimal-pad" maxLength={4}
            value={draft.oxygenLpm} onChangeText={(text) => updateDraft({ oxygenLpm: text.replace(/[^0-9.,]/g, '') })}
            error={lpmProblem === 'required' && attempted ? t('home_oxygen_lpm_required') : lpmProblem === 'invalid' ? t('home_oxygen_lpm_invalid', { max: OXYGEN_LPM_MAX }) : undefined}
          />
        </Anchor>
      )}

      <Anchor id="history">
        <FieldHeader title={t('req_medical_history')} hint={`${codePointLength(draft.desc)}/${TEXT_MAX}`} />
        <View className="min-h-[88px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><Activity size={18} color="#97A4B8" strokeWidth={2} /></View>
          <MultilineInput
            multiline textAlignVertical="top" value={draft.desc} onChangeText={(desc) => updateDraft({ desc })}
            accessibilityLabel={t('req_medical_history')} placeholder={t('req_medical_history_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[64px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{historyError}</FieldError>
      </Anchor>

      <Anchor id="files">
        <ReportTiles title={t('req_reports')} files={draft.files} onChange={(files) => updateDraft({ files })} />
      </Anchor>
    </RequestFrame>
  );
}
