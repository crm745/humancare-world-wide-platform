import { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { DEFAULT_FILTERS } from '../lib/filters';
import { Button, ChipGroup, Field, Text } from './ui';
import { Sheet } from './widgets';

const DATE_OPTIONS = ['all', 'today', 'week', 'month', 'year', 'custom'];

function GroupLabel({ children }) {
  return <Text className="mb-2.5 font-inter-black text-[12px] uppercase tracking-wide text-navy">{children}</Text>;
}

// Mounted fresh each time the sheet opens (Modal drops hidden children), so edits
// start from the applied filters and stay local until "Apply Filters".
function FilterForm({ services, value, onApply, onClose }) {
  const { t, toast } = useApp();
  const [f, setF] = useState(value);
  const set = (patch) => setF((cur) => ({ ...cur, ...patch }));

  return (
    <>
      <GroupLabel>{t('filter_service_type_label')}</GroupLabel>
      <ChipGroup
        className="mb-5"
        value={f.service}
        onChange={(service) => set({ service })}
        options={[{ value: 'all', label: t('filter_svc_all') }, ...services.map((s) => ({ value: s.value, label: t(s.labelKey) }))]}
      />
      <GroupLabel>{t('filter_date_range_label')}</GroupLabel>
      <ChipGroup
        className="mb-3"
        value={f.date}
        onChange={(date) => set({ date })}
        options={DATE_OPTIONS.map((d) => ({ value: d, label: t('filter_date_' + d) }))}
      />
      {f.date === 'custom' && (
        <View className="mb-5 flex-row gap-2.5">
          <Field className="flex-1" label={t('lbl_from')} placeholder="YYYY-MM-DD" value={f.from} onChangeText={(from) => set({ from })} />
          <Field className="flex-1" label={t('lbl_to')} placeholder="YYYY-MM-DD" value={f.to} onChangeText={(to) => set({ to })} />
        </View>
      )}
      <GroupLabel>{t('filter_sort_label')}</GroupLabel>
      <ChipGroup
        className="mb-6"
        value={f.sort}
        onChange={(sort) => set({ sort })}
        options={[{ value: 'newest', label: t('sort_newest') }, { value: 'oldest', label: t('sort_oldest') }]}
      />
      <View className="flex-row gap-2.5">
        <Button variant="outline" title={t('btn_reset')} className="flex-1" onPress={() => { setF(DEFAULT_FILTERS); onApply(DEFAULT_FILTERS); }} />
        <Button title={t('btn_apply_filters')} className="flex-[2]" onPress={() => { onApply(f); toast('Filters applied'); onClose(); }} />
      </View>
    </>
  );
}

// `services` is [{ value, labelKey }].
export function FilterSheet({ visible, onClose, title, services, value, onApply }) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title} fit>
      <FilterForm services={services} value={value} onApply={onApply} onClose={onClose} />
    </Sheet>
  );
}
