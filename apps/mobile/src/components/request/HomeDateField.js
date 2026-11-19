import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Calendar } from 'lucide-react-native';
import { FieldLabel, Text } from '../ui';
import { Sheet } from '../widgets';
import { dateToString, stringToDate, todayDate, todayString } from '../../lib/homeHealthcare';

// The Service Date of a Home Healthcare request: a calendar day, no time, TODAY or later (every past day is disabled). Today is the device's own,
// the same day the server works out from the UTC offset the request sends. Android shows its own picker dialog; iOS wraps the spinner in the existing
// Sheet with a Done button; the browser has a native date input (its min is not enforced on typing, so the form's own rule judges the value too).
// Home Healthcare's own component: the other services' date fields are left exactly as they are.
export function HomeDateField({ label, required, value, onChange, error }) {
  const [open, setOpen] = useState(false);
  const earliest = todayDate();

  if (Platform.OS === 'web') {
    return (
      <View>
        <FieldLabel required={required}>{label}</FieldLabel>
        <input
          type="date"
          required={required}
          value={value || ''}
          min={todayString()}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box', borderRadius: 10, border: '1.5px solid #E1E7F0', background: '#F7F9FC', padding: '12px', fontSize: 15,
            color: value ? '#17233D' : '#97A4B8', fontFamily: 'inherit',
          }}
        />
        {error ? <Text className="mt-1 text-[12px] text-danger">{error}</Text> : null}
      </View>
    );
  }

  const picked = stringToDate(value) || earliest;
  const handleAndroidChange = (event, selected) => {
    setOpen(false);
    if (event.type === 'dismissed' || !selected) return;
    onChange(dateToString(selected));
  };

  return (
    <View>
      <FieldLabel required={required}>{label}</FieldLabel>
      <Pressable
        onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${label}, ${value || 'Select a date'}`}
        className="min-h-[48px] flex-row items-center justify-between gap-1 rounded-[10px] border-[1.5px] border-field bg-input px-3 py-3"
      >
        <Text className={`text-[15px] ${value ? 'text-ink' : 'text-faint'}`}>{value || 'Select a date'}</Text>
        <Calendar size={16} color="#97A4B8" />
      </Pressable>
      {error ? <Text className="mt-1 text-[12px] text-danger">{error}</Text> : null}

      {Platform.OS === 'android' && open && (
        <DateTimePicker value={picked} mode="date" minimumDate={earliest} onChange={handleAndroidChange} />
      )}

      {Platform.OS !== 'android' && (
        <Sheet visible={open} onClose={() => setOpen(false)} title={label}>
          <DateTimePicker
            value={picked} mode="date" display="spinner" minimumDate={earliest}
            onChange={(_event, selected) => selected && onChange(dateToString(selected))}
          />
          <Pressable onPress={() => setOpen(false)} className="mt-4 items-center rounded-xl bg-primary py-3.5">
            <Text className="font-inter-bold text-[15px] text-white">Done</Text>
          </Pressable>
        </Sheet>
      )}
    </View>
  );
}
