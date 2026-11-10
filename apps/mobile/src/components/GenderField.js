import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { GENDER_OPTIONS } from '../data/mock';
import { FieldLabel, Text } from './ui';
import { Select } from './widgets';

// Gender as a dropdown (Create Account and the Google/Apple step). The list shows the translated
// labels; `value` and `onChange` use the values the API stores ("male", "prefer_not_to_say"...).
export function GenderField({ value, onChange, showError }) {
  const { t } = useApp();
  const labels = GENDER_OPTIONS.map((option) => t(`gender_${option}`));
  return (
    <View>
      <FieldLabel large required>{t('field_gender')}</FieldLabel>
      <Select
        large value={value ? t(`gender_${value}`) : ''} options={labels} title={t('field_gender')} placeholder={t('gender_placeholder')}
        onChange={(label) => onChange(GENDER_OPTIONS[labels.indexOf(label)])}
      />
      {showError && !value ? <Text className="mt-1 text-[12px] text-danger">{t('gender_required')}</Text> : null}
    </View>
  );
}
