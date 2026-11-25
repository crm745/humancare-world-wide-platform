import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Activity } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { TEXT_MAX, codePointLength, corporateStep2Problems, corporateText, requirementProblem } from '../../lib/corporateMedical';
import { Anchor, RequestFrame } from './RequestFrame';
import { FieldError, FieldHeader } from './fields';
import { MultilineInput } from './MultilineInput';

// One optional requirement: a multiline box with its own counter. The text is kept exactly as typed.
function RequirementBox({ id, title, placeholder, value, onChange, problem, serverMessage, text }) {
  const error = problem === 'too_long' ? text('corp_err_too_long', { max: TEXT_MAX }) : problem === 'characters' ? text('corp_err_text_chars') : serverMessage;
  return (
    <Anchor id={id}>
      <FieldHeader title={title} hint={`${codePointLength(value)}/${TEXT_MAX}`} />
      <View className="min-h-[88px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
        <View className="pt-0.5"><Activity size={18} color="#97A4B8" strokeWidth={2} /></View>
        <MultilineInput
          multiline textAlignVertical="top" value={value} onChangeText={onChange} accessibilityLabel={title} placeholder={placeholder} placeholderTextColor="#97A4B8"
          className="min-h-[64px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
        />
      </View>
      <FieldError>{error}</FieldError>
    </Anchor>
  );
}

// Step 2 of 3 for Corporate Medical Solutions: Any Requirement and Special Requirement (both optional). No urgency and no documents. Used by app/request/step2.js when the
// chosen service is "corporate".
export function CorporateStep2() {
  const { t, draft, updateDraft, serverErrors } = useApp();
  const text = (key, values) => corporateText(t, key, values);
  const [, setAttempted] = useState(false);
  const problems = corporateStep2Problems(draft);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const serverError = (field) => (serverErrors ? serverErrors[field] : undefined);

  return (
    <RequestFrame
      step={2} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/review')}
      nextKey="req_next_review"
    >
      <RequirementBox
        id="any" title={text('corp_any')} placeholder={text('corp_any_placeholder')} value={draft.corpAny} onChange={(corpAny) => updateDraft({ corpAny })}
        problem={requirementProblem(draft.corpAny)} serverMessage={serverError('anyRequirement')} text={text}
      />
      <RequirementBox
        id="special" title={text('corp_special')} placeholder={text('corp_special_placeholder')} value={draft.corpSpecial} onChange={(corpSpecial) => updateDraft({ corpSpecial })}
        problem={requirementProblem(draft.corpSpecial)} serverMessage={serverError('specialRequirement')} text={text}
      />
    </RequestFrame>
  );
}
