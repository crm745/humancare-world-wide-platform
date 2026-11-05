import { useState } from 'react';
import { Platform, Pressable, Switch, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Camera, ChevronDown, ChevronUp, FileText, Upload, X } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { MAX_REPORT_BYTES, MAX_REPORT_FILES } from '../../data/mock';
import { Text } from '../ui';

// Label row for a field on the medical page: the name on the left, a hint or link on the right.
export function FieldHeader({ title, hint, required, right }) {
  return (
    <View className="mb-2 flex-row items-center justify-between gap-3">
      <Text className="flex-shrink font-inter-bold text-[13.5px] text-navy">
        {title}{required ? <Text className="text-danger"> *</Text> : null}
      </Text>
      {right || (hint ? <Text className="flex-1 text-right text-[11.5px] text-faint">{hint}</Text> : null)}
    </View>
  );
}

export function FieldError({ children }) {
  return children ? <Text className="mt-1.5 text-[12px] text-danger">{children}</Text> : null;
}

// Chips for one choice (a radio group) or several (checkboxes). `label` names the group for
// screen readers and each chip says whether it is chosen. `options` is
// [{ value, label, Icon?, danger?, exclusive? }]; a `danger` option takes the light red tint when
// chosen. `columns` puts the chips in rows of that many, all the same width, so they line up and
// sit centred; without it they flow left to right. Single mode: tapping the chosen chip again
// clears it when `clearable`. `multiple` mode: `value` and `onChange` use arrays, and an
// `exclusive` option ("Not applicable") replaces the others instead of joining them.
export function ChoiceChips({ label, options, value, onChange, clearable, multiple, columns }) {
  const chosen = multiple ? value : [value];
  const choose = (option) => {
    if (!multiple) { onChange(clearable && option.value === value ? '' : option.value); return; }
    if (value.includes(option.value)) { onChange(value.filter((v) => v !== option.value)); return; }
    const exclusive = options.filter((o) => o.exclusive).map((o) => o.value);
    onChange(option.exclusive ? [option.value] : [...value.filter((v) => !exclusive.includes(v)), option.value]);
  };

  const chip = (option) => {
    const { value: v, label: text, Icon, danger } = option;
    const on = chosen.includes(v);
    const box = on ? (danger ? 'border-danger bg-danger-soft' : 'border-primary bg-primary-soft') : 'border-field bg-white';
    const tone = on ? (danger ? 'text-danger-dark' : 'text-primary-dark') : 'text-slate';
    const iconColor = on ? (danger ? '#B02A2A' : '#1A5FC4') : '#5B6B84';
    return (
      <Pressable
        key={v} onPress={() => choose(option)}
        accessibilityRole={multiple ? 'checkbox' : 'radio'} accessibilityState={{ checked: on }} accessibilityLabel={text}
        className={`min-h-[44px] items-center justify-center gap-1.5 rounded-full border-[1.5px] px-3 py-2 active:opacity-80 ${columns ? 'flex-1 flex-row' : 'flex-row'} ${box}`}
      >
        {Icon ? <Icon size={15} color={iconColor} strokeWidth={2} /> : null}
        <Text className={`flex-shrink text-center font-inter-bold text-[12.5px] leading-4 ${tone}`}>{text}</Text>
      </Pressable>
    );
  };

  if (!columns) {
    return (
      <View accessibilityRole={multiple ? undefined : 'radiogroup'} accessibilityLabel={label} className="flex-row flex-wrap gap-2">
        {options.map(chip)}
      </View>
    );
  }

  // Rows of `columns` chips. A short last row gets empty spacers so its chips are the same
  // width as the rest instead of stretching across the row.
  const rows = [];
  for (let i = 0; i < options.length; i += columns) rows.push(options.slice(i, i + columns));
  return (
    <View accessibilityRole={multiple ? undefined : 'radiogroup'} accessibilityLabel={label} className="gap-2">
      {rows.map((row) => (
        <View key={row[0].value} className="flex-row gap-2">
          {row.map(chip)}
          {Array.from({ length: columns - row.length }, (_, i) => <View key={`pad${i}`} className="flex-1" />)}
        </View>
      ))}
    </View>
  );
}

// A labelled on/off switch. The whole row is the control, so it is easy to hit.
export function SwitchRow({ label, value, onChange, last }) {
  return (
    <Pressable
      onPress={() => onChange(!value)} accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value }}
      className={`min-h-[48px] flex-row items-center justify-between gap-3 py-1.5 ${last ? '' : 'border-b border-divider'}`}
    >
      <Text className="flex-1 text-[14.5px] text-navy">{label}</Text>
      <View pointerEvents="none" accessible={false} importantForAccessibility="no-hide-descendants">
        <Switch value={value} trackColor={{ false: '#E1E7F0', true: '#0D2340' }} thumbColor="#FFFFFF" ios_backgroundColor="#E1E7F0" />
      </View>
    </Pressable>
  );
}

