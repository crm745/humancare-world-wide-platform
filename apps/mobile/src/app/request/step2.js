import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Accessibility, Activity, BedDouble, PersonStanding } from 'lucide-react-native';
import { needsCareLevel, useApp } from '../../state/AppContext';
import { EQUIPMENT_OPTIONS, MOBILITY_OPTIONS, URGENCY_OPTIONS, isMortal } from '../../data/mock';
import { Anchor, RequestFrame } from '../../components/request/RequestFrame';
import { ChoiceChips, FieldError, FieldHeader, ReportTiles, SwitchRow } from '../../components/request/fields';
import { CARE_LEVELS } from '../../components/ui';

const MOBILITY_ICONS = { bedridden: BedDouble, wheelchair: Accessibility, walking: PersonStanding };

// Step 2 of 3: the medical details. Patient transport (air and ground ambulance) also asks
// about care level, mobility and what is needed on board; every service asks how urgent it is.
// Mortal Remains asks for "Details" and the documents (the death certificate) instead of a
// diagnosis.
export default function RequestStep2() {
  const { t, draft, updateDraft } = useApp();
  const transport = needsCareLevel(draft.service);
  const mortal = isMortal(draft.service);
  const [attempted, setAttempted] = useState(false);

  const problems = [
    ['mobility', transport && !draft.mobility],
    ['urgency', !draft.urgency],
  ];
  const firstError = () => problems.find(([, wrong]) => wrong)?.[0] || null;

  return (
    <RequestFrame
      step={2} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/review')}
      nextKey="req_next_review"
    >
      <View>
        <FieldHeader title={t(mortal ? 'req_details' : 'req_condition')} />
        <View className="min-h-[88px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><Activity size={18} color="#97A4B8" strokeWidth={2} /></View>
          <TextInput
            multiline textAlignVertical="top" value={draft.desc} onChangeText={(desc) => updateDraft({ desc })}
            accessibilityLabel={t(mortal ? 'req_details' : 'req_condition')}
            placeholder={t(mortal ? 'req_details_placeholder' : 'req_condition_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[64px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
      </View>

      {transport && (
        <View>
          <FieldHeader title={t('field_care_level')} />
          <ChoiceChips
            multiple columns={2} label={t('field_care_level')} value={draft.care} onChange={(care) => updateDraft({ care })}
            options={CARE_LEVELS.map((key) => ({ value: key, label: t(key), exclusive: key === 'care_na' }))}
          />
        </View>
      )}

      {transport && (
        <Anchor id="mobility">
          <FieldHeader title={t('req_mobility')} required />
          <ChoiceChips
            columns={3} label={t('req_mobility')} value={draft.mobility} onChange={(mobility) => updateDraft({ mobility })}
            options={MOBILITY_OPTIONS.map((key) => ({ value: key, label: t(`mobility_${key}`), Icon: MOBILITY_ICONS[key] }))}
          />
          <FieldError>{attempted && !draft.mobility ? t('req_required') : null}</FieldError>
        </Anchor>
      )}

      {transport && (
        <View>
          <FieldHeader title={t('req_on_board')} />
          <View className="rounded-2xl border border-line bg-white px-4">
            {EQUIPMENT_OPTIONS.map(([field, , labelKey], i) => (
              <SwitchRow key={field} label={t(labelKey)} value={draft[field]} onChange={(on) => updateDraft({ [field]: on })} last={i === EQUIPMENT_OPTIONS.length - 1} />
            ))}
          </View>
        </View>
      )}

      <ReportTiles title={t(mortal ? 'req_documents' : 'req_reports')} files={draft.files} onChange={(files) => updateDraft({ files })} />

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
