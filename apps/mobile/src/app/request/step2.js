import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useFormInput } from '../../components/keyboard';
import { router } from 'expo-router';
import { Accessibility, Activity, BedDouble, PersonStanding } from 'lucide-react-native';
import { needsCareLevel, useApp } from '../../state/AppContext';
import { EQUIPMENT_OPTIONS, MOBILITY_OPTIONS, URGENCY_OPTIONS, isMortal } from '../../data/mock';
import { CRITICAL_LEVELS, orderedCriticalLevels, firstAnchorOnStep, isOxygenFlow, isPrivateCharter, mobilityList, needsDocument, singleChoice } from '../../lib/privateCharter';
import { Anchor, RequestFrame } from '../../components/request/RequestFrame';
import { ChoiceChips, FieldError, FieldHeader, ReportTiles, SwitchRow } from '../../components/request/fields';
import { CARE_LEVELS, Field } from '../../components/ui';

// The description is multiline: Return adds a line, and the cursor line stays above the keyboard while it grows. It is its own component
// because it has to sit below the form (the hook reads the form it is in).
function DescriptionInput(props) {
  const form = useFormInput({ multiline: true });
  return <TextInput {...form} {...props} />;
}

const MOBILITY_ICONS = { bedridden: BedDouble, wheelchair: Accessibility, walking: PersonStanding };