// Optional extra questions, closed until the person opens them. `defaultOpen` starts it open
// (when it already holds answers); `forceOpen` keeps it open while one of them has an error,
// so the error is never hidden. `onOpen` runs after it opens, so the page can scroll the
// newly shown fields into view.
export function Collapsible({ title, hint, children, defaultOpen = false, forceOpen = false, onOpen }) {
  const [opened, setOpened] = useState(defaultOpen);
  const open = opened || forceOpen;
  const Chevron = open ? ChevronUp : ChevronDown;
  const toggle = () => {
    setOpened(!open);
    if (!open) onOpen?.();
  };
  return (
    <View className="rounded-2xl border border-line bg-white">
      <Pressable
        onPress={toggle} accessibilityRole="button" accessibilityState={{ expanded: open }}
        className="min-h-[52px] flex-row items-center justify-between gap-3 px-4 py-3 active:opacity-80"
      >
        <View className="flex-1">
          <Text className="font-inter-bold text-[14px] text-navy">{title}</Text>
          {hint ? <Text className="mt-0.5 text-[11.5px] text-faint">{hint}</Text> : null}
        </View>
        <Chevron size={18} color="#5B6B84" />
      </Pressable>
      {open ? <View className="gap-5 border-t border-divider px-4 pb-4 pt-4">{children}</View> : null}
    </View>
  );
}

// Matches the backend's allowed types (backend src/middleware/upload.middleware.js).
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

export function formatFileSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// The medical reports on the form: a tile for each file (with a remove button), an "Add file"
// tile and a "Camera" link. Each file is checked here, before the request is sent, so a bad
// one is caught while the person can still fix it.
export function ReportTiles({ files, onChange, title }) {
  const { t, toast } = useApp();

  const add = (picked) => {
    const next = [...files];
    for (const file of picked) {
      if (file.mimeType && !ALLOWED_MIME_TYPES.includes(file.mimeType)) { toast(t('req_file_type')); continue; }
      if (file.size && file.size > MAX_REPORT_BYTES) { toast(t('req_file_big')); continue; }
      if (next.some((f) => f.uri === file.uri || (f.name === file.name && f.size === file.size))) continue;
      if (next.length >= MAX_REPORT_FILES) { toast(t('req_file_max').replace('{n}', MAX_REPORT_FILES)); break; }
      next.push(file);
    }
    onChange(next);
  };

  const pickFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ALLOWED_MIME_TYPES, multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    // The picker's `type` is only a hint to the OS file dialog, so each file is checked in add().
    add(result.assets.map((a) => ({ uri: a.uri, name: a.name, mimeType: a.mimeType, size: a.size })));
  };

  const takePhoto = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) { toast(t('req_camera_denied')); return; }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 });
      if (result.canceled) return;
      const a = result.assets[0];
      add([{ uri: a.uri, name: a.fileName || `report-${Date.now()}.jpg`, mimeType: a.mimeType || 'image/jpeg', size: a.fileSize }]);
    } catch {
      toast(t('req_camera_failed'));
    }
  };

  const remove = (uri) => onChange(files.filter((f) => f.uri !== uri));

  return (
    <View>
      <FieldHeader
        title={title}
        right={Platform.OS === 'web' ? null : (
          <Pressable onPress={takePhoto} accessibilityRole="button" accessibilityLabel={t('req_camera')} className="min-h-[44px] flex-row items-center gap-1.5 px-1 active:opacity-70">
            <Camera size={16} color="#1A73E8" strokeWidth={2.2} />
            <Text className="font-inter-bold text-[13.5px] text-primary">{t('req_camera')}</Text>
          </Pressable>
        )}
      />
      <View className="flex-row flex-wrap gap-2.5">
        {files.map((file) => (
          <View key={file.uri} className="h-[104px] w-[104px] justify-between rounded-2xl border border-line bg-primary-soft p-2.5">
            <FileText size={20} color="#1A5FC4" />
            <View>
              <Text className="font-inter-bold text-[11.5px] text-navy" numberOfLines={2}>{file.name}</Text>
              <Text className="mt-0.5 text-[10.5px] text-muted">{formatFileSize(file.size)}</Text>
            </View>
            <Pressable
              onPress={() => remove(file.uri)} accessibilityRole="button" accessibilityLabel={`${t('req_file_remove')} ${file.name}`}
              hitSlop={{ top: 8, left: 8, right: 8, bottom: 8 }}
              className="absolute right-1 top-1 h-7 w-7 items-center justify-center rounded-full bg-white active:opacity-70"
            >
              <X size={14} color="#45526B" strokeWidth={2.6} />
            </Pressable>
          </View>
        ))}
        <Pressable
          onPress={pickFiles} accessibilityRole="button" accessibilityLabel={t('req_add_file')}
          className="h-[104px] w-[104px] items-center justify-center gap-1.5 rounded-2xl border-[1.5px] border-dashed border-[#C7D3E5] bg-input active:opacity-80"
        >
          <Upload size={20} color="#1A73E8" />
          <Text className="font-inter-bold text-[12px] text-muted">{t('req_add_file')}</Text>
        </Pressable>
      </View>
      <Text className="mt-2 text-[11.5px] text-faint">{t('upload_hint')}</Text>
    </View>
  );
}
