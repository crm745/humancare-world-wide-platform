import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useFormInput } from '../../components/keyboard';
import { router } from 'expo-router';
import { Accessibility, Activity, BedDouble, PersonStanding } from 'lucide-react-native';
import { needsCareLevel, useApp } from '../../state/AppContext';
import { AIRLINE_MODES, EQUIPMENT_OPTIONS, MOBILITY_OPTIONS, URGENCY_OPTIONS, isMortal } from '../../data/mock';
import { CRITICAL_LEVELS, orderedCriticalLevels, firstAnchorOnStep, isOxygenFlow, isPrivateCharter, mobilityList, needsDocument, singleChoice } from '../../lib/privateCharter';
import { OXYGEN_LPM_MAX, asksPatientMobility, careLevelOptionsFor, equipmentOptionsFor, isGroundService, needsOxygenRate, needsTravelType, oxygenLpmProblem, presentIssueMissing } from '../../lib/requestForm';
import { Anchor, RequestFrame } from '../../components/request/RequestFrame';
import { ChoiceChips, FieldError, FieldHeader, ReportTiles, SwitchRow } from '../../components/request/fields';
import { CARE_LEVELS, Field } from '../../components/ui';
import { TeleStep2 } from '../../components/request/TeleStep2';
import { isTeleService } from '../../lib/teleConsultation';
import { MortalStep2 } from '../../components/request/MortalStep2';
import { isMortalService } from '../../lib/mortalRemains';
import { HomeStep2 } from '../../components/request/HomeStep2';
import { isHomeService } from '../../lib/homeHealthcare';
import { MvtStep2 } from '../../components/request/MvtStep2';
import { isMvtService } from '../../lib/medicalValueTravel';
import { MarineStep2 } from '../../components/request/MarineStep2';
import { isMarineService } from '../../lib/marineMedicalSafety';
import { CorporateStep2 } from '../../components/request/CorporateStep2';
import { isCorporateService } from '../../lib/corporateMedical';

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
function GenericStep2() {
  const { t, draft, updateDraft, serverErrors } = useApp();
  const transport = needsCareLevel(draft.service);
  // The API's message for a field, shown under it until the person changes the field.
  const serverError = (field) => (serverErrors ? serverErrors[field] : undefined);
  // Private Charter needs at least one care level and lets several be chosen (Not Applicable only on its own); the other transport
  // services keep the single choice and leave it optional.
  const charter = isPrivateCharter(draft.service);
  const mobility = mobilityList(draft.mobility);
  const mortal = isMortal(draft.service);
  // Commercial Air only: Oxygen under "Required on board" asks for its flow rate (LPM), mandatory while Oxygen is on.
  const lpmProblem = oxygenLpmProblem(draft);
  const askLpm = needsOxygenRate(draft.service) && draft.equipOxygen;
  // Commercial Air: Travel type is asked here (it was on Step 1), and Patient mobility is not asked.
  const askTravel = needsTravelType(draft.service);
  const askMobility = asksPatientMobility(draft.service);
  const equipment = equipmentOptionsFor(draft.service, EQUIPMENT_OPTIONS);
  const [attempted, setAttempted] = useState(false);
  // Ground Ambulance: the description is its mandatory "Present medical issue" (every other service keeps "Condition & diagnosis", optional).
  const ground = isGroundService(draft.service);
  const conditionTitle = t(mortal ? 'req_details' : charter ? 'req_medical_history' : ground ? 'field_present_issue' : 'req_condition');

  // Private Charter (revised form): Medical History, Critical Level, Oxygen Required (+ flow rate with Yes) and the report.
  // The other services keep their own questions (Travel type for Commercial Air, care level, mobility, on-board equipment, urgency).
  const problems = charter ? [
    ['critical', !orderedCriticalLevels(draft.criticalLevel).length],
    ['oxygen', typeof draft.oxygenRequired !== 'boolean' || (draft.oxygenRequired && !isOxygenFlow(draft.oxygenFlowLpm))],
    ['files', needsDocument(draft)],
  ] : [
    ['desc', presentIssueMissing(draft)],
    ['travel', askTravel && !draft.airlineMode],
    ['mobility', askMobility && !singleChoice(mobility)],
    ['oxygenLpm', lpmProblem !== null],
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
        <FieldHeader title={conditionTitle} required={ground} />
        <View className="min-h-[88px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><Activity size={18} color="#97A4B8" strokeWidth={2} /></View>
          <DescriptionInput
            multiline textAlignVertical="top" value={draft.desc} onChangeText={(desc) => updateDraft({ desc })}
            accessibilityLabel={conditionTitle}
            placeholder={t(mortal ? 'req_details_placeholder' : charter ? 'req_medical_history_charter_placeholder' : 'req_condition_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[64px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{ground && attempted && presentIssueMissing(draft) ? t('req_required') : serverError('description')}</FieldError>
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

      {askTravel && (
        <Anchor id="travel">
          <FieldHeader title={t('field_airline_mode')} required />
          <ChoiceChips
            columns={2} label={t('field_airline_mode')} value={draft.airlineMode} onChange={(airlineMode) => updateDraft({ airlineMode })}
            options={AIRLINE_MODES.map((key) => ({ value: key, label: t(`rd_travel_${key}`) }))}
          />
          <FieldError>{attempted && !draft.airlineMode ? t('req_required') : null}</FieldError>
        </Anchor>
      )}

      {transport && !charter && (
        <Anchor id="care">
          <FieldHeader title={t('field_care_level')} />
          {/* Commercial Air and Ground: the critical levels; every other transport service: the care levels. Several may be chosen. */}
          <ChoiceChips
            columns={2} label={t('field_care_level')} multiple value={draft.care} onChange={(care) => updateDraft({ care })}
            options={careLevelOptionsFor(draft.service, CARE_LEVELS).map((key) => ({ value: key, label: t(key), exclusive: key === 'care_na' }))}
          />
          <FieldError>{serverError('careLevel')}</FieldError>
        </Anchor>
      )}

      {askMobility && !charter && (
        <Anchor id="mobility">
          <FieldHeader title={t('req_mobility')} required />
          <ChoiceChips
            columns={3} label={t('req_mobility')}
            value={singleChoice(mobility)} onChange={(next) => updateDraft({ mobility: next ? [next] : [] })}
            options={MOBILITY_OPTIONS.map((key) => ({ value: key, label: t(`mobility_${key}`), Icon: MOBILITY_ICONS[key] }))}
          />
          <FieldError>{attempted && !singleChoice(mobility) ? t('req_required') : serverError('mobility')}</FieldError>
        </Anchor>
      )}

      {transport && !charter && (
        <Anchor id="equipment">
          <FieldHeader title={t('req_on_board')} />
          <View className="rounded-2xl border border-line bg-white px-4">
            {equipment.map(([field, , labelKey], i) => (
              <SwitchRow key={field} label={t(labelKey)} value={draft[field]} onChange={(on) => updateDraft(field === 'equipOxygen' && !on ? { equipOxygen: false, oxygenLpm: '' } : { [field]: on })} last={i === equipment.length - 1} />
            ))}
          </View>
          <FieldError>{serverError('equipOxygen') || serverError('equipCardiacMonitor') || serverError('equipVentilator')}</FieldError>
        </Anchor>
      )}

      {askLpm && (
        <Anchor id="oxygenLpm">
          <Field
            required label={t('req_oxygen_lpm')} placeholder={t('req_oxygen_lpm_placeholder')} keyboardType="decimal-pad" maxLength={4}
            value={draft.oxygenLpm} onChangeText={(text) => updateDraft({ oxygenLpm: text.replace(/[^0-9.,]/g, '') })}
            error={lpmProblem === 'required' && attempted ? t('req_oxygen_lpm_required') : lpmProblem === 'invalid' ? t('req_oxygen_lpm_invalid', { max: OXYGEN_LPM_MAX }) : undefined}
          />
        </Anchor>
      )}

      <Anchor id="files">
        <ReportTiles title={t(mortal ? 'req_documents' : 'req_reports')} files={draft.files} onChange={(files) => updateDraft({ files })} />
        <FieldError>{attempted && needsDocument(draft) ? t('req_err_need_doc') : null}</FieldError>
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

// Teleconsultation ("tele"), Mortal Remains ("mortal") and Home Healthcare ("homecare") have their own Step 2 (components/request/TeleStep2.js, MortalStep2.js,
// HomeStep2.js); every other service keeps the page above, unchanged.
export default function RequestStep2() {
  const { draft } = useApp();
  if (isCorporateService(draft.service)) return <CorporateStep2 />;
  if (isHomeService(draft.service)) return <HomeStep2 />;
  if (isMvtService(draft.service)) return <MvtStep2 />;
  if (isMarineService(draft.service)) return <MarineStep2 />;
  if (isMortalService(draft.service)) return <MortalStep2 />;
  return isTeleService(draft.service) ? <TeleStep2 /> : <GenericStep2 />;
}