// Step 2 of 3: the medical details. Patient transport (air and ground ambulance) also asks
// about care level, mobility and what is needed on board; every service asks how urgent it is.
// Mortal Remains asks for "Details" and the documents (the death certificate) instead of a
// diagnosis.
export default function RequestStep2() {
  const { t, draft, updateDraft, serverErrors } = useApp();
  const transport = needsCareLevel(draft.service);
  // The API's message for a field, shown under it until the person changes the field.
  const serverError = (field) => (serverErrors ? serverErrors[field] : undefined);
  // Private Charter needs at least one care level and lets several be chosen (Not Applicable only on its own); the other transport
  // services keep the single choice and leave it optional.
  const charter = isPrivateCharter(draft.service);
  const mobility = mobilityList(draft.mobility);
  const mortal = isMortal(draft.service);
  const [attempted, setAttempted] = useState(false);

  // Private Charter (revised form): Medical History, Critical Level, Oxygen Required (+ flow rate with Yes) and the report.
  // The other services keep care level, mobility, on-board equipment and urgency.
  const problems = charter ? [
    ['critical', !orderedCriticalLevels(draft.criticalLevel).length],
    ['oxygen', typeof draft.oxygenRequired !== 'boolean' || (draft.oxygenRequired && !isOxygenFlow(draft.oxygenFlowLpm))],
    ['files', needsDocument(draft)],
  ] : [
    ['mobility', transport && !singleChoice(mobility)],
    ['files', needsDocument(draft)],
    ['urgency', !draft.urgency],
  ];
  const firstError = () => problems.find(([, wrong]) => wrong)?.[0] || null;

  return (
    <RequestFrame
      step={2} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/review')}
      nextKey="req_next_review" serverAnchor={firstAnchorOnStep(serverErrors, 2)}
    >
      <Anchor id="desc">
        <FieldHeader title={t(mortal ? 'req_details' : charter ? 'req_medical_history' : 'req_condition')} />
        <View className="min-h-[88px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><Activity size={18} color="#97A4B8" strokeWidth={2} /></View>
          <DescriptionInput
            multiline textAlignVertical="top" value={draft.desc} onChangeText={(desc) => updateDraft({ desc })}
            accessibilityLabel={t(mortal ? 'req_details' : charter ? 'req_medical_history' : 'req_condition')}
            placeholder={t(mortal ? 'req_details_placeholder' : charter ? 'req_medical_history_placeholder' : 'req_condition_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[64px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{serverError('description')}</FieldError>
      </Anchor>

      {charter && (
        <Anchor id="critical">
          <FieldHeader title={t('req_critical_level')} required />
          {/* Several may be chosen; tapping a chosen one again deselects it. At least one is required. */}
          <ChoiceChips
            multiple columns={2} label={t('req_critical_level')} value={orderedCriticalLevels(draft.criticalLevel)}
            onChange={(criticalLevel) => updateDraft({ criticalLevel: orderedCriticalLevels(criticalLevel) })}
            options={CRITICAL_LEVELS.map((key) => ({ value: key, label: t(`critical_${key}`) }))}
          />
          <FieldError>{attempted && !orderedCriticalLevels(draft.criticalLevel).length ? t('req_critical_level_required') : serverError('criticalLevel')}</FieldError>
        </Anchor>
      )}

      {charter && (
        <Anchor id="oxygen">
          <FieldHeader title={t('req_oxygen_required')} required />
          <ChoiceChips
            columns={2} label={t('req_oxygen_required')} value={draft.oxygenRequired === true ? 'yes' : draft.oxygenRequired === false ? 'no' : ''}
            // Choosing No hides the flow rate and forgets what was typed, so it can never be sent with "No".
            onChange={(v) => updateDraft(v === 'yes' ? { oxygenRequired: true } : { oxygenRequired: v === 'no' ? false : null, oxygenFlowLpm: '' })}
            options={[{ value: 'yes', label: t('req_yes') }, { value: 'no', label: t('req_no') }]}
          />
          <FieldError>{attempted && typeof draft.oxygenRequired !== 'boolean' ? t('req_required') : serverError('oxygenRequired')}</FieldError>
          {draft.oxygenRequired === true && (
            <Field
              required className="mt-3" label={t('req_oxygen_flow')} placeholder={t('req_oxygen_flow_placeholder')} keyboardType="number-pad"
              value={draft.oxygenFlowLpm} onChangeText={(oxygenFlowLpm) => updateDraft({ oxygenFlowLpm: oxygenFlowLpm.replace(/\D/g, '').slice(0, 3) })}
              error={(attempted || draft.oxygenFlowLpm) && !isOxygenFlow(draft.oxygenFlowLpm) ? (draft.oxygenFlowLpm ? t('req_oxygen_flow_invalid') : t('req_required')) : serverError('oxygenFlowLpm')}
            />
          )}
        </Anchor>
      )}

      {transport && !charter && (
        <Anchor id="care">
          <FieldHeader title={t('field_care_level')} required={charter} />
          {charter ? (
            <ChoiceChips
              multiple columns={2} label={t('field_care_level')}
              value={draft.care} onChange={(care) => updateDraft({ care })}
              options={CARE_LEVELS.map((key) => ({ value: key, label: t(key), exclusive: key === 'care_na' }))}
            />
          ) : (
            <ChoiceChips
              columns={2} label={t('field_care_level')}
              value={singleChoice(draft.care)} onChange={(key) => updateDraft({ care: key ? [key] : [] })}
              options={CARE_LEVELS.map((key) => ({ value: key, label: t(key) }))}
            />
          )}
          <FieldError>{charter && attempted && !draft.care.length ? t('req_required') : serverError('careLevel')}</FieldError>
        </Anchor>
      )}

      {transport && !charter && (
        <Anchor id="mobility">
          <FieldHeader title={t('req_mobility')} required />
          <ChoiceChips
            columns={3} label={t('req_mobility')} multiple={charter}
            value={charter ? mobility : singleChoice(mobility)} onChange={(next) => updateDraft({ mobility: charter ? next : next ? [next] : [] })}
            options={MOBILITY_OPTIONS.map((key) => ({ value: key, label: t(`mobility_${key}`), Icon: MOBILITY_ICONS[key] }))}
          />
          <FieldError>{attempted && !(charter ? mobility.length : singleChoice(mobility)) ? t('req_required') : serverError('mobility')}</FieldError>
        </Anchor>
      )}

      {transport && !charter && (
        <Anchor id="equipment">
          <FieldHeader title={t('req_on_board')} />
          <View className="rounded-2xl border border-line bg-white px-4">
            {EQUIPMENT_OPTIONS.map(([field, , labelKey], i) => (
              <SwitchRow key={field} label={t(labelKey)} value={draft[field]} onChange={(on) => updateDraft({ [field]: on })} last={i === EQUIPMENT_OPTIONS.length - 1} />
            ))}
          </View>
          <FieldError>{serverError('equipOxygen') || serverError('equipCardiacMonitor') || serverError('equipVentilator')}</FieldError>
        </Anchor>
      )}

      <Anchor id="files">
        <ReportTiles title={t(mortal ? 'req_documents' : 'req_reports')} files={draft.files} onChange={(files) => updateDraft({ files })} />
        <FieldError>{attempted && needsDocument(draft) ? 'Upload at least one document to submit this request.' : null}</FieldError>
      </Anchor>

      {!charter && (
      <Anchor id="urgency">
        <FieldHeader title={t('req_urgency')} required />
        <ChoiceChips
          columns={3} label={t('req_urgency')} value={draft.urgency} onChange={(urgency) => updateDraft({ urgency })}
          options={URGENCY_OPTIONS.map((key) => ({ value: key, label: t(`urgency_${key}`), danger: key === 'critical_6h' }))}
        />
        <FieldError>{attempted && !draft.urgency ? t('req_required') : serverError('urgency')}</FieldError>
      </Anchor>
      )}
    </RequestFrame>
  );
}
